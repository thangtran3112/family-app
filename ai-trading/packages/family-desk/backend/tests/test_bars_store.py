"""The bar store: closed-bar-only upserts (Review Focus 2), as-of reads (Review Focus 6), backfill
planning, and the 1-minute retention prune. Needs a real Postgres (`scripts/test-db.sh`)."""

from datetime import date, timedelta

import pandas as pd
import pytest

from ai_trading.core.calendar import et, session
from ai_trading.data import bars
from ai_trading.data.bars import bar_close, missing_sessions, prune_1m, read_bars, upsert_bars

DAY = date(2026, 10, 6)  # a regular (non-half-day) XNYS session
NEXT_DAY = date(2026, 10, 7)
THIRD_DAY = date(2026, 10, 8)
HALF_DAY = date(2025, 11, 28)  # the day after Thanksgiving, 13:00 ET close


def _frame(points, prices) -> pd.DataFrame:
    return pd.DataFrame(
        {"open": prices, "high": prices, "low": prices, "close": prices, "volume": [1_000.0] * len(prices)},
        index=pd.Index(points),
    )


# --- bar_close -----------------------------------------------------------------------------------


def test_bar_close_1m_is_one_minute_later():
    start = et(DAY, "10:00")
    assert bar_close("stock", "1m", start) == start + pd.Timedelta(minutes=1)


def test_bar_close_1d_is_the_session_regular_close():
    assert bar_close("stock", "1d", DAY) == session("stock", DAY).regular_close
    assert bar_close("stock", "1d", HALF_DAY) == et(HALF_DAY, "13:00")


def test_bar_close_1h_is_one_hour_later_on_a_full_day():
    start = et(DAY, "10:00")
    assert bar_close("stock", "1h", start) == start + pd.Timedelta(hours=1)


def test_bar_close_1h_caps_at_a_half_days_short_last_hour():
    # 12:30-13:30 ET would naturally close at 13:30, but the half day closes at 13:00.
    start = et(HALF_DAY, "12:30")
    assert bar_close("stock", "1h", start) == et(HALF_DAY, "13:00")


def test_bar_close_1h_does_not_pull_a_post_market_bar_backward():
    # Already past the regular close; the half-day cap must not apply to it.
    start = et(HALF_DAY, "14:00")
    assert bar_close("stock", "1h", start) == start + pd.Timedelta(hours=1)


# --- upsert_bars -----------------------------------------------------------------------------------


def test_upsert_raises_on_a_bar_not_yet_closed(db_session):
    frame = _frame([DAY], [100.0])
    almost_close = session("stock", DAY).regular_close - pd.Timedelta(seconds=1)
    with pytest.raises(ValueError, match="has not closed"):
        upsert_bars(db_session, "AAPL", "1d", frame, "alpaca", "stock", now=almost_close)
    db_session.rollback()
    assert read_bars(db_session, "AAPL", "1d", DAY, DAY, "stock", as_of=et(DAY, "20:00")).empty


def test_upsert_accepts_a_bar_exactly_at_its_close(db_session):
    frame = _frame([DAY], [100.0])
    upsert_bars(db_session, "AAPL", "1d", frame, "alpaca", "stock", now=session("stock", DAY).regular_close)
    db_session.commit()
    out = read_bars(db_session, "AAPL", "1d", DAY, DAY, "stock", as_of=et(DAY, "20:00"))
    assert list(out["close"]) == [100.0]


def test_upsert_splits_a_large_batch_into_chunks_and_keeps_row_order(monkeypatch):
    monkeypatch.setattr(bars, "_UPSERT_CHUNK", 5_000)
    start = et(DAY, "04:00")
    points = [start + pd.Timedelta(minutes=i) for i in range(12_000)]
    frame = _frame(points, [float(i) for i in range(12_000)])

    class _Session:
        def __init__(self):
            self.statements = []

        def execute(self, stmt):
            self.statements.append(stmt)

    fake = _Session()
    bars.upsert_bars(fake, "AAPL", "1m", frame, "alpaca", "stock", now=points[-1] + pd.Timedelta(days=1))

    rows = [{c.key: v for c, v in row.items()} for stmt in fake.statements for row in stmt._multi_values[0]]
    assert [len(stmt._multi_values[0]) for stmt in fake.statements] == [5_000, 5_000, 2_000]
    assert [row["bar_start"] for row in rows] == points
    assert [row["close"] for row in rows] == [float(i) for i in range(12_000)]


