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
from ai_trading.db.engine import session_scope
from ai_trading.db.models import Bar1m
from ai_trading.engine.degraded import quality_for

router = APIRouter(prefix="/api/desk/quotes", tags=["quotes"])

POLL_INTERVAL_SECONDS = 60.0
_SYMBOL = re.compile(r"/?[A-Za-z0-9][A-Za-z0-9.-]{0,14}\Z")


def _latest_quote(symbol: str, session_factory: sessionmaker[Session]) -> dict[str, float | str] | None:
    """Return a supported Alpaca stock bar; never call a provider from an SSE connection."""
    as_of = datetime.now(UTC)
    closed_through = as_of - timedelta(minutes=1)
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
        return {
            "symbol": symbol,
            "close": float(bar.close),
            "quality": quality_for("stock", "bar_close_1m"),
            "as_of": bar.bar_start.isoformat(),
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
    if not _SYMBOL.fullmatch(symbol):
        raise HTTPException(status_code=422, detail="invalid symbol")
    return EventSourceResponse(
        quote_events(symbol, request.app.state.session_factory, request.is_disconnected)
    )
