"""Data-quality labelling for a strategy's cadence (PROTO-BRIEF.md section 4 L2; 02a section 5).

Phase 3 has no IBKR (D-c): there is no live gateway, so no `bar_close_*` cadence can ever reach
"realtime". A stock runs against Alpaca's delayed bars; a future has no data source at all. The
daily/weekly cadences run on end-of-day bars and are never degraded by the lack of a streaming
slot -- 2b changes only this module's body, not its callers.
"""

from typing import Literal

from ai_trading.core.calendar import Asset

DataQuality = Literal["realtime", "delayed-15m", "eod", "fallback", "unavailable"]

#: `premarket_0830`/`daily_close`/`weekly` read daily/hourly bars, never a live streaming slot.
_EOD_CADENCES = frozenset({"premarket_0830", "daily_close", "weekly"})


def quality_for(asset: Asset, run_on: str) -> DataQuality:
    """Phase 3 has no IBKR (D-c): a `bar_close_*` cadence on `stock` is "delayed-15m"; on `future`
    is "unavailable". `premarket_0830`/`daily_close`/`weekly` are "eod" regardless of asset (daily
    bars are never degraded by lack of a streaming slot). 2b changes only this function's body."""
    if run_on in _EOD_CADENCES:
        return "eod"
    return "unavailable" if asset == "future" else "delayed-15m"


def is_degraded(quality: DataQuality) -> bool:
    """True for every quality except "realtime" and "eod" -- 02a section 5: "bar_close_1m ... has
    no live streaming slot is marked degraded"."""
    return quality not in ("realtime", "eod")
