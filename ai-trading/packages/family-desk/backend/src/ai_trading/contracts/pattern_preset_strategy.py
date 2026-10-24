"""Pattern preset (spec 02k section 4). Mirror of contracts/src/pattern-preset-strategy.ts.

Same field names (the JSON keys, camelCase), same ranges, same PATTERN_RULES table. Hand-written:
each Zod superRefine check is one model validator here, with the same rule name in snake_case
(directionAllowed -> direction_allowed, and so on).
"""

from dataclasses import dataclass
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from ai_trading.contracts.common import ConfigModel, Description, Name, SchemaVersion, Slug, Timeframe

PatternKind = Literal[
    "hammer",
    "inverted_hammer",
    "bullish_engulfing",
    "bearish_engulfing",
    "doji",
    "morning_star",
    "evening_star",
    "three_white_soldiers",
    "three_black_crows",
    "breakout",
    "bullish_reversal",
    "bearish_reversal",
]
PatternDirection = Literal["bullish", "bearish", "neutral"]


@dataclass(frozen=True)
class PatternRule:
    category: Literal["candlestick", "technical"]
    bars: int | None  # candles in the pattern; informational only, None for technical kinds
    lookback_required: bool
    directions: tuple[PatternDirection, ...]
    tolerance: tuple[str, ...]


# The same table as PATTERN_RULES in pattern-preset-strategy.ts, in the same order.
# Fields: category, bars, lookback_required, directions, tolerance.
PATTERN_RULES: dict[PatternKind, PatternRule] = {
    "hammer": PatternRule("candlestick", 1, False, ("bullish",), ("shadowMinRatio", "bodyMaxPct")),
    "inverted_hammer": PatternRule("candlestick", 1, False, ("bullish",), ("shadowMinRatio", "bodyMaxPct")),
    "bullish_engulfing": PatternRule("candlestick", 2, False, ("bullish",), ("engulfMinRatio",)),
    "bearish_engulfing": PatternRule("candlestick", 2, False, ("bearish",), ("engulfMinRatio",)),
    "doji": PatternRule("candlestick", 1, False, ("neutral",), ("bodyMaxPct",)),
    "morning_star": PatternRule("candlestick", 3, False, ("bullish",), ("starBodyMaxPct",)),
    "evening_star": PatternRule("candlestick", 3, False, ("bearish",), ("starBodyMaxPct",)),
    "three_white_soldiers": PatternRule("candlestick", 3, False, ("bullish",), ("bodyMinPct",)),
    "three_black_crows": PatternRule("candlestick", 3, False, ("bearish",), ("bodyMinPct",)),
    "breakout": PatternRule("technical", None, True, ("bullish", "bearish"), ("bufferPct",)),
    "bullish_reversal": PatternRule("technical", None, True, ("bullish",), ("retracePct",)),
    "bearish_reversal": PatternRule("technical", None, True, ("bearish",), ("retracePct",)),
}


class PatternTolerance(ConfigModel):
    """Every key is optional here; PatternSpec's tolerance_keys_match_kind requires exactly the kind's keys."""

    bodyMaxPct: Annotated[float, Field(gt=0, le=100)] | None = None
    bodyMinPct: Annotated[float, Field(gt=0, le=100)] | None = None
    starBodyMaxPct: Annotated[float, Field(gt=0, le=100)] | None = None
    shadowMinRatio: Annotated[float, Field(gt=0, le=20)] | None = None
    engulfMinRatio: Annotated[float, Field(ge=1, le=5)] | None = None
    bufferPct: Annotated[float, Field(ge=0, le=10)] | None = None
    retracePct: Annotated[float, Field(gt=0, le=100)] | None = None


class PatternConfirmationNone(ConfigModel):
    type: Literal["none"]


class PatternConfirmationNextBarClose(ConfigModel):
    type: Literal["next_bar_close"]
    bars: Annotated[int, Field(ge=1, le=3)]


class PatternConfirmationVolume(ConfigModel):
    type: Literal["volume"]
    minRatio: Annotated[float, Field(ge=1, le=20)]
    lookback: Annotated[int, Field(ge=2, le=60)]


PatternConfirmation = Annotated[
    PatternConfirmationNone | PatternConfirmationNextBarClose | PatternConfirmationVolume,
    Field(discriminator="type"),
]


class PriorTrend(ConfigModel):
    direction: Literal["up", "down", "any"]
    bars: Annotated[int, Field(ge=1, le=50)]


class PatternSpec(ConfigModel):
    pattern: PatternKind
    direction: PatternDirection
    timeframe: Timeframe
    lookback: Annotated[int, Field(ge=2, le=260)] | None = None
    priorTrend: PriorTrend | None = None
    confirmation: PatternConfirmation
    tolerance: PatternTolerance

    @model_validator(mode="after")
    def direction_allowed(self) -> Self:
        allowed = PATTERN_RULES[self.pattern].directions
        if self.direction not in allowed:
            raise ValueError(f"{self.pattern} allows direction {' or '.join(allowed)}, not {self.direction}")
        return self

    @model_validator(mode="after")
    def lookback_matches_kind(self) -> Self:
        required = PATTERN_RULES[self.pattern].lookback_required
        if required != (self.lookback is not None):
            raise ValueError(f"{self.pattern} {'requires' if required else 'takes no'} lookback")
        return self

    @model_validator(mode="after")
    def tolerance_keys_match_kind(self) -> Self:
        wanted = set(PATTERN_RULES[self.pattern].tolerance)
        present = {key for key in PatternTolerance.model_fields if getattr(self.tolerance, key) is not None}
        if wanted != present:
            raise ValueError(
                f"{self.pattern} tolerance must be {sorted(wanted)}; "
                f"missing {sorted(wanted - present)}, extra {sorted(present - wanted)}"
            )
        return self

    @model_validator(mode="after")
    def prior_trend_matches_direction(self) -> Self:
        # Candlestick kinds only: doji is neutral and unconstrained.
        if self.priorTrend is None or PATTERN_RULES[self.pattern].category != "candlestick":
            return self
        if self.direction == "bullish" and self.priorTrend.direction == "up":
            raise ValueError("a bullish pattern needs a down or any prior trend")
        if self.direction == "bearish" and self.priorTrend.direction == "down":
            raise ValueError("a bearish pattern needs an up or any prior trend")
        return self


class PatternPreset(ConfigModel):
    schemaVersion: SchemaVersion
    kind: Literal["pattern"]
    id: Slug
    name: Name
    description: Description | None = None
    spec: PatternSpec
