"""Shared bounded, closed-bar reads for the Desk's read-only market-data routes."""

import re
from dataclasses import dataclass
from datetime import date, timedelta
from math import isfinite
from typing import Literal

import pandas as pd
from ai_trading_common.errors import NoData, ProviderError
from ai_trading_common.quality import Quality
from ai_trading_common.registry import DataSources
from fastapi import HTTPException

from ai_trading.core.calendar import Asset, annotate, session
from ai_trading.core.evaluate import _last_of_week, _resample
from ai_trading.data.bars import bar_close

_SYMBOL = re.compile(r"^/?[A-Za-z0-9][A-Za-z0-9.-]{0,14}$")
_SOURCE_INTERVAL = {
    "1d": "1d",
    "1w": "1d",
    "1h": "1h",
    "1m": "1m",
    "5m": "1m",
    "15m": "1m",
    "30m": "1m",
    "4h": "1m",
}
_RESAMPLE_MINUTES = {"5m": 5, "15m": 15, "30m": 30, "4h": 240}
_MAX_SOURCE_DAYS = {
    "1m": 30,
    "5m": 30,
    "15m": 90,
    "30m": 180,
    "1h": 365,
    "4h": 220,
    "1d": 3650,
    "1w": 3650,
}
MAX_BARS = 5000
OHLCV = ("open", "high", "low", "close", "volume")


@dataclass(frozen=True)
class MarketBars:
    frame: pd.DataFrame
    quality: Quality
    daily_bars: pd.DataFrame | None = None


def validate_symbol(symbol: str) -> str:
    if not _SYMBOL.fullmatch(symbol):
        raise HTTPException(status_code=422, detail="invalid symbol")
    return symbol


def finite_or_none(value: object) -> float | None:
    if value is None or pd.isna(value):
        return None
    number = float(value)
    return number if isfinite(number) else None


def _weekly_bars(frame: pd.DataFrame, asset: Asset) -> pd.DataFrame:
    rows = []
    index = []
    for week_start, week in frame.groupby(lambda day: day - timedelta(days=day.weekday())):
        first_day, last_day = week.index[0], week.index[-1]
        is_first_session = not any(
            session(asset, first_day - timedelta(days=offset)) is not None
            for offset in range(1, first_day.weekday() + 1)
        )
        if not is_first_session or not _last_of_week(asset, last_day):
            continue
        rows.append(
            {
                "open": week["open"].iloc[0],
                "high": week["high"].max(),
                "low": week["low"].min(),
                "close": week["close"].iloc[-1],
                "volume": week["volume"].sum(),
            }
        )
        index.append(week_start)
    return pd.DataFrame(rows, index=pd.Index(index), columns=OHLCV)


def get_market_bars(
    data_sources: DataSources,
    symbol: str,
    interval: str,
    days: int,
    *,
    stock_session: Literal["regular", "extended"] | None = None,
    now: pd.Timestamp | None = None,
) -> MarketBars:
    """Fetch bounded closed bars. Provider `NoData` is empty/unavailable; provider failures stay 503s."""
    symbol = validate_symbol(symbol)
    now = now if now is not None else pd.Timestamp.now(tz="UTC")
    start = now - pd.Timedelta(days=min(days, _MAX_SOURCE_DAYS[interval]))
    source_interval = _SOURCE_INTERVAL[interval]
    asset: Asset = "future" if symbol.startswith("/") else "stock"
    try:
        bars = data_sources.bars.bars(symbol, source_interval, start, now, now=now)
    except NoData:
        empty = pd.DataFrame(columns=OHLCV)
        return MarketBars(empty, "unavailable", empty if interval == "1w" else None)
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail="market data provider unavailable") from exc

    frame = bars.frame.sort_index()
    if source_interval == "1d":
        first_day = start.tz_convert("America/New_York").date()
        last_day = now.tz_convert("America/New_York").date()
        frame = frame.loc[(frame.index >= first_day) & (frame.index <= last_day)]
    else:
        frame = frame.loc[(frame.index >= start) & (frame.index <= now)]
    closed = []
    for point in frame.index:
        try:
            closed.append(bar_close(asset, source_interval, point) <= now)
        except ValueError:
            closed.append(False)
    frame = frame.loc[closed]

    daily_bars = frame if interval == "1w" else None
    if interval == "1w" and not frame.empty:
        frame = _weekly_bars(frame, asset)
    elif source_interval != "1d" and not frame.empty:
        annotated = annotate(frame, asset)
        if asset == "stock" and stock_session is not None:
            is_regular = annotated["phase"] == "regular"
            annotated = annotated[is_regular if stock_session == "regular" else ~is_regular]
        if interval in _RESAMPLE_MINUTES:
            frame = _resample(annotated, asset, _RESAMPLE_MINUTES[interval], now)
            # The bounded source window may start inside its first phase-aligned bin.
            frame = frame.loc[frame.index >= start]
        else:
            frame = annotated.loc[:, OHLCV]
    frame = frame.tail(MAX_BARS)
    quality = bars.quality if not frame.empty else "unavailable"
    return MarketBars(frame, quality, daily_bars)


def bar_as_of(point: date | pd.Timestamp) -> str:
    return point.isoformat()
