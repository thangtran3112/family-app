"""Response and request models for the delivery log and alert strategies (02m §a3.7). The inbox keeps its
`AlertOut` in `api/alerts.py`. Names carry the `Alert` prefix so they stay unique across the OpenAPI document."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, FiniteFloat

from ai_trading.api.schemas.common import Problem

LogStatus = Literal["delivered", "held_quiet_hours", "no_channel", "failed"]
AlertChannel = Literal["inbox", "telegram", "slack"]
AlertStrategyStatus = Literal["active", "paused", "expired", "draft"]
AlertStrategyStage = Literal["draft", "alert_only"]
AlertStrategyOrigin = Literal["seed", "library", "user"]
AlertStrategyCategory = Literal["pattern", "indicator", "level", "screener"]
AlertStrategyRunOn = Literal[
    "bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h", "premarket_0830", "daily_close", "weekly"
]
AlertStrategyFrequency = Literal["once", "once_per_bar", "every_time"]
AlertSeverity = Literal["info", "opportunity", "risk"]


class AlertLogOut(BaseModel):
    delivery_id: int
    alert_id: int
    created_at: datetime
    symbol: str | None
    strategy_id: int | None
    strategy_name: str | None
    channel: str
    status: LogStatus
    detail: str  # plain wording; never the provider's raw error text


class AlertReadAllOut(BaseModel):
    marked: int


class AlertStrategySourceOut(BaseModel):
    kind: Literal["symbol", "watchlist", "filter"]
    id: int | None
    label: str


class AlertStrategyOut(BaseModel):
    id: int
    name: str
    origin: AlertStrategyOrigin
    stage: AlertStrategyStage
    status: AlertStrategyStatus
    paused_reason: str | None
    version: int
    source: AlertStrategySourceOut
    category: AlertStrategyCategory
    run_on: AlertStrategyRunOn
    frequency: AlertStrategyFrequency
    cooldown_minutes: int | None
    expires_on: str | None  # YYYY-MM-DD, New York date
    channels: list[AlertChannel]
    severity: AlertSeverity
    last_fired_at: datetime | None
    fires_7d: int
    spec: dict[str, Any]  # an AlertStrategySpecV1, dumped


class AlertStrategyVersionOut(BaseModel):
    version: int
    created_at: datetime
    change_note: str | None


class AlertStrategyDetailOut(AlertStrategyOut):
    versions: list[AlertStrategyVersionOut]


class AlertStrategyCreate(BaseModel):
    spec: dict[str, Any]
    save_as: Literal["draft", "on"]


class AlertStrategyUpdate(BaseModel):
    spec: dict[str, Any]
    change_note: str | None = None


class AlertStrategyValidateIn(BaseModel):
    spec: dict[str, Any]


class AlertStrategyValidateOut(BaseModel):
    problems: list[Problem]
    resolved_symbols: list[str]
    run_on: AlertStrategyRunOn | None


class AlertStrategyPauseIn(BaseModel):
    reason: Literal["user"]


class AlertStrategyDeliveryOut(BaseModel):
    channel: AlertChannel
    status: LogStatus


class AlertStrategyBarOut(BaseModel):
    t: str  # UTC ISO-8601 with Z
    o: FiniteFloat | None
    h: FiniteFloat | None
    l: FiniteFloat | None  # noqa: E741 (OHLC field name)
    c: FiniteFloat | None
    v: FiniteFloat | None


class AlertStrategyThumbOut(BaseModel):
    interval: Literal["15m"]
    bars: list[AlertStrategyBarOut]


class AlertStrategyFireOut(BaseModel):
    signal_id: int  # 0 when the fire has no signal row
    symbol: str
    bar_time: datetime
    evidence: dict[str, Any]
    deliveries: list[AlertStrategyDeliveryOut]
    thumb: AlertStrategyThumbOut
