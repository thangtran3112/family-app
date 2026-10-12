from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from ai_trading.db.models import Alert, Delivery, User
from ai_trading.jobs import JobResult, relogin_reminder
from ai_trading.jobs.clock import JobClock
from ai_trading.notify.dispatch import DeliveryOutcome, dispatch_pending


def test_due_now_is_false_before_1800_on_sunday():
    # 2026-10-11 is a Sunday; 17:59 ET (EDT, UTC-4) == 21:59 UTC.
    assert relogin_reminder.due_now(datetime(2026, 10, 11, 21, 59, tzinfo=UTC)) is False


def test_due_now_fires_at_1800_et_on_sunday():
    assert relogin_reminder.due_now(datetime(2026, 10, 11, 22, 0, tzinfo=UTC)) is True
    assert relogin_reminder.due_now(datetime(2026, 10, 11, 23, 30, tzinfo=UTC)) is True  # open window


def test_due_now_is_false_on_a_weekday():
    assert relogin_reminder.due_now(datetime(2026, 10, 12, 22, 0, tzinfo=UTC)) is False  # Monday


def test_writes_one_alert_per_user(db_session, owner):
    now = datetime(2026, 10, 11, 22, 0, tzinfo=UTC)

    result = relogin_reminder.run(db_session, JobClock(), now=now)

    assert result == JobResult(relogin_reminder.NAME, ok=True)
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 1
    assert rows[0].kind == "system"
    # F3: "system" severity, not "info" -- `notify.quiet_hours.in_quiet_hours` only bypasses
    # "system"/"risk" severities, and this reminder must still reach the owner inside quiet hours.
    assert rows[0].severity == "system"
    assert rows[0].dedupe_key == f"relogin-reminder:{now.date()}"


def test_dedupe_suppresses_a_same_week_refire(db_session, owner):
    first_sunday = datetime(2026, 10, 11, 22, 0, tzinfo=UTC)
    relogin_reminder.run(db_session, JobClock(), now=first_sunday)

    relogin_reminder.run(db_session, JobClock(), now=first_sunday + timedelta(minutes=5))
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 1  # the second call, same day, is a no-op

    next_sunday = first_sunday + timedelta(days=7)
    relogin_reminder.run(db_session, JobClock(), now=next_sunday)
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 2  # a week later (past the 6-day cooldown), it fires again


def test_run_marks_the_clock_on_success_so_the_scheduler_does_not_rerun_it(db_session, owner):
    clock = JobClock()
    now = datetime(2026, 10, 11, 22, 0, tzinfo=UTC)

    relogin_reminder.run(db_session, clock, now=now)

    assert clock.succeeded_today(relogin_reminder.NAME, now) is True


def test_the_reminder_alert_still_delivers_during_quiet_hours(db_session, owner):
    """F3: a `system`-severity alert's delivery must not be suppressed by quiet hours, even when
    the user's quiet hours cover the whole day -- the regression this review fix closed (the
    reminder previously used severity="info", which `in_quiet_hours` does NOT bypass)."""
    now = datetime(2026, 10, 11, 22, 0, tzinfo=UTC)
    db_session.execute(
        User.__table__.update()
        .where(User.id == owner)
        .values(settings={"quiet_hours": {"start": "00:00", "end": "23:59"}})
    )

    relogin_reminder.run(db_session, JobClock(), now=now)
    alert = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalar_one()
    delivery = Delivery(alert_id=alert.id, channel="telegram")
    db_session.add(delivery)
    db_session.flush()

    class _FakeChannel:
        name = "telegram"

        def send(self, *, title: str, body: str, severity: str) -> None:
            return None

    outcomes = dispatch_pending(db_session, channels={"telegram": _FakeChannel()}, now=now)

    assert outcomes == [DeliveryOutcome(delivery.id, "sent")]
    assert delivery.status == "sent"
