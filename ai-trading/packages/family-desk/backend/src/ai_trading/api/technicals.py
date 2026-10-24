from datetime import UTC, datetime
from math import isnan
from typing import Literal

import pandas as pd
from ai_trading_common.quality import Quality
from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, FiniteFloat

from ai_trading.api.auth import get_current_user, get_data_sources
from ai_trading.api.bars import INTERVAL_DELTA, utc_datetime
from ai_trading.api.market_data import bar_as_of, finite_or_none, get_market_bars, validate_symbol
from ai_trading.api.schemas.common import Stamp
from ai_trading.api.schemas.market import (
    BiasHistoryOut,
    GaugeLabel,
    LevelsOut,
    StrategiesGaugeOut,
    VoteCountsOut,
)
from ai_trading.api.stamp import make_stamp
from ai_trading.core import bias, indicators, pivots
from ai_trading.engine.cardback import _PIVOT_PERIOD, CardBack, compute_card_back, pivot_inputs
from ai_trading.mvp_stub import market as stub_market
from ai_trading.mvp_stub import stub_enabled

router = APIRouter(prefix="/api/desk/technicals", tags=["market data"], dependencies=[Depends(get_current_user)])

Timeframe = Literal["1d", "1w", "1h", "5m", "15m", "30m", "4h", "1m"]
_CARD_TIMEFRAME = {
    "1d": "1D",
    "1w": "1W",
    "1h": "1h",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "4h": "4h",
    "1m": "1m",
}
VolatilityLabel = Literal["low", "normal", "high"]


class GaugeOut(BaseModel):
    label: GaugeLabel
    score: FiniteFloat | None
    counts: VoteCountsOut | None


class GaugesOut(BaseModel):
    summary: GaugeOut
    oscillators: GaugeOut
    moving_averages: GaugeOut
    strategies: StrategiesGaugeOut | None  # the fourth gauge (02l §e4); null with no attached strategy


class VoteOut(BaseModel):
    values: dict[str, FiniteFloat | None]
    action: Literal["Sell", "Neutral", "Buy"] | None


class MacdOut(BaseModel):
    line: FiniteFloat | None
    signal: FiniteFloat | None
    histogram: FiniteFloat | None


class VolatilityOut(BaseModel):
    atr14: FiniteFloat | None
    atr_percent: FiniteFloat | None
    label: VolatilityLabel | None


class PivotMethodsOut(BaseModel):
    classic: dict[str, FiniteFloat | None]
    fibonacci: dict[str, FiniteFloat | None]
    camarilla: dict[str, FiniteFloat | None]


class CardBackOut(BaseModel):
    symbol: str
    timeframe: str
    bias_label: str | None
    bias_score: FiniteFloat | None
    oscillators: dict[str, FiniteFloat | None]
    moving_averages: dict[str, FiniteFloat | None]
    atr_pct_label: str
    pivots: dict[str, FiniteFloat | None]


class TechnicalsOut(BaseModel):
    symbol: str
    quality: Quality
    as_of: str | None
    gauges: GaugesOut
    moving_averages: dict[str, VoteOut]
    oscillators: dict[str, VoteOut]
    pivots: PivotMethodsOut
    rsi: FiniteFloat | None
    macd: MacdOut
    volatility: VolatilityOut
    card_back: CardBackOut
    timeframe: str
    bars_used: int
    first_bar: datetime | None
    last_bar: datetime | None
    bias_ready: bool  # false while the bias is "warming up" (fewer than 250 closed bars)
    indicators: dict[str, FiniteFloat | str | None] | None  # stub only until the real series lands
    bias_history: BiasHistoryOut | None
    levels: LevelsOut | None
    stamp: Stamp


def _counts(value: bias.VoteCounts | None) -> VoteCountsOut | None:
    if value is None:
        return None
    return VoteCountsOut(sell=value.sell, neutral=value.neutral, buy=value.buy)


def _gauge(label: str | None, score: float | None, counts: bias.VoteCounts | None) -> GaugeOut:
    return GaugeOut(label=label or "warming up", score=finite_or_none(score), counts=_counts(counts))


def _votes(values: dict[str, bias.Vote]) -> dict[str, VoteOut]:
    return {
        name: VoteOut(values={key: finite_or_none(value) for key, value in vote.values.items()}, action=vote.action)
        for name, vote in values.items()
    }


def _volatility(frame: pd.DataFrame) -> VolatilityOut:
    if frame.empty or any(finite_or_none(frame[column].iloc[-1]) is None for column in ("high", "low", "close")):
        return VolatilityOut(atr14=None, atr_percent=None, label=None)
    atr_values = indicators.atr(frame, 14)
    atr_percent = indicators.atr_percent(frame)
    atr14 = finite_or_none(atr_values.iloc[-1]) if len(atr_values) else None
    percent = finite_or_none(atr_percent.pct.iloc[-1]) if len(atr_percent.pct) else None
    label = atr_percent.label.iloc[-1] if atr14 is not None and percent is not None else None
    return VolatilityOut(atr14=atr14, atr_percent=percent, label=label)


