"""`bridge_shadow`: the direct chain against the bridge, every 5 minutes in regular hours (02t §7 B2).

One JSON log line per symbol per run -- the shadow's only output, and what the B2 exit gate is read
from (02t §8.2):

    {"job": "bridge_shadow", "at": "...", "symbol": "AAPL",
     "direct": {"provider": "alpaca", "quality": "delayed-15m", "price": 190.0, "as_of": "..."},
     "bridge": {"provider": "alpaca", "quality": "delayed-15m", "price": 190.0, "as_of": "..."},
     "gap_bps": 0.0, "quality_match": true, "direct_ms": 41, "bridge_ms": 12}

plus one summary line per run (`"summary": true`), so a day's worth of lines reduces with a single
`jq` query. The direct side is `data_sources.quotes` -- the chain the Desk actually serves from; the
bridge side pins Alpaca (`pin_provider`), because that is the same feed as the direct path at B2, so
the gate's two conditions are exact: a 0-bps gap and identical quality labels. A pin that fails
(provider not on the bridge) is logged as an error line and never silently compared.

Nothing here is user-visible: the Desk still serves Alpaca everywhere (02t §2.3).
"""

import json
import logging
import time
from datetime import datetime
from datetime import time as wall
from typing import Any

from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET
from ai_trading.core.calendar import session as market_session
from ai_trading.data import refresher
from ai_trading.jobs import JobResult

NAME = "bridge_shadow"

#: The bridge's `GetQuotes` takes 1..100 symbols; a longer watchlist is shadowed in the same order the
#: refresher uses, capped here rather than split into several calls.
SYMBOL_LIMIT = 100

#: B2 compares the same Alpaca feed on both sides (02t §7 B2), so the pinned provider is fixed.
PIN_PROVIDER = "alpaca"

_WINDOW_START = wall(9, 30)
_WINDOW_END = wall(16, 0)

logger = logging.getLogger(__name__)


def due_now(now: datetime) -> bool:
    """Every 5 minutes, 09:30-16:00 ET, on an XNYS trading day: the regular session only, since a
    delayed quote outside it would compare two different snapshots."""
    et_now = now.astimezone(ET)
    if market_session("stock", et_now.date()) is None:
        return False
    if not (_WINDOW_START <= et_now.time() <= _WINDOW_END):
        return False
    return et_now.minute % 5 == 0


def _timed(call) -> tuple[Any, int]:
    """`(result, elapsed ms)` -- the latency half of each log line."""
    started = time.monotonic()
    result = call()
    return result, int(round((time.monotonic() - started) * 1000))


def _gap_bps(direct: float, bridged: float) -> float:
    if direct == 0:
        return 0.0
    return round((bridged - direct) / direct * 10_000, 2)


def _price(quote) -> dict[str, Any]:
    return {
        "provider": quote.provider,
        "quality": quote.quality,
        "price": quote.price,
        "as_of": quote.as_of.isoformat(),
    }


def run(session_: Session, data_sources: DataSources, *, now: datetime) -> JobResult:
    """Shadow one run. `ran=False` when the bridge is not configured or the watchlist is empty; a
    failure on either side is logged (as a JSON error line) and returned as `ok=False`, never raised."""
    bridge = data_sources.bridge
    if bridge is None:
        logger.info(json.dumps({"job": NAME, "at": now.isoformat(), "ran": False, "reason": "bridge_not_configured"}))
        return JobResult(NAME, ok=True, ran=False)

    symbols = refresher.watchlist_symbols(session_)[:SYMBOL_LIMIT]
    if not symbols:
        logger.info(json.dumps({"job": NAME, "at": now.isoformat(), "ran": False, "reason": "empty_watchlist"}))
        return JobResult(NAME, ok=True, ran=False)

    try:
        direct_quotes, direct_ms = _timed(lambda: data_sources.quotes.latest(symbols, now=now))
        bridge_quotes, bridge_ms = _timed(lambda: bridge.pinned_quotes(symbols, now=now, provider=PIN_PROVIDER))
    except ProviderError as exc:
        # The exception text never carries a token (the bridge seam's own messages name the class only).
        logger.warning(json.dumps({"job": NAME, "at": now.isoformat(), "ran": True, "error": str(exc)}))
        return JobResult(NAME, ok=False, error=str(exc))

    by_symbol = {quote.symbol: quote for quote in direct_quotes}
    bridged_by_symbol = {quote.symbol: quote for quote in bridge_quotes}
    lines = 0
    worst_gap = 0.0
    mismatches = 0
    for symbol in symbols:
        one, other = by_symbol.get(symbol), bridged_by_symbol.get(symbol)
        if one is None or other is None:
            logger.info(
                json.dumps(
                    {
                        "job": NAME,
                        "at": now.isoformat(),
                        "symbol": symbol,
                        "missing": "direct" if one is None else "bridge",
                    },
                    sort_keys=True,
                )
            )
            lines += 1
            continue
        gap = _gap_bps(one.price, other.price)
        matched = one.quality == other.quality
        worst_gap = max(worst_gap, abs(gap))
        mismatches += 0 if matched else 1
        logger.info(
            json.dumps(
                {
                    "job": NAME,
                    "at": now.isoformat(),
                    "symbol": symbol,
                    "direct": _price(one),
                    "bridge": _price(other),
                    "gap_bps": gap,
                    "quality_match": matched,
                    "direct_ms": direct_ms,
                    "bridge_ms": bridge_ms,
                },
                sort_keys=True,
            )
        )
        lines += 1

    logger.info(
        json.dumps(
            {
                "job": NAME,
                "at": now.isoformat(),
                "summary": True,
                "symbols": lines,
                "max_gap_bps": round(worst_gap, 2),
                "quality_mismatches": mismatches,
                "direct_ms": direct_ms,
                "bridge_ms": bridge_ms,
            },
            sort_keys=True,
        )
    )
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "PIN_PROVIDER", "SYMBOL_LIMIT", "due_now", "run")