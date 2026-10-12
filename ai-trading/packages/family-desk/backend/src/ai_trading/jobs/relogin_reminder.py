"""Sunday 18:00 ET: a standing reminder to re-login to IBKR's weekly 2FA session (02a §5) -- not
a liveness check, so it fires every week regardless of IBKR connectivity."""

from datetime import datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET
from ai_trading.db.models import Alert, User
from ai_trading.jobs import JobResult
from ai_trading.jobs.clock import JobClock
from ai_trading.notify.dedupe import should_alert

NAME = "relogin_reminder"
_SCHEDULED_ET = time(18, 0)
_SUNDAY = 6


def due_now(now: datetime) -> bool:
    """Every Sunday at 18:00 ET, regardless of IBKR connectivity."""
    et_now = now.astimezone(ET)
    return et_now.weekday() == _SUNDAY and et_now.time() >= _SCHEDULED_ET


def run(session_: Session, clock: JobClock, *, now: datetime) -> JobResult:
    """Writes one `alerts` row per user (kind="system", severity="system" -- F3/review fix:
    `notify.quiet_hours.in_quiet_hours` only bypasses "system"/"risk" severities, and this is a
    standing operator reminder that must still reach the owner inside their quiet hours, not a
    routine "info" notice), gated by `should_alert` so a same-week re-fire is a no-op.

    Marks `clock` on success (whether or not a new alert was actually written -- a dedupe-
    suppressed call is still a successful run of this slot) so `scheduler.run_due` does not call
    this again for the rest of today's open `due_now()` window (F1/F2)."""
    dedupe_key = f"relogin-reminder:{now.date()}"
    if should_alert(session_, dedupe_key=dedupe_key, cooldown=timedelta(days=6), now=now):
        for user in session_.execute(select(User)).scalars():
            session_.add(
                Alert(
                    user_id=user.id,
                    kind="system",
                    severity="system",
                    dedupe_key=dedupe_key,
                    title="Re-login to IBKR",
                    body="IBKR's weekly session needs a fresh 2FA login before the market opens.",
                    created_at=now,
                )
            )
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")