def _card_back(value: CardBack) -> CardBackOut:
    return CardBackOut(
        symbol=value.symbol,
        timeframe=value.timeframe,
        bias_label=value.bias_label,
        bias_score=finite_or_none(value.bias_score),
        oscillators={key: finite_or_none(score) for key, score in value.oscillators.items()},
        moving_averages={key: finite_or_none(score) for key, score in value.moving_averages.items()},
        atr_pct_label=value.atr_pct_label,
        pivots={key: finite_or_none(score) for key, score in value.pivots.items()},
    )


def _pivot_methods(
    frame: pd.DataFrame,
    timeframe: Timeframe,
    asset: str,
    *,
    daily_bars: pd.DataFrame | None = None,
) -> PivotMethodsOut:
    core_timeframe = _CARD_TIMEFRAME[timeframe]
    daily, reference = pivot_inputs(frame, core_timeframe, asset, daily_bars=daily_bars)
    if reference is None:
        return PivotMethodsOut(classic={}, fibonacci={}, camarilla={})
    high_series, low_series, close_series = pivots.prior_period_hlc(
        daily, pd.Index([reference]), asset, _PIVOT_PERIOD[core_timeframe]
    )
    high, low, close = float(high_series.iloc[0]), float(low_series.iloc[0]), float(close_series.iloc[0])
    if any(isnan(value) for value in (high, low, close)):
        return PivotMethodsOut(classic={}, fibonacci={}, camarilla={})
    methods = {
        "classic": pivots.classic_pivots,
        "fibonacci": pivots.fibonacci_pivots,
        "camarilla": pivots.camarilla_pivots,
    }
    return PivotMethodsOut(
        **{
            name: {level: finite_or_none(value) for level, value in method(high, low, close).items()}
            for name, method in methods.items()
        }
    )


@router.get("/{symbol:path}", response_model=TechnicalsOut)
def technicals(
    symbol: str,
    timeframe: Timeframe = "1d",
    days: int = Query(default=365, ge=1, le=3650),
    data_sources: DataSources = Depends(get_data_sources),
) -> TechnicalsOut:
    """The desk's technical view for one timeframe. Stub (`DESK_MVP_STUB=1`): SPY, NVDA, MSFT from the snapshot;
    `gauges.strategies` is a sample for NVDA 15m only. Real mode fills `timeframe`, `bars_used`, the bar
    bounds, `bias_ready` and `stamp`; `indicators`, `bias_history`, `levels` and `gauges.strategies` are null
    until their services land."""
    if stub_enabled():
        validate_symbol(symbol)
        return stub_market.technicals(symbol, timeframe)
    asset = "future" if symbol.startswith("/") else "stock"
    market = get_market_bars(
        data_sources, symbol, timeframe, days, stock_session="regular" if asset == "stock" else None
    )
    frame, quality = market.frame, market.quality
    back = compute_card_back(symbol, _CARD_TIMEFRAME[timeframe], frame, asset, daily_bars=market.daily_bars)
    result = bias.bias(frame)
    close = frame["close"] if "close" in frame else pd.Series(dtype=float)
    rsi = indicators.rsi(close, 14)
    macd = indicators.macd(close)
    if result == "warming up":
        gauges = GaugesOut(
            summary=_gauge("warming up", None, None),
            oscillators=_gauge("warming up", None, None),
            moving_averages=_gauge("warming up", None, None),
            strategies=None,
        )
        oscillators, moving_averages = bias.votes(frame)
        oscillator_votes = _votes(oscillators)
        moving_average_votes = _votes(moving_averages)
    else:
        gauges = GaugesOut(
            summary=_gauge(result.summary_label, result.summary_score, None),
            oscillators=_gauge(result.oscillator_label, result.oscillator_score, result.oscillator_counts),
            moving_averages=_gauge(result.ma_label, result.ma_score, result.ma_counts),
            strategies=None,
        )
        oscillator_votes = _votes(result.oscillators)
        moving_average_votes = _votes(result.moving_averages)
    first_bar = utc_datetime(frame.index[0]) if not frame.empty else None
    last_bar = utc_datetime(frame.index[-1]) if not frame.empty else None

    return TechnicalsOut(
        symbol=symbol,
        quality=quality,
        as_of=bar_as_of(frame.index[-1]) if not frame.empty else None,
        gauges=gauges,
        moving_averages=moving_average_votes,
        oscillators=oscillator_votes,
        pivots=_pivot_methods(frame, timeframe, asset, daily_bars=market.daily_bars),
        rsi=finite_or_none(rsi.iloc[-1]) if len(rsi) else None,
        macd=MacdOut(
            line=finite_or_none(macd.line.iloc[-1]) if len(macd.line) else None,
            signal=finite_or_none(macd.signal.iloc[-1]) if len(macd.signal) else None,
            histogram=finite_or_none(macd.histogram.iloc[-1]) if len(macd.histogram) else None,
        ),
        volatility=_volatility(frame),
        card_back=_card_back(back),
        timeframe=timeframe,
        bars_used=len(frame),
        first_bar=first_bar,
        last_bar=last_bar,
        bias_ready=result != "warming up",
        indicators=None,
        bias_history=None,
        levels=None,
        stamp=make_stamp(
            quality=quality,
            source="alpaca" if asset == "stock" else None,
            as_of=last_bar,
            interval=INTERVAL_DELTA[timeframe],
            last_ok_at=datetime.now(UTC) if not frame.empty else None,
        ),
    )
