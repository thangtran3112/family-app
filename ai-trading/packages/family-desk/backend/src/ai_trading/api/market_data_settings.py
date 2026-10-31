"""`GET/PUT /api/desk/settings/market-data`: the Market-data card and the owner's provider choice (02t §6).

**Shadow mode (B2).** `SHADOW` is True: the card says so, and a choice is stored and synced to the bridge
without changing what the Desk serves -- the direct Alpaca path is still the only one in a chain (02t §2.3).
The flip at B3 is `DESK data providers` plus this constant.

**Who may change it.** Only the owner: the Clerk allow-list identity, read from `DESK_OWNER_EMAILS`
(comma-separated, the 02s precedent), never a new auth system. Everyone else gets the same card read-only
and a 403 on PUT. The route never trusts a header other than the gateway's verified email
(`api/auth.py`).

**Validation (02t §3.5).** A choice is checked against what the bridge actually offers -- its `ListProviders`
and its own ladder for the class -- before it is stored, and a rejected one answers 422 with a reason in
words (the card shows it inline under the row). A provider that is configured but down is accepted: the
bridge falls through, uses it again on recovery, and the response carries the exact warning §6 words.

**Storage order.** The Desk's row is written first, inside the request's transaction, so a bridge that
rejects the choice rolls the row back with the 422 (no drifting intent); the bridge's copy is written second
and a restart is re-synced by `jobs/bridge_routing.py`.
"""

import os
from datetime import UTC, datetime
from typing import Any, Literal

from ai_trading_common.errors import ProviderError
from ai_trading_common.quality import Quality
from ai_trading_common.registry import DataSources
from ai_trading_common.types import ProviderHealth, Routing
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ai_trading.api import status as status_api
from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.data import routing as routing_store

router = APIRouter(prefix="/api/desk/settings/market-data", tags=["settings"])

#: B2 (02t §7): everything here is a preview of what the bridge would serve. Flip at B3, with the
#: `DATA_PROVIDERS_QUOTES=bridge,alpaca` value.
SHADOW = True

#: The four providers the card offers, in the order §6 lists them. A provider the bridge does not know at
#: all is still rendered, as an option that cannot be picked, with its own reason.
OPTION_PROVIDERS = ("ibkr", "longbridge", "alpaca", "marketdata_app")

PROVIDER_LABELS = {
    "ibkr": "IBKR",
    "longbridge": "Longbridge",
    "alpaca": "Alpaca",
    "marketdata_app": "marketdata.app",
}
CLASS_LABELS = {
    "equity_quotes": "stock quotes",
    "equity_bars": "bars",
    "option_chain": "option chains",
}

DataClass = Literal["equity_quotes", "equity_bars", "option_chain"]


class ProviderOptionOut(BaseModel):
    """One provider's standing in one class. `state` is the bridge's own health state; `detail` is its
    reason code (never rendered raw -- the card maps both to words, 02t §6)."""

    provider: str
    configured: bool
    state: str
    quality: Quality | None
    in_ladder: bool
    detail: str | None


class MarketDataClassOut(BaseModel):
    data_class: DataClass
    preferred: str  # "" = no preference: the ladder's first rung answers
    serving: str  # who would answer the class right now, per the bridge
    ladder: list[str]  # the bridge's allowlist for this class, in order
    options: list[ProviderOptionOut]


class MarketDataCardOut(BaseModel):
    shadow: bool
    owner: bool
    available: bool  # the bridge answered; False renders the card's honest "not reachable" state
    reason: str | None  # "bridge_not_configured" | "bridge_unreachable" | "routing_syncing"
    routing_source: str  # "env_default" (the bridge has not been told yet) | "desk" | "unspecified"
    version: int
    desk_serving: str  # what the Desk itself serves from today (shadow mode: still the direct provider)
    desk_quality: Quality | None
    classes: list[MarketDataClassOut]


class MarketDataChoiceBody(BaseModel):
    data_class: DataClass
    provider: str  # "" clears the preference and returns the class to the bridge's own ladder


class MarketDataChoiceOut(BaseModel):
    routing_source: str
    version: int
    classes: list[MarketDataClassOut]
    warning: str | None  # §6's saved-with-warning words, or None


def owner_emails(env: dict[str, str] | os._Environ[str] | None = None) -> frozenset[str]:
    raw = (env if env is not None else os.environ).get("DESK_OWNER_EMAILS", "")
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())


def is_owner(email: str, env: dict[str, str] | os._Environ[str] | None = None) -> bool:
    return email.strip().lower() in owner_emails(env)


def _label(provider: str) -> str:
    return PROVIDER_LABELS.get(provider, provider)


def _options(
    data_class: str, ladder: list[str], health: dict[str, ProviderHealth]
) -> list[ProviderOptionOut]:
    out: list[ProviderOptionOut] = []
    for provider in OPTION_PROVIDERS:
        row = health.get(provider)
        out.append(
            ProviderOptionOut(
                provider=provider,
                configured=bool(row.configured) if row else False,
                state=row.state if row else "unspecified",
                quality=row.quality if row else None,
                in_ladder=provider in ladder,
                detail=row.reason if row else None,
            )
        )
    return out


def _classes(
    routing: Routing | None, stored: dict[str, str], health: dict[str, ProviderHealth]
) -> list[MarketDataClassOut]:
    out: list[MarketDataClassOut] = []
    for data_class in routing_store.DATA_CLASSES:
        row = routing.for_class(data_class) if routing is not None else None
        ladder = list(row.ladder) if row else []
        out.append(
            MarketDataClassOut(
                data_class=data_class,  # type: ignore[arg-type]
                preferred=stored.get(data_class, ""),
                serving=row.serving if row else "",
                ladder=ladder,
                options=_options(data_class, ladder, health),
            )
        )
    return out


