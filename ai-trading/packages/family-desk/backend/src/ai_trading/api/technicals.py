from typing import Literal

import pandas as pd
from ai_trading_common.quality import Quality
from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, FiniteFloat

from ai_trading.api.auth import get_current_user, get_data_sources
from ai_trading.api.market_data import bar_as_of, finite_or_none, get_market_bars
from ai_trading.core import bias, indicators
from ai_trading.engine.cardback import CardBack, compute_card_back

router = APIRouter(prefix="/api/desk/technicals", tags=["market data"], dependencies=[Depends(get_current_user)])

Timeframe = Literal["1d", "1h", "5m", "1m"]
_CARD_TIMEFRAME = {"1d": "1D", "1h": "1h", "5m": "5m", "1m": "1m"}
GaugeLabel = Literal["Strong Sell", "Sell", "Neutral", "Buy", "Strong Buy", "warming up"]


class VoteCountsOut(BaseModel):
    sell: int
    neutral: int
    buy: int


class GaugeOut(BaseModel):
    label: GaugeLabel
    score: FiniteFloat | None
    counts: VoteCountsOut | None


class GaugesOut(BaseModel):
    summary: GaugeOut
    oscillators: GaugeOut
    moving_averages: GaugeOut


class VoteOut(BaseModel):
    values: dict[str, FiniteFloat | None]
    action: Literal["Sell", "Neutral", "Buy"] | None


class MacdOut(BaseModel):
    line: FiniteFloat | None
    signal: FiniteFloat | None
    histogram: FiniteFloat | None


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
    pivots: dict[str, FiniteFloat | None]
    rsi: FiniteFloat | None
    macd: MacdOut
    card_back: CardBackOut


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


@router.get("/{symbol:path}", response_model=TechnicalsOut)
def technicals(
    symbol: str,
    timeframe: Timeframe = "1d",
    days: int = Query(default=365, ge=1, le=3650),
    data_sources: DataSources = Depends(get_data_sources),
) -> TechnicalsOut:
    frame, quality = get_market_bars(data_sources, symbol, timeframe, days)
    asset = "future" if symbol.startswith("/") else "stock"
    back = compute_card_back(symbol, _CARD_TIMEFRAME[timeframe], frame, asset)
    result = bias.bias(frame)
    close = frame["close"] if "close" in frame else pd.Series(dtype=float)
    rsi = indicators.rsi(close, 14)
    macd = indicators.macd(close)
    if result == "warming up":
        gauges = GaugesOut(
            summary=_gauge("warming up", None, None),
            oscillators=_gauge("warming up", None, None),
            moving_averages=_gauge("warming up", None, None),
        )
        oscillator_votes: dict[str, VoteOut] = {}
        moving_average_votes: dict[str, VoteOut] = {}
    else:
        gauges = GaugesOut(
            summary=_gauge(result.summary_label, result.summary_score, None),
            oscillators=_gauge(result.oscillator_label, result.oscillator_score, result.oscillator_counts),
            moving_averages=_gauge(result.ma_label, result.ma_score, result.ma_counts),
        )
        oscillator_votes = _votes(result.oscillators)
        moving_average_votes = _votes(result.moving_averages)

    return TechnicalsOut(
        symbol=symbol,
        quality=quality,
        as_of=bar_as_of(frame.index[-1]) if not frame.empty else None,
        gauges=gauges,
        moving_averages=moving_average_votes,
        oscillators=oscillator_votes,
        pivots=back.pivots,
        rsi=finite_or_none(rsi.iloc[-1]) if len(rsi) else None,
        macd=MacdOut(
            line=finite_or_none(macd.line.iloc[-1]) if len(macd.line) else None,
            signal=finite_or_none(macd.signal.iloc[-1]) if len(macd.signal) else None,
            histogram=finite_or_none(macd.histogram.iloc[-1]) if len(macd.histogram) else None,
        ),
        card_back=_card_back(back),
    )
