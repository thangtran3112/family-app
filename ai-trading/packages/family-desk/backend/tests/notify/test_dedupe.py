from datetime import UTC, datetime, timedelta

from ai_trading.db.models import Alert, User
from ai_trading.notify.dedupe import should_alert

_NOW = datetime(2026, 10, 12, 18, 0, tzinfo=UTC)
_COOLDOWN = timedelta(hours=1)


def _make_user(db_session) -> User:
    user = User(email="owner@example.com")
    db_session.add(user)
    db_session.flush()
    return user


def _make_alert(db_session, user: User, *, dedupe_key: str, created_at: datetime) -> Alert:
    alert = Alert(
        user_id=user.id,
        kind="system",
        severity="system",
        dedupe_key=dedupe_key,
        title="Job overdue",
        body="daily_close has not run",
        created_at=created_at,
    )
    db_session.add(alert)
    db_session.flush()
    return alert


def test_should_alert_false_when_a_row_was_created_inside_the_cooldown(db_session):
    user = _make_user(db_session)
    _make_alert(
        db_session, user, dedupe_key="job-overdue:daily_close", created_at=_NOW - _COOLDOWN + timedelta(seconds=1)
    )

    assert should_alert(db_session, "job-overdue:daily_close", cooldown=_COOLDOWN, now=_NOW) is False


def test_should_alert_true_exactly_at_the_cooldown_boundary(db_session):
    user = _make_user(db_session)
    _make_alert(db_session, user, dedupe_key="job-overdue:daily_close", created_at=_NOW - _COOLDOWN)

    assert should_alert(db_session, "job-overdue:daily_close", cooldown=_COOLDOWN, now=_NOW) is True


def test_should_alert_true_when_the_existing_row_is_older_than_the_cooldown(db_session):
    user = _make_user(db_session)
    _make_alert(
        db_session, user, dedupe_key="job-overdue:daily_close", created_at=_NOW - _COOLDOWN - timedelta(seconds=1)
    )

    assert should_alert(db_session, "job-overdue:daily_close", cooldown=_COOLDOWN, now=_NOW) is True


def test_should_alert_true_when_no_row_with_that_dedupe_key_exists(db_session):
    _make_user(db_session)

    assert should_alert(db_session, "job-overdue:weekly", cooldown=_COOLDOWN, now=_NOW) is True


def test_should_alert_ignores_a_row_with_a_different_dedupe_key(db_session):
    user = _make_user(db_session)
    _make_alert(db_session, user, dedupe_key="job-overdue:premarket_0830", created_at=_NOW)

    assert should_alert(db_session, "job-overdue:daily_close", cooldown=_COOLDOWN, now=_NOW) is True
