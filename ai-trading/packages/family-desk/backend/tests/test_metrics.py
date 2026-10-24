"""The shared metric row (02m §a1): golden against the Run 0 snapshot's recorded rows, the live-session
overlay, and the `symbol_metrics` store (real Postgres via `scripts/test-db.sh`)."""

import json
import math
from datetime import UTC, date, datetime
from pathlib import Path

import pandas as pd
import pytest
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.core.calendar import et
from ai_trading.data.bars import upsert_bars
from ai_trading.data.metrics import METRIC_KEYS, metric_row, refresh_metrics
from ai_trading.db.models import SymbolMetrics

FIXTURES = Path(__file__).parent / "fixtures" / "desk-mvp"
LAST_DAY = date(2026, 10, 6)


def _snapshot() -> dict:
    return json.loads((FIXTURES / "snapshot_trimmed.json").read_text())


def _daily(rows: list[list]) -> pd.DataFrame:
    return pd.DataFrame(
        [row[1:] for row in rows],
        columns=["open", "high", "low", "close", "volume"],
        index=[date.fromisoformat(row[0]) for row in rows],
    )


@pytest.mark.parametrize("symbol", ["SPY", "NVDA", "MSFT"])
def test_daily_metrics_match_the_snapshot_rows(symbol):
    snapshot = _snapshot()
    got = metric_row(_daily(snapshot["symbols"][symbol]["bars"]["1d"]["rows"]))
    want = snapshot["screener"]["metrics"][symbol]
    exact = ("last", "prev_close", "change_pct", "volume", "avg_volume_20d", "rvol_10d", "gap_pct_open", "high_252d")
    for key in (*exact, "dist_to_252d_high_pct"):
        assert got[key] == want[key], key
    # Wilder smoothing remembers its start: the fixture keeps 60 bars where the snapshot used ~450.
    assert got["atr_pct_14"] == pytest.approx(want["atr_pct_14"], rel=0.01)
    assert got["rsi_14"] == pytest.approx(want["rsi_14"], abs=0.6)
    # No 1-minute bars: the VWAP fields are null, never a guess.
    assert got["vwap_close"] is None and got["vs_vwap_pct"] is None and got["rvol_intraday_10d_at_close"] is None


def test_the_row_has_exactly_the_documented_keys_and_no_nan():
    snapshot = _snapshot()
    row = metric_row(_daily(snapshot["symbols"]["NVDA"]["bars"]["1d"]["rows"]))
    assert tuple(row) == METRIC_KEYS
    assert not any(isinstance(v, float) and math.isnan(v) for v in row.values())


def test_fewer_than_two_daily_bars_is_an_all_null_row():
    one = daily_bars([LAST_DAY], [10.0])
    assert set(metric_row(one).values()) == {None}
    assert set(metric_row(one.iloc[0:0]).values()) == {None}


def _history(count: int = 30) -> pd.DataFrame:
    days = trading_days("stock", LAST_DAY, count)
    return daily_bars(days, [100.0 + i for i in range(count)], volume=2_000_000)


def test_vwap_fields_come_from_the_last_regular_one_minute_bar_of_the_last_daily_day():
    daily = _history()
    minutes = minute_bars("stock", LAST_DAY, price=129.0, volume=100)
    set_bar(minutes, LAST_DAY, "10:00", close=131.0, volume=100)
    row = metric_row(daily, minutes)
    # The day is already in `daily`, so `last` is the daily close; only the intraday fields use minutes.
    assert row["last"] == 129.0
    assert row["vwap_close"] is not None and 129.0 <= row["vwap_close"] < 129.1
    assert row["vs_vwap_pct"] == pytest.approx((129.0 / row["vwap_close"] - 1) * 100, abs=0.001)
    assert row["rvol_intraday_10d_at_close"] is None  # only one day of minutes: no ten-day baseline


def test_a_session_in_progress_becomes_a_partial_daily_bar():
    daily = _history()
    next_day = date(2026, 10, 7)
    minutes = minute_bars("stock", next_day, price=140.0, volume=500)
    minutes = minutes[minutes.index < et(next_day, "10:30")]  # 09:30-10:30 ET only: an hour of the session
    minutes = minutes[minutes.index >= et(next_day, "09:30")]
    set_bar(minutes, next_day, "09:30", open=135.0)
    row = metric_row(daily, minutes)
    assert row["last"] == 140.0
    assert row["prev_close"] == 129.0
    assert row["change_pct"] == pytest.approx((140.0 / 129.0 - 1) * 100, abs=0.001)
    assert row["volume"] == 500.0 * 60
    assert row["gap_pct_open"] == pytest.approx((135.0 / 129.0 - 1) * 100, abs=0.001)
    # Closed daily bars only: the partial day must not move them.
    assert row["avg_volume_20d"] == 2_000_000.0
    assert row["rvol_10d"] is None  # no ten prior days of minutes to compare the clock time against


def test_refresh_metrics_reads_stored_bars_and_stores_one_row_per_symbol(db_session):
    now = et(date(2026, 10, 7), "09:00")  # before the open: the 10-06 daily bar has closed
    days = trading_days("stock", LAST_DAY, 30)
    upsert_bars(db_session, "AAA", "1d", daily_bars(days, [50.0 + i for i in range(30)]), "alpaca", "stock", now=now)
    upsert_bars(db_session, "NEW", "1d", daily_bars(days[-1:], [10.0]), "alpaca", "stock", now=now)
    stored = refresh_metrics(db_session, ["AAA", "NEW", "NONE"], now=now)
    db_session.commit()
    assert stored == ["AAA"]  # one daily bar is not enough; no bars at all is not a row
    row = db_session.get(SymbolMetrics, "AAA")
    assert row.metrics["last"] == 79.0
    assert row.quality == "eod" and row.source == "alpaca"
    assert row.as_of == datetime(2026, 10, 6, 20, 0, tzinfo=UTC)
    assert db_session.get(SymbolMetrics, "NEW") is None

    refresh_metrics(db_session, ["AAA"], now=now)  # idempotent: the same row, updated in place
    db_session.commit()
    assert db_session.query(SymbolMetrics).count() == 1
