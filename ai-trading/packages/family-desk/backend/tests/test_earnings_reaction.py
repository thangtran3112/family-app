import numpy as np
import pandas as pd
import pytest

from ai_trading.core import earnings_reaction as er


def _series(n: int, alpha: float, beta: float, seed: int = 7) -> tuple[pd.Series, pd.Series]:
    """`n` trading days of SPY returns and a stock that tracks them exactly via `alpha`/`beta`
    (zero residual), so OLS over any sub-window recovers `alpha` and `beta` exactly."""
    rng = np.random.default_rng(seed)
    spy = rng.normal(0.0004, 0.008, n)
    stock = alpha + beta * spy
    days = pd.bdate_range("2024-01-02", periods=n)
    return pd.Series(stock, index=days), pd.Series(spy, index=days)


def test_event_reaction_recovers_alpha_beta_and_the_injected_abnormal_returns():
    # Cross-checked offline (ref-venv): np.linalg.lstsq matches scipy.stats.linregress to float
    # precision (largest diff 4e-16) on noisy data, and on this exact-linear fixture it recovers
    # alpha/beta exactly since the estimation window holds no injected shock.
    stock, spy = _series(262, alpha=0.0002, beta=1.4)
    event_idx = 255
    ar0, ar1 = 0.03, -0.015
    stock = stock.copy()
    stock.iloc[event_idx] += ar0
    stock.iloc[event_idx + 1] += ar1
    announced = stock.index[event_idx]

    reaction = er.event_reaction(stock, spy, announced)
    assert reaction is not None
    assert reaction.model.alpha == pytest.approx(0.0002, abs=1e-9)
    assert reaction.model.beta == pytest.approx(1.4, abs=1e-9)
    assert reaction.excess_0_1 == pytest.approx(ar0 + ar1, abs=1e-9)
    assert reaction.next_day_return == pytest.approx(stock.iloc[event_idx + 1])


def test_event_reaction_is_none_without_enough_estimation_history():
    stock, spy = _series(262, alpha=0.0, beta=1.0)
    announced = stock.index[100]  # trading days -250..-11 before it would go negative
    assert er.event_reaction(stock, spy, announced) is None


def test_event_reaction_is_none_for_a_date_outside_the_series():
    stock, spy = _series(262, alpha=0.0, beta=1.0)
    assert er.event_reaction(stock, spy, pd.Timestamp("2099-01-01")) is None


def test_event_reaction_next_day_return_and_excess_are_none_past_the_edge_of_history():
    stock, spy = _series(262, alpha=0.0, beta=1.0)
    announced = stock.index[-1]  # the most recent day: no day 1 exists yet
    reaction = er.event_reaction(stock, spy, announced)
    assert reaction is not None
    assert reaction.next_day_return is None
    assert reaction.excess_0_1 is None


def test_summarize_needs_at_least_four_reports():
    stock, spy = _series(300, alpha=0.0, beta=1.0)
    reactions = [er.event_reaction(stock, spy, stock.index[idx]) for idx in (255, 256, 257)]
    assert er.summarize(reactions) is None


def test_summarize_drops_unavailable_reports_before_counting():
    stock, spy = _series(300, alpha=0.0, beta=1.0)
    reactions = [er.event_reaction(stock, spy, stock.index[idx]) for idx in (255, 256, 257, 258)]
    assert er.summarize(reactions + [None]) is not None  # the unavailable report doesn't count
    assert er.summarize(reactions[:3] + [None]) is None  # only 3 usable reports remain


def test_summarize_splits_beats_and_misses_and_averages_absolute_moves():
    stock, spy = _series(300, alpha=0.0, beta=1.0)
    idxs = [255, 260, 265, 270, 275]
    beats = [True, True, False, False, None]
    reactions = [er.event_reaction(stock, spy, stock.index[idx], beat=b) for idx, b in zip(idxs, beats, strict=True)]

    summary = er.summarize(reactions)
    assert summary.overall.n == 5
    assert summary.beats.n == 2
    assert summary.misses.n == 2
    assert summary.overall.avg_absolute_next_day_move == pytest.approx(
        sum(abs(r.next_day_return) for r in reactions) / 5
    )
    assert summary.beats.avg_excess_0_1 == pytest.approx(sum(r.excess_0_1 for r in reactions[:2]) / 2)
    assert summary.misses.avg_excess_0_1 == pytest.approx(sum(r.excess_0_1 for r in reactions[2:4]) / 2)


def test_summarize_is_none_without_beats_or_misses_in_the_window():
    stock, spy = _series(300, alpha=0.0, beta=1.0)
    reactions = [er.event_reaction(stock, spy, stock.index[idx]) for idx in (255, 256, 257, 258)]
    summary = er.summarize(reactions)
    assert summary.beats is None
    assert summary.misses is None
