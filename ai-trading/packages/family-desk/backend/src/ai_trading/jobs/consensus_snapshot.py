"""`consensus_snapshot`: the daily consensus-EPS, earnings-result, and analyst-target snapshot (02n §d, 02f §4),
from 16:30 ET on every trading day. It starts early on purpose: the 7/30/90-day estimate revisions are read from
the Desk's own history, which only exists once this job has run for that many days.

The work is `research.consensus.snapshot_pass`; this module is the scheduler hook. The pass skips a feed that
already finished today (persisted in `feed_health`, so a restart or the UTC-midnight clock roll costs nothing)
and retries only a feed that fetched nothing, on the scheduler's next tick."""

from datetime import datetime, time

from ai_trading_common.registry import DataSources
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, session
from ai_trading.jobs import JobResult
from ai_trading.jobs.clock import JobClock
from ai_trading.research import consensus

NAME = "consensus_snapshot"
_SCHEDULED_ET = time(16, 30)


def due_now(now: datetime) -> bool:
    """True from 16:30 ET onward on any XNYS trading day (the slot `daily_close` runs at: bars are final)."""
    et_now = now.astimezone(ET)
    return session("stock", et_now.date()) is not None and et_now.time() >= _SCHEDULED_ET


def run(session_: Session, data_sources: DataSources, clock: JobClock, *, now: datetime) -> JobResult:
    """Snapshot every feed not yet done today. `ran=False` when all three were. A feed that fetched nothing fails the
    job without marking the clock, so the next tick retries it (the others are already done)."""
    reports = consensus.snapshot_pass(session_, data_sources, now=now)
    down = [feed for feed, report in reports.items() if report.state == "down"]
    if down:
        return JobResult(NAME, ok=False, error=f"{', '.join(down)}: no provider answered")
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True, ran=bool(reports))


__all__ = ("NAME", "due_now", "run")
