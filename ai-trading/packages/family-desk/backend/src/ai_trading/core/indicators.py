"""Indicators over bar series. Every value uses only its own and earlier bars."""

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from ai_trading.core.calendar import ET


def sma(values: pd.Series, length: int) -> pd.Series:
    return values.rolling(length, min_periods=length).mean()


def ema(values: pd.Series, length: int) -> pd.Series:
    return values.ewm(span=length, adjust=False, min_periods=length).mean()


def _wilder(values: pd.Series, length: int) -> pd.Series:
    """Wilder's smoothing, seeded by the mean of the first `length` valid values:
    avg_t = (avg_{t-1} * (length - 1) + x_t) / length for every later value."""
    valid = np.flatnonzero(values.notna().to_numpy())
    if len(valid) < length:
        return pd.Series(np.nan, index=values.index)
    seed_at = valid[length - 1]
    seeded = values.copy()
    seeded.iloc[:seed_at] = np.nan
    seeded.iloc[seed_at] = values.iloc[valid[:length]].mean()
    return seeded.ewm(alpha=1 / length, adjust=False).mean()


def rsi(close: pd.Series, length: int) -> pd.Series:
    """Wilder's RSI. 100 when there were no losses, 0 when there were no gains."""
    delta = close.diff()
    gain = _wilder(delta.clip(lower=0), length)
    loss = _wilder(-delta.clip(upper=0), length)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = 100 - 100 / (1 + gain / loss)
    return out.where(~((gain == 0) & (loss == 0)), 50.0)


def _true_range(bars: pd.DataFrame) -> pd.Series:
    """max(high, prior close) - min(low, prior close): equal to the usual max(H-L, |H-PC|, |L-PC|),
    without a prior close (the first bar) this is just H-L."""
    prev_close = bars["close"].shift(1)
    upper = pd.concat([bars["high"], prev_close], axis=1).max(axis=1)
    lower = pd.concat([bars["low"], prev_close], axis=1).min(axis=1)
    return upper - lower


def atr(bars: pd.DataFrame, length: int) -> pd.Series:
    """Wilder's average true range."""
    return _wilder(_true_range(bars), length)


@dataclass(frozen=True)
class Macd:
    line: pd.Series
    signal: pd.Series
    histogram: pd.Series


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Macd:
    """MACD line (EMA(fast) - EMA(slow)), its signal line (EMA(signal) of the MACD line), and
    their difference. NaN until `slow` bars for the line, `slow + signal - 1` for the signal and
    histogram (34 for the default 12,26,9)."""
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    return Macd(line, sig, line - sig)


@dataclass(frozen=True)
class Stochastic:
    k: pd.Series  # slow %K
    d: pd.Series


def stochastic(bars: pd.DataFrame, length: int = 14, smooth_k: int = 3, smooth_d: int = 3) -> Stochastic:
    """Slow %K (an SMA(smooth_k) of the raw %K) and %D (an SMA(smooth_d) of slow %K). Raw %K is
    100 x (close - lowestLow(length)) / (highestHigh(length) - lowestLow(length)), 50 when that
    range is zero. NaN until `length + smooth_k + smooth_d - 2` bars (18 for the default 14,3,3)."""
    lowest = bars["low"].rolling(length, min_periods=length).min()
    highest = bars["high"].rolling(length, min_periods=length).max()
    span = highest - lowest
    with np.errstate(divide="ignore", invalid="ignore"):
        raw_k = 100 * (bars["close"] - lowest) / span
    raw_k = raw_k.where(span != 0, 50.0)
    k = sma(raw_k, smooth_k)
    return Stochastic(k, sma(k, smooth_d))


@dataclass(frozen=True)
class StochRsi:
    k: pd.Series
    d: pd.Series


def stoch_rsi(
    close: pd.Series, smooth_k: int = 3, smooth_d: int = 3, rsi_length: int = 14, stoch_length: int = 14
) -> StochRsi:
    """A stochastic of Wilder's RSI(rsi_length) over its own `stoch_length`-bar range, scaled
    0-100 and smoothed into %K (SMA(smooth_k)) and %D (SMA(smooth_d) of %K). 50 when the RSI range
    is zero. NaN until `rsi_length + stoch_length + smooth_k + smooth_d - 2` bars (32 for the
    default 3,3,14,14)."""
    rsi_values = rsi(close, rsi_length)
    lowest = rsi_values.rolling(stoch_length, min_periods=stoch_length).min()
    highest = rsi_values.rolling(stoch_length, min_periods=stoch_length).max()
    span = highest - lowest
    with np.errstate(divide="ignore", invalid="ignore"):
        raw = 100 * (rsi_values - lowest) / span
    raw = raw.where(span != 0, 50.0)
    k = sma(raw, smooth_k)
    return StochRsi(k, sma(k, smooth_d))


