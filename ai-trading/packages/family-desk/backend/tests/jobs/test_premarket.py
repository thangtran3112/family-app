from datetime import UTC, datetime

from ai_trading.jobs import premarket
from ai_trading.jobs.clock import JobClock


def test_due_now_is_false_before_0830_et():
    # 2026-10-06 12:29 UTC == 08:29 ET (EDT, UTC-4) -- one minute before the slot.
    assert premarket.due_now(datetime(2026, 10, 6, 12, 29, tzinfo=UTC)) is False


def test_due_now_is_true_at_and_after_0830_et_on_a_trading_day():
    assert premarket.due_now(datetime(2026, 10, 6, 12, 30, tzinfo=UTC)) is True
    assert premarket.due_now(datetime(2026, 10, 6, 20, 0, tzinfo=UTC)) is True  # open window: still due later


def test_due_now_is_false_on_a_non_trading_day():
    # 2026-11-26 is Thanksgiving, an XNYS holiday.
    assert premarket.due_now(datetime(2026, 11, 26, 13, 30, tzinfo=UTC)) is False


def test_due_now_premarket_0830_shifts_correctly_across_the_dst_change():
    # 2026-03-06 (EST, UTC-5): 08:30 ET == 13:30 UTC. 2026-03-09 (EDT, UTC-4, after the spring
    # DST change): 08:30 ET == 12:30 UTC. Both must read as "due" at their own 08:30 ET instant.
    assert premarket.due_now(datetime(2026, 3, 6, 13, 30, tzinfo=UTC)) is True
    assert premarket.due_now(datetime(2026, 3, 6, 13, 29, tzinfo=UTC)) is False
    assert premarket.due_now(datetime(2026, 3, 9, 12, 30, tzinfo=UTC)) is True
    assert premarket.due_now(datetime(2026, 3, 9, 12, 29, tzinfo=UTC)) is False


def test_run_calls_tick_with_its_own_cadence_and_marks_the_clock(monkeypatch):
    calls = []
    monkeypatch.setattr(premarket, "tick", lambda session, *, now, live_cadences: calls.append((now, live_cadences)))
    clock = JobClock()
    now = datetime(2026, 10, 6, 13, 30, tzinfo=UTC)

    result = premarket.run(session_=object(), clock=clock, now=now)

    assert result.name == "premarket_0830"
    assert result.ok is True
    assert calls == [(now, frozenset({"premarket_0830"}))]
    assert clock.succeeded_today("premarket_0830", now) is True
