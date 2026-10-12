"""Desk Technical Bias: TradingView's published -1/0/+1 votes over 11 oscillators and 15 moving
averages/filters (02f section 3), scored into an oscillator, moving-average, and summary rating.

Rule sources, and a conflict between them:
- https://www.tradingview.com/support/solutions/43000614331-technical-ratings/ (canonical: the
  Technical Ratings page says these are the same ratings the Screener columns and Technicals
  gauges show, so it is the tie-breaker when the two disagree)
- https://www.tradingview.com/support/solutions/43000475547-what-do-the-ratings-in-the-screener-mean/

The two pages disagree on ADX's Sell condition: Technical Ratings says ADX must be *falling*
(the opposite of Buy's rising requirement); the Screener page says "rising", the same as Buy.
This module follows Technical Ratings (see `_adx_vote` and REPORT-C.md's Decisions).

Two rules those pages state but do not define ("uptrend"/"downtrend" for Stoch RSI and Bull/Bear
Power) use this module's own definition; see `_trend`'s docstring and REPORT-C.md's Decisions.
Everything else below is TradingView's rule read literally, including the one other surprising
rule it documents plainly: Ultimate Oscillator buys above 70 and sells below 70 (not the usual
overbought/oversold reading).
"""

import math
from dataclasses import dataclass
from typing import Literal

import pandas as pd

from ai_trading.core import indicators
from ai_trading.core.indicators import Adx, BullBearPower, Ichimoku, Macd, Stochastic, StochRsi

MIN_BARS = 250  # 02f §3: fewer closed bars than this returns "warming up" instead of a bias.
_TREND_LENGTH = 50

Action = Literal["Sell", "Neutral", "Buy"]
Label = Literal["Strong Sell", "Sell", "Neutral", "Buy", "Strong Buy"]
_SCORE: dict[Action, float] = {"Sell": -1.0, "Neutral": 0.0, "Buy": 1.0}


@dataclass(frozen=True)
class Vote:
    """One voting indicator's named sub-values (e.g. `{"value": 61.8}` or `{"k": 86.2, "d": 71.4}`,
    for the Technicals page tables) and its action. `action` is `None` when a value the rule needs
    is unknown: it never votes (02f §3's "unknown data never votes")."""

    values: dict[str, float]
    action: Action | None


@dataclass(frozen=True)
class VoteCounts:
    sell: int
    neutral: int
    buy: int


@dataclass(frozen=True)
class Bias:
    oscillators: dict[str, Vote]
    moving_averages: dict[str, Vote]
    oscillator_counts: VoteCounts
    ma_counts: VoteCounts
    oscillator_score: float  # mean of the known oscillator votes; math.nan if none are known
    ma_score: float
    summary_score: float  # mean of oscillator_score and ma_score; math.nan if either is
    oscillator_label: Label | None  # None only when oscillator_score is math.nan
    ma_label: Label | None
    summary_label: Label | None
    atr_pct: float  # ATR(14) as a percent of price; math.nan until known. Never votes (02f §3).
    volatility_label: str | None  # "low" | "normal" | "high"; None until known


def label(score: float) -> Label | None:
    """02f §3's table, with the boundaries exactly as published: Strong Sell below -0.5; Sell
    from -0.5 up to -0.1 (exclusive); Neutral from -0.1 to +0.1 inclusive; Buy above +0.1 up to
    +0.5; Strong Buy above +0.5. `None` only for an unknown (`math.nan`) score."""
    if math.isnan(score):
        return None
    if score < -0.5:
        return "Strong Sell"
    if score < -0.1:
        return "Sell"
    if score <= 0.1:
        return "Neutral"
    if score <= 0.5:
        return "Buy"
    return "Strong Buy"


def _last(values: pd.Series) -> float:
    return float(values.iloc[-1]) if len(values) else math.nan


def _last_two(values: pd.Series) -> tuple[float, float]:
    if len(values) < 2:
        return math.nan, math.nan
    return float(values.iloc[-1]), float(values.iloc[-2])


def _last_three(values: pd.Series) -> tuple[float, float, float]:
    if len(values) < 3:
        return math.nan, math.nan, math.nan
    return float(values.iloc[-1]), float(values.iloc[-2]), float(values.iloc[-3])


