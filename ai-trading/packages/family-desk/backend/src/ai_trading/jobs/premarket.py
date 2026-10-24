"""`premarket_0830`: the engine's single evaluation point per trading day, 08:30 ET (Lane L3).

With a `DataSources` that has the universe kind it first runs the screener's premarket pass (the universe, daily
bars and metrics, the liquidity floor, premarket minutes, then the `premarket_0830` filters, 02m §b3). Without
one, `premarket_0830` strategies evaluate whatever bars are already stored (02a §5's gap-and-go template reads
prior-day/overnight levels and premarket bars). If that pass fetched nothing (the provider is down) the job fails
without ticking or marking the clock, so the scheduler retries on its next tick and the day's one evaluation point
is not spent on stale data.
"""

from datetime import datetime, time

from ai_trading_common.registry import DataSources
from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import tick
from ai_trading.core.calendar import ET, session
from ai_trading.data import refresher
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


def run(session_: Session, clock: JobClock, *, now: datetime, data_sources: DataSources | None = None) -> JobResult:
    if data_sources is not None and refresher.scan_enabled(data_sources):
        report = refresher.premarket_pass(session_, data_sources, now=now)
        if report.state == "down":  # the provider answered nothing: stay unmarked so the next tick retries
            return JobResult(NAME, ok=False, error="market data unavailable")
    tick(session_, now=now, live_cadences=frozenset({NAME}))
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")