def cci(bars: pd.DataFrame, length: int = 20) -> pd.Series:
    """(typical price - its SMA(length)) / (0.015 x the mean absolute deviation of the typical
    price from that SMA, over the same window). 0 when every bar in the window has the same
    typical price. NaN until `length` bars."""
    typical = (bars["high"] + bars["low"] + bars["close"]) / 3
    mean = sma(typical, length)
    mad = typical.rolling(length, min_periods=length).apply(lambda w: np.abs(w - w.mean()).mean(), raw=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = (typical - mean) / (0.015 * mad)
    return out.where(mad != 0, 0.0)


@dataclass(frozen=True)
class Adx:
    adx: pd.Series
    plus_di: pd.Series
    minus_di: pd.Series


def adx(bars: pd.DataFrame, length: int = 14) -> Adx:
    """Wilder's ADX and +DI/-DI. NaN for +DI/-DI until `length` bars, and for ADX until
    `2 * length - 1` bars (27 for the default 14): +DI/-DI need `length` bars of Wilder-smoothed
    true range and directional movement, then ADX needs another `length` bars of DX to smooth.

    Adapted from Vibe-Trading `agent/src/skills/technical-basic/example_signal_engine.py`
    (`compute_adx`, commit d402c2d; MIT License, see THIRD_PARTY_NOTICES.md). Changes: this
    module's Wilder seeding rule (the mean of the first `length` valid values, via `_wilder`)
    instead of an EWM-only smoothing with no explicit seed.
    """
    high, low = bars["high"], bars["low"]
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=bars.index)
    minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=bars.index)
    smoothed_tr = _wilder(_true_range(bars), length)
    smoothed_plus_dm = _wilder(plus_dm, length)
    smoothed_minus_dm = _wilder(minus_dm, length)
    with np.errstate(divide="ignore", invalid="ignore"):
        plus_di = 100 * smoothed_plus_dm / smoothed_tr
        minus_di = 100 * smoothed_minus_dm / smoothed_tr
        dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    return Adx(_wilder(dx, length), plus_di, minus_di)


def awesome_oscillator(bars: pd.DataFrame, fast: int = 5, slow: int = 34) -> pd.Series:
    """SMA(fast) minus SMA(slow) of the median price (high + low) / 2. NaN until `slow` bars."""
    median_price = (bars["high"] + bars["low"]) / 2
    return sma(median_price, fast) - sma(median_price, slow)


def momentum(close: pd.Series, length: int = 10) -> pd.Series:
    """Close minus the close `length` bars ago. NaN until `length + 1` bars."""
    return close.diff(length)


def williams_r(bars: pd.DataFrame, length: int = 14) -> pd.Series:
    """-100 x (highestHigh(length) - close) / (highestHigh(length) - lowestLow(length)). -50 when
    that range is zero. NaN until `length` bars."""
    highest = bars["high"].rolling(length, min_periods=length).max()
    lowest = bars["low"].rolling(length, min_periods=length).min()
    span = highest - lowest
    with np.errstate(divide="ignore", invalid="ignore"):
        out = -100 * (highest - bars["close"]) / span
    return out.where(span != 0, -50.0)


@dataclass(frozen=True)
class BullBearPower:
    bull: pd.Series  # high - EMA(length)
    bear: pd.Series  # low - EMA(length)


def bull_bear_power(bars: pd.DataFrame, length: int = 13) -> BullBearPower:
    """High minus EMA(length) of the close (bull power), and low minus that same EMA (bear
    power). NaN until `length` bars."""
    baseline = ema(bars["close"], length)
    return BullBearPower(bars["high"] - baseline, bars["low"] - baseline)


def ultimate_oscillator(bars: pd.DataFrame, fast: int = 7, mid: int = 14, slow: int = 28) -> pd.Series:
    """Larry Williams' Ultimate Oscillator: a 4:2:1-weighted blend of buying pressure over true
    range (see `_true_range`) at three lookbacks, where buying pressure is the close minus the
    lesser of the low and the prior close. NaN until `slow` bars (28 for the default 7,14,28)."""
    prev_close = bars["close"].shift(1)
    lower = pd.concat([bars["low"], prev_close], axis=1).min(axis=1)
    buying_pressure = bars["close"] - lower
    true_range = _true_range(bars)

    def average(length: int) -> pd.Series:
        bp_sum = buying_pressure.rolling(length, min_periods=length).sum()
        tr_sum = true_range.rolling(length, min_periods=length).sum()
        return bp_sum / tr_sum.replace(0, np.nan)

    return 100 * (4 * average(fast) + 2 * average(mid) + average(slow)) / 7


def vwma(bars: pd.DataFrame, length: int = 20) -> pd.Series:
    """Volume-weighted moving average of the close. NaN until `length` bars, or wherever the
    window's total volume is zero."""
    pv_sum = (bars["close"] * bars["volume"]).rolling(length, min_periods=length).sum()
    vol_sum = bars["volume"].rolling(length, min_periods=length).sum()
    return pv_sum / vol_sum.replace(0, np.nan)


def _wma(values: pd.Series, length: int) -> pd.Series:
    """Linearly weighted moving average: the most recent bar weighs `length`, the oldest weighs 1."""
    weights = np.arange(1, length + 1)
    return values.rolling(length, min_periods=length).apply(lambda w: np.dot(w, weights) / weights.sum(), raw=True)