def _extreme_turn_vote(values: pd.Series, buy_below: float, sell_above: float) -> Vote:
    """Buy below `buy_below` and rising; Sell above `sell_above` and falling; else Neutral. RSI's,
    CCI's, and Williams %R's rule, read literally off both rule pages."""
    cur, prev = _last_two(values)
    out = {"value": cur}
    if math.isnan(cur) or math.isnan(prev):
        return Vote(out, None)
    if cur < buy_below and cur > prev:
        return Vote(out, "Buy")
    if cur > sell_above and cur < prev:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _stochastic_vote(st: Stochastic) -> Vote:
    k, d = _last(st.k), _last(st.d)
    out = {"k": k, "d": d}
    if math.isnan(k) or math.isnan(d):
        return Vote(out, None)
    if k < 20 and d < 20 and k > d:
        return Vote(out, "Buy")
    if k > 80 and d > 80 and k < d:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _adx_vote(a: Adx) -> Vote:
    """Buy: +DI > -DI, ADX > 20, and ADX rising. Sell: +DI < -DI, ADX > 20, and ADX FALLING --
    Technical Ratings' own rule (canonical; see the module docstring), the opposite of Buy's
    rising requirement and of the Screener page's "rising" wording for Sell."""
    plus, minus = _last(a.plus_di), _last(a.minus_di)
    cur, prev = _last_two(a.adx)
    out = {"adx": cur, "plus_di": plus, "minus_di": minus}
    if math.isnan(plus) or math.isnan(minus) or math.isnan(cur) or math.isnan(prev):
        return Vote(out, None)
    if plus > minus and cur > 20 and cur > prev:
        return Vote(out, "Buy")
    if plus < minus and cur > 20 and cur < prev:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _awesome_oscillator_vote(ao: pd.Series) -> Vote:
    """Buy on a cross over 0, or two consecutive bars above 0 turning up (current > previous and
    previous < two bars back). Sell is the mirror. TradingView's own "saucer" wording for its
    Technical Ratings indicator (the rule page's shorter text is this one in other words)."""
    cur, prev, prev2 = _last_three(ao)
    out = {"value": cur}
    if math.isnan(cur) or math.isnan(prev) or math.isnan(prev2):
        return Vote(out, None)
    crosses_over, crosses_under = prev <= 0 < cur, prev >= 0 > cur
    turns_up = cur > 0 and prev > 0 and cur > prev and prev < prev2
    turns_down = cur < 0 and prev < 0 and cur < prev and prev > prev2
    if crosses_over or turns_up:
        return Vote(out, "Buy")
    if crosses_under or turns_down:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _momentum_vote(values: pd.Series) -> Vote:
    cur, prev = _last_two(values)
    out = {"value": cur}
    if math.isnan(cur) or math.isnan(prev):
        return Vote(out, None)
    if cur > prev:
        return Vote(out, "Buy")
    if cur < prev:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _macd_vote(m: Macd) -> Vote:
    line, signal = _last(m.line), _last(m.signal)
    out = {"line": line, "signal": signal}
    if math.isnan(line) or math.isnan(signal):
        return Vote(out, None)
    if line > signal:
        return Vote(out, "Buy")
    if line < signal:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _stoch_rsi_vote(sr: StochRsi, uptrend: bool, downtrend: bool) -> Vote:
    k, d = _last(sr.k), _last(sr.d)
    out = {"k": k, "d": d}
    if math.isnan(k) or math.isnan(d):
        return Vote(out, None)
    if downtrend and k < 20 and d < 20 and k > d:
        return Vote(out, "Buy")
    if uptrend and k > 80 and d > 80 and k < d:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _bull_bear_power_vote(bb: BullBearPower, uptrend: bool, downtrend: bool) -> Vote:
    bull_cur, bull_prev = _last_two(bb.bull)
    bear_cur, bear_prev = _last_two(bb.bear)
    out = {"bull": bull_cur, "bear": bear_cur}
    if math.isnan(bull_cur) or math.isnan(bull_prev) or math.isnan(bear_cur) or math.isnan(bear_prev):
        return Vote(out, None)
    if uptrend and bear_cur < 0 and bear_cur > bear_prev:
        return Vote(out, "Buy")
    if downtrend and bull_cur > 0 and bull_cur < bull_prev:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _ultimate_oscillator_vote(values: pd.Series) -> Vote:
    """Buy above 70, Sell below 30 -- TradingView's own rule, stated identically on both rule
    pages; the inverse of the usual overbought/oversold reading, kept as published."""
    cur = _last(values)
    out = {"value": cur}
    if math.isnan(cur):
        return Vote(out, None)
    if cur > 70:
        return Vote(out, "Buy")
    if cur < 30:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _ma_vote(value: float, price: float) -> Vote:
    out = {"value": value}
    if math.isnan(value) or math.isnan(price):
        return Vote(out, None)
    if value < price:
        return Vote(out, "Buy")
    if value > price:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _ichimoku_vote(ic: Ichimoku, price: float) -> Vote:
    conversion, base = _last(ic.conversion), _last(ic.base)
    span_a, span_b = _last(ic.span_a), _last(ic.span_b)
    out = {"conversion": conversion, "base": base, "span_a": span_a, "span_b": span_b}
    if any(math.isnan(v) for v in (conversion, base, span_a, span_b, price)):
        return Vote(out, None)
    if span_a > span_b and base > span_a and conversion > base and price > conversion:
        return Vote(out, "Buy")
    if span_a < span_b and base < span_a and conversion < base and price < conversion:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _trend(close: pd.Series, length: int = _TREND_LENGTH) -> tuple[bool, bool]:
    """Both rule pages use "uptrend"/"downtrend" for Stoch RSI's and Bull/Bear Power's votes
    without defining either term (unlike "rising"/"falling", which they define as a change from
    the previous bar). Decision (REPORT-C.md): price above its own SMA(50) is an uptrend, below is
    a downtrend; neither (so both votes stay Neutral) when they are equal or either is unknown."""
    sma = indicators.sma(close, length)
    price, baseline = _last(close), _last(sma)
    if math.isnan(price) or math.isnan(baseline):
        return False, False
    return price > baseline, price < baseline