def _desk_serving(session: Session, data_sources: DataSources, now: datetime) -> tuple[str, Quality | None]:
    """What the Desk itself is serving quotes from right now (02t §5.5, §6's shadow copy names it). In shadow
    mode that is the direct provider -- `bridge` is in no chain. The `/status` stamp is the same source, so the
    card can never name a vendor the desk is not showing; `DataSources.serving` covers a Desk whose feed has no
    row yet (a weekend deploy)."""
    stamp, quality = status_api.quotes_stamp(session, data_sources, now=now)
    serving = dict(getattr(data_sources, "serving", {}) or {})
    return stamp.source or serving.get("quotes") or "unknown", quality


def _bridge_or_503(data_sources: DataSources) -> Any:
    bridge = data_sources.bridge
    if bridge is None:
        raise HTTPException(status_code=503, detail="The bridge is not configured yet, so there is nothing to switch.")
    return bridge


@router.get("", response_model=MarketDataCardOut)
def get_market_data(
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    data_sources: DataSources = Depends(get_data_sources),
) -> MarketDataCardOut:
    now = datetime.now(UTC)
    stored = routing_store.read(session) if routing_store.tables_exist(session) else routing_store.StoredRouting({}, 0)
    desk_serving, desk_quality = _desk_serving(session, data_sources, now)
    bridge = data_sources.bridge
    if bridge is None:
        return MarketDataCardOut(
            shadow=SHADOW,
            owner=is_owner(user.email),
            available=False,
            reason="bridge_not_configured",
            routing_source="unspecified",
            version=stored.version,
            desk_serving=desk_serving,
            desk_quality=desk_quality,
            classes=_classes(None, stored.preferences, {}),
        )
    try:
        current = bridge.routing()
        health = {row.provider: row for row in bridge.providers()}
    except ProviderError:
        return MarketDataCardOut(
            shadow=SHADOW,
            owner=is_owner(user.email),
            available=False,
            reason="bridge_unreachable",
            routing_source="unspecified",
            version=stored.version,
            desk_serving=desk_serving,
            desk_quality=desk_quality,
            classes=_classes(None, stored.preferences, {}),
        )
    syncing = not stored.unused and (current.source != "desk" or current.version != stored.version)
    return MarketDataCardOut(
        shadow=SHADOW,
        owner=is_owner(user.email),
        available=True,
        reason="routing_syncing" if syncing else None,
        routing_source=current.source,
        version=stored.version,
        desk_serving=desk_serving,
        desk_quality=desk_quality,
        classes=_classes(current, stored.preferences, health),
    )


def _reject(reason: str) -> HTTPException:
    """A 422 with the reason in words, shown inline under the row (02t §3.5)."""
    return HTTPException(status_code=422, detail=reason)


@router.put("", response_model=MarketDataChoiceOut)
def put_market_data(
    body: MarketDataChoiceBody,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    data_sources: DataSources = Depends(get_data_sources),
) -> MarketDataChoiceOut:
    if not is_owner(user.email):
        raise HTTPException(status_code=403, detail="Only the owner changes data providers")
    bridge = _bridge_or_503(data_sources)
    provider = body.provider.strip().lower()
    class_label = CLASS_LABELS[body.data_class]

    try:
        current = bridge.routing()
        health = {row.provider: row for row in bridge.providers()}
    except ProviderError:
        raise HTTPException(
            status_code=503, detail="The bridge is not reachable right now, so nothing was saved."
        ) from None

    row = current.for_class(body.data_class)
    if row is None:
        raise _reject(f"The bridge does not serve {class_label} yet, so there is nothing to choose.")
    if provider:
        if provider not in PROVIDER_LABELS:
            raise _reject(f"{body.provider!r} is not a provider the Desk offers.")
        if provider not in row.ladder:
            raise _reject(
                f"{_label(provider)} is not in the {class_label} ladder on the bridge "
                f"({', '.join(row.ladder)})."
            )
        if provider not in health or body.data_class not in health[provider].classes:
            raise _reject(f"The bridge has no {_label(provider)} adapter for {class_label}.")
        if not health[provider].configured:
            raise _reject(f"{_label(provider)} has no key on the bridge yet, so it cannot serve {class_label}.")

    now = datetime.now(UTC)
    stored = routing_store.record(
        session, data_class=body.data_class, provider=provider, updated_by=user.email, now=now
    )
    try:
        applied = bridge.set_routing(stored.preferences, stored.version)
    except ProviderError as exc:
        # The row rolls back with this request's transaction, so the Desk's intent never drifts from the
        # bridge's copy. The bridge's own message is safe (it names providers, never tokens).
        raise _reject(f"The bridge did not accept that choice: {exc}") from None

    resolved = applied.for_class(body.data_class)
    serving = resolved.serving if resolved else ""
    warning = None
    if provider and serving and serving != provider:
        # §6's saved-with-warning words, e.g. "Saved. IBKR is off right now, so Alpaca serves until it's back."
        warning = f"Saved. {_label(provider)} is off right now, so {_label(serving)} serves until it's back."
    return MarketDataChoiceOut(
        routing_source=applied.source,
        version=applied.version,
        classes=_classes(applied, stored.preferences, health),
        warning=warning,
    )