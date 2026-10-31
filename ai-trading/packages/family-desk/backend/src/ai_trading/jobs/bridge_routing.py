"""`bridge_routing`: keep the bridge's cached routing equal to the Desk's stored preference (02t §3.5).

The bridge holds its routing in memory and falls back to its env default after a restart, so the Desk
reconciles every scheduler tick (60 s): if the bridge's `GetStatus.routing` is not `source=DESK` at the
Desk's own version, the stored preference is sent again with `SetRouting` (idempotent). That gap is what
the Settings card calls "Routing syncing…".

Nothing to say and nothing sent: before the toggle's first use the Desk has no version (0), and the bridge
keeps its env default.
"""

import json
import logging
from datetime import datetime

from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from sqlalchemy.orm import Session

from ai_trading.data import routing
from ai_trading.jobs import JobResult

NAME = "bridge_routing"

logger = logging.getLogger(__name__)


def due_now(now: datetime) -> bool:
    """Every scheduler tick: the reconciler must be cheap and always on, not slotted."""
    return True


def run(session_: Session, data_sources: DataSources, *, now: datetime) -> JobResult:
    bridge = data_sources.bridge
    if bridge is None:
        return JobResult(NAME, ok=True, ran=False)
    stored = routing.read(session_)
    if stored.unused:
        return JobResult(NAME, ok=True, ran=False)

    try:
        current = bridge.routing()
        if current.source == "desk" and current.version == stored.version:
            return JobResult(NAME, ok=True, ran=False)
        bridge.set_routing(stored.preferences, stored.version)
    except ProviderError as exc:
        # A rejected preference (the ladder changed under it) stays stored: the card shows the reason and
        # the owner can pick again. Never a crash, never a retried storm -- the next tick tries once more.
        logger.warning(json.dumps({"job": NAME, "at": now.isoformat(), "error": str(exc)}))
        return JobResult(NAME, ok=False, error=str(exc))

    logger.info(
        json.dumps(
            {
                "job": NAME,
                "at": now.isoformat(),
                "synced": True,
                "version": stored.version,
                "bridge_source": current.source,
                "bridge_version": current.version,
            },
            sort_keys=True,
        )
    )
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")