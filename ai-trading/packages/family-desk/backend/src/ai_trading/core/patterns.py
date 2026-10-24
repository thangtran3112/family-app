"""Candlestick pattern detection on closed bars (02k section 3, 02l section e2).

The geometry is fixed textbook geometry, not user-tunable in v1. Every ratio is a share of the
candle's own high-low range, so it works at any price and on any cadence:

- doji: body <= 10% of range. Dragonfly: a doji with lower wick >= 60% and upper wick <= 10%.
  Gravestone: the mirror.
- hammer / hanging man: body >= 10%, lower wick >= 2x body, upper wick <= 10%. Inverted hammer /
  shooting star: the mirror. A hammer and a hanging man differ only by the trend before them.
- engulfing: the body covers the prior opposite body and is larger. Harami: the body sits inside a
  prior long body (>= 50% of its range). Piercing line / dark cloud cover: opens beyond the prior
  close and closes past the prior body's midpoint. Tweezer: equal extremes within 10% of the two
  candles' mean range. Inside bar: high below and low above the prior bar's.
- morning / evening star: a long first body (>= 50%), a small middle body (<= 30% of the first) whose
  midpoint lies beyond the first close, and a close past the first body's midpoint.
- three white soldiers / three black crows: three long bodies (>= 50%), each opening inside the prior
  body and closing beyond it, with a wick ahead of the move (upper for soldiers, lower for crows) of
  at most 30% of the body.
- A candle with no range (high == low) matches nothing, and every pattern with two or more candles
  also needs its prior candles to have a range.

The textbook thresholds are the ones that found 299 real occurrences across the 17 seed symbols on
Fri 2026-10-23 (the desktop-MVP snapshot, `tests/fixtures/patterns/`).

Trend: `after_downtrend` needs the close of the bar before the pattern's first candle to be below
the close `trendBars` bars earlier; `after_uptrend` mirrors it; `any` (or no trend) checks nothing.
`withinBars` N is true on the bar a pattern completes and on the next N-1 bars. Pass `groups` (one label
per bar, e.g. the trading day) to `detect` to keep that window inside a group: candles and trend still
read across groups, but a pattern never counts as "within" bars of a later group.

A bar is unknown (NA) while there are not enough earlier bars to decide, so `not pattern` stays
unknown there too; it is never false-by-default.
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd

#: Candles in each pattern, in the contract's `PATTERN_IDS` order.
PATTERN_CANDLES: dict[str, int] = {
    "hammer": 1,
    "inverted_hammer": 1,
    "hanging_man": 1,
    "shooting_star": 1,
    "doji": 1,
    "dragonfly_doji": 1,
    "gravestone_doji": 1,
    "bullish_engulfing": 2,
    "bearish_engulfing": 2,
    "bullish_harami": 2,
    "bearish_harami": 2,
    "piercing_line": 2,
    "dark_cloud_cover": 2,
    "morning_star": 3,
    "evening_star": 3,
    "tweezer_bottom": 2,
    "tweezer_top": 2,
    "three_white_soldiers": 3,
    "three_black_crows": 3,
    "inside_bar": 2,
}
DEFAULT_TREND_BARS = 5

_DOJI_BODY_MAX = 0.10
_LONG_WICK_MIN = 0.60
_SHADOW_MAX = 0.10  # the wick opposite the long one, as a share of the range
_LONG_BODY_MIN = 0.50
_STAR_BODY_MAX = 0.30  # the star's body against the first candle's body
_SOLDIER_WICK_MAX = 0.30  # the wick on the side of travel, against the candle's own body
_TWEEZER_TOLERANCE = 0.10


@dataclass(frozen=True)
class PatternOccurrence:
    """A pattern that completed on `bar_time` (the bar's start). `evidence` is the completing candle."""

    pattern: str
    bar_time: pd.Timestamp
    first_bar_time: pd.Timestamp
    evidence: dict[str, float]


@dataclass(frozen=True)
class Detection:
    """`truth` per bar (NA while undecided); `completed_at` is the row position of the most recent
    completing bar inside the `withinBars` window (NA where the pattern is not true)."""

    truth: pd.Series
    completed_at: pd.Series


def _shift(array: np.ndarray, by: int) -> np.ndarray:
    """`array` as seen `by` bars earlier: row k holds row k-by; NaN where there is no such row."""
    out = np.full(len(array), np.nan)
    if by < len(array):
        out[by:] = array[: len(array) - by]
    return out


class _Candles:
    """Open/high/low/close arrays plus each candle's shape."""

    def __init__(self, bars: pd.DataFrame) -> None:
        self.o, self.h, self.l, self.c = (bars[name].to_numpy(dtype=float) for name in ("open", "high", "low", "close"))
        self.n = len(bars)
        self.rng = self.h - self.l
        self.body = np.abs(self.c - self.o)
        self.up = self.h - np.maximum(self.o, self.c)
        self.lo = np.minimum(self.o, self.c) - self.l
        self.valid = self.rng > 0  # False for NaN too

    def share(self, part: np.ndarray) -> np.ndarray:
        """`part` / range, NaN where the range is 0 (every comparison with it is then False)."""
        out = np.full(self.n, np.nan)
        np.divide(part, self.rng, out=out, where=self.rng > 0)
        return out


def _prior(candles: _Candles, by: int) -> _Candles:
    """The candle `by` bars earlier, as a `_Candles` over the same rows."""
    prior = _Candles.__new__(_Candles)
    prior.n = candles.n
    for name in ("o", "h", "l", "c", "rng", "body", "up", "lo"):
        setattr(prior, name, _shift(getattr(candles, name), by))
    prior.valid = prior.rng > 0
    return prior


def geometry(bars: pd.DataFrame, pattern: str) -> np.ndarray:
    """True on each row where `pattern` completes (False where the candles before it do not exist)."""
    if pattern not in PATTERN_CANDLES:
        raise KeyError(pattern)
    k = _Candles(bars)
    with np.errstate(invalid="ignore"):
        match = _one_candle(pattern, k) if PATTERN_CANDLES[pattern] == 1 else _many_candles(pattern, k)
    return np.asarray(match & k.valid, dtype=bool)


def _one_candle(pattern: str, k: _Candles) -> np.ndarray:
    body, up, lo = k.share(k.body), k.share(k.up), k.share(k.lo)
    if pattern == "doji":
        return body <= _DOJI_BODY_MAX
    if pattern == "dragonfly_doji":
        return (body <= _DOJI_BODY_MAX) & (lo >= _LONG_WICK_MIN) & (up <= _SHADOW_MAX)
    if pattern == "gravestone_doji":
        return (body <= _DOJI_BODY_MAX) & (up >= _LONG_WICK_MIN) & (lo <= _SHADOW_MAX)
    if pattern in ("hammer", "hanging_man"):
        return (body >= _DOJI_BODY_MAX) & (k.lo >= 2 * k.body) & (k.up <= _SHADOW_MAX * k.rng)
    # inverted hammer, shooting star
    return (body >= _DOJI_BODY_MAX) & (k.up >= 2 * k.body) & (k.lo <= _SHADOW_MAX * k.rng)


def _many_candles(pattern: str, k: _Candles) -> np.ndarray:
    p = _prior(k, 1)
    bull, bear = k.c > k.o, k.c < k.o
    p_bull, p_bear = p.c > p.o, p.c < p.o
    p_long = p.share(p.body) >= _LONG_BODY_MIN
    base = p.valid
    if pattern == "inside_bar":
        return base & (k.h < p.h) & (k.l > p.l)
    if pattern == "bullish_engulfing":
        return base & p_bear & bull & (k.o <= p.c) & (k.c >= p.o) & (k.body > p.body)
    if pattern == "bearish_engulfing":
        return base & p_bull & bear & (k.o >= p.c) & (k.c <= p.o) & (k.body > p.body)
    if pattern == "bullish_harami":
        return base & p_bear & p_long & bull & (k.o >= p.c) & (k.c <= p.o) & (k.body < p.body)
    if pattern == "bearish_harami":
        return base & p_bull & p_long & bear & (k.o <= p.c) & (k.c >= p.o) & (k.body < p.body)
    mid_p = (p.o + p.c) / 2
    if pattern == "piercing_line":
        return base & p_bear & bull & (k.o < p.c) & (mid_p < k.c) & (k.c < p.o)
    if pattern == "dark_cloud_cover":
        return base & p_bull & bear & (k.o > p.c) & (p.o < k.c) & (k.c < mid_p)
    tolerance = _TWEEZER_TOLERANCE * (p.rng + k.rng) / 2
    if pattern == "tweezer_bottom":
        return base & p_bear & bull & (np.abs(p.l - k.l) <= tolerance)
    if pattern == "tweezer_top":
        return base & p_bull & bear & (np.abs(p.h - k.h) <= tolerance)
    a = _prior(k, 2)
    a_long = a.share(a.body) >= _LONG_BODY_MIN
    mid_a = (a.o + a.c) / 2
    mid_b = (p.o + p.c) / 2
    small_star = p.body <= _STAR_BODY_MAX * a.body
    if pattern == "morning_star":
        return base & a.valid & (a.c < a.o) & a_long & small_star & (mid_b < a.c) & bull & (k.c > mid_a)
    if pattern == "evening_star":
        return base & a.valid & (a.c > a.o) & a_long & small_star & (mid_b > a.c) & bear & (k.c < mid_a)
    # three soldiers / crows
    up_case = pattern == "three_white_soldiers"
    ok = base & a.valid
    for candle in (a, p, k):
        direction = candle.c > candle.o if up_case else candle.c < candle.o
        wick = candle.up if up_case else candle.lo
        ok = (
            ok
            & candle.valid
            & (candle.share(candle.body) >= _LONG_BODY_MIN)
            & direction
            & (wick <= _SOLDIER_WICK_MAX * candle.body)
        )
    for before, now in ((a, p), (p, k)):
        if up_case:
            ok = ok & (now.c > before.c) & (before.o < now.o) & (now.o < before.c)
        else:
            ok = ok & (now.c < before.c) & (before.c < now.o) & (now.o < before.o)
    return ok


def trend_holds(
    bars: pd.DataFrame, pattern: str, trend: str | None, trend_bars: int = DEFAULT_TREND_BARS
) -> np.ndarray:
    """True where the trend rule holds for a pattern completing on that row. `any`/None: always True;
    False where `trendBars` earlier bars do not exist."""
    n = len(bars)
    if trend in (None, "any"):
        return np.ones(n, dtype=bool)
    candles = PATTERN_CANDLES[pattern]
    close = bars["close"].to_numpy(dtype=float)
    before = _shift(close, candles)  # close of the bar before the first candle
    earlier = _shift(close, candles + trend_bars)
    with np.errstate(invalid="ignore"):
        return np.asarray(before < earlier if trend == "after_downtrend" else before > earlier, dtype=bool)


def _bars_needed(pattern: str, trend: str | None, trend_bars: int) -> int:
    """Row index from which `pattern` (with `trend`) can be decided: earlier rows are unknown."""
    candles = PATTERN_CANDLES[pattern]
    return candles + trend_bars if trend not in (None, "any") else candles - 1


def detect(
    bars: pd.DataFrame,
    pattern: str,
    *,
    trend: str | None = None,
    trend_bars: int = DEFAULT_TREND_BARS,
    within_bars: int = 1,
    groups: np.ndarray | None = None,
) -> Detection:
    """Truth of `pattern` (with `trend`, within the last `within_bars` bars) on every row of `bars`.

    `bars` is closed OHLC bars, oldest first; a row's candles are the rows before it, whatever the gap
    between them (a session boundary included). With `groups`, the `within_bars` window of a row holds
    only the rows of its own group."""
    n = len(bars)
    rows = np.arange(n)
    matched = geometry(bars, pattern) & trend_holds(bars, pattern, trend, trend_bars)
    known = rows >= _bars_needed(pattern, trend, trend_bars)
    window_any = np.zeros(n, dtype=bool)
    window_known = np.ones(n, dtype=bool)
    latest = np.full(n, -1)
    for back in range(within_bars):
        exists = rows >= back
        in_window = exists.copy()
        if groups is not None and back < n:
            in_window[back:] = np.asarray(groups)[back:] == np.asarray(groups)[: n - back]
            in_window[:back] = False
        match_back = np.zeros(n, dtype=bool)
        known_back = np.zeros(n, dtype=bool)
        if back < n:
            match_back[back:] = matched[: n - back]
            known_back[back:] = known[: n - back]
        window_any |= in_window & match_back
        latest = np.maximum(latest, np.where(in_window & match_back, rows - back, -1))
        # An absent row makes the window unknown, unless the group's own start cut the window there.
        window_known &= known_back | (~in_window if groups is not None else False)
    values = pd.array(window_any, dtype="boolean")
    values[~(window_any | window_known)] = pd.NA
    completed = pd.array(np.where(latest >= 0, latest, 0), dtype="Int64")
    completed[latest < 0] = pd.NA
    return Detection(pd.Series(values, index=bars.index), pd.Series(completed, index=bars.index))


def candle_evidence(bars: pd.DataFrame, position: int) -> dict[str, float]:
    """The candle at row `position`: its prices and its body and wicks as a percentage of its range."""
    row = bars.iloc[position]
    o, h, low, c = (float(row[name]) for name in ("open", "high", "low", "close"))
    rng = h - low
    evidence = {"open": o, "high": h, "low": low, "close": c}
    if rng > 0:
        evidence |= {
            "bodyPct": 100 * abs(c - o) / rng,
            "upperWickPct": 100 * (h - max(o, c)) / rng,
            "lowerWickPct": 100 * (min(o, c) - low) / rng,
        }
    return {key: round(value, 6) for key, value in evidence.items()}


def occurrences(
    bars: pd.DataFrame,
    pattern: str,
    *,
    trend: str | None = None,
    trend_bars: int = DEFAULT_TREND_BARS,
) -> list[PatternOccurrence]:
    """Every bar `pattern` completes on (with `trend`), oldest first."""
    matched = geometry(bars, pattern) & trend_holds(bars, pattern, trend, trend_bars)
    first_offset = PATTERN_CANDLES[pattern] - 1
    return [
        PatternOccurrence(pattern, bars.index[row], bars.index[row - first_offset], candle_evidence(bars, int(row)))
        for row in np.flatnonzero(matched)
    ]
