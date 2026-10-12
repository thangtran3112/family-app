"""`ai_trading.jobs`: the scheduler and its named jobs (02c Phase 3, Lane L3).

`JobResult` lives here rather than in a dedicated module, since the brief's own file list
(PROTO-BRIEF §4 L3) names no shared-helper file for it: it is the return type every job's own
`run()` (and `scheduler.run_due`) uses.

`watchdog.py`/`relogin_reminder.py` use `ai_trading.notify.dedupe.should_alert` directly
(integration fix: Lane L3's own prototype could not import Lane L1's `ai_trading.notify`, since it
did not exist in L3's sandbox copy, so L3 shipped a lane-local `_should_alert` stand-in with the
same contract; that stub is removed now that the real module is present).
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class JobResult:
    """What one job's `run()` call did. `ran=False` marks a call that found nothing to do (a
    job already run today, or -- `scheduler.run_due`'s wrapping of `watchdog.run` -- no job was
    overdue); it is still `ok=True`. `ok=False` only for a raised exception."""

    name: str
    ok: bool
    ran: bool = True
    error: str | None = None


__all__ = ("JobResult",)
