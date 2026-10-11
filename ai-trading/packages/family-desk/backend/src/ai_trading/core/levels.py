"""Price levels. A level is NaN until the window that defines it has closed, so it never moves
while a rule is using it."""

import numpy as np
import pandas as pd

from ai_trading.core.calendar import Asset, previous_session, session


def prior_day(daily: pd.DataFrame, days: pd.Index, asset: Asset, column: str) -> pd.Series:
    """`column` ("high", "low", "close") of the trading day before each of `days`, from regular-
    session daily bars indexed by date. NaN when that day's bar is missing."""
    previous = [previous_session(asset, day) for day in days]
    return pd.Series(daily[column].reindex(previous).to_numpy(), index=days)


def n_day(daily: pd.DataFrame, days: pd.Index, count: int, column: str) -> pd.Series:
    """Highest high ("high") or lowest low ("low") of the `count` daily bars before each of
    `days`. NaN without `count` bars of history."""
    values = daily[column]
    window = values.rolling(count, min_periods=count)
    rolled = (window.max() if column == "high" else window.min()).to_numpy()
    last_before = values.index.searchsorted(days, side="left") - 1
    out = np.where(last_before >= 0, rolled[np.clip(last_before, 0, None)], np.nan)
    return pd.Series(out, index=days, dtype=float)


def pre_phase(ann: pd.DataFrame, side: str) -> pd.Series:
    """High ("high") or low ("low") of each day's pre phase (stock pre-market, futures overnight),
    known from the regular open on. Aligned to `ann`'s index."""
    pre = ann[ann["phase"] == "pre"]
    grouped = pre[side].groupby(pre["day"])
    per_day = grouped.max() if side == "high" else grouped.min()
    known = ann["phase"] != "pre"
    return pd.Series(ann["day"].map(per_day).to_numpy(), index=ann.index).where(known)


def opening_range(ann: pd.DataFrame, asset: Asset, minutes: int, side: str) -> pd.Series:
    """High or low of the first `minutes` of each regular session, known from the bar that
    starts when the range ends. NaN on days whose session is shorter than the range."""
    out = pd.Series(float("nan"), index=ann.index)
    for day, rows in ann.groupby("day").groups.items():
        found = session(asset, day)
        end = found.regular_open + pd.Timedelta(minutes=minutes)
        if end > found.regular_close:
            continue
        day_bars = ann.loc[rows]
        window = day_bars[(day_bars.index >= found.regular_open) & (day_bars.index < end)]
        if window.empty:
            continue
        value = window["high"].max() if side == "high" else window["low"].min()
        out.loc[day_bars.index[day_bars.index >= end]] = value
    return out


def _clusters(prices: list[float], count: int) -> list[float]:
    """Centers of the `count` most-touched price clusters (prices within 5% of the range)."""
    if len(prices) <= count:
        return sorted(prices)
    ordered = sorted(prices)
    spread = ordered[-1] - ordered[0]
    threshold = spread * 0.05 if spread > 0 else 1.0
    groups: list[list[float]] = [[ordered[0]]]
    for price in ordered[1:]:
        if abs(price - float(np.mean(groups[-1]))) <= threshold:
            groups[-1].append(price)
        else:
            groups.append([price])
    ranked = sorted(((len(group), float(np.mean(group))) for group in groups), reverse=True)
    return [center for _, center in ranked[:count]]


def support_resistance(
    daily: pd.DataFrame, days: pd.Index, lookback: int, side: str, window: int = 5, count: int = 3
) -> pd.Series:
    """Nearest support at or below ("support"), or resistance at or above ("resistance"), the
    previous close. Levels are cluster centers of the closing-price pivots in the `lookback`
    daily bars before each day; a pivot counts only once `window` bars after it have closed, so a
    level never moves on bars that are already known.

    Adapted from Vibe-Trading `agent/src/tools/pattern_tool.py` (`find_peaks_valleys`,
    `support_resistance`; MIT License, see THIRD_PARTY_NOTICES.md). Changes: confirmed pivots only,
    and the nearest level to the previous close instead of the whole list.
    """
    closes = daily["close"].to_numpy(dtype=float)
    out = []
    for day in days:
        end = int(daily.index.searchsorted(day, side="left"))
        history = closes[max(0, end - lookback) : end]
        level = float("nan")
        if len(history) > 2 * window:
            pivots = []
            for i in range(window, len(history) - window):
                segment = history[i - window : i + window + 1]
                is_pivot = history[i] == segment.min() if side == "support" else history[i] == segment.max()
                if is_pivot and not np.isnan(history[i]):
                    pivots.append(float(history[i]))
            reference = history[-1]
            centers = _clusters(pivots, count)
            if side == "support":
                below = [c for c in centers if c <= reference]
                level = max(below) if below else level
            else:
                above = [c for c in centers if c >= reference]
                level = min(above) if above else level
        out.append(level)
    return pd.Series(out, index=days, dtype=float)
