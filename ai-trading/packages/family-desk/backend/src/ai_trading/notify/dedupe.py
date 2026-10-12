"""Cooldown-based dedupe for system alerts (watchdog, re-login reminder) that a periodic check
could otherwise re-raise every tick. Strategy signals never use this -- `signals`' own unique
constraint (`strategy_version_id`, `symbol`, `bar_time`) dedupes those at the database level.
"""

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.db.models import Alert


def should_alert(session: Session, dedupe_key: str, *, cooldown: timedelta, now: datetime) -> bool:
    """False iff an `alerts` row with this `dedupe_key` was created within `cooldown` of `now`.
    Used only for system alerts (gateway/job-overdue/re-login-reminder), which a periodic check
    could otherwise re-raise every tick; strategy signals are deduped by `signals`' own unique
    constraint instead, never by this function.

    "Within `cooldown`" is exclusive of the boundary: a row created exactly `cooldown` ago has
    fully served its cooldown and no longer blocks a new alert.
    """
    cutoff = now - cooldown
    recent = session.execute(
        select(Alert.id).where(Alert.dedupe_key == dedupe_key, Alert.created_at > cutoff).limit(1)
    ).scalar_one_or_none()
    return recent is None
