"""Response models for the platform family: `GET /status` extras (02m §a3.1, the `StatusOut` in
`api/status.py` embeds these), `GET /symbols/search` (§a3.1), and `GET /dashboard` (§a3.2)."""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, FiniteFloat

from ai_trading.api.schemas.common import MarketSession, Stamp

AlertsState = Literal["running", "paused_no_quotes", "paused_by_user", "not_started"]
SignalKind = Literal["orb", "vwap_reclaim", "pattern", "rvol", "other"]


class StatusMarketOut(BaseModel):
    session: MarketSession
    next_open: datetime
    last_close: datetime


class StatusScansOut(Stamp):
    next_run_at: datetime | None


class StatusAlertsOut(BaseModel):
    state: AlertsState
    unread: int


class SymbolSearchOut(BaseModel):
    symbol: str
    name: str
    asset_type: Literal["stock", "etf"]
    in_watchlist: bool


class DashboardMarketOut(BaseModel):
    session: MarketSession
    next_open: datetime
    #: When the scheduler's next scan runs: the first update of a market strip that has no data yet.
    next_update_at: datetime | None = None


class MarketStripTileOut(BaseModel):
    symbol: str
    last: FiniteFloat | None
    change_pct: FiniteFloat | None
    stamp: Stamp


class DashboardSignalOut(BaseModel):
    id: int
    symbol: str
    strategy_id: int
    strategy_name: str
    kind: SignalKind
    bar_time: datetime
    summary: str
    evidence: dict[str, Any]


class DashboardScreenerMatchOut(BaseModel):
    filter_id: int
    name: str
    run_on: str
    scanned: int
    matches_total: int
    top: list[str]
    stamp: Stamp


class DashboardWatchlistRowOut(BaseModel):
    symbol: str
    last: FiniteFloat | None
    change_pct: FiniteFloat | None
    rvol_10d: FiniteFloat | None
    vs_vwap_pct: FiniteFloat | None
    bias_label: str


class DashboardWatchlistOut(BaseModel):
    id: int
    name: str
    rows: list[DashboardWatchlistRowOut]


class DashboardEventOut(BaseModel):
    symbol: str
    kind: Literal["earnings"]
    date: date
    timing: str


class DashboardOut(BaseModel):
    stamp: Stamp
    market: DashboardMarketOut
    market_strip: list[MarketStripTileOut]
    signals: list[DashboardSignalOut]
    screener_matches: list[DashboardScreenerMatchOut]
    watchlist: DashboardWatchlistOut
    events: list[DashboardEventOut]
    alerts_state: AlertsState
