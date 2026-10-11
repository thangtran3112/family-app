"""Intrinsic-value methods, deterministic and LLM-free (02h section 4): owner earnings, a classic
single-rate DCF, a bear/base/bull DCF-scenario blend, EV/EBITDA at a historical multiple, residual
income, WACC, and a 60/40 blended value.

Copied from ai-hedge-fund `src/agents/valuation.py` at commit `6c41ae8` (v1 history; MIT License,
Copyright (c) 2024 Virat Singh; see THIRD_PARTY_NOTICES.md). Changes: the framework
ties are gone (no `AgentState`, no network calls, no `FinancialMetrics` objects — plain numbers
in, a number or `None` out); a non-positive cash flow or a missing input gives `None` instead of
upstream's `0`, so a true "unavailable" is never averaged in as a real value of zero; a division
whose denominator (a discount or WACC at or below its matching growth rate) would be non-positive
also gives `None` instead of raising, since the Desk's "Adjust assumptions" recompute lets an
owner pick rates upstream never validated; `calculate_wacc`'s unused `debt_to_equity` parameter
and `calculate_dcf_scenarios`'s unused `growth_metrics` parameter are dropped (dead in the
original: neither function body reads them). `blended_value` is new (02h section 4).
"""

import statistics
from dataclasses import dataclass


def calculate_owner_earnings_value(
    net_income: float | None,
    depreciation: float | None,
    capex: float | None,
    working_capital_change: float | None,
    growth_rate: float = 0.05,
    required_return: float = 0.15,
    margin_of_safety: float = 0.25,
    num_years: int = 5,
) -> float | None:
    """Buffett-style owner-earnings value, discounted at `required_return` with a margin of safety.

    `None` when an input is missing, owner earnings (`net_income + depreciation - capex -
    working_capital_change`) is not positive, or `required_return` does not exceed the terminal
    growth rate (`min(growth_rate, 0.03)`).
    """
    if None in (net_income, depreciation, capex, working_capital_change):
        return None
    owner_earnings = net_income + depreciation - capex - working_capital_change
    if owner_earnings <= 0:
        return None
    terminal_growth = min(growth_rate, 0.03)
    if required_return <= terminal_growth:
        return None

    pv = 0.0
    for year in range(1, num_years + 1):
        pv += owner_earnings * (1 + growth_rate) ** year / (1 + required_return) ** year
    terminal_value = (
        owner_earnings * (1 + growth_rate) ** num_years * (1 + terminal_growth) / (required_return - terminal_growth)
    )
    pv_terminal = terminal_value / (1 + required_return) ** num_years
    return (pv + pv_terminal) * (1 - margin_of_safety)


def calculate_intrinsic_value(
    free_cash_flow: float | None,
    growth_rate: float = 0.05,
    discount_rate: float = 0.10,
    terminal_growth_rate: float = 0.02,
    num_years: int = 5,
) -> float | None:
    """Classic single-rate DCF on free cash flow, with a constant growth rate and terminal value.

    `None` when `free_cash_flow` is missing or not positive, or `discount_rate` does not exceed
    `terminal_growth_rate`.
    """
    if free_cash_flow is None or free_cash_flow <= 0:
        return None
    if discount_rate <= terminal_growth_rate:
        return None

    pv = 0.0
    for year in range(1, num_years + 1):
        pv += free_cash_flow * (1 + growth_rate) ** year / (1 + discount_rate) ** year
    terminal_value = (free_cash_flow * (1 + growth_rate) ** num_years * (1 + terminal_growth_rate)) / (
        discount_rate - terminal_growth_rate
    )
    pv_terminal = terminal_value / (1 + discount_rate) ** num_years
    return pv + pv_terminal


def calculate_ev_ebitda_value(
    enterprise_value: float | None,
    market_cap: float | None,
    ev_ebitda_ratios: list[float | None],
) -> float | None:
    """Implied equity value from the stock's own median EV/EBITDA multiple, applied to today's
    EBITDA (02h: "at the stock's own 5-year median multiple").

    `ev_ebitda_ratios[0]` is the current period's ratio (used with `enterprise_value` to back out
    today's EBITDA); the median is over however many of the given periods (most recent first,
    typically up to 8 quarters) have a ratio. `None` when `enterprise_value`, `market_cap`, or the
    current ratio is missing (a missing `market_cap` must not fabricate a net debt of zero), or
    the current ratio is zero. The implied equity value floors at 0 rather than going negative.
    """
    if not enterprise_value or not ev_ebitda_ratios:
        return None
    if market_cap is None:
        return None
    current_ratio = ev_ebitda_ratios[0]
    if not current_ratio:
        return None
    ebitda_now = enterprise_value / current_ratio
    valid_ratios = [ratio for ratio in ev_ebitda_ratios if ratio]
    median_multiple = statistics.median(valid_ratios)
    implied_ev = median_multiple * ebitda_now
    net_debt = enterprise_value - market_cap
    return max(implied_ev - net_debt, 0.0)


def calculate_residual_income_value(
    market_cap: float | None,
    net_income: float | None,
    price_to_book_ratio: float | None,
    book_value_growth: float = 0.03,
    cost_of_equity: float = 0.10,
    terminal_growth_rate: float = 0.03,
    num_years: int = 5,
) -> float | None:
    """Residual income (Edwards-Bell-Ohlson) value: book value plus the present value of income
    above the cost of equity, with a 20% margin of safety.

    `None` when an input is missing or `price_to_book_ratio` is not positive, when first-year
    residual income (`net_income - cost_of_equity * book_value`) is not positive, or when
    `cost_of_equity` does not exceed `terminal_growth_rate`.
    """
    if not (market_cap and net_income and price_to_book_ratio and price_to_book_ratio > 0):
        return None
    if cost_of_equity <= terminal_growth_rate:
        return None
    book_value = market_cap / price_to_book_ratio
    residual_income = net_income - cost_of_equity * book_value
    if residual_income <= 0:
        return None

    pv = 0.0
    for year in range(1, num_years + 1):
        pv += residual_income * (1 + book_value_growth) ** year / (1 + cost_of_equity) ** year
    terminal_value = (
        residual_income * (1 + book_value_growth) ** (num_years + 1) / (cost_of_equity - terminal_growth_rate)
    )
    pv_terminal = terminal_value / (1 + cost_of_equity) ** num_years
    return (book_value + pv + pv_terminal) * 0.8


def calculate_wacc(
    market_cap: float,
    total_debt: float | None,
    cash: float | None,
    interest_coverage: float | None,
    beta_proxy: float = 1.0,
    risk_free_rate: float = 0.045,
    market_risk_premium: float = 0.06,
) -> float:
    """Weighted average cost of capital from a CAPM cost of equity and an interest-coverage proxy
    for the cost of debt, clamped to [6%, 20%]. Always returns a number: a missing `total_debt`,
    `cash`, or `interest_coverage` falls back to no debt or a default spread, same as upstream.
    """
    cost_of_equity = risk_free_rate + beta_proxy * market_risk_premium
    if interest_coverage and interest_coverage > 0:
        cost_of_debt = max(risk_free_rate + 0.01, risk_free_rate + 10 / interest_coverage)
    else:
        cost_of_debt = risk_free_rate + 0.05

    net_debt = max((total_debt or 0) - (cash or 0), 0)
    total_value = market_cap + net_debt
    if total_value > 0:
        weight_equity = market_cap / total_value
        weight_debt = net_debt / total_value
        wacc = weight_equity * cost_of_equity + weight_debt * cost_of_debt * 0.75  # 25% tax shield
    else:
        wacc = cost_of_equity
    return min(max(wacc, 0.06), 0.20)


def _fcf_volatility(fcf_history: list[float]) -> float:
    """Coefficient of variation of the positive entries in `fcf_history`, as a 0-1 quality
    discount for `_enhanced_dcf_value`. A default when there is too little history to measure."""
    if len(fcf_history) < 3:
        return 0.5
    positive = [fcf for fcf in fcf_history if fcf > 0]
    if len(positive) < 2:
        return 0.8
    mean_fcf = statistics.mean(positive)
    if mean_fcf <= 0:
        return 0.8
    return min(statistics.stdev(positive) / mean_fcf, 1.0)


def _enhanced_dcf_value(
    fcf_history: list[float], wacc: float, market_cap: float, revenue_growth: float | None = None
) -> float | None:
    """Three-stage DCF (high growth years 1-3, declining transition years 4-7, terminal value),
    discounted to the present and discounted further by an FCF-volatility quality factor.
    `None` when `fcf_history` is empty or its most recent entry is not positive, or when `wacc` is
    at or below zero or at or below the terminal growth rate derived from `revenue_growth` (the
    Gordon terminal value is invalid there; no silent rate substitution).

    `revenue_growth` is used as given — a real `0.0` or a negative growth is respected, capped at
    25% where the cap applies — and only a missing (`None`) `revenue_growth` takes the 5% default;
    only `None` counts as missing, not a falsy `0.0`.
    """
    if not fcf_history or fcf_history[0] <= 0:
        return None
    fcf_current = fcf_history[0]
    fcf_avg_3yr = sum(fcf_history[:3]) / min(3, len(fcf_history))
    volatility = _fcf_volatility(fcf_history)

    high_growth = min(revenue_growth, 0.25) if revenue_growth is not None else 0.05
    if market_cap > 50_000_000_000:
        high_growth = min(high_growth, 0.10)
    transition_growth = (high_growth + 0.03) / 2
    terminal_growth = min(0.03, high_growth * 0.6)
    if wacc <= 0 or wacc <= terminal_growth:
        return None

    base_fcf = max(fcf_current, fcf_avg_3yr * 0.85)  # a conservative floor under a sharp dip
    pv = 0.0
    for year in range(1, 4):
        pv += base_fcf * (1 + high_growth) ** year / (1 + wacc) ** year
    for year in range(4, 8):
        transition_rate = transition_growth * (8 - year) / 4  # declining to 0 by year 8
        projected = base_fcf * (1 + high_growth) ** 3 * (1 + transition_rate) ** (year - 3)
        pv += projected / (1 + wacc) ** year

    final_fcf = base_fcf * (1 + high_growth) ** 3 * (1 + transition_growth) ** 4
    terminal_value = final_fcf * (1 + terminal_growth) / (wacc - terminal_growth)
    pv_terminal = terminal_value / (1 + wacc) ** 7

    quality_factor = max(0.7, 1 - volatility * 0.5)
    return (pv + pv_terminal) * quality_factor


def calculate_dcf_scenarios(
    fcf_history: list[float], wacc: float, market_cap: float, revenue_growth: float | None = None
) -> dict[str, float | dict[str, float]] | None:
    """Bear/base/bull DCF, weighted 20/60/20 into `expected_value` (02h section 4). Each scenario
    scales growth and WACC (bear: half the growth, 1.2x WACC; bull: 1.5x growth, 0.9x WACC).

    Returns `{"scenarios": {"bear", "base", "bull"}, "expected_value", "range", "upside",
    "downside"}`. `None` when `fcf_history` is empty or its most recent entry is not positive, or
    when any scenario's own-scaled `wacc` (bear 1.2x, base 1x, bull 0.9x the given `wacc`) ends up
    at or below its terminal growth rate — one unusable scenario makes the whole set unavailable.

    `revenue_growth` is used as given — a real `0.0` or a negative growth is respected, then scaled
    per scenario — and only a missing (`None`) `revenue_growth` takes the 5% default; only `None`
    counts as missing, not a falsy `0.0`.
    """
    if not fcf_history or fcf_history[0] <= 0:
        return None
    adjustments = {
        "bear": (0.5, 1.2),
        "base": (1.0, 1.0),
        "bull": (1.5, 0.9),
    }
    base_revenue_growth = revenue_growth if revenue_growth is not None else 0.05
    scenarios = {
        name: _enhanced_dcf_value(fcf_history, wacc * wacc_adj, market_cap, base_revenue_growth * growth_adj)
        for name, (growth_adj, wacc_adj) in adjustments.items()
    }
    if any(value is None for value in scenarios.values()):
        return None
    expected_value = scenarios["bear"] * 0.2 + scenarios["base"] * 0.6 + scenarios["bull"] * 0.2
    return {
        "scenarios": scenarios,
        "expected_value": expected_value,
        "range": scenarios["bull"] - scenarios["bear"],
        "upside": scenarios["bull"],
        "downside": scenarios["bear"],
    }


@dataclass(frozen=True)
class BlendedValue:
    value: float
    methods_used: tuple[str, ...]  # which of "owner_earnings", "ev_ebitda", "residual_income" fed the 40%


def blended_value(
    dcf_value: float | None,
    owner_earnings_value: float | None,
    ev_ebitda_value: float | None,
    residual_income_value: float | None,
) -> BlendedValue | None:
    """60% `dcf_value` (the scenario DCF's `expected_value`) plus 40% the mean of
    `owner_earnings_value`, `ev_ebitda_value`, and `residual_income_value` (02h section 4).

    02h section 4's literal 60/40 blend assumes all three of the other methods are available.
    When one or two are missing, this still computes a blend over whichever are available (one
    missing method should not sink the whole card), but it is a weaker number than the spec's
    blend — `methods_used` names exactly which methods fed the 40% mean, so a caller can label a
    blend that used fewer than three. `None` when `dcf_value` is unavailable, or none of the other
    three are (nothing left to blend).
    """
    candidates = (
        ("owner_earnings", owner_earnings_value),
        ("ev_ebitda", ev_ebitda_value),
        ("residual_income", residual_income_value),
    )
    used = [(name, value) for name, value in candidates if value is not None]
    if dcf_value is None or not used:
        return None
    mean_others = sum(value for _, value in used) / len(used)
    return BlendedValue(0.6 * dcf_value + 0.4 * mean_others, tuple(name for name, _ in used))
