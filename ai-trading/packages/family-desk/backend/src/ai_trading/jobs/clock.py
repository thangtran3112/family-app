"""In-process, per-`scheduler`-run bookkeeping of each job's last successful run (Lane L3)."""

from dataclasses import dataclass, field
from datetime import date, datetime


@dataclass
class JobClock:
    """In-process, per-`scheduler`-run state: the last UTC date each job name last SUCCEEDED on.

    Not persisted (ponytail: a `scheduler` restart forgets today's completions until that job's
    next due slot re-runs it -- acceptable because every job here is itself idempotent/catch-up-
    safe per 02c's own "halting on failure" wording; upgrade to a `job_runs` table if the
    watchdog's false-positive rate after a restart ever matters).
    """

    last_success: dict[str, date] = field(default_factory=dict)

    def mark(self, job: str, day: date) -> None:
        self.last_success[job] = day

    def succeeded_today(self, job: str, now: datetime) -> bool:
        return self.last_success.get(job) == now.date()


__all__ = ("JobClock",)
