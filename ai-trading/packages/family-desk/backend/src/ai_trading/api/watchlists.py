"""`/api/desk/watchlists*` (PROTO-BRIEF.md §4 L4)."""

import unicodedata
from datetime import UTC, datetime
from typing import Literal

from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.api.market_data import validate_symbol
from ai_trading.db.models import Bar1d, User, Watchlist, WatchlistItem
from ai_trading.jobs.backfill_watchlist import backfill_on_join

router = APIRouter(prefix="/api/desk/watchlists", tags=["watchlists"])


class WatchlistCreate(BaseModel):
    name: str = Field(strict=True, min_length=1, max_length=80)
    horizon: Literal["intraday", "swing", "long_term"]

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = " ".join(unicodedata.normalize("NFKC", value).split())
        if not normalized or len(normalized) > 80:
            raise ValueError("name must contain 1–80 characters")
        return normalized


class WatchlistOut(BaseModel):
    id: int
    name: str
    horizon: str


class WatchlistItemCreate(BaseModel):
    symbol: str = Field(strict=True, min_length=1, max_length=32)
    asset_type: Literal["stock", "future"]


class WatchlistItemOut(BaseModel):
    watchlist_id: int
    symbol: str
    asset_type: str


class WatchlistItemReadOut(BaseModel):
    symbol: str
    asset_type: str
    backfill: Literal["ready", "pending"]


def _owned_watchlist(session: Session, watchlist_id: int, user: AuthedUser, *, lock: bool = False) -> Watchlist:
    query = select(Watchlist).where(Watchlist.id == watchlist_id)
    if lock:
        query = query.with_for_update()
    row = session.execute(query).scalar_one_or_none()
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


@router.get("/{watchlist_id}/items", response_model=list[WatchlistItemReadOut])
def list_watchlist_items(
    watchlist_id: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[WatchlistItemReadOut]:
    _owned_watchlist(session, watchlist_id, user)
    items = (
        session.execute(
            select(WatchlistItem).where(WatchlistItem.watchlist_id == watchlist_id).order_by(WatchlistItem.symbol)
        )
        .scalars()
        .all()
    )
    symbols = [item.symbol for item in items]
    available = (
        set(session.execute(select(Bar1d.symbol).where(Bar1d.symbol.in_(symbols)).distinct()).scalars())
        if symbols
        else set()
    )
    return [
        WatchlistItemReadOut(
            symbol=item.symbol,
            asset_type=item.asset_type,
            backfill="ready" if item.symbol in available else "pending",
        )
        for item in items
    ]


@router.post("", status_code=201, response_model=WatchlistOut)
def create_watchlist(
    body: WatchlistCreate, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> WatchlistOut:
    # Serialize owner-local name checks without a schema migration; another owner can reuse a name.
    owner = session.execute(select(User).where(User.id == user.id).with_for_update()).scalar_one_or_none()
    if owner is None:
        raise HTTPException(status_code=404, detail="user not found")
    existing_names = session.execute(select(Watchlist.name).where(Watchlist.user_id == user.id)).scalars()
    if any(name.casefold() == body.name.casefold() for name in existing_names):
        raise HTTPException(status_code=409, detail="watchlist name already exists")
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
    _owned_watchlist(session, watchlist_id, user, lock=True)
    symbol = body.symbol.strip().upper()
    if body.asset_type == "future":
        if not symbol.startswith("/"):
            symbol = f"/{symbol}"
    elif symbol.startswith("/"):
        raise HTTPException(status_code=422, detail="symbol prefix does not match asset_type")
    symbol = validate_symbol(symbol)
    key = (watchlist_id, symbol)
    if session.get(WatchlistItem, key) is not None:
        raise HTTPException(status_code=409, detail="symbol already exists in watchlist")
    item = WatchlistItem(watchlist_id=watchlist_id, symbol=symbol, asset_type=body.asset_type)
    session.add(item)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        if session.get(WatchlistItem, key) is not None:
            raise HTTPException(status_code=409, detail="symbol already exists in watchlist") from exc
        raise
    # Blocks the request (acceptable at Phase 3's data volumes, per the brief); a future symbol's
    # stub/real backfill writes nothing, but the watchlist_items row is still created either way.
    backfill_on_join(session, data_sources, symbol=symbol, asset=body.asset_type, now=datetime.now(UTC))
    session.commit()
    return WatchlistItemOut(watchlist_id=watchlist_id, symbol=item.symbol, asset_type=item.asset_type)


@router.delete("/{watchlist_id}/items/{symbol:path}", status_code=204)
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
