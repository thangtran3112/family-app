"""Shared primitives for the persona-split strategy configs (filter, pattern, custom, alert, draft).

Mirror of contracts/src/strategy-common.ts: same field names, same limits, same patterns.
Hand-written, not generated: the cross-field validity rules live in Zod `superRefine` and
JSON Schema cannot carry them, so the models implement each rule next to the field it guards.
"""

from typing import Annotated, Literal

from pydantic import ConfigDict, Field

from ai_trading.contracts.base import SpecModel


class ConfigModel(SpecModel):
    """SpecModel (strict, no nulls or booleans) plus Zod's strictObject: unknown keys are errors."""

    model_config = ConfigDict(extra="forbid")


SchemaVersion = Literal[1]
# [a-z0-9], not \w: Zod and Python must agree on ASCII.
Slug = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")]
Name = Annotated[str, Field(min_length=1, max_length=80)]
Description = Annotated[str, Field(min_length=1, max_length=500)]
HhMm = Annotated[str, Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")]
Ticker = Annotated[str, Field(pattern=r"^\/?[A-Z][A-Z0-9.]{0,9}$")]
UtcTimestamp = Annotated[
    str,
    Field(pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$"),
]

Timeframe = Literal["1m", "5m", "15m", "1h", "1d", "1w"]
TIMEFRAMES: tuple[str, ...] = ("1m", "5m", "15m", "1h", "1d", "1w")  # shortest to longest
Severity = Literal["info", "opportunity", "risk"]


def timeframe_at_least(a: str, b: str) -> bool:
    """True when `a` is the same bar length as `b` or a longer one."""
    return TIMEFRAMES.index(a) >= TIMEFRAMES.index(b)


class WatchlistUniverse(ConfigModel):
    watchlist: Annotated[str, Field(min_length=1, max_length=80)]


class SymbolsUniverse(ConfigModel):
    symbols: Annotated[list[Ticker], Field(min_length=1, max_length=70)]


Universe = WatchlistUniverse | SymbolsUniverse
