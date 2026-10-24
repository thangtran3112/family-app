"""`/api/desk/watchlists*` (PROTO-BRIEF.md §4 L4; 02m §a3.5 for rename, order, delete, and table)."""

from datetime import UTC, datetime, timedelta
from typing import Literal

from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.alerts.tags import table_tags
from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.api.market_data import validate_symbol
from ai_trading.api.schemas.watchlists import (
    WatchlistNameBase,
    WatchlistOrder,
    WatchlistRename,
    WatchlistTable,
    WatchlistTableHeader,
    WatchlistTableRow,
)
from ai_trading.api.stamp import feed_last_ok, make_stamp
from ai_trading.db.models import (
    Bar1d,
    Strategy,
    StrategyVersion,
    SymbolMetrics,
    UniverseSymbol,
    User,
    Watchlist,
    WatchlistItem,
)
from ai_trading.jobs.backfill_watchlist import backfill_on_join
from ai_trading.mvp_stub import stamp as stub_stamp
from ai_trading.mvp_stub import stub_enabled, world
from ai_trading.mvp_stub import watchlists as stub_watchlists

router = APIRouter(prefix="/api/desk/watchlists", tags=["watchlists"])

#: The table's metric rows come from the scheduler's 15-minute scan (02m §b3).
TABLE_INTERVAL = timedelta(minutes=15)


class WatchlistCreate(WatchlistNameBase):
    horizon: Literal["intraday", "swing", "long_term"]


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


def _ordered_items(session: Session, watchlist_id: int, *, lock: bool = False) -> list[WatchlistItem]:
    query = (
        select(WatchlistItem)
        .where(WatchlistItem.watchlist_id == watchlist_id)
        .order_by(WatchlistItem.position, WatchlistItem.symbol)
    )
    if lock:
        query = query.with_for_update()
    return list(session.execute(query).scalars().all())


def _items_out(session: Session, items: list[WatchlistItem]) -> list[WatchlistItemReadOut]:
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
    return _items_out(session, _ordered_items(session, watchlist_id))


@router.get("/{watchlist_id}/table", response_model=WatchlistTable)
def watchlist_table(
    watchlist_id: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> WatchlistTable:
    watchlist = _owned_watchlist(session, watchlist_id, user)
    items = _ordered_items(session, watchlist_id)
    symbols = [item.symbol for item in items]
    universe = {
        row.symbol: row
        for row in session.execute(select(UniverseSymbol).where(UniverseSymbol.symbol.in_(symbols))).scalars()
    }
    latest = {
        row.symbol: row
        for row in session.execute(select(SymbolMetrics).where(SymbolMetrics.symbol.in_(symbols))).scalars()
    }
    last_ok_at = feed_last_ok(session, "scan")
    stub = stub_enabled()
    tags = {} if stub else table_tags(session, user.id, watchlist.name, symbols, now=datetime.now(UTC))
    rows: list[WatchlistTableRow] = []
    for item in items:
        known = universe.get(item.symbol)
        name = known.name if known else (world.SYMBOL_NAMES.get(item.symbol, item.symbol) if stub else item.symbol)
        if stub:
            fields = stub_watchlists.table_fields(item.symbol, watchlist.name)
            freshness = "closed"
        else:
            data = latest.get(item.symbol)
            values = data.metrics if data is not None else {}
            fields = {
                **{key: values.get(key) for key in ("last", "change_pct", "rvol_10d", "vs_vwap_pct")},
                # The refresher writes the 15-minute summary label beside the metrics; none yet reads "warming up".
                "bias_label": values.get("bias_15m") or "warming up",
                "tags": tags[item.symbol],
            }
            freshness = (
                "unavailable"
                if data is None
                else make_stamp(
                    quality="delayed-15m",
                    source="alpaca",
                    as_of=data.as_of,
                    interval=TABLE_INTERVAL,
                    last_ok_at=last_ok_at,
                ).freshness
            )
        rows.append(
            WatchlistTableRow(
                symbol=item.symbol,
                name=name,
                asset_type=known.asset_type if known else item.asset_type,
                freshness=freshness,
                **fields,
            )
        )
    if stub:
        head = stub_stamp()
    else:
        newest = max((row.as_of for row in latest.values()), default=None)
        head = make_stamp(
            quality="delayed-15m", source="alpaca", as_of=newest, interval=TABLE_INTERVAL, last_ok_at=last_ok_at
        )
    return WatchlistTable(
        watchlist=WatchlistTableHeader(id=watchlist.id, name=watchlist.name, horizon=watchlist.horizon),
        stamp=head,
        rows=rows,
    )


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


@router.patch("/{watchlist_id}", response_model=WatchlistOut)
def rename_watchlist(
    watchlist_id: int,
    body: WatchlistRename,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> WatchlistOut:
    # Same owner-level lock as create: the name check must not race another create or rename.
    session.execute(select(User.id).where(User.id == user.id).with_for_update())
    row = _owned_watchlist(session, watchlist_id, user)
    others = session.execute(
        select(Watchlist.name).where(Watchlist.user_id == user.id, Watchlist.id != row.id)
    ).scalars()
    if any(name.casefold() == body.name.casefold() for name in others):
        raise HTTPException(status_code=409, detail="watchlist name already exists")
    row.name = body.name
    session.commit()
    return WatchlistOut(id=row.id, name=row.name, horizon=row.horizon)


@router.delete("/{watchlist_id}", status_code=204, response_model=None)
def delete_watchlist(
    watchlist_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> None:
    row = _owned_watchlist(session, watchlist_id, user, lock=True)
    # Strategies name their universe by the list's name (`watch.universe.watchlist`), so a live one blocks the delete.
    referencing = session.execute(
        select(Strategy.id)
        .join(StrategyVersion, StrategyVersion.id == Strategy.current_version_id)
        .where(
            Strategy.owner_user_id == user.id,
            Strategy.archived_at.is_(None),
            StrategyVersion.spec[("watch", "universe", "watchlist")].astext == row.name,
        )
        .limit(1)
    ).first()
    if referencing is not None:
        raise HTTPException(status_code=409, detail=f"Remove the alert strategies that watch {row.name} first")
    session.delete(row)
    session.commit()


@router.put("/{watchlist_id}/order", response_model=list[WatchlistItemReadOut])
def reorder_watchlist_items(
    watchlist_id: int,
    body: WatchlistOrder,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[WatchlistItemReadOut]:
    _owned_watchlist(session, watchlist_id, user, lock=True)
    items = _ordered_items(session, watchlist_id, lock=True)
    by_symbol = {item.symbol: item for item in items}
    # Items are unique per list, so an equal-length list with the same set is a permutation.
    if len(body.symbols) != len(items) or set(body.symbols) != set(by_symbol):
        raise HTTPException(status_code=422, detail="symbols must be the same symbols as the list")
    ordered = [by_symbol[symbol] for symbol in body.symbols]
    for position, item in enumerate(ordered):
        item.position = position
    session.commit()
    return _items_out(session, ordered)


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
    # The list is locked above, so max+1 is free of races: a new item goes to the end of the order.
    last_position = session.execute(
        select(func.max(WatchlistItem.position)).where(WatchlistItem.watchlist_id == watchlist_id)
    ).scalar()
    item = WatchlistItem(
        watchlist_id=watchlist_id,
        symbol=symbol,
        asset_type=body.asset_type,
        position=0 if last_position is None else last_position + 1,
    )
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
