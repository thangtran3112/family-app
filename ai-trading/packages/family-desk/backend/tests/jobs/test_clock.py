from datetime import UTC, date, datetime

from ai_trading.jobs.clock import JobClock


def test_succeeded_today_is_false_before_any_mark():
    clock = JobClock()
    assert clock.succeeded_today("premarket_0830", datetime(2026, 10, 6, 13, 0, tzinfo=UTC)) is False


def test_mark_then_succeeded_today_is_true_for_that_utc_date():
    clock = JobClock()
    clock.mark("daily_close", date(2026, 10, 6))
    assert clock.succeeded_today("daily_close", datetime(2026, 10, 6, 23, 0, tzinfo=UTC)) is True


def test_succeeded_today_is_false_on_a_different_utc_date():
    clock = JobClock()
    clock.mark("weekly", date(2026, 10, 6))
    assert clock.succeeded_today("weekly", datetime(2026, 10, 7, 12, 0, tzinfo=UTC)) is False


def test_mark_is_per_job_name():
    clock = JobClock()
    clock.mark("premarket_0830", date(2026, 10, 6))
    assert clock.succeeded_today("daily_close", datetime(2026, 10, 6, 23, 0, tzinfo=UTC)) is False
