"""`weekly`: evaluates `weekly` strategies once, on the first trading day of each ISO week, 07:00
ET (Lane L3). The brief's table (PROTO-BRIEF §4 L3) overrides 02a §5's fixed "Monday 07:00 ET" to
handle a Monday holiday (e.g. MLK Day) correctly -- the week's evaluation runs on its first
trading day instead of being silently skipped that week."""

from datetime import date, datetime, time

import pandas as pd
from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import tick
from ai_trading.core.calendar import ET, Asset, session
from ai_trading.jobs import JobResult
from ai_trading.jobs.clock import JobClock

NAME = "weekly"
_SCHEDULED_ET = time(7, 0)


def _first_of_week(asset: Asset, day: date) -> bool:
    """True when no earlier trading day falls in the same ISO week -- the inverse of
    `ai_trading.core.evaluate._last_of_week`."""
    for offset in range(1, day.weekday() + 1):
        earlier = pd.Timestamp(day) - pd.Timedelta(days=offset)
        if session(asset, earlier.date()) is not None:
            return False
    return True


def due_now(now: datetime) -> bool:
    """True from 07:00 ET onward on the first XNYS stock trading day of the ISO week (open
    window, same catch-up reasoning as `premarket.due_now`)."""
    et_now = now.astimezone(ET)
    today = et_now.date()
    if session("stock", today) is None or not _first_of_week("stock", today):
        return False
    return et_now.time() >= _SCHEDULED_ET


def run(session_: Session, clock: JobClock, *, now: datetime) -> JobResult:
    tick(session_, now=now, live_cadences=frozenset({NAME}))
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run", "_first_of_week")
