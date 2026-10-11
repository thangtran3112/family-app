"""Classic, Fibonacci, and Camarilla pivots from a prior completed period's high, low, and close.

02f §3: intraday timeframes use the prior session, 1D the prior week, 1W the prior month. The
pivot formulas work on a float or a `pd.Series` of the same shape alike, since they are plain
arithmetic on `high`, `low`, and `close`.
"""

from datetime import date, timedelta
from typing import Literal

import pandas as pd

from ai_trading.core import levels
from ai_trading.core.calendar import Asset

Period = Literal["session", "week", "month"]


def _week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _month_start(day: date) -> date:
    return day.replace(day=1)


def _prior_period_start(day: date, period: Period) -> date:
    if period == "week":
        return _week_start(day) - timedelta(days=7)
    previous_day_in_month_before = _month_start(day) - timedelta(days=1)
    return _month_start(previous_day_in_month_before)


def _period_hlc(daily: pd.DataFrame, period: Period) -> pd.DataFrame:
    """One row per calendar week or month, keyed by its start: the period's highest high, lowest
    low, and its last trading day's close. `daily` must be sorted oldest first."""
    starts = [_week_start(day) if period == "week" else _month_start(day) for day in daily.index]
    grouped = daily.groupby(starts)
    return pd.DataFrame({"high": grouped["high"].max(), "low": grouped["low"].min(), "close": grouped["close"].last()})


def prior_period_hlc(daily: pd.DataFrame, days: pd.Index, asset: Asset, period: Period) -> tuple[pd.Series, ...]:
    """The prior completed period's high, low, and close for each of `days`, from regular-session
    daily bars indexed by date (`levels.prior_day`'s convention). NaN wherever that period has no
    bar: no trading day old enough, or (for "week"/"month") a period with no bars at all.
    """
    if period == "session":
        return tuple(levels.prior_day(daily, days, asset, column) for column in ("high", "low", "close"))
    periods = _period_hlc(daily, period)
    prior_starts = [_prior_period_start(day, period) for day in days]
    aligned = periods.reindex(prior_starts)
    return tuple(pd.Series(aligned[column].to_numpy(), index=days, dtype=float) for column in ("high", "low", "close"))


def classic_pivots[T: (float, pd.Series)](high: T, low: T, close: T) -> dict[str, T]:
    """TradingView's "Classic" pivot type (see `pivots.py`'s module docstring for the offline
    cross-check): P = (H+L+C)/3; R1/S1 and R2/S2 mirror P by the prior range; R3/S3 extend from H
    and L through P.
    """
    pivot = (high + low + close) / 3
    rng = high - low
    return {
        "P": pivot,
        "R1": 2 * pivot - low,
        "S1": 2 * pivot - high,
        "R2": pivot + rng,
        "S2": pivot - rng,
        "R3": high + 2 * (pivot - low),
        "S3": low - 2 * (high - pivot),
    }


def fibonacci_pivots[T: (float, pd.Series)](high: T, low: T, close: T) -> dict[str, T]:
    """P = (H+L+C)/3; R1/S1, R2/S2, and R3/S3 offset P by 38.2%, 61.8%, and 100% of the prior
    range."""
    pivot = (high + low + close) / 3
    rng = high - low
    return {
        "P": pivot,
        "R1": pivot + 0.382 * rng,
        "S1": pivot - 0.382 * rng,
        "R2": pivot + 0.618 * rng,
        "S2": pivot - 0.618 * rng,
        "R3": pivot + rng,
        "S3": pivot - rng,
    }


def camarilla_pivots[T: (float, pd.Series)](high: T, low: T, close: T) -> dict[str, T]:
    """P = (H+L+C)/3, shown for the same reference as the other two methods, though Camarilla's
    own R/S levels offset the close (not P) by 1.1/12, 1.1/6, and 1.1/4 of the prior range."""
    pivot = (high + low + close) / 3
    rng = high - low
    return {
        "P": pivot,
        "R1": close + rng * 1.1 / 12,
        "S1": close - rng * 1.1 / 12,
        "R2": close + rng * 1.1 / 6,
        "S2": close - rng * 1.1 / 6,
        "R3": close + rng * 1.1 / 4,
        "S3": close - rng * 1.1 / 4,
    }
