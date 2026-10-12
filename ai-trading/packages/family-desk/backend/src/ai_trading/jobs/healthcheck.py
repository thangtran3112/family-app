"""`python -m ai_trading.jobs.healthcheck`: the `scheduler` compose service's Docker healthcheck
(F4c). `scheduler` has no HTTP endpoint for Docker to poll (unlike `api`'s `/healthz`), so instead
its own main loop touches a heartbeat file once per iteration (`scheduler.main`), and this process
exits 0 only while that file is still fresh -- a stuck or crashed loop stops touching it and this
starts failing within one `FRESH_SECONDS` window.
"""

import os
import sys
import time
from pathlib import Path

HEARTBEAT_PATH_VAR = "DESK_SCHEDULER_HEARTBEAT"
DEFAULT_HEARTBEAT_PATH = "/tmp/desk-scheduler.heartbeat"
FRESH_SECONDS = 180.0


def heartbeat_path() -> Path:
    return Path(os.environ.get(HEARTBEAT_PATH_VAR, DEFAULT_HEARTBEAT_PATH))


def touch(path: Path) -> None:
    """Creates (or updates the mtime of) `path`, creating its parent directory if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()


def is_healthy(path: Path, *, now: float | None = None) -> bool:
    """True iff `path` exists and was touched less than `FRESH_SECONDS` ago."""
    try:
        age = (time.time() if now is None else now) - path.stat().st_mtime
    except FileNotFoundError:
        return False
    return age < FRESH_SECONDS


def main() -> int:
    return 0 if is_healthy(heartbeat_path()) else 1


if __name__ == "__main__":
    sys.exit(main())


__all__ = (
    "DEFAULT_HEARTBEAT_PATH",
    "FRESH_SECONDS",
    "HEARTBEAT_PATH_VAR",
    "heartbeat_path",
    "is_healthy",
    "main",
    "touch",
)
