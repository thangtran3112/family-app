from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from ai_trading.db.models import Alert
from ai_trading.jobs import watchdog
from ai_trading.jobs.clock import JobClock


def test_due_now_is_true_on_any_trading_day():
    assert watchdog.due_now(datetime(2026, 10, 6, 15, 0, tzinfo=UTC)) is True


def test_due_now_is_false_on_a_non_trading_day():
    assert watchdog.due_now(datetime(2026, 11, 26, 15, 0, tzinfo=UTC)) is False  # Thanksgiving


def test_overdue_job_alerts_once(db_session, owner):
    # premarket_0830's slot is 08:30 ET; 08:30 + 20 minutes = 08:50 ET == 12:50 UTC on 2026-10-06.
    now = datetime(2026, 10, 6, 12, 51, tzinfo=UTC)
    clock = JobClock()

    alerted = watchdog.run(db_session, clock, now=now)

    assert alerted == ["premarket_0830"]
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 1
    assert rows[0].kind == "system"
    assert rows[0].dedupe_key == "job-overdue:premarket_0830:2026-10-06"


def test_not_yet_overdue_does_not_alert(db_session, owner):
    now = datetime(2026, 10, 6, 12, 49, tzinfo=UTC)  # one minute before the deadline
    alerted = watchdog.run(db_session, JobClock(), now=now)
    assert alerted == []


def test_no_alert_when_the_job_already_succeeded_today(db_session, owner):
    now = datetime(2026, 10, 6, 12, 51, tzinfo=UTC)
    clock = JobClock()
    clock.mark("premarket_0830", now.date())

    alerted = watchdog.run(db_session, clock, now=now)

    assert alerted == []


def test_dedupe_suppresses_a_second_call_within_the_cooldown(db_session, owner):
    now = datetime(2026, 10, 6, 12, 51, tzinfo=UTC)
    clock = JobClock()

    first = watchdog.run(db_session, clock, now=now)
    second = watchdog.run(db_session, clock, now=now + timedelta(minutes=1))

    assert first == ["premarket_0830"]
    assert second == []  # same dedupe key, within the 1-hour cooldown
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 1


def test_weekly_is_only_checked_on_the_first_trading_day_of_the_week(db_session, owner):
    # 2026-10-06 is a Tuesday (2026-10-05, Monday, trades) -- not the week's first trading day,
    # so `weekly`'s overdue check never runs that day, however late `now` is or however long the
    # clock has gone unmarked.
    now = datetime(2026, 10, 6, 11, 21, tzinfo=UTC)  # 07:21 ET: past weekly's 07:00+20min deadline

    alerted = watchdog.run(db_session, JobClock(), now=now)

    assert "weekly" not in alerted
