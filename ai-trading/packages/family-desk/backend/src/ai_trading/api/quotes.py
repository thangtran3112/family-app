"""SSE quotes (PROTO-BRIEF.md §4 L4): at most ~4 updates per second per connection (02a §7).

`quote_events` is the testable core: a plain async generator taking an injectable `sleep` so a
test can prove the send cadence never exceeds `MIN_INTERVAL_SECONDS` without a real 0.25s wait,
and an injectable `is_disconnected` so a test can prove the stream stops on disconnect without a
real socket. `stream_quotes` is the thin FastAPI/sse-starlette wiring around it.
"""

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable

import pandas as pd
from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources

router = APIRouter(prefix="/api/desk/quotes", tags=["quotes"])

#: 02a §7: "SSE fan-out to browsers (at most about 4 updates per second)".
MIN_INTERVAL_SECONDS = 0.25


async def _latest_quote(symbol: str, data_sources: DataSources) -> dict[str, float | str] | None:
    """One best-effort quote read; `None` when the provider has nothing right now (a `ProviderError`
    -- unconfigured, unavailable, or genuinely no data -- is never surfaced to the stream as an
    error, since a quiet tick is routine, not a failure)."""
    now = pd.Timestamp.now(tz="UTC")
    try:
        bars = data_sources.bars.bars(symbol, "1m", now - pd.Timedelta(minutes=5), now, now=now)
    except ProviderError:
        return None
    if bars.frame.empty:
        return None
    last = bars.frame.iloc[-1]
    return {"symbol": symbol, "close": float(last["close"]), "quality": bars.quality, "as_of": now.isoformat()}


async def quote_events(
    symbol: str,
    data_sources: DataSources,
    is_disconnected: Callable[[], Awaitable[bool]],
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> AsyncIterator[dict[str, str]]:
    """Yields one SSE event per tick, stopping once `is_disconnected()` is True. The
    `MIN_INTERVAL_SECONDS` sleep is unconditional -- not "whatever's left after the read" -- so the
    cap is mechanically enforced even when the read is effectively instant (a fake `DataSources` in
    tests; in Phase 3 the real value only actually changes every 15 minutes anyway, Alpaca's delay)."""
    while not await is_disconnected():
        quote = await _latest_quote(symbol, data_sources)
        if quote is not None:
            yield {"event": "quote", "data": json.dumps(quote)}
        await sleep(MIN_INTERVAL_SECONDS)


@router.get("/{symbol}")
async def stream_quotes(
    symbol: str,
    request: Request,
    user: AuthedUser = Depends(get_current_user),
    data_sources: DataSources = Depends(get_data_sources),
) -> EventSourceResponse:
    return EventSourceResponse(quote_events(symbol, data_sources, request.is_disconnected))
