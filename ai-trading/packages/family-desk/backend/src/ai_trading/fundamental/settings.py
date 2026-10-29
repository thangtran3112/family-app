"""The Fundamental lane's settings keys (02n §c3 #19): `mask_values`, `fundamental_columns` and `covered_calls` in the
user's `users.settings` blob. `validate` is what `PUT /settings` runs; `covered_call_settings` is the one place the
defaults (the engine's own `Filters` plus a 50% cover cap) and the merge rule live."""

import math
from dataclasses import asdict
from typing import Any

from ai_trading.core.covered_calls import DEFAULT_FILTERS, Filters

#: 02n §c4: the metric keys a holdings row, a `long_term` watchlist row and the `Columns` menu share.
METRIC_KEYS = (
    "fwd_pe",
    "pe_vs_5y_median_pct",
    "fcf_yield_pct",
    "revenue_growth_yoy_pct",
    "debt_to_equity",
    "eps_rev_7d_pct",
    "eps_rev_30d_pct",
    "eps_rev_90d_pct",
    "next_earnings",
    "dividend_yield_pct",
    "ex_dividend",
    "ai_rating",
    "ai_target_base",
    "ai_upside_pct",
    "dist_to_252d_high_pct",
    "weight_pct",
    "gain_vs_cost_pct",
    "cc_coverable",
)
DEFAULT_COLUMNS = ("fwd_pe", "pe_vs_5y_median_pct", "fcf_yield_pct", "eps_rev_30d_pct", "next_earnings", "cc_coverable")
MAX_COLUMNS = 8
DEFAULT_MASK_VALUES = True  # hidden on every load (02n §g.4)
DEFAULT_CAP_PCT = 50.0  # of the shares of a holding that may be covered

#: Setting -> (lowest, highest, whole number). The engine's sane bounds: outside them a scan finds nothing or means
#: something else (a delta of 0 or 1, a spread above the whole price).
_BOUNDS: dict[str, tuple[float, float, bool]] = {
    "min_dte": (1, 365, True),
    "max_dte": (1, 365, True),
    "min_delta": (0.01, 0.99, False),
    "max_delta": (0.01, 0.99, False),
    "min_open_interest": (0, 1_000_000, True),
    "max_spread_pct": (0, 100, False),
    "min_bid": (0, 100, False),
    "cap_pct": (1, 100, False),
}
_ORDERED_PAIRS = (("min_dte", "max_dte"), ("min_delta", "max_delta"))


def covered_call_defaults() -> dict[str, float]:
    return {**asdict(DEFAULT_FILTERS), "cap_pct": DEFAULT_CAP_PCT}


def covered_call_settings(settings: dict[str, Any]) -> tuple[Filters, float]:
    """The engine's `Filters` and the cover cap (% of shares) for a user's stored settings; a missing key takes its
    default. Call it on settings that passed `validate`."""
    merged = {**covered_call_defaults(), **(settings.get("covered_calls") or {})}
    cap_pct = float(merged.pop("cap_pct"))
    return Filters(**merged), cap_pct


def _problem(path: str, message: str) -> dict[str, str]:
    return {"path": path, "message": message}


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _validate_covered_calls(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, dict):
        return [_problem("covered_calls", "must be an object")]
    problems = []
    for key, number in value.items():
        path = f"covered_calls.{key}"
        if key not in _BOUNDS:
            problems.append(_problem(path, "is not a covered-call setting"))
            continue
        low, high, whole = _BOUNDS[key]
        if not _is_number(number) or (whole and not isinstance(number, int)):
            problems.append(_problem(path, "must be a whole number" if whole else "must be a number"))
        elif not low <= number <= high:
            problems.append(_problem(path, f"must be between {low:g} and {high:g}"))
    if problems:
        return problems
    merged = {**covered_call_defaults(), **value}
    return [
        _problem(f"covered_calls.{high}", f"must not be below {low}")
        for low, high in _ORDERED_PAIRS
        if merged[low] > merged[high]
    ]


def validate(settings: dict[str, Any]) -> list[dict[str, str]]:
    """The problems (`{path, message}`, 02m §a1) in the Fundamental keys of `settings`; empty when they are fine."""
    problems = []
    if "mask_values" in settings and not isinstance(settings["mask_values"], bool):
        problems.append(_problem("mask_values", "must be true or false"))
    if "fundamental_columns" in settings:
        columns = settings["fundamental_columns"]
        if not isinstance(columns, list) or not all(isinstance(column, str) for column in columns):
            problems.append(_problem("fundamental_columns", "must be a list of metric keys"))
        else:
            unknown = sorted({column for column in columns if column not in METRIC_KEYS})
            if unknown:
                problems.append(_problem("fundamental_columns", f"unknown metric: {', '.join(unknown)}"))
            if len(columns) > MAX_COLUMNS:
                problems.append(_problem("fundamental_columns", f"at most {MAX_COLUMNS} columns"))
            if len(set(columns)) != len(columns):
                problems.append(_problem("fundamental_columns", "a column can be chosen once"))
    if "covered_calls" in settings:
        problems += _validate_covered_calls(settings["covered_calls"])
    return problems
