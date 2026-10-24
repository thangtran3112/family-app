from datetime import UTC, datetime, timedelta
from typing import Literal

import pandas as pd
from ai_trading_common.quality import Quality
from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

from ai_trading.api.auth import get_current_user, get_data_sources
from ai_trading.api.market_data import bar_as_of, finite_or_none, get_market_bars, validate_symbol
from ai_trading.api.schemas.common import Stamp
from ai_trading.api.stamp import make_stamp
from ai_trading.core.calendar import ET
from ai_trading.core.calendar import session as trading_session
from ai_trading.mvp_stub import market as stub_market
from ai_trading.mvp_stub import stub_enabled

router = APIRouter(prefix="/api/desk/bars", tags=["market data"], dependencies=[Depends(get_current_user)])

Interval = Literal["1d", "1w", "1h", "5m", "15m", "30m", "4h", "1m"]
INTERVAL_DELTA = {
    "1m": timedelta(minutes=1),
    "5m": timedelta(minutes=5),
    "15m": timedelta(minutes=15),
    "30m": timedelta(minutes=30),
    "1h": timedelta(hours=1),
    "4h": timedelta(hours=4),
    "1d": timedelta(days=1),
    "1w": timedelta(days=7),
}


class BarOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    t: str
    o: FiniteFloat | None
    h: FiniteFloat | None
    low: FiniteFloat | None = Field(alias="l")
    c: FiniteFloat | None
    v: FiniteFloat | None
    ext: bool  # pre- or after-hours (extended-hours shading); always false for daily, weekly and futures


class BarsOut(BaseModel):
    symbol: str
    interval: Interval
    quality: Quality
    as_of: str | None
    bars: list[BarOut]
    stamp: Stamp


def utc_datetime(point: object) -> datetime:
    """A bar's index as a UTC datetime. A daily or weekly index is a bare date, so it is 00:00 UTC."""
    moment = pd.Timestamp(point)
    moment = moment.tz_localize("UTC") if moment.tzinfo is None else moment.tz_convert("UTC")
    return moment.to_pydatetime()


def _extended_flags(index: pd.Index, asset: str, interval: str) -> list[bool]:
    """True for an intraday stock bar that starts outside the regular session (or on a non-session day)."""
    if asset != "stock" or interval in ("1d", "1w"):
        return [False] * len(index)
    flags = []
    for point in index:
        moment = pd.Timestamp(utc_datetime(point))
        found = trading_session("stock", moment.tz_convert(ET).date())
        flags.append(found is None or moment < found.regular_open or moment >= found.regular_close)
    return flags


@router.get("/{symbol:path}", response_model=BarsOut)
def bars(
    symbol: str,
    interval: Interval = "1d",
    days: int = Query(default=30, ge=1, le=3650),
    session: Literal["regular", "extended"] = "regular",
    data_sources: DataSources = Depends(get_data_sources),
) -> BarsOut:
    """Closed bars for the chart. `ext` marks pre/after-hours bars; `stamp` is the freshness the UI shows.
    Stub (`DESK_MVP_STUB=1`): SPY, NVDA, MSFT from the snapshot, `session=extended` reads the Friday 5m series."""
    if stub_enabled():
        validate_symbol(symbol)
        return stub_market.bars(symbol, interval, days, session)
    market = get_market_bars(data_sources, symbol, interval, days, stock_session=session)
    frame, quality = market.frame, market.quality
    asset = "future" if symbol.startswith("/") else "stock"
    extended = _extended_flags(frame.index, asset, interval)
    rows = [
        BarOut(
            t=bar_as_of(point),
            o=finite_or_none(row.open),
            h=finite_or_none(row.high),
            low=finite_or_none(row.low),
            c=finite_or_none(row.close),
            v=finite_or_none(row.volume),
            ext=flag,
        )
        for (point, row), flag in zip(frame.iterrows(), extended, strict=True)
    ]
    last_bar = utc_datetime(frame.index[-1]) if len(frame) else None
    return BarsOut(
        symbol=symbol,
        interval=interval,
        quality=quality,
        as_of=rows[-1].t if rows else None,
        bars=rows,
        stamp=make_stamp(
            quality=quality,
            source="alpaca" if asset == "stock" else None,
            as_of=last_bar,
            interval=INTERVAL_DELTA[interval],
            last_ok_at=datetime.now(UTC) if rows else None,
        ),
    )
