"""Custom strategy (kind "custom"), spec 02k section 5.

Mirror of contracts/src/custom-strategy.ts: same field names (camelCase JSON keys), same ranges, and the
same eight validity rules under the same ids (CUSTOM_RULES). Each Zod superRefine rule is one model
validator here that raises a PydanticCustomError whose error type is the rule id, so the tests can prove
that each rule's fixture fails on that rule. Hand-written, not generated.
"""

from typing import Annotated, Literal, NamedTuple, Self

from pydantic import Field, model_validator
from pydantic_core import PydanticCustomError

from ai_trading.contracts.common import (
    ConfigModel,
    Description,
    Name,
    SchemaVersion,
    Slug,
    Timeframe,
    Universe,
    timeframe_at_least,
)
from ai_trading.contracts.filter_strategy import FilterGroup, filter_group_stats
from ai_trading.contracts.pattern_preset_strategy import PatternSpec

RULE_1 = "rule-1-no-filters-or-patterns"
RULE_2 = "rule-2-filter-group-size"
RULE_3 = "rule-3-pattern-timeframe"
RULE_4 = "rule-4-duplicate-pattern"
RULE_5 = "rule-5-all-mixed-direction"
RULE_6 = "rule-6-direction-conflict"
RULE_7 = "rule-7-r-multiple-needs-stop"
RULE_8 = "rule-8-empty-risk"


class CustomRule(NamedTuple):
    id: str
    description: str


# Same list, same order, as CUSTOM_RULES in custom-strategy.ts (the tests compare the ids).
CUSTOM_RULES: tuple[CustomRule, ...] = (
    CustomRule(RULE_1, "filters or patterns present"),
    CustomRule(RULE_2, "filter group depth <= 3 and leaves <= 30"),
    CustomRule(RULE_3, "every pattern spec timeframe is the strategy timeframe or longer"),
    CustomRule(RULE_4, "no two pattern entries share (pattern, timeframe, direction)"),
    CustomRule(RULE_5, "patterns.match all cannot mix bullish and bearish entries"),
    CustomRule(RULE_6, "direction long rejects bearish entries; short rejects bullish entries"),
    CustomRule(RULE_7, "an r_multiple target requires a stop"),
    CustomRule(RULE_8, "risk, when present, has at least one of stop, target, positionSizeHint"),
)


class PctStop(ConfigModel):
    type: Literal["pct"]
    value: Annotated[float, Field(gt=0, le=50)]


class AtrMultipleStop(ConfigModel):
    type: Literal["atr_multiple"]
    value: Annotated[float, Field(gt=0, le=20)]


Stop = Annotated[PctStop | AtrMultipleStop, Field(discriminator="type")]


class PctTarget(ConfigModel):
    type: Literal["pct"]
    value: Annotated[float, Field(gt=0, le=500)]


class RMultipleTarget(ConfigModel):
    type: Literal["r_multiple"]
    value: Annotated[float, Field(gt=0, le=20)]


class AtrMultipleTarget(ConfigModel):
    type: Literal["atr_multiple"]
    value: Annotated[float, Field(gt=0, le=40)]


Target = Annotated[PctTarget | RMultipleTarget | AtrMultipleTarget, Field(discriminator="type")]


class RiskPctOfBookSizeHint(ConfigModel):
    type: Literal["risk_pct_of_book"]
    value: Annotated[float, Field(gt=0, le=5)]


class NotionalUsdSizeHint(ConfigModel):
    type: Literal["notional_usd"]
    value: Annotated[float, Field(gt=0, le=1000000)]


class SharesSizeHint(ConfigModel):
    type: Literal["shares"]
    value: Annotated[int, Field(ge=1, le=100000)]


SizeHint = Annotated[
    RiskPctOfBookSizeHint | NotionalUsdSizeHint | SharesSizeHint,
    Field(discriminator="type"),
]


# Non-empty: at least one key is required (rule 8).
class Risk(ConfigModel):
    stop: Stop | None = None
    target: Target | None = None
    positionSizeHint: SizeHint | None = None


class PatternEntry(ConfigModel):
    presetId: Slug | None = None
    spec: PatternSpec


class PatternSet(ConfigModel):
    match: Literal["all", "any"]
    entries: Annotated[list[PatternEntry], Field(min_length=1, max_length=8)]


def _entries(patterns: PatternSet | None) -> list[PatternEntry]:
    return patterns.entries if patterns is not None else []


class CustomStrategy(ConfigModel):
    schemaVersion: SchemaVersion
    kind: Literal["custom"]
    name: Name
    description: Description | None = None
    timeframe: Timeframe
    universe: Universe | None = None
    direction: Literal["long", "short", "either"]
    filters: FilterGroup | None = None
    patterns: PatternSet | None = None
    risk: Risk | None = None

    @model_validator(mode="after")
    def rule_1_no_filters_or_patterns(self) -> Self:
        if self.filters is None and self.patterns is None:
            raise PydanticCustomError(RULE_1, "a custom strategy needs filters, patterns, or both")
        return self

    @model_validator(mode="after")
    def rule_2_filter_group_size(self) -> Self:
        if self.filters is not None:
            stats = filter_group_stats(self.filters)
            if stats.depth > 3:
                raise PydanticCustomError(RULE_2, f"group depth {stats.depth} exceeds 3")
            if stats.leaves > 30:
                raise PydanticCustomError(RULE_2, f"{stats.leaves} conditions exceed 30")
        return self

    @model_validator(mode="after")
    def rule_3_pattern_timeframe(self) -> Self:
        for entry in _entries(self.patterns):
            if not timeframe_at_least(entry.spec.timeframe, self.timeframe):
                raise PydanticCustomError(
                    RULE_3,
                    f"{entry.spec.timeframe} is shorter than the strategy timeframe {self.timeframe}",
                )
        return self

    @model_validator(mode="after")
    def rule_4_duplicate_pattern(self) -> Self:
        seen: set[tuple[str, str, str]] = set()
        for entry in _entries(self.patterns):
            key = (entry.spec.pattern, entry.spec.timeframe, entry.spec.direction)
            if key in seen:
                raise PydanticCustomError(RULE_4, f"duplicate {' '.join(key)}")
            seen.add(key)
        return self

    @model_validator(mode="after")
    def rule_5_all_mixed_direction(self) -> Self:
        if self.patterns is not None and self.patterns.match == "all":
            sides = {entry.spec.direction for entry in self.patterns.entries}
            if {"bullish", "bearish"} <= sides:
                raise PydanticCustomError(RULE_5, "match all cannot mix bullish and bearish entries")
        return self

    @model_validator(mode="after")
    def rule_6_direction_conflict(self) -> Self:
        for entry in _entries(self.patterns):
            side = entry.spec.direction
            if (self.direction == "long" and side == "bearish") or (self.direction == "short" and side == "bullish"):
                raise PydanticCustomError(RULE_6, f"direction {self.direction} rejects {side} entries")
        return self

    @model_validator(mode="after")
    def rule_7_r_multiple_needs_stop(self) -> Self:
        risk = self.risk
        if risk is not None and risk.target is not None and risk.target.type == "r_multiple" and risk.stop is None:
            raise PydanticCustomError(RULE_7, "an r_multiple target needs a stop")
        return self

    @model_validator(mode="after")
    def rule_8_empty_risk(self) -> Self:
        risk = self.risk
        if risk is not None and risk.stop is None and risk.target is None and risk.positionSizeHint is None:
            raise PydanticCustomError(RULE_8, "risk needs at least one of stop, target, positionSizeHint")
        return self
