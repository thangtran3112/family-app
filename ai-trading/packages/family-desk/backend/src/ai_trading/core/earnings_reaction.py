"""A market-model excess return around one earnings announcement, and a summary over the most
recent reports (02h section 4). The options-implied move for the next report needs IBKR (I/O) and
is not part of this module.

Adapted from ai-hedge-fund `hedge_fund/event_study/engine.py` and `stats.py` at commit `78b779c`
(MIT License, Copyright (c) 2024 Virat Singh; see THIRD_PARTY_NOTICES.md). Changes:
one stock at a time, no cross-sectional aggregation by filing type; the t-test and the bootstrap
confidence interval are dropped (with the scipy dependency they need), per the brief; `r_squared`
is dropped from the market-model fit (unused by anything the Desk shows); `announced` is given by
the caller (the 8-K date; 02h's PEAD lesson) and must already be a trading day both return series
have a value for — this module has no calendar of its own (`ai_trading.core.calendar` already
owns trading-day snapping) and does not re-implement upstream's weekend/holiday search.
"""

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

ESTIMATION_START = -250  # trading days before the event where the estimation window starts
ESTIMATION_END = -11  # ... and ends (a 10-day buffer avoids pre-announcement drift)
MIN_ESTIMATION_DAYS = 200  # fewer days of estimation history than this: the event is unusable
MIN_REPORTS = 4  # fewer usable reports than this: the whole summary is unavailable


@dataclass(frozen=True)
class MarketModel:
    """R_stock = alpha + beta * R_market, fit by OLS over the estimation window."""

    alpha: float
    beta: float


@dataclass(frozen=True)
class EventReaction:
    """One announcement's reaction.

    `next_day_return` is the stock's own actual return on the trading day after `announced` (not
    market-adjusted); `excess_0_1` is the market-model abnormal return (actual minus the model's
    prediction) summed over `announced` and the day after. Either is `None` when that day falls
    beyond the given return series (the announcement is the most recent trading day).
    """

    announced: pd.Timestamp
    model: MarketModel
    next_day_return: float | None
    excess_0_1: float | None
    beat: bool | None = None  # EPS beat (True), miss (False), met or unknown (None)


def _fit_market_model(stock: np.ndarray, market: np.ndarray) -> MarketModel:
    """OLS of `stock` on `market` via the normal equations: alpha (intercept) and beta (slope)."""
    design = np.column_stack([np.ones(len(market)), market])
    (alpha, beta), *_ = np.linalg.lstsq(design, stock, rcond=None)
    return MarketModel(float(alpha), float(beta))


def event_reaction(
    stock_returns: pd.Series,
    spy_returns: pd.Series,
    announced: pd.Timestamp,
    *,
    beat: bool | None = None,
) -> EventReaction | None:
    """The market-model reaction to one announcement, or `None` when it cannot be computed.

    `stock_returns` and `spy_returns` are daily returns indexed by trading day, already aligned to
    the days both have a close (ai-hedge-fund's stock-intersect-SPY step). `announced` is the
    trading day the market first could react; `None` when it is not in the index, or fewer than
    `MIN_ESTIMATION_DAYS` days of estimation history (trading days -250 to -11 before it) exist.
    """
    days = stock_returns.index
    if announced not in days:
        return None
    event_idx = days.get_loc(announced)
    est_start, est_end = event_idx + ESTIMATION_START, event_idx + ESTIMATION_END
    if est_start < 0 or est_end < 0:
        return None
    stock_est = stock_returns.iloc[est_start : est_end + 1].to_numpy()
    spy_est = spy_returns.iloc[est_start : est_end + 1].to_numpy()
    if len(stock_est) < MIN_ESTIMATION_DAYS:
        return None
    model = _fit_market_model(stock_est, spy_est)

    def abnormal(offset: int) -> float | None:
        idx = event_idx + offset
        if idx >= len(days):
            return None
        return float(stock_returns.iloc[idx] - (model.alpha + model.beta * spy_returns.iloc[idx]))

    ar0, ar1 = abnormal(0), abnormal(1)
    excess_0_1 = ar0 + ar1 if ar0 is not None and ar1 is not None else None
    next_idx = event_idx + 1
    next_day_return = float(stock_returns.iloc[next_idx]) if next_idx < len(days) else None
    return EventReaction(announced, model, next_day_return, excess_0_1, beat)


@dataclass(frozen=True)
class ReactionStats:
    n: int
    avg_absolute_next_day_move: float  # NaN when no report in the group has a known next-day move
    avg_excess_0_1: float  # NaN when no report in the group has a known days-0-1 excess


def _stats(group: list[EventReaction]) -> ReactionStats | None:
    """`None` for an empty group (e.g. no misses in the window)."""
    if not group:
        return None
    moves = [abs(r.next_day_return) for r in group if r.next_day_return is not None]
    excess = [r.excess_0_1 for r in group if r.excess_0_1 is not None]
    return ReactionStats(
        n=len(group),
        avg_absolute_next_day_move=float(np.mean(moves)) if moves else math.nan,
        avg_excess_0_1=float(np.mean(excess)) if excess else math.nan,
    )


@dataclass(frozen=True)
class ReactionSummary:
    overall: ReactionStats
    beats: ReactionStats | None
    misses: ReactionStats | None


def summarize(reactions: list[EventReaction | None]) -> ReactionSummary | None:
    """Summary over the given reports (the Desk passes its most recent 8; 02h section 4): the
    average absolute next-day move, the average excess move over days 0-1, and the same two split
    into beats and misses.

    A report whose reaction is `None` (`event_reaction` could not compute one) is dropped first.
    Fewer than `MIN_REPORTS` remaining reports makes the whole summary `None` (unavailable).
    """
    known = [r for r in reactions if r is not None]
    if len(known) < MIN_REPORTS:
        return None
    return ReactionSummary(
        overall=_stats(known),
        beats=_stats([r for r in known if r.beat is True]),
        misses=_stats([r for r in known if r.beat is False]),
    )
