"""`/api/desk/symbols*` (02m §a3.1): the `⌘K` search over the stored universe and the caller's watchlists."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.api.schemas.platform import SymbolSearchOut
from ai_trading.db.models import UniverseSymbol, Watchlist, WatchlistItem
from ai_trading.mvp_stub import stub_enabled, world

router = APIRouter(prefix="/api/desk/symbols", tags=["symbols"], dependencies=[Depends(get_current_user)])


@router.get("/search", response_model=list[SymbolSearchOut])
def search_symbols(
    q: str = Query(min_length=1),
    limit: int = Query(default=8, ge=1, le=20),
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[SymbolSearchOut]:
    term = q.strip()
    if not term:
        return []
    watched = set(
        session.execute(
            select(WatchlistItem.symbol)
            .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
            .where(Watchlist.user_id == user.id)
        ).scalars()
    )
    universe = session.execute(
        select(UniverseSymbol).where(
            UniverseSymbol.active.is_(True),
            or_(
                UniverseSymbol.symbol.startswith(term.upper(), autoescape=True),
                UniverseSymbol.name.icontains(term, autoescape=True),
                UniverseSymbol.symbol.in_(watched),
            ),
        )
    ).scalars()
    # symbol -> (name, asset_type). A watchlist symbol with no active universe row takes the stub's name
    # (when the stub is on) or the symbol itself, and its asset type from the stub or "stock".
    found = {row.symbol: (row.name, row.asset_type) for row in universe}
    for symbol in watched - set(found):
        if stub_enabled():
            found[symbol] = (world.SYMBOL_NAMES.get(symbol, symbol), world.asset_type(symbol))
        else:
            found[symbol] = (symbol, "stock")
    ranked = []
    for symbol, (name, asset_type) in found.items():
        if symbol.startswith("/"):  # futures roots are never searchable
            continue
        if symbol.startswith(term.upper()):
            rank = 0
        elif term.casefold() in name.casefold():
            rank = 1
        else:
            continue
        ranked.append((rank, symbol, name, asset_type))
    ranked.sort()
    return [
        SymbolSearchOut(symbol=symbol, name=name, asset_type=asset_type, in_watchlist=symbol in watched)
        for _, symbol, name, asset_type in ranked[:limit]
    ]
