from datetime import UTC, date, datetime

from ai_trading.jobs import weekly
from ai_trading.jobs.clock import JobClock


def test_first_of_week_is_true_for_monday_when_monday_trades():
    assert weekly._first_of_week("stock", date(2026, 10, 5)) is True  # a Monday


def test_first_of_week_is_false_for_a_later_trading_day():
    assert weekly._first_of_week("stock", date(2026, 10, 6)) is False  # Tuesday, same week


def test_first_of_week_shifts_to_tuesday_when_monday_is_a_holiday():
    # 2026-01-19 is MLK Day (a Monday XNYS holiday); the week's first trading day is Tuesday.
    assert weekly._first_of_week("stock", date(2026, 1, 20)) is True


def test_due_now_is_false_before_0700_et_on_the_first_trading_day():
    assert weekly.due_now(datetime(2026, 10, 5, 10, 59, tzinfo=UTC)) is False  # 06:59 ET


def test_due_now_is_true_at_and_after_0700_et_on_the_first_trading_day():
    assert weekly.due_now(datetime(2026, 10, 5, 11, 0, tzinfo=UTC)) is True  # 07:00 ET, Monday


def test_due_now_is_false_on_a_later_trading_day_of_the_same_week():
    assert weekly.due_now(datetime(2026, 10, 6, 11, 0, tzinfo=UTC)) is False  # Tuesday


def test_due_now_shifts_to_tuesday_when_monday_is_a_holiday():
    assert weekly.due_now(datetime(2026, 1, 19, 12, 0, tzinfo=UTC)) is False  # MLK Day itself
    assert weekly.due_now(datetime(2026, 1, 20, 12, 0, tzinfo=UTC)) is True  # Tuesday, 07:00 ET


def test_run_calls_tick_with_its_own_cadence_and_marks_the_clock(monkeypatch):
    calls = []
    monkeypatch.setattr(weekly, "tick", lambda session, *, now, live_cadences: calls.append(live_cadences))
    clock = JobClock()
    now = datetime(2026, 10, 5, 11, 0, tzinfo=UTC)

    result = weekly.run(session_=object(), clock=clock, now=now)

    assert result.ok is True
    assert calls == [frozenset({"weekly"})]
    assert clock.succeeded_today("weekly", now) is True
