"""The dead-man check (02 §11): alerts once when a scheduled job has not completed within
`OVERDUE_AFTER` of its usual slot. No "gateway down" half in Phase 3 -- there is no gateway; that
half of 02 §11's dead-man check starts in 2b, where `engine.degraded.quality_for`'s inputs
change."""

from datetime import datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, session
from ai_trading.db.models import Alert, User
from ai_trading.jobs.clock import JobClock
from ai_trading.jobs.weekly import _first_of_week
from ai_trading.notify.dedupe import should_alert

#: Each job's usual slot (ET), matching 02/02a's schedule table. `daily_close`'s own `due_now` is
#: this same fixed 16:30 ET slot (integration fix: a FIXED time on every trading day, half days
#: included -- see `daily_close.py`'s docstring) -- not a separate value that happens to agree.
JOB_SCHEDULE = {"premarket_0830": time(8, 30), "daily_close": time(16, 30), "weekly": time(7, 0)}
OVERDUE_AFTER = timedelta(minutes=20)  # 02 §11 dead-man check


def due_now(now: datetime) -> bool:
    """True on every tick on an XNYS stock trading day -- cheap (DB-only) and re-run-safe;
    `should_alert`'s cooldown is what prevents repeat alerts, not this function."""
    return session("stock", now.astimezone(ET).date()) is not None


def run(session_: Session, clock: JobClock, *, now: datetime) -> list[str]:
    """For each `JOB_SCHEDULE` entry due today whose slot time + `OVERDUE_AFTER` has passed and
    `clock.succeeded_today(name, now)` is False: raises a system alert, gated by `should_alert`.
    Returns the job names alerted this call."""
    today = now.astimezone(ET).date()
    if session("stock", today) is None:
        return []

    alerted: list[str] = []
    for name, slot in JOB_SCHEDULE.items():
        if name == "weekly" and not _first_of_week("stock", today):
            continue  # weekly's own slot only exists on the week's first trading day
        deadline = datetime.combine(today, slot, tzinfo=ET) + OVERDUE_AFTER
        if now < deadline or clock.succeeded_today(name, now):
            continue
        dedupe_key = f"job-overdue:{name}:{today}"
        if not should_alert(session_, dedupe_key=dedupe_key, cooldown=timedelta(hours=1), now=now):
            continue
        for user in session_.execute(select(User)).scalars():
            session_.add(
                Alert(
                    user_id=user.id,
                    kind="system",
                    severity="system",
                    dedupe_key=dedupe_key,
                    title=f"{name} is overdue",
                    body=f"{name} has not completed today ({today}); its usual slot is {slot.isoformat()} ET.",
                    created_at=now,
                )
            )
        alerted.append(name)
    return alerted


__all__ = ("JOB_SCHEDULE", "OVERDUE_AFTER", "due_now", "run")
