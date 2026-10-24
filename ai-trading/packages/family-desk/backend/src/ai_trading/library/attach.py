"""Attach a library preset to a watchlist as an alert-only strategy (02m §b1 `library/attach.py`).

The strategy is a copy of the template with its source set to the watchlist, `paperOrder` removed, and only the
alert-side limit kept (`catalog.alert_only_spec`). It is idempotent per (preset, watchlist): a repeat returns the
strategy the first attach wrote. It starts `draft`; only with `DESK_ALERTS_RUNTIME_ENABLED=1` does it start
`alert_only` (02m §b5 item 6).
"""

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ai_trading.alerts import service
from ai_trading.contracts.strategy_spec_v1 import Entry
from ai_trading.db.models import Watchlist
from ai_trading.library.catalog import alert_only_spec
from ai_trading.runtime_flags import alerts_runtime_enabled


def attach(
    session: Session,
    user_id: int,
    entry: Entry,
    template: dict[str, Any],
    watchlist: Watchlist,
    *,
    channels: list[str],
    severity: str,
    now: datetime,
) -> tuple[service.StrategyView, bool]:
    """`(strategy, created)`. Raises pydantic's `ValidationError` when the result is not a valid
    `AlertStrategySpecV1` (the caller turns it into the 422 `problems`). Caller commits."""
    spec = alert_only_spec(template, watchlist=watchlist.name, channels=channels, severity=severity)
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    existing = service.find_library_strategy(session, user_id, dumped["name"], watchlist.name)
    if existing is not None:
        return existing, False
    view = service.create_strategy(
        session,
        user_id,
        dumped,
        save_as="on" if alerts_runtime_enabled() else "draft",
        origin="library",
        note=f"attached from the library ({entry.id})",
        now=now,
    )
    return view, True
