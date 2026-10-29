"""Request and response models for the watchlist endpoints added by 02m §a3.5: rename, order, and the
table. The create, items, and delete models stay in `api/watchlists.py` (existing endpoints)."""

import unicodedata
from datetime import datetime
from typing import ClassVar, Literal

from pydantic import BaseModel, Field, FiniteFloat, field_validator

from ai_trading.api.schemas.common import Freshness, Stamp, SwingOptional
from ai_trading.api.schemas.fundamental import Fundamentals


class WatchlistNameBase(BaseModel):
    """The 1-80 character name rule shared by create and rename: NFKC, inner whitespace collapsed."""

    name: str = Field(strict=True, min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = " ".join(unicodedata.normalize("NFKC", value).split())
        if not normalized or len(normalized) > 80:
            raise ValueError("name must contain 1–80 characters")
        return normalized


class WatchlistRename(WatchlistNameBase):
    """`PATCH /api/desk/watchlists/{id}`."""


class WatchlistOrder(BaseModel):
    """`PUT /api/desk/watchlists/{id}/order`: the list's own symbols in their new order."""

    symbols: list[str]


class WatchlistTableHeader(BaseModel):
    id: int
    name: str
    horizon: str


class WatchlistTableTag(BaseModel):
    kind: Literal["pattern", "armed"]
    label: str
    at: datetime | None  # the pattern's bar time; null for an armed strategy


class WatchlistTableRow(SwingOptional):
    """`fundamentals` is a `long_term` list's (02n §c3 #20): a row of an intraday or swing list leaves it out, so those
    responses are byte for byte what they were (`SwingOptional`'s rule, whatever the lane)."""

    swing_only: ClassVar[tuple[str, ...]] = ("fundamentals",)

    symbol: str
    name: str
    asset_type: Literal["stock", "etf", "future"]
    last: FiniteFloat | None
    change_pct: FiniteFloat | None
    rvol_10d: FiniteFloat | None
    vs_vwap_pct: FiniteFloat | None
    bias_label: str
    freshness: Freshness
    tags: list[WatchlistTableTag]
    fundamentals: Fundamentals | None = None


class WatchlistTable(BaseModel):
    """`GET /api/desk/watchlists/{id}/table`: rows in stored `position` order."""

    watchlist: WatchlistTableHeader
    stamp: Stamp
    rows: list[WatchlistTableRow]
