from typing import Literal

from ai_trading_common.quality import Quality
from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

from ai_trading.api.auth import get_current_user, get_data_sources
from ai_trading.api.market_data import bar_as_of, finite_or_none, get_market_bars

router = APIRouter(prefix="/api/desk/bars", tags=["market data"], dependencies=[Depends(get_current_user)])

Interval = Literal["1d", "1w", "1h", "5m", "15m", "30m", "4h", "1m"]


class BarOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    t: str
    o: FiniteFloat | None
    h: FiniteFloat | None
    low: FiniteFloat | None = Field(alias="l")
    c: FiniteFloat | None
    v: FiniteFloat | None


class BarsOut(BaseModel):
    symbol: str
    interval: Interval
    quality: Quality
    as_of: str | None
    bars: list[BarOut]


@router.get("/{symbol:path}", response_model=BarsOut)
def bars(
    symbol: str,
    interval: Interval = "1d",
    days: int = Query(default=30, ge=1, le=3650),
    session: Literal["regular", "extended"] = "regular",
    data_sources: DataSources = Depends(get_data_sources),
) -> BarsOut:
    frame, quality = get_market_bars(data_sources, symbol, interval, days, stock_session=session)
    rows = [
        BarOut(
            t=bar_as_of(point),
            o=finite_or_none(row.open),
            h=finite_or_none(row.high),
            low=finite_or_none(row.low),
            c=finite_or_none(row.close),
            v=finite_or_none(row.volume),
        )
        for point, row in frame.iterrows()
    ]
    return BarsOut(
        symbol=symbol,
        interval=interval,
        quality=quality,
        as_of=rows[-1].t if rows else None,
        bars=rows,
    )
