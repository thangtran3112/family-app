"""Types shared by every MVP family: the stamp (02m §a1), the plain-English `problems` body, and the
shared per-symbol metric row. `Freshness` and `MarketSession` are the same literals `core/freshness.py`
computes, so the API can never return a value the core does not produce."""

from datetime import datetime

from ai_trading_common.quality import Quality
from pydantic import BaseModel, FiniteFloat

from ai_trading.core.freshness import Freshness, MarketSession

__all__ = ["Freshness", "MarketSession", "Metrics", "Problem", "ProblemsOut", "Stamp"]


class Stamp(BaseModel):
    """Embedded in every response that carries market data; the UI never computes freshness."""

    as_of: datetime | None  # null only when nothing was ever read (for example an ES tile before IBKR)
    source: str | None
    quality: Quality
    freshness: Freshness


class Problem(BaseModel):
    path: str  # dotted JSON path from contracts/json_pointer.py, shown muted under the plain message
    message: str


class ProblemsOut(BaseModel):
    problems: list[Problem]


class Metrics(BaseModel):
    """The snapshot's metric names, exactly (02m §a1). Numbers or null, never NaN."""

    last: FiniteFloat | None = None
    prev_close: FiniteFloat | None = None
    change_pct: FiniteFloat | None = None
    volume: FiniteFloat | None = None
    avg_volume_20d: FiniteFloat | None = None
    rvol_10d: FiniteFloat | None = None
    atr_pct_14: FiniteFloat | None = None
    rsi_14: FiniteFloat | None = None
    gap_pct_open: FiniteFloat | None = None
    high_252d: FiniteFloat | None = None
    dist_to_252d_high_pct: FiniteFloat | None = None
    vwap_close: FiniteFloat | None = None
    vs_vwap_pct: FiniteFloat | None = None
    rvol_intraday_10d_at_close: FiniteFloat | None = None
