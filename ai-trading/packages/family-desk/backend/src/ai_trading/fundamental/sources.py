"""Where each Fundamental-lane field comes from, and what it honestly is today (02b §4b, 02n §e).

The 2026-10-29 revision: quotes and option chains come from Alpaca through the registry's `quotes` and `option_chain`
kinds (the free key is 15 minutes delayed until the Algo Trader Plus tier is bought, and both providers stamp
`delayed-15m` whatever the key); holdings come from the IBKR Flex report only (a yearly token, read-only; no gateway,
so the `DESK_IBKR_GATEWAY_ENABLED` switch stays off); a field with no source behind it says so, so a screen shows
"unavailable" and never a stand-in. "Configured" means a key is set, not that Alpaca accepts it: a rejected key still
surfaces on each read as an unavailable stamp.

Pure: it reads the environment it is given (Firestore `ai-trading/desk` rendered by `family_config.py`) and reports
only whether a value is set, never the value."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from ai_trading_common.quality import Quality

FLEX_TOKEN_VAR = "IBKR_FLEX_TOKEN"
FLEX_QUERY_VAR = "IBKR_FLEX_QUERY_ID"
ALPACA_KEY_VARS = ("ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY")

State = Literal["configured", "delayed", "not_configured", "unavailable", "deferred"]


@dataclass(frozen=True)
class SourceState:
    """`source` is None when no provider stands behind the field; `quality` is what its numbers carry today."""

    source: str | None
    state: State
    quality: Quality
    reason: str


def _set(env: Mapping[str, str], *names: str) -> bool:
    return all(env.get(name) for name in names)


def fundamental_sources(env: Mapping[str, str]) -> dict[str, SourceState]:
    """Field -> its source and state: `holdings`, `quotes`, `option_chain` (chain, bid and ask, open interest, delta,
    IV), `futures_prices`, `ex_dividend`."""
    holdings = _set(env, FLEX_TOKEN_VAR, FLEX_QUERY_VAR)
    quotes = _set(env, *ALPACA_KEY_VARS)
    return {
        "holdings": SourceState(
            "ibkr_flex",
            "configured" if holdings else "not_configured",
            "eod" if holdings else "unavailable",
            "IBKR Flex report, read-only, as of the statement's close"
            if holdings
            else f"set {FLEX_TOKEN_VAR} and {FLEX_QUERY_VAR} in the ai-trading/desk profile",
        ),
        "quotes": SourceState(
            "alpaca",
            "delayed" if quotes else "not_configured",
            "delayed-15m" if quotes else "unavailable",
            "Alpaca, 15 minutes delayed until the Algo Trader Plus tier is bought"
            if quotes
            else f"set {' and '.join(ALPACA_KEY_VARS)} in the ai-trading/desk profile",
        ),
        "option_chain": SourceState(
            "alpaca_options" if quotes else None,
            "delayed" if quotes else "not_configured",
            "delayed-15m" if quotes else "unavailable",
            "Alpaca options, 15 minutes delayed (the free `indicative` feed until the Algo Trader Plus tier is bought)"
            if quotes
            else f"set {' and '.join(ALPACA_KEY_VARS)} in the ai-trading/desk profile",
        ),
        "futures_prices": SourceState(
            None,
            "deferred",
            "unavailable",
            "futures deferred: US futures are out of live-data scope (02b §4b); roll and expiry dates still come "
            "from core/futures.py",
        ),
        "ex_dividend": SourceState(
            None,
            "unavailable",
            "unavailable",
            "no registry kind carries ex-dividend dates (02n §g.3); the engine gets None",
        ),
    }
