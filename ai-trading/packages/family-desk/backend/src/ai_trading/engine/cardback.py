"""The watchlist card back (PROTO-BRIEF.md section 4 L2; 02f section 3): a pure read model over
bars already read by the caller. No new table -- D7 in Phase 2a already deferred "read models and
typed evidence snapshots" to the phase that consumes them (Phase 4's UI), so this ships only the
function, proven correct here, for that phase to call straight from the API.

Pure: no I/O, recomputed on every call (bias/indicator math is already fast pure code, so caching
is unneeded until it measurably isn't -- ponytail: add an LRU keyed by (symbol, timeframe,
bar_time) only if a real request measurement needs it).
"""

import math
from dataclasses import dataclass
from datetime import date, timedelta

import pandas as pd

from ai_trading.core import bias, indicators, pivots
from ai_trading.core.calendar import Asset, annotate, session

Timeframe = str  # "5m" | "15m" | "1h" | "1D" | "1W"

#: 02f section 3: intraday timeframes' pivots come from the prior session, "1D"'s from the prior
#: week, "1W"'s from the prior month.
_PIVOT_PERIOD: dict[str, pivots.Period] = {
    "1m": "session",
    "5m": "session",
    "15m": "session",
    "1h": "session",
    "1D": "week",
    "1W": "month",
}

#: TradingView's own -1/0/+1 vote scoring (`ai_trading.core.bias._SCORE`), duplicated here rather
#: than imported since it is that module's private detail: the card back shows each named
#: indicator's own vote as a number, not the bias group's mean.
_VOTE_SCORE = {"Sell": -1.0, "Neutral": 0.0, "Buy": 1.0}


@dataclass(frozen=True)
class CardBack:
    symbol: str
    timeframe: Timeframe
    bias_label: str | None  # None below 250 bars ("warming up", 02f section 3)
    bias_score: float | None
    oscillators: dict[str, float]  # name -> vote score (-1/0/+1); an unknown vote is omitted
    moving_averages: dict[str, float]
    atr_pct_label: str  # "low" | "normal" | "high"
    pivots: dict[str, float]  # classic pivots from the prior completed period; {} until known


def compute_card_back(symbol: str, timeframe: Timeframe, bars: pd.DataFrame, asset: Asset) -> CardBack:
    """`bars` is closed-bar OHLCV at `timeframe`'s own granularity (already read from bars_1h/
    bars_1d via `ai_trading.data.bars` by the caller), oldest first, matching every
    `ai_trading.core` convention. `bias_label`/`bias_score` are the Desk Technical Bias's single
    "summary" score (02f section 3's one bias gauge on the watchlist card back; the Technicals
    page shows the oscillator and moving-average gauges separately, a Phase 4 UI concern)."""
    result = bias.bias(bars)
    if result == "warming up":
        bias_label: str | None = None
        bias_score: float | None = None
        oscillators: dict[str, float] = {}
        moving_averages: dict[str, float] = {}
        atr_pct_label = _fallback_atr_label(bars)
    else:
        bias_label = result.summary_label
        bias_score = result.summary_score
        oscillators = _vote_scores(result.oscillators)
        moving_averages = _vote_scores(result.moving_averages)
        # Guaranteed known: bias.MIN_BARS (250) exceeds atr_percent's own 113-bar warm-up, so
        # result.volatility_label is never None whenever `result` itself is not "warming up".
        atr_pct_label = result.volatility_label or "normal"

    return CardBack(
        symbol=symbol,
        timeframe=timeframe,
        bias_label=bias_label,
        bias_score=bias_score,
        oscillators=oscillators,
        moving_averages=moving_averages,
        atr_pct_label=atr_pct_label,
        pivots=_pivots_for(bars, timeframe, asset),
    )


def _vote_scores(votes: dict[str, bias.Vote]) -> dict[str, float]:
    return {name: _VOTE_SCORE[vote.action] for name, vote in votes.items() if vote.action is not None}


def _fallback_atr_label(bars: pd.DataFrame) -> str:
    """Before 250 bars, the bias itself is unknown, but ATR%'s own 113-bar warm-up may already
    have passed -- show it then; "normal" otherwise, since `atr_pct_label` is not optional."""
    if len(bars) == 0:
        return "normal"
    label = indicators.atr_percent(bars, 14, 100).label
    last = label.iloc[-1] if len(label) else None
    return last if last is not None else "normal"


def _daily_hlc(bars: pd.DataFrame, timeframe: Timeframe, asset: Asset) -> pd.DataFrame:
    """A date-indexed high/low/close frame `pivots.prior_period_hlc` can read: `bars` themselves
    for "1D"/"1W" (already date-indexed, one row per day or week -- `evaluate()`'s own convention
    is regular-session-only daily bars, so these are assumed regular-session too), or one row per
    trading day's regular session aggregated from intraday bars otherwise. A "1W" bar back
    approximates its prior month from its own weekly rows -- there is no finer-grained daily frame
    in scope for a pure, single-frame function (see REPORT-L2.md)."""
    if len(bars) == 0:
        return pd.DataFrame(columns=["high", "low", "close"])
    if timeframe in ("1D", "1W"):
        return bars
    ann = annotate(bars, asset)
    regular = ann[ann["phase"] == "regular"]
    if regular.empty:
        return pd.DataFrame(columns=["high", "low", "close"])
    grouped = regular.groupby("day")
    return pd.DataFrame({"high": grouped["high"].max(), "low": grouped["low"].min(), "close": grouped["close"].last()})


def _next_trading_day(asset: Asset, day: date) -> date:
    """The trading day after `day` (which itself need not be one): the mirror of
    `ai_trading.core.calendar.previous_session`, which this module has no public equivalent of."""
    candidate = day + timedelta(days=1)
    while session(asset, candidate) is None:
        candidate += timedelta(days=1)
    return candidate


def _pivots_for(bars: pd.DataFrame, timeframe: Timeframe, asset: Asset) -> dict[str, float]:
    daily = _daily_hlc(bars, timeframe, asset)
    if daily.empty:
        return {}
    last_day = daily.index.max()
    # Daily/weekly bars are closed-bar only, so the most recent row is the last *completed*
    # period, not "today" -- the day pivots are actually shown for (and whose prior
    # week/month they need) is the next trading day after it. Intraday bars include today's own
    # still-forming session, so `last_day` itself is already the right reference there; computing
    # a next trading day from it would just return tomorrow and shift the lookup a day late.
    reference = _next_trading_day(asset, last_day) if timeframe in ("1D", "1W") else last_day
    high, low, close = pivots.prior_period_hlc(daily, pd.Index([reference]), asset, _PIVOT_PERIOD[timeframe])
    h, lo, c = float(high.iloc[0]), float(low.iloc[0]), float(close.iloc[0])
    if math.isnan(h) or math.isnan(lo) or math.isnan(c):
        return {}
    return pivots.classic_pivots(h, lo, c)
