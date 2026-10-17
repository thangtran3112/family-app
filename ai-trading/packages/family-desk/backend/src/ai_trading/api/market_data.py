"""Shared bounded, closed-bar reads for the Desk's read-only market-data routes."""

import re
from datetime import date
from math import isfinite

import pandas as pd
from ai_trading_common.errors import NoData, ProviderError
from ai_trading_common.quality import Quality
from ai_trading_common.registry import DataSources
from fastapi import HTTPException

from ai_trading.core.calendar import Asset, annotate
from ai_trading.core.evaluate import _resample
from ai_trading.data.bars import bar_close

_SYMBOL = re.compile(r"^/?[A-Za-z0-9][A-Za-z0-9.-]{0,14}$")
_SOURCE_INTERVAL = {"1d": "1d", "1h": "1h", "1m": "1m", "5m": "1m"}
MAX_BARS = 5000
OHLCV = ("open", "high", "low", "close", "volume")


def validate_symbol(symbol: str) -> str:
    if not _SYMBOL.fullmatch(symbol):
        raise HTTPException(status_code=422, detail="invalid symbol")
    return symbol


def finite_or_none(value: object) -> float | None:
    if value is None or pd.isna(value):
        return None
    number = float(value)
    return number if isfinite(number) else None


def get_market_bars(
    data_sources: DataSources, symbol: str, interval: str, days: int
) -> tuple[pd.DataFrame, Quality]:
    """Fetch bounded closed bars. Provider `NoData` is empty/unavailable; provider failures stay 503s."""
    symbol = validate_symbol(symbol)
    now = pd.Timestamp.now(tz="UTC")
    start = now - pd.Timedelta(days=days)
    source_interval = _SOURCE_INTERVAL[interval]
    asset: Asset = "future" if symbol.startswith("/") else "stock"
    try:
        bars = data_sources.bars.bars(symbol, source_interval, start, now, now=now)
    except NoData:
        return pd.DataFrame(columns=OHLCV), "unavailable"
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

    if interval == "5m" and not frame.empty:
        frame = _resample(annotate(frame, asset), asset, 5, now)
    frame = frame.tail(MAX_BARS)
    return frame, bars.quality if not frame.empty else "unavailable"


def bar_as_of(point: date | pd.Timestamp) -> str:
    return point.isoformat()
