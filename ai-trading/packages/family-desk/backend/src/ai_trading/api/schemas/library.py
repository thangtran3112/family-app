"""Request and response models for `/api/desk/library*` (02m §a3.6). `LibraryAttachOut` mirrors the
alerts family's `AlertStrategyOut` (§a3.7) field for field, but is defined here so this family does
not import another family's module."""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, FiniteFloat

LibraryKind = Literal["strategy", "filter"]
LibraryLane = Literal["technical", "fundamental"]
LibraryCategory = Literal["candlestick", "breakout", "trend", "volume", "futures", "income", "long_term"]
LibraryBias = Literal["bullish", "bearish", "neutral"]


class LibraryItemOut(BaseModel):
    """One catalog entry, as `PresetCatalogV1` ships it, plus whether it can be attached."""

    id: str
    file: str
    kind: LibraryKind
    lane: LibraryLane
    category: LibraryCategory
    bias: LibraryBias
    label: str
    summary: str
    attachable: bool
    attach_blocked_reason: str | None


class LibraryExampleOut(BaseModel):
    """A real occurrence on stored bars (the stub's snapshot here); the mock draws it as an example."""

    symbol: str
    timeframe: str
    bar_time: datetime
    ohlc: Annotated[list[FiniteFloat], Field(min_length=4, max_length=4)]


class LibraryEntryOut(LibraryItemOut):
    spec: dict[str, Any]  # the template JSON exactly as shipped
    defaults: dict[str, Any]  # {limits, severity, channels} for a strategy; {} for a filter
    example: LibraryExampleOut | None


class LibraryAttachIn(BaseModel):
    watchlist_id: int
    channels: list[str] = ["inbox"]
    severity: str = "opportunity"


class LibraryAttachSourceOut(BaseModel):
    kind: Literal["symbol", "watchlist", "filter"]
    id: int
    label: str


class LibraryAttachOut(BaseModel):
    id: int
    name: str
    origin: Literal["seed", "library", "user"]
    stage: Literal["draft", "alert_only"]
    status: Literal["active", "paused", "expired", "draft"]
    paused_reason: str | None
    version: int
    source: LibraryAttachSourceOut
    category: Literal["pattern", "indicator", "level", "screener"]
    run_on: str
    frequency: Literal["once", "once_per_bar", "every_time"]
    cooldown_minutes: int | None
    expires_on: str | None  # the contract's YYYY-MM-DD string, not a timestamp
    channels: list[str]
    severity: Literal["info", "opportunity", "risk"]
    last_fired_at: datetime | None
    fires_7d: int
    spec: dict[str, Any]
