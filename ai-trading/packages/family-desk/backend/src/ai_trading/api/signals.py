"""`GET /api/desk/signals` (PROTO-BRIEF.md §4 L4): paginated, owner-scoped via the strategy's
`owner_user_id` -- a `signals` row has no `user_id` of its own, so ownership is a join, not a
column filter."""

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.alerts.describe import SignalKind, signal_kind
from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.db.models import Signal, Strategy, StrategyVersion
from ai_trading.mvp_stub import market as stub_market
from ai_trading.mvp_stub import stub_enabled

router = APIRouter(prefix="/api/desk/signals", tags=["signals"])

_DEFAULT_LIMIT = 50
_MAX_LIMIT = 200


class SignalOut(BaseModel):
    id: int
    strategy_version_id: int
    symbol: str
    bar_time: datetime
    evidence: dict[str, Any]
    data_quality: str
    created_at: datetime
    strategy_id: int
    strategy_name: str
    kind: SignalKind  # the icon family: orb | vwap_reclaim | pattern | rvol | other


@router.get("", response_model=list[SignalOut])
def list_signals(
    symbol: str | None = None,
    since: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=_MAX_LIMIT)] = _DEFAULT_LIMIT,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[SignalOut]:
    if stub_enabled():
        return stub_market.signal_rows(symbol, since, limit, offset)
    query = (
        select(Signal, Strategy.id, Strategy.name, StrategyVersion.spec)
        .join(StrategyVersion, Signal.strategy_version_id == StrategyVersion.id)
        .join(Strategy, StrategyVersion.strategy_id == Strategy.id)
        .where(Strategy.owner_user_id == user.id)
    )
    if symbol is not None:
        query = query.where(Signal.symbol == symbol)
    if since is not None:
        query = query.where(Signal.created_at >= since)
    query = query.order_by(Signal.created_at.desc(), Signal.id.desc()).limit(limit).offset(offset)
    rows = session.execute(query).all()
    return [
        SignalOut(
            id=row.id,
            strategy_version_id=row.strategy_version_id,
            symbol=row.symbol,
            bar_time=row.bar_time,
            evidence=row.evidence,
            data_quality=row.data_quality,
            created_at=row.created_at,
            strategy_id=strategy_id,
            strategy_name=strategy_name,
            # A version without an alert `when` (another lane's spec shape) is "other", not an error.
            kind=signal_kind(spec) if "when" in spec else "other",
        )
        for row, strategy_id, strategy_name, spec in rows
    ]