def test_upsert_stores_a_batch_past_the_postgres_parameter_cap(db_session):
    start = et(DAY, "04:00")
    points = [start + pd.Timedelta(minutes=i) for i in range(9_000)]  # 72k binds in one statement: over the 65,535 cap
    now = points[-1] + pd.Timedelta(days=1)
    upsert_bars(db_session, "AAPL", "1m", _frame(points, [1.0] * 9_000), "alpaca", "stock", now=now)
    db_session.commit()
    out = read_bars(db_session, "AAPL", "1m", points[0], points[-1], "stock", as_of=now)
    assert len(out) == 9_000


def test_upsert_is_idempotent_and_the_second_write_wins(db_session):
    now = et(DAY, "20:00")
    upsert_bars(db_session, "AAPL", "1d", _frame([DAY], [100.0]), "alpaca", "stock", now=now)
    upsert_bars(db_session, "AAPL", "1d", _frame([DAY], [101.0]), "stooq", "stock", now=now)
    db_session.commit()
    out = read_bars(db_session, "AAPL", "1d", DAY, DAY, "stock", as_of=now)
    assert list(out["close"]) == [101.0]


# --- read_bars: no look-ahead (Review Focus 6) ------------------------------------------------------


def test_read_as_of_ignores_a_later_mutation_of_a_future_bar(db_session):
    now = et(THIRD_DAY, "20:00")
    upsert_bars(db_session, "AAPL", "1d", _frame([DAY, NEXT_DAY], [100.0, 101.0]), "alpaca", "stock", now=now)
    db_session.commit()
    as_of = session("stock", DAY).regular_close + pd.Timedelta(minutes=1)  # only DAY has closed

    before = read_bars(db_session, "AAPL", "1d", DAY, THIRD_DAY, "stock", as_of=as_of)

    # Mutate the later (still-in-the-future, relative to `as_of`) bar -- closed by `now`, so the
    # write itself is legal, but it must not change what the earlier `as_of` sees.
    upsert_bars(db_session, "AAPL", "1d", _frame([NEXT_DAY], [999.0]), "alpaca", "stock", now=now)
    db_session.commit()

    after = read_bars(db_session, "AAPL", "1d", DAY, THIRD_DAY, "stock", as_of=as_of)
    pd.testing.assert_frame_equal(before, after)
    assert list(before.index) == [DAY]  # NEXT_DAY had not closed as of `as_of`


def test_read_as_of_filters_an_intraday_bar_not_yet_closed(db_session):
    first = et(DAY, "10:00")
    second = et(DAY, "10:01")
    now = et(DAY, "20:00")
    upsert_bars(db_session, "AAPL", "1m", _frame([first, second], [100.0, 101.0]), "alpaca", "stock", now=now)
    db_session.commit()
    out = read_bars(db_session, "AAPL", "1m", first, second, "stock", as_of=first + pd.Timedelta(minutes=1))
    assert list(out.index) == [first]


# --- missing_sessions ------------------------------------------------------------------------------


def test_missing_sessions_daily_reports_a_day_with_no_bar(db_session):
    now = et(THIRD_DAY, "20:00")
    upsert_bars(db_session, "AAPL", "1d", _frame([DAY, THIRD_DAY], [100.0, 102.0]), "alpaca", "stock", now=now)
    db_session.commit()
    assert missing_sessions(db_session, "AAPL", "1d", "stock", DAY, THIRD_DAY) == [NEXT_DAY]


def test_missing_sessions_intraday_treats_a_quiet_session_as_present(db_session):
    now = et(THIRD_DAY, "20:00")
    one_bar = _frame([et(DAY, "10:00")], [100.0])
    upsert_bars(db_session, "AAPL", "1m", one_bar, "alpaca", "stock", now=now)
    db_session.commit()
    # DAY has exactly one bar (quiet minutes elsewhere are fine); NEXT_DAY and THIRD_DAY have none.
    assert missing_sessions(db_session, "AAPL", "1m", "stock", DAY, THIRD_DAY) == [NEXT_DAY, THIRD_DAY]


# --- prune_1m --------------------------------------------------------------------------------------


def test_prune_1m_drops_only_bars_older_than_90_days(db_session):
    now = et(DAY, "20:00")
    old = now - timedelta(days=91)
    recent = now - timedelta(days=10)
    upsert_bars(db_session, "AAPL", "1m", _frame([old], [1.0]), "alpaca", "stock", now=old + pd.Timedelta(minutes=1))
    upsert_bars(
        db_session, "AAPL", "1m", _frame([recent], [2.0]), "alpaca", "stock", now=recent + pd.Timedelta(minutes=1)
    )
    db_session.commit()
    deleted = prune_1m(db_session, now=now)
    db_session.commit()
    assert deleted == 1
    out = read_bars(db_session, "AAPL", "1m", old - pd.Timedelta(days=1), now, "stock", as_of=now)
    assert list(out["close"]) == [2.0]
