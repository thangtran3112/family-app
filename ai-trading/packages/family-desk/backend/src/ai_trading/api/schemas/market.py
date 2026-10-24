"""Market-data response models that are new in the MVP (02m §a3.3): the bias history, the key levels, the
strategies gauge, and chart markers. `GaugeLabel` and `VoteCountsOut` live here (not in `api/technicals.py`)
so the strategies gauge can reuse them without an import cycle; `technicals.py` imports them back."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

GaugeLabel = Literal["Strong Sell", "Sell", "Neutral", "Buy", "Strong Buy", "warming up"]


class VoteCountsOut(BaseModel):
    sell: int
    neutral: int
    buy: int


class BiasHistoryEntryOut(BaseModel):
    bar: datetime
    summary: GaugeLabel
    score: FiniteFloat | None
    oscillators: GaugeLabel
    moving_averages: GaugeLabel


class BiasChangeOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: GaugeLabel = Field(alias="from")
    to: GaugeLabel
    at_bar: datetime


class BiasHistoryOut(BaseModel):
    history: list[BiasHistoryEntryOut]  # the last 20 closed bars of the requested timeframe
    last_change_in_window: BiasChangeOut | None


class LevelsOut(BaseModel):
    prior_close: FiniteFloat | None
    session_high: FiniteFloat | None
    session_low: FiniteFloat | None


class StrategyVoteOut(BaseModel):
    strategy_id: int
    name: str
    bias: Literal["bullish", "bearish", "neutral"]
    vote: Literal["buy", "neutral", "sell"]


class StrategyWatchOut(BaseModel):
    strategy_id: int
    name: str


class StrategiesGaugeOut(BaseModel):
    label: GaugeLabel
    score: FiniteFloat | None
    counts: VoteCountsOut
    votes: list[StrategyVoteOut]
    watching: list[StrategyWatchOut]


class PatternMarkerOut(BaseModel):
    pattern: str
    template: str
    bar_start: datetime
    bar_close: datetime
    ohlc: Annotated[list[FiniteFloat], Field(min_length=4, max_length=4)]


class FireMarkerOut(BaseModel):
    signal_id: int
    strategy_name: str
    bar_time: datetime


class MarkersOut(BaseModel):
    patterns: list[PatternMarkerOut]
    fires: list[FireMarkerOut]
