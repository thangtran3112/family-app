"""`/api/desk/charts*` (02m §a3.3): chart markers. The stub (`DESK_MVP_STUB=1`) answers from the snapshot; the
real service (`core/patterns.py` on stored closed bars) is a later step, so the flag-off path is 503."""

from datetime import datetime

from fastapi import APIRouter, Depends, Query

from ai_trading.api.auth import get_current_user
from ai_trading.api.bars import Interval
from ai_trading.api.market_data import validate_symbol
from ai_trading.api.schemas.market import MarkersOut
from ai_trading.mvp_stub import market as stub_market
from ai_trading.mvp_stub import stub_enabled, unavailable

router = APIRouter(prefix="/api/desk/charts", tags=["charts"], dependencies=[Depends(get_current_user)])


@router.get("/{symbol:path}/markers", response_model=MarkersOut)
def markers(
    symbol: str,
    timeframe: Interval = "15m",
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = None,
    all_patterns: bool = False,
) -> MarkersOut:
    """Pattern markers on closed bars plus the fires of her strategies, filtered to `from`..`to`
    (on the bar start for patterns, the bar time for fires). By default only the patterns her attached
    strategies use; `all_patterns=true` returns every pattern in the fixture. Stub: SPY, NVDA, MSFT patterns
    (the default set is `hammer`); fires are the signal feed's rows for the symbol."""
    if not stub_enabled():
        unavailable()
    validate_symbol(symbol)
    return stub_market.markers(symbol, timeframe, all_patterns, from_, to)
