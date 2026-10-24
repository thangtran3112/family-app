from datetime import UTC, datetime

from conftest import FakeBarsSource

from ai_trading.data.bars import read_bars
from ai_trading.jobs import refresh_15m


class _FakeSources:
    def __init__(self, bars: FakeBarsSource) -> None:
        self.bars = bars


def test_due_now_is_true_only_on_15_minute_marks_within_the_window():
    assert refresh_15m.due_now(datetime(2026, 10, 6, 14, 0, tzinfo=UTC)) is True  # 10:00 ET
    assert refresh_15m.due_now(datetime(2026, 10, 6, 14, 15, tzinfo=UTC)) is True
    assert refresh_15m.due_now(datetime(2026, 10, 6, 14, 5, tzinfo=UTC)) is False


def test_due_now_is_false_outside_the_window():
    assert refresh_15m.due_now(datetime(2026, 10, 6, 10, 45, tzinfo=UTC)) is False  # 06:45 ET
    assert refresh_15m.due_now(datetime(2026, 10, 6, 21, 15, tzinfo=UTC)) is False  # 17:15 ET


def test_due_now_is_false_on_a_non_trading_day():
    assert refresh_15m.due_now(datetime(2026, 11, 26, 14, 0, tzinfo=UTC)) is False  # Thanksgiving


def test_run_backfills_stock_symbols_only_and_ticks(db_session, watchlist_with_items, monkeypatch):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    ticked = []
    monkeypatch.setattr(refresh_15m, "tick", lambda session, *, now, live_cadences: ticked.append(live_cadences))
    now = datetime(2026, 10, 6, 14, 0, tzinfo=UTC)

    result = refresh_15m.run(db_session, sources, now=now)
    db_session.commit()

    assert result.ok is True
    assert {call[0] for call in fake_bars.calls} == {"AAPL"}  # ES (future) is excluded, D-c
    assert ticked == [refresh_15m._LIVE_CADENCES]


def test_a_second_same_day_call_stores_the_minutes_that_appeared_since_the_first_call(db_session, watchlist_with_items):
    # Integration fix: `run` now fetches `data_sources.bars` directly and `upsert_bars`s the
    # result instead of routing through `ai_trading.data.backfill.backfill`, whose
    # `missing_sessions` check only ever treats a whole day as "missing" -- a later same-day call
    # used to find today's first bar already present and fetch nothing new (REPORT-L3.md's own
    # flagged limitation). Two same-day calls at different `now`s must store progressively more
    # minutes.
    from ai_trading.core.calendar import session as calendar_session

    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    first_now = datetime(2026, 10, 6, 14, 0, tzinfo=UTC)  # 10:00 ET
    second_now = datetime(2026, 10, 6, 14, 30, tzinfo=UTC)  # 10:30 ET, same trading day
    found = calendar_session("stock", first_now.date())

    refresh_15m.run(db_session, sources, now=first_now)
    db_session.commit()
    first_bars = read_bars(
        db_session, "AAPL", "1m", found.extended_open, found.extended_close, "stock", as_of=second_now
    )

    refresh_15m.run(db_session, sources, now=second_now)
    db_session.commit()
    second_bars = read_bars(
        db_session, "AAPL", "1m", found.extended_open, found.extended_close, "stock", as_of=second_now
    )

    assert len(second_bars) > len(first_bars) > 0
