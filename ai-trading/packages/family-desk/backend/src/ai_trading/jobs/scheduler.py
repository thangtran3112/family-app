"""The process entrypoint for the `scheduler` compose service (02c Phase 3)."""

import logging
import os
import sys
import time as _time
from collections.abc import Callable
from datetime import UTC, datetime

from ai_trading_common.registry import DataSources
from sqlalchemy import text
from sqlalchemy.orm import Session

from ai_trading.data import refresher
from ai_trading.jobs import (
    JobResult,
    consensus_snapshot,
    daily_close,
    healthcheck,
    premarket,
    refresh_15m,
    relogin_reminder,
    watchdog,
    weekly,
)
from ai_trading.jobs.clock import JobClock

logger = logging.getLogger(__name__)

#: `watchdog` last, so it sees this tick's own completions.
_ORDER = (
    "premarket_0830",
    "daily_close",
    "consensus_snapshot",
    "weekly",
    "relogin_reminder",
    "refresh_15m",
    "watchdog",
)

#: These jobs each fire once per day (or once per week) but their own `due_now()` is an open
#: window (true for the rest of the day/week once their slot starts), not a single exact minute --
#: without this gate, a successful run reran every minute for the rest of its window (F1/F2 review
#: fix). `JobClock.succeeded_today` is what stops that: each of these jobs' own `run()` marks the
#: clock only on success, so a failed run is still retried on the next tick. `refresh_15m` is
#: meant to re-run every 15 minutes (not slotted this way) and `watchdog`'s own dedupe cooldown
#: already gates its alerts, so neither belongs here.
_SLOTTED = ("premarket_0830", "daily_close", "consensus_snapshot", "weekly", "relogin_reminder")

_DUE_NOW = {
    "premarket_0830": premarket.due_now,
    "daily_close": daily_close.due_now,
    "consensus_snapshot": consensus_snapshot.due_now,
    "weekly": weekly.due_now,
    "relogin_reminder": relogin_reminder.due_now,
    "refresh_15m": refresh_15m.due_now,
    "watchdog": watchdog.due_now,
}

#: F4a: bounded startup retry against the shared Postgres cluster, which may still be cold when
#: `scheduler` starts (same reasoning as `api`'s `/healthz`, but `scheduler` has no HTTP endpoint
#: for Docker to poll, so the retry lives in-process instead).
_STARTUP_RETRY_ATTEMPTS = 30
_STARTUP_RETRY_DELAY_SECONDS = 2.0


def due_now(now: datetime) -> list[str]:
    """Every job name whose own `due_now(now)` is True right now, in `_ORDER`."""
    return [name for name in _ORDER if _DUE_NOW[name](now)]


def run_due(session: Session, data_sources: DataSources, clock: JobClock, *, now: datetime) -> list[JobResult]:
    """Runs every due job in order (`_ORDER`). A `_SLOTTED` job that already succeeded today is
    skipped without being called again -- see `_SLOTTED`'s own comment (F1/F2). A job raising
    halts only that job (02c: "halting on failure") -- caught here, logged as a
    `JobResult(ok=False, error=...)`, and does not stop the remaining due jobs or crash the
    process."""
    due = set(due_now(now))
    results: list[JobResult] = []
    for name in _ORDER:
        if name not in due:
            continue
        if name in _SLOTTED and clock.succeeded_today(name, now):
            results.append(JobResult(name, ok=True, ran=False))
            continue
        try:
            if name == "premarket_0830":
                results.append(premarket.run(session, clock, now=now, data_sources=data_sources))
            elif name == "daily_close":
                results.append(daily_close.run(session, data_sources, clock, now=now))
            elif name == "consensus_snapshot":
                results.append(consensus_snapshot.run(session, data_sources, clock, now=now))
            elif name == "weekly":
                results.append(weekly.run(session, clock, now=now))
            elif name == "relogin_reminder":
                results.append(relogin_reminder.run(session, clock, now=now))
            elif name == "refresh_15m":
                results.append(refresh_15m.run(session, data_sources, now=now))
            else:  # watchdog
                alerted = watchdog.run(session, clock, now=now)
                results.append(JobResult("watchdog", ok=True, ran=bool(alerted)))
        except Exception as exc:  # noqa: BLE001 -- "halting on failure": one job never stops the rest
            results.append(JobResult(name, ok=False, error=str(exc)))
    return results


def seed_strip(session: Session, data_sources: DataSources, *, now: datetime) -> bool:
    """Gives the dashboard's market strip its first rows without waiting for a slotted job (a weekend deploy has no
    session until Monday). A failure is logged and rolled back to a savepoint; it never stops a tick."""
    try:
        with session.begin_nested():
            return refresher.ensure_market_strip(session, data_sources, now=now)
    except Exception:  # noqa: BLE001 -- see the docstring
        logger.exception("market strip seed failed")
        return False


def _wait_for_database(
    engine,
    *,
    attempts: int = _STARTUP_RETRY_ATTEMPTS,
    delay: float = _STARTUP_RETRY_DELAY_SECONDS,
    sleep: Callable[[float], None] = _time.sleep,
) -> None:
    """F4a: tries `SELECT 1` against `engine` up to `attempts` times, `delay` seconds apart.
    Returns as soon as one attempt succeeds. Exits the process non-zero (`sys.exit(1)`) once
    `attempts` is exhausted -- `restart: unless-stopped` then retries the whole process."""
    for attempt in range(1, attempts + 1):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except Exception:
            logger.warning("database not reachable yet (attempt %d/%d)", attempt, attempts)
            sleep(delay)
    logger.error("database never became reachable after %d attempts; exiting", attempts)
    sys.exit(1)


def _log_result(result: JobResult) -> None:
    """A failed job at warning level so `docker logs` shows it; a skipped (already done today) one at debug."""
    if not result.ok:
        logger.warning("job %s failed (ok=%s ran=%s): %s", result.name, result.ok, result.ran, result.error)
    elif not result.ran:
        logger.debug("job %s skipped (ok=%s ran=%s)", result.name, result.ok, result.ran)
    else:
        logger.debug("job %s ran (ok=%s)", result.name, result.ok)


def main() -> None:  # pragma: no cover -- the real loop; exercised through `run_due`'s own tests
    from ai_trading.db.engine import make_engine, make_session_factory

    engine = make_engine(os.environ["DESK_RUNTIME_DATABASE_URL"])
    _wait_for_database(engine)
    factory = make_session_factory(engine)
    sources = DataSources.from_env()
    clock = JobClock()
    heartbeat = healthcheck.heartbeat_path()
    while True:
        with factory() as session:
            now = datetime.now(UTC)
            seed_strip(session, sources, now=now)
            for result in run_due(session, sources, clock, now=now):
                _log_result(result)
            session.commit()
        healthcheck.touch(heartbeat)  # F4b: proves this loop iteration to ai_trading.jobs.healthcheck
        _time.sleep(60)


if __name__ == "__main__":
    main()


__all__ = ("due_now", "run_due", "seed_strip", "main")
