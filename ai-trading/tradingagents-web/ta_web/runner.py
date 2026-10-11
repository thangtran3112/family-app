"""Process supervision for research runs: one ``ta_web.worker`` child per run.

The HTTP process never runs research in-process; it only starts, tracks, and
stops these children (protocol.md). The service lock (``fcntl.flock``) that
keeps a second process sharing the volume from interrupting this one's runs
is owned by the API lifespan, not here.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from .domain import NotFoundError
from .store import Store
from .worker import RESEARCH_FAILED

# ponytail: one process, one Runner instance tracking its own children — no
# cross-process child registry. Fine while "one active research subprocess"
# (global-constraints.md) holds; a multi-worker deploy would need a shared
# registry instead.
_SHUTDOWN_GRACE_SECONDS = 5
_POLL_INTERVAL_SECONDS = 0.02


class Runner:
    """Starts/tracks/stops ``ta_web.worker`` child processes for one root."""

    def __init__(self, root: Path):
        self._root = Path(root)
        self._store = Store(self._root)
        self._lock = threading.Lock()
        self._children: dict[str, subprocess.Popen] = {}
        self._closing = False
        self._grace_seconds = _SHUTDOWN_GRACE_SECONDS

    def _argv(self, id: str) -> list[str]:
        return [sys.executable, "-m", "ta_web.worker", "--root", str(self._root), "--run-id", id]

    def start(self, id: str) -> None:
        """Launch the worker subprocess for ``id``. Never raises: a launch
        failure — including one that raced an in-progress ``close()`` — is
        recorded on the run instead of propagating or leaving it stuck
        running.

        Checking ``_closing``, spawning, and registering the child all
        happen under one lock acquisition (shared with ``close()``'s own
        closing-flag-plus-snapshot) so the two can never interleave: either
        this call finishes registering the child before ``close()`` can
        take its snapshot — in which case ``close()`` is guaranteed to see
        and terminate it — or ``close()`` has already flipped ``_closing``
        before this call gets the lock, in which case the child is never
        spawned at all. There is no window where a child exists but is
        untracked by both.
        """
        with self._lock:
            if self._closing:
                self._mark_failed_if_running(id, "LAUNCH_FAILED")
                return
            try:
                proc = subprocess.Popen(
                    self._argv(id),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError:
                self._mark_failed_if_running(id, "LAUNCH_FAILED")
                return
            self._children[id] = proc
        threading.Thread(target=self._reap, args=(id, proc), daemon=True).start()

    def close(self) -> None:
        """Shut down every tracked child: terminate its process group, wait
        up to the grace period, kill if still alive, then record each as
        Interrupted — never Failed, which would misclassify an intentional
        shutdown.

        Setting ``_closing`` and snapshotting ``_children`` happen under the
        same lock ``start()`` uses for its own closing-check-and-register,
        so no child started concurrently can be missed (see ``start()``).
        """
        with self._lock:
            self._closing = True
            children = list(self._children.items())

        for _id, proc in children:
            self._signal_group(proc, signal.SIGTERM)
        deadline = time.monotonic() + self._grace_seconds
        for id_, proc in children:
            self._wait_reaped(id_, deadline)
            if self._is_tracked(id_):
                self._signal_group(proc, signal.SIGKILL)
                self._wait_reaped(id_, time.monotonic() + self._grace_seconds)

        for id_, _proc in children:
            try:
                run = self._store.worker_run(id_)
            except NotFoundError:
                continue
            if run["status"] == "running":
                self._store.update(id_, status="interrupted")

    # --- internals -----------------------------------------------------------

    def _mark_failed_if_running(self, id: str, error_code: str = RESEARCH_FAILED) -> None:
        try:
            run = self._store.worker_run(id)
        except NotFoundError:
            return
        if run["status"] == "running":
            self._store.update(id, status="failed", error_code=error_code)

    def _reap(self, id: str, proc: subprocess.Popen) -> None:
        proc.wait()
        with self._lock:
            self._children.pop(id, None)
        if self._closing:
            # close() itself records Interrupted for every child it shut down.
            return
        # An unexpected exit (crash, external kill) while the record still
        # says running must not leave it Busy forever.
        self._mark_failed_if_running(id)

    def _is_tracked(self, id: str) -> bool:
        with self._lock:
            return id in self._children

    def _wait_reaped(self, id: str, deadline: float) -> None:
        while time.monotonic() < deadline and self._is_tracked(id):
            time.sleep(_POLL_INTERVAL_SECONDS)

    @staticmethod
    def _signal_group(proc: subprocess.Popen, sig: int) -> None:
        try:
            os.killpg(os.getpgid(proc.pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            pass
