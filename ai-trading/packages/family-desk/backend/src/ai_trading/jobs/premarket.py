"""`premarket_0830`: the engine's single evaluation point per trading day, 08:30 ET (Lane L3).

No prep of its own: `premarket_0830` strategies evaluate whatever bars are already stored (02a
§5's gap-and-go template reads prior-day/overnight levels and premarket bars, not anything this
job needs to fetch itself).
"""

from datetime import datetime, time

from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import tick
from ai_trading.core.calendar import ET, session
from ai_trading.jobs import JobResult
from ai_trading.jobs.clock import JobClock

NAME = "premarket_0830"
_SCHEDULED_ET = time(8, 30)


def due_now(now: datetime) -> bool:
    """True from 08:30 ET onward on an XNYS stock trading day.

    An open window, not a single exact minute: a scheduler that wakes up late still sees today's
    slot as due, and re-running for the rest of the day is a safe no-op -- `evaluate()` reports
    the same `premarket_0830` evaluation point every time, and `signals`' own unique constraint
    (`strategy_version_id`, `symbol`, `bar_time`) makes a repeat `record_signal` a no-op, not a
    second alert (02c Review Focus 1/2).
    """
    et_now = now.astimezone(ET)
    if session("stock", et_now.date()) is None:
        return False
    return et_now.time() >= _SCHEDULED_ET


def run(session_: Session, clock: JobClock, *, now: datetime) -> JobResult:
    tick(session_, now=now, live_cadences=frozenset({NAME}))
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")