def hull_ma(close: pd.Series, length: int = 9) -> pd.Series:
    """Hull moving average: WMA(2 x WMA(close, length // 2) - WMA(close, length), round(sqrt(length))).
    NaN until `length + round(sqrt(length)) - 1` bars (11 for the default 9)."""
    half = max(1, length // 2)
    root = max(1, round(math.sqrt(length)))
    raw = 2 * _wma(close, half) - _wma(close, length)
    return _wma(raw, root)


@dataclass(frozen=True)
class Ichimoku:
    conversion: pd.Series  # tenkan-sen
    base: pd.Series  # kijun-sen
    span_a: pd.Series  # senkou span A
    span_b: pd.Series  # senkou span B


def ichimoku(
    bars: pd.DataFrame, conversion_length: int = 9, base_length: int = 26, span_b_length: int = 52
) -> Ichimoku:
    """Conversion (tenkan-sen) and base (kijun-sen) lines, each the midpoint of the highest high
    and lowest low over its own length, and leading spans A (midpoint of conversion and base) and
    B (the same midpoint over `span_b_length`) -- all as they stand at each bar, with no forward
    shift. A traditional chart plots a leading span `base_length` bars ahead of the bar it was
    computed from, so a chart's value at bar t + base_length is this function's span_a/span_b
    value at bar t; shifting is left to the chart, so this never exposes an unclosed future bar as
    the "current" value. NaN until `conversion_length`, `base_length`, and `span_b_length` bars
    respectively (span_a needs `base_length`, the larger of the two).

    Adapted from Vibe-Trading `agent/src/skills/ichimoku/example_signal_engine.py`
    (`_donchian_mid`, commit d402c2d; MIT License, see THIRD_PARTY_NOTICES.md). Changes: no
    forward displacement, and conversion/base/span_a/span_b values only, no TK-cross signal.
    """

    def donchian_mid(length: int) -> pd.Series:
        highest = bars["high"].rolling(length, min_periods=length).max()
        lowest = bars["low"].rolling(length, min_periods=length).min()
        return (highest + lowest) / 2

    conversion = donchian_mid(conversion_length)
    base = donchian_mid(base_length)
    return Ichimoku(conversion, base, (conversion + base) / 2, donchian_mid(span_b_length))


@dataclass(frozen=True)
class AtrPercent:
    pct: pd.Series  # ATR(length) / close * 100
    label: pd.Series  # "low", "normal", "high", or None until the median is known


def atr_percent(bars: pd.DataFrame, length: int = 14, median_length: int = 100) -> AtrPercent:
    """ATR(length) as a percent of the close, and a volatility label against its own trailing
    `median_length`-bar median: "low" below 0.8x that median, "high" above 1.25x, "normal"
    otherwise. The label is None until the median is known. NaN/None until
    `length + median_length - 1` bars (113 for the default 14,100)."""
    pct = atr(bars, length) / bars["close"] * 100
    median = pct.rolling(median_length, min_periods=median_length).median()
    labels = np.select([pct < 0.8 * median, pct > 1.25 * median], ["low", "high"], default="normal")
    return AtrPercent(pct, pd.Series(labels, index=bars.index, dtype=object).where(median.notna(), None))


def session_vwap(ann: pd.DataFrame) -> pd.Series:
    """VWAP of each day's regular session; NaN outside regular hours. `ann` comes from annotate()."""
    regular = ann[ann["phase"] == "regular"]
    typical = (regular["high"] + regular["low"] + regular["close"]) / 3
    weighted = (typical * regular["volume"]).groupby(regular["day"]).cumsum()
    volume = regular["volume"].groupby(regular["day"]).cumsum()
    return (weighted / volume.replace(0, np.nan)).reindex(ann.index)


def rvol_intraday(ann: pd.DataFrame, lookback_days: int) -> pd.Series:
    """Volume so far in this day's phase, over its average at the same clock time on the
    previous `lookback_days` days that have data. NaN until that much history exists."""
    cumulative = ann["volume"].groupby([ann["day"], ann["phase"]]).cumsum()
    key = pd.MultiIndex.from_arrays([ann["phase"], ann.index.tz_convert(ET).strftime("%H:%M")])
    table = (
        pd.Series(
            cumulative.to_numpy(),
            index=pd.MultiIndex.from_arrays([ann["day"], key.get_level_values(0), key.get_level_values(1)]),
        )
        .unstack([1, 2])
        .sort_index()
    )
    table = table.T.groupby(level=0).ffill().T
    baseline = table.shift(1).rolling(lookback_days, min_periods=lookback_days).mean()
    lookup = baseline.stack([0, 1], future_stack=True)
    rows = pd.MultiIndex.from_arrays([ann["day"], key.get_level_values(0), key.get_level_values(1)])
    expected = lookup.reindex(rows).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        out = cumulative.to_numpy() / np.where(expected > 0, expected, np.nan)
    return pd.Series(out, index=ann.index)


def rvol_daily(daily: pd.DataFrame, lookback_days: int) -> pd.Series:
    """Each day's volume over the average of the previous `lookback_days` days."""
    expected = daily["volume"].shift(1).rolling(lookback_days, min_periods=lookback_days).mean()
    return daily["volume"] / expected.replace(0, np.nan)
