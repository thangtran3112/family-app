"""`/api/desk/watchlists*` (PROTO-BRIEF.md §4 L4)."""

from datetime import UTC, datetime
from typing import Literal

from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.db.models import Watchlist, WatchlistItem
from ai_trading.jobs.backfill_watchlist import backfill_on_join

router = APIRouter(prefix="/api/desk/watchlists", tags=["watchlists"])


class WatchlistCreate(BaseModel):
    name: str
    horizon: Literal["intraday", "swing", "long_term"]


class WatchlistOut(BaseModel):
    id: int
    name: str
    horizon: str


class WatchlistItemCreate(BaseModel):
    symbol: str
    asset_type: Literal["stock", "future"]


class WatchlistItemOut(BaseModel):
    watchlist_id: int
    symbol: str
    asset_type: str


def _owned_watchlist(session: Session, watchlist_id: int, user: AuthedUser) -> Watchlist:
    row = session.get(Watchlist, watchlist_id)
    if row is None or row.user_id != user.id:
        # Never confirm existence to a non-owner (PROTO-BRIEF.md §4 L4): same 404 either way.
        raise HTTPException(status_code=404, detail="watchlist not found")
    return row


@router.get("", response_model=list[WatchlistOut])
def list_watchlists(
    user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> list[WatchlistOut]:
    rows = session.execute(select(Watchlist).where(Watchlist.user_id == user.id).order_by(Watchlist.id)).scalars()
    return [WatchlistOut(id=row.id, name=row.name, horizon=row.horizon) for row in rows]


@router.post("", status_code=201, response_model=WatchlistOut)
def create_watchlist(
    body: WatchlistCreate, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> WatchlistOut:
    row = Watchlist(user_id=user.id, name=body.name, horizon=body.horizon)
    session.add(row)
    session.flush()
    session.commit()
    return WatchlistOut(id=row.id, name=row.name, horizon=row.horizon)


@router.post("/{watchlist_id}/items", status_code=201, response_model=WatchlistItemOut)
def add_watchlist_item(
    watchlist_id: int,
    body: WatchlistItemCreate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    data_sources: DataSources = Depends(get_data_sources),
) -> WatchlistItemOut:
    _owned_watchlist(session, watchlist_id, user)
    item = WatchlistItem(watchlist_id=watchlist_id, symbol=body.symbol, asset_type=body.asset_type)
    session.add(item)
    session.flush()
    # Blocks the request (acceptable at Phase 3's data volumes, per the brief); a future symbol's
    # stub/real backfill writes nothing, but the watchlist_items row is still created either way.
    backfill_on_join(session, data_sources, symbol=body.symbol, asset=body.asset_type, now=datetime.now(UTC))
    session.commit()
    return WatchlistItemOut(watchlist_id=watchlist_id, symbol=item.symbol, asset_type=item.asset_type)


@router.delete("/{watchlist_id}/items/{symbol}", status_code=204)
def remove_watchlist_item(
    watchlist_id: int,
    symbol: str,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> None:
    _owned_watchlist(session, watchlist_id, user)
    item = session.get(WatchlistItem, (watchlist_id, symbol))
    if item is not None:
        session.delete(item)
    session.commit()
