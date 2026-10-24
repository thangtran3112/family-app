"""SSE quotes from the persisted closed-bar store; provider refresh belongs to the scheduler."""

import asyncio
import json
import math
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from sse_starlette.sse import EventSourceResponse

from ai_trading.api.auth import AuthedUser, get_current_user_for_stream
from ai_trading.api.stamp import feed_last_ok
from ai_trading.core.freshness import freshness, market_session
from ai_trading.db.engine import session_scope
from ai_trading.db.models import Bar1m
from ai_trading.engine.degraded import quality_for
from ai_trading.mvp_stub import market as stub_market
from ai_trading.mvp_stub import stub_enabled

router = APIRouter(prefix="/api/desk/quotes", tags=["quotes"])

POLL_INTERVAL_SECONDS = 60.0
_SYMBOL = re.compile(r"/?[A-Za-z0-9][A-Za-z0-9.-]{0,14}\Z")
_BAR_INTERVAL = timedelta(minutes=1)


def _latest_quote(symbol: str, session_factory: sessionmaker[Session]) -> dict[str, float | str] | None:
    """Return a supported Alpaca stock bar; never call a provider from an SSE connection.

    `freshness` comes from `core/freshness.py` with the `bars_delayed` feed's last success (null before the
    first refresh, so `unavailable`). Stub (`DESK_MVP_STUB=1`): the SPY, NVDA, MSFT fixture quote."""
    if stub_enabled() and stub_market.has_symbol(symbol):
        return stub_market.latest_quote(symbol)
    as_of = datetime.now(UTC)
    closed_through = as_of - _BAR_INTERVAL
    with session_scope(session_factory) as session:
        bar = session.execute(
            select(Bar1m)
            .where(Bar1m.symbol == symbol, Bar1m.bar_start <= closed_through)
            .order_by(Bar1m.bar_start.desc())
            .limit(1)
        ).scalar_one_or_none()
        if bar is None or not math.isfinite(bar.close):
            return None
        if symbol.startswith("/") or bar.source != "alpaca":
            return None
        quality = quality_for("stock", "bar_close_1m")
        session_now = market_session(as_of)
        return {
            "symbol": symbol,
            "close": float(bar.close),
            "quality": quality,
            "as_of": bar.bar_start.isoformat(),
            "freshness": freshness(quality, session_now, feed_last_ok(session, "bars_delayed"), as_of, _BAR_INTERVAL),
            "source": bar.source,
            "session": session_now,
        }


async def quote_events(
    symbol: str,
    session_factory: sessionmaker[Session],
    is_disconnected: Callable[[], Awaitable[bool]],
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> AsyncIterator[dict[str, str]]:
    """Send the initial stored quote and later changes, stopping on disconnect.

    Each poll gets and closes its own DB session in a worker thread. EventSourceResponse supplies
    its normal SSE ping heartbeat between the bounded 60-second store polls.
    """
    last_quote: dict[str, float | str] | None = None
    while not await is_disconnected():
        quote = await asyncio.to_thread(_latest_quote, symbol, session_factory)
        if quote is not None and quote != last_quote:
            last_quote = quote
            yield {"event": "quote", "data": json.dumps(quote)}
        await sleep(POLL_INTERVAL_SECONDS)


@router.get("/{symbol:path}")
async def stream_quotes(
    symbol: str,
    request: Request,
    user: AuthedUser = Depends(get_current_user_for_stream),
) -> EventSourceResponse:
    """Server-sent events, one connection per symbol. Each `quote` event's data is JSON:
    `{"symbol", "close", "quality", "as_of", "freshness", "source", "session"}`.
    `as_of` is the closed 1m bar's start (`+00:00`, `Z` in the stub).
    `freshness` is live|delayed|closed|paused|unavailable; `source` is the bar's provider;
    `session` is pre|regular|after|closed (the market session now).
    An event is sent only when the quote changes; the stream stays open until the client disconnects.
    Stub: one event for SPY, NVDA or MSFT from the last 15m fixture bar, then the stream stays open."""
    if not _SYMBOL.fullmatch(symbol):
        raise HTTPException(status_code=422, detail="invalid symbol")
    return EventSourceResponse(quote_events(symbol, request.app.state.session_factory, request.is_disconnected))
