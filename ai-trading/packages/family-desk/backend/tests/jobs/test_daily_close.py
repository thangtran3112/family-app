from datetime import UTC, datetime

from conftest import FakeBarsSource

from ai_trading.data.bars import read_bars
from ai_trading.jobs import daily_close
from ai_trading.jobs.clock import JobClock


class _FakeSources:
    def __init__(self, bars: FakeBarsSource) -> None:
        self.bars = bars


def test_due_now_is_false_before_1630_et():
    # 2026-10-06 is a regular session (EDT, UTC-4): 16:30 ET == 20:30 UTC.
    assert daily_close.due_now(datetime(2026, 10, 6, 20, 29, tzinfo=UTC)) is False


def test_due_now_is_true_at_and_after_1630_et():
    assert daily_close.due_now(datetime(2026, 10, 6, 20, 30, tzinfo=UTC)) is True
    assert daily_close.due_now(datetime(2026, 10, 6, 23, 59, tzinfo=UTC)) is True


def test_due_now_is_false_on_a_non_trading_day():
    assert daily_close.due_now(datetime(2026, 11, 26, 21, 30, tzinfo=UTC)) is False  # Thanksgiving


def test_due_now_daily_close_fires_at_the_half_days_1300_et_close(db_session, watchlist_with_items, monkeypatch):
    # 2026-11-27 is a half day: its own regular close is 13:00 ET (18:00 UTC, EST) -- but
    # `daily_close` fires at a FIXED 16:30 ET (21:30 UTC) on every XNYS trading day, half days
    # included, not at the session's own early close (integration fix).
    assert daily_close.due_now(datetime(2026, 11, 27, 21, 29, tzinfo=UTC)) is False
    assert daily_close.due_now(datetime(2026, 11, 27, 21, 30, tzinfo=UTC)) is True

    # By 16:30 ET the half day's own 13:00 ET close has long passed, so when the job actually
    # runs at its fixed slot, the half-day bar is already closed and gets stored.
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    clock = JobClock()
    now = datetime(2026, 11, 27, 21, 30, tzinfo=UTC)

    result = daily_close.run(db_session, sources, clock, now=now)
    db_session.commit()

    assert result == daily_close.JobResult("daily_close", ok=True)
    bars = read_bars(db_session, "AAPL", "1d", now.date(), now.date(), "stock", as_of=now)
    assert list(bars["close"]) == [100.0]


def test_run_backfills_every_distinct_stock_symbol_then_ticks(db_session, watchlist_with_items, monkeypatch):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    ticked = []
    monkeypatch.setattr(daily_close, "tick", lambda session, *, now, live_cadences: ticked.append(live_cadences))
    clock = JobClock()
    now = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)

    result = daily_close.run(db_session, sources, clock, now=now)
    db_session.commit()

    assert result == daily_close.JobResult("daily_close", ok=True)
    # Only AAPL (stock) is backfilled -- ES (future) has no data source in Phase 3 (D-c).
    assert [call[0] for call in fake_bars.calls] == ["AAPL"]
    assert ticked == [frozenset({"daily_close"})]
    assert clock.succeeded_today("daily_close", now) is True


def test_run_writes_the_days_bar(db_session, watchlist_with_items):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    clock = JobClock()
    now = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)

    daily_close.run(db_session, sources, clock, now=now)
    db_session.commit()

    bars = read_bars(db_session, "AAPL", "1d", now.date(), now.date(), "stock", as_of=now)
    assert list(bars["close"]) == [100.0]
