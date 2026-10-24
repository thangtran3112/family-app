"""`/api/desk/screener*` response and request models (02m §a3.4). Names start with `Screener`.

`spec` is typed as a plain object: the spec's 422 `problems` come from our own validation, and FastAPI
re-serialising a strict spec through a typed model would add `null` for every absent optional field.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, FiniteFloat, model_validator

from ai_trading.api.schemas.common import Metrics, Problem, Stamp

ScreenerRunOn = Literal[
    "bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h", "premarket_0830", "daily_close", "weekly"
]
ScreenerSession = Literal["regular", "extended"]
ScreenerOrigin = Literal["seed", "user"]
ScreenerFormat = Literal["price", "pct", "pct_signed", "compact", "ratio", "number", "time"]


class ScreenerLastRunOut(BaseModel):
    evaluation_point: datetime
    matches_total: int
    scanned: int
    stamp: Stamp


class ScreenerFilterOut(BaseModel):
    id: int
    name: str
    origin: ScreenerOrigin
    seed_key: str | None
    read_only: bool
    run_on: ScreenerRunOn
    session: ScreenerSession
    last_run: ScreenerLastRunOut | None


class ScreenerFilterDetailOut(BaseModel):
    id: int
    name: str
    origin: ScreenerOrigin
    read_only: bool
    version: int
    spec: dict[str, Any]
    default_spec: dict[str, Any] | None
    stamp: Stamp


class ScreenerFilterCreate(BaseModel):
    copy_of: int | None = None
    spec: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "ScreenerFilterCreate":
        if (self.copy_of is None) == (self.spec is None):
            raise ValueError("send either copy_of or spec, not both and not neither")
        return self


class ScreenerFilterUpdate(BaseModel):
    spec: dict[str, Any]
    change_note: str | None = None


class ScreenerRankOut(BaseModel):
    by: dict[str, Any]
    order: Literal["desc", "asc"]


class ScreenerLiquidityOut(BaseModel):
    minPrice: FiniteFloat | None = None
    minAvgVolume: int | None = None
    avgVolumeDays: int | None = None


class ScreenerTableColumnOut(BaseModel):
    key: str
    label: str
    format: ScreenerFormat


class ScreenerMatchOut(BaseModel):
    symbol: str
    matched_since: datetime
    rank_value: FiniteFloat | None
    operands: dict[str, FiniteFloat | None]
    columns: Metrics


class ScreenerResultsOut(BaseModel):
    filter_id: int
    name: str
    run_on: ScreenerRunOn
    session: ScreenerSession
    rank: ScreenerRankOut | None
    liquidity: ScreenerLiquidityOut | None
    evaluation_point: datetime
    scanned: int
    no_data_on_eval_day: int
    matches_total: int
    matches_returned: int
    stamp: Stamp
    table_columns: list[ScreenerTableColumnOut]
    matches: list[ScreenerMatchOut]


class ScreenerPreviewIn(BaseModel):
    spec: dict[str, Any]


class ScreenerPreviewTopOut(BaseModel):
    symbol: str
    rank_value: FiniteFloat | None


class ScreenerPreviewOut(BaseModel):
    problems: list[Problem]
    matches_total: int | None
    scanned: int
    top: list[ScreenerPreviewTopOut]


class ScreenerUniverseOut(BaseModel):
    scan_basis: str
    candidates: int
    scanned: int
    dropped_non_plain_tickers: int
    no_daily_data: int
    liquidity_floor: ScreenerLiquidityOut
    stamp: Stamp
