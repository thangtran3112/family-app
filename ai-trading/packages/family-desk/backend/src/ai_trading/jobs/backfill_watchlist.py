"""Backfill on watchlist join (Lane L3): called synchronously from the API's watchlist-item-
create endpoint (L4), not on a cadence."""

from dataclasses import dataclass, field
from datetime import datetime

from ai_trading_common.registry import DataSources
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, Asset
from ai_trading.data.backfill import ALPACA_FREE_HISTORY_START
from ai_trading.data.backfill import BackfillResult as TimeframeResult
from ai_trading.data.backfill import backfill as backfill_timeframe

#: Stocks only (D-c): a future has no data source at all until 2b's IBKR client ships.
_STOCK_TIMEFRAMES = ("1d", "1h")


@dataclass(frozen=True)
class BackfillResult:
    """What one `backfill_on_join` call covered: one `ai_trading.data.backfill.BackfillResult`
    per timeframe it touched. Empty for a future symbol -- it backfills nothing and the API still
    creates the `watchlist_items` row (02c §4 L3/L4)."""

    symbol: str
    by_timeframe: dict[str, TimeframeResult] = field(default_factory=dict)


def backfill_on_join(
    session: Session, data_sources: DataSources, *, symbol: str, asset: Asset, now: datetime
) -> BackfillResult:
    """Backfills `bars_1d` (and `bars_1h` for a stock) from `ALPACA_FREE_HISTORY_START` to today."""
    if asset != "stock":
        return BackfillResult(symbol)
    today = now.astimezone(ET).date()
    by_timeframe = {
        timeframe: backfill_timeframe(
            session, symbol, timeframe, asset, ALPACA_FREE_HISTORY_START, today, bars_source=data_sources.bars, now=now
        )
        for timeframe in _STOCK_TIMEFRAMES
    }
    return BackfillResult(symbol, by_timeframe)


__all__ = ("BackfillResult", "backfill_on_join")
