"""Alert strategy (kind "alert"): when to notify, and where. Nothing here places an order.

Mirror of contracts/src/alert-strategy.ts: same field names, same limits, same rules. Every rule in
ALERT_RULES has a model_validator here with the same message (the validator names are ours; Zod has
none). Hand-written, not generated.
"""

from typing import Annotated, Literal, NamedTuple

from pydantic import Field, model_validator

from ai_trading.contracts.common import (
    ConfigModel,
    Description,
    HhMm,
    Name,
    SchemaVersion,
    Severity,
    Slug,
    Ticker,
    Timeframe,
)
from ai_trading.contracts.filter_strategy import FILTER_METRIC_DOMAIN, FilterMetric


class _Rule(NamedTuple):
    id: str
    description: str


ALERT_RULES: tuple[_Rule, ...] = (
    _Rule("channels-unique", "channels must be unique"),
    _Rule("channels-in-app-first", "channels[0] must be in_app"),
    _Rule("days-unique", "days must be unique"),
    _Rule("days-weekday-session", "regular and extended sessions cannot include sat or sun"),
    _Rule("window-start-before-end", "window.start must be before window.end"),
    _Rule("window-regular-bounds", "a regular window must lie inside 09:30-16:00"),
    _Rule("window-extended-bounds", "an extended window must lie inside 04:00-20:00"),
    _Rule("threshold-in-domain", "threshold must lie in the indicator metric's domain"),
)
_RULE_TEXT: dict[str, str] = {rule.id: rule.description for rule in ALERT_RULES}

AlertChannel = Literal["in_app", "telegram", "slack"]
Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


class StrategyMatchTrigger(ConfigModel):
    type: Literal["strategy_match"]
    strategyId: Slug


class PriceCrossTrigger(ConfigModel):
    type: Literal["price_cross"]
    symbol: Ticker
    direction: Literal["above", "below"]
    level: Annotated[float, Field(gt=0, le=1000000)]


class IndicatorThresholdTrigger(ConfigModel):
    type: Literal["indicator_threshold"]
    symbol: Ticker
    indicator: FilterMetric
    op: Literal["gt", "gte", "lt", "lte", "crosses_above", "crosses_below"]
    threshold: float

    @model_validator(mode="after")
    def _threshold_in_domain(self) -> "IndicatorThresholdTrigger":
        low, high = FILTER_METRIC_DOMAIN[self.indicator.metric]
        if self.threshold < low or (high is not None and self.threshold > high):
            raise ValueError(_RULE_TEXT["threshold-in-domain"])
        return self


AlertTrigger = Annotated[
    StrategyMatchTrigger | PriceCrossTrigger | IndicatorThresholdTrigger,
    Field(discriminator="type"),
]


class AlertWindow(ConfigModel):
    start: HhMm
    end: HhMm


class AlertSchedule(ConfigModel):
    sessions: Literal["regular", "extended", "always"]
    days: Annotated[list[Weekday], Field(min_length=1, max_length=7)]
    window: AlertWindow | None = None

    @model_validator(mode="after")
    def _schedule_rules(self) -> "AlertSchedule":
        if len(set(self.days)) != len(self.days):
            raise ValueError(_RULE_TEXT["days-unique"])
        if self.sessions != "always" and {"sat", "sun"} & set(self.days):
            raise ValueError(_RULE_TEXT["days-weekday-session"])
        if self.window is None:
            return self
        start, end = self.window.start, self.window.end
        if not start < end:
            raise ValueError(_RULE_TEXT["window-start-before-end"])
        if self.sessions == "regular" and not ("09:30" <= start and end <= "16:00"):
            raise ValueError(_RULE_TEXT["window-regular-bounds"])
        if self.sessions == "extended" and not ("04:00" <= start and end <= "20:00"):
            raise ValueError(_RULE_TEXT["window-extended-bounds"])
        return self


class AlertCooldown(ConfigModel):
    minutes: Annotated[int, Field(ge=0, le=1440)]
    dedupe: Literal["per_symbol", "per_trigger", "per_bar"]


class AlertStrategy(ConfigModel):
    schemaVersion: SchemaVersion
    kind: Literal["alert"]
    name: Name
    description: Description | None = None
    severity: Severity | None = None
    timeframe: Timeframe
    trigger: AlertTrigger
    schedule: AlertSchedule
    cooldown: AlertCooldown
    maxPerDay: Annotated[int, Field(ge=1, le=50)] | None = None
    channels: Annotated[list[AlertChannel], Field(min_length=1, max_length=3)]

    @model_validator(mode="after")
    def _channels_rules(self) -> "AlertStrategy":
        if len(set(self.channels)) != len(self.channels):
            raise ValueError(_RULE_TEXT["channels-unique"])
        if self.channels[0] != "in_app":
            raise ValueError(_RULE_TEXT["channels-in-app-first"])
        return self