def _score_group(votes: dict[str, Vote]) -> tuple[VoteCounts, float]:
    actions = [v.action for v in votes.values() if v.action is not None]
    counts = VoteCounts(
        sell=sum(1 for a in actions if a == "Sell"),
        neutral=sum(1 for a in actions if a == "Neutral"),
        buy=sum(1 for a in actions if a == "Buy"),
    )
    score = sum(_SCORE[a] for a in actions) / len(actions) if actions else math.nan
    return counts, score


_MA_LENGTHS = (10, 20, 30, 50, 100, 200)


def bias(bars: pd.DataFrame) -> Bias | Literal["warming up"]:
    """The Desk Technical Bias: TradingView's 11 oscillator votes and 15 moving-average/filter
    votes (02f §3), scored into an oscillator score, a moving-average score, and their mean (the
    summary), each with its Strong Sell..Strong Buy label; plus ATR's volatility label (no vote).

    `bars` is closed-bar OHLCV (columns `high`, `low`, `close`, `volume`), oldest first, matching
    every other `ai_trading.core.indicators` function's convention. Fewer than `MIN_BARS` (250)
    rows returns the literal string `"warming up"` instead of a `Bias` (02f §3). Every vote reads
    only the bars given; closed-bar and look-ahead discipline is the caller's (it passes only bars
    already closed as of the time being evaluated).
    """
    if len(bars) < MIN_BARS:
        return "warming up"
    close = bars["close"]
    price = _last(close)
    uptrend, downtrend = _trend(close)

    oscillators: dict[str, Vote] = {
        "rsi": _extreme_turn_vote(indicators.rsi(close, 14), buy_below=30, sell_above=70),
        "stochastic": _stochastic_vote(indicators.stochastic(bars, 14, 3, 3)),
        "cci": _extreme_turn_vote(indicators.cci(bars, 20), buy_below=-100, sell_above=100),
        "adx": _adx_vote(indicators.adx(bars, 14)),
        "awesome_oscillator": _awesome_oscillator_vote(indicators.awesome_oscillator(bars, 5, 34)),
        "momentum": _momentum_vote(indicators.momentum(close, 10)),
        "macd": _macd_vote(indicators.macd(close, 12, 26, 9)),
        "stoch_rsi": _stoch_rsi_vote(indicators.stoch_rsi(close, 3, 3, 14, 14), uptrend, downtrend),
        "williams_r": _extreme_turn_vote(indicators.williams_r(bars, 14), buy_below=-80, sell_above=-20),
        "bull_bear_power": _bull_bear_power_vote(indicators.bull_bear_power(bars, 13), uptrend, downtrend),
        "ultimate_oscillator": _ultimate_oscillator_vote(indicators.ultimate_oscillator(bars, 7, 14, 28)),
    }

    moving_averages: dict[str, Vote] = {}
    for length in _MA_LENGTHS:
        moving_averages[f"sma_{length}"] = _ma_vote(_last(indicators.sma(close, length)), price)
    for length in _MA_LENGTHS:
        moving_averages[f"ema_{length}"] = _ma_vote(_last(indicators.ema(close, length)), price)
    moving_averages["vwma_20"] = _ma_vote(_last(indicators.vwma(bars, 20)), price)
    moving_averages["hull_ma_9"] = _ma_vote(_last(indicators.hull_ma(close, 9)), price)
    moving_averages["ichimoku"] = _ichimoku_vote(indicators.ichimoku(bars, 9, 26, 52), price)

    oscillator_counts, oscillator_score = _score_group(oscillators)
    ma_counts, ma_score = _score_group(moving_averages)
    summary_score = (
        math.nan if math.isnan(oscillator_score) or math.isnan(ma_score) else (oscillator_score + ma_score) / 2
    )

    atr_percent = indicators.atr_percent(bars, 14, 100)
    return Bias(
        oscillators=oscillators,
        moving_averages=moving_averages,
        oscillator_counts=oscillator_counts,
        ma_counts=ma_counts,
        oscillator_score=oscillator_score,
        ma_score=ma_score,
        summary_score=summary_score,
        oscillator_label=label(oscillator_score),
        ma_label=label(ma_score),
        summary_label=label(summary_score),
        atr_pct=_last(atr_percent.pct),
        volatility_label=atr_percent.label.iloc[-1] if len(atr_percent.label) else None,
    )
