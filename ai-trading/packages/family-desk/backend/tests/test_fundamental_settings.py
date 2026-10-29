"""The Fundamental lane's settings keys (02n §c3 #19): what is valid, the defaults, and the merge into the engine's
`Filters`."""

import pytest

from ai_trading.core.covered_calls import DEFAULT_FILTERS, Filters
from ai_trading.fundamental.settings import (
    DEFAULT_COLUMNS,
    MAX_COLUMNS,
    METRIC_KEYS,
    covered_call_defaults,
    covered_call_settings,
    validate,
)


def test_the_defaults_are_the_engines_filters_plus_a_50_percent_cap():
    assert covered_call_settings({}) == (DEFAULT_FILTERS, 50.0)
    assert covered_call_defaults() == {
        "min_dte": 21,
        "max_dte": 45,
        "min_delta": 0.15,
        "max_delta": 0.30,
        "min_open_interest": 100,
        "max_spread_pct": 10.0,
        "min_bid": 0.10,
        "cap_pct": 50.0,
    }
    assert set(DEFAULT_COLUMNS) <= set(METRIC_KEYS) and len(METRIC_KEYS) == 18


def test_a_stored_setting_overrides_only_its_own_default():
    filters, cap = covered_call_settings({"covered_calls": {"min_dte": 14, "cap_pct": 25}})
    assert filters == Filters(min_dte=14)
    assert cap == 25.0


@pytest.mark.parametrize(
    "settings",
    [
        {},
        {"mask_values": True},
        {"mask_values": False},
        {"fundamental_columns": []},
        {"fundamental_columns": list(METRIC_KEYS[:MAX_COLUMNS])},
        {"covered_calls": {}},
        {"covered_calls": covered_call_defaults()},
        {"covered_calls": {"min_dte": 1, "max_dte": 365, "min_delta": 0.01, "max_delta": 0.99, "cap_pct": 100}},
        {"covered_calls": {"min_dte": 30, "max_dte": 30}},  # a single expiry window is not an error
        {"covered_calls": {"max_spread_pct": 0, "min_bid": 0, "min_open_interest": 0}},
        {"default_view": "fundamental", "future_key": 1},  # other keys are not this module's to judge
    ],
)
def test_valid_settings_have_no_problems(settings):
    assert validate(settings) == []


@pytest.mark.parametrize(
    ("settings", "path"),
    [
        ({"mask_values": 1}, "mask_values"),
        ({"mask_values": None}, "mask_values"),
        ({"fundamental_columns": "fwd_pe"}, "fundamental_columns"),
        ({"fundamental_columns": [1]}, "fundamental_columns"),
        ({"fundamental_columns": ["fwd_pe", "fwd_pe"]}, "fundamental_columns"),
        ({"fundamental_columns": list(METRIC_KEYS[: MAX_COLUMNS + 1])}, "fundamental_columns"),
        ({"covered_calls": []}, "covered_calls"),
        ({"covered_calls": {"strike": 1}}, "covered_calls.strike"),
        ({"covered_calls": {"min_dte": 21.5}}, "covered_calls.min_dte"),  # whole days only
        ({"covered_calls": {"min_dte": True}}, "covered_calls.min_dte"),  # a boolean is not a number
        ({"covered_calls": {"min_dte": "21"}}, "covered_calls.min_dte"),
        ({"covered_calls": {"min_dte": 0}}, "covered_calls.min_dte"),
        ({"covered_calls": {"max_dte": 366}}, "covered_calls.max_dte"),
        ({"covered_calls": {"min_delta": 0}}, "covered_calls.min_delta"),
        ({"covered_calls": {"max_delta": 1}}, "covered_calls.max_delta"),
        ({"covered_calls": {"max_spread_pct": 101}}, "covered_calls.max_spread_pct"),
        ({"covered_calls": {"min_bid": -0.01}}, "covered_calls.min_bid"),
        ({"covered_calls": {"min_open_interest": -1}}, "covered_calls.min_open_interest"),
        ({"covered_calls": {"cap_pct": 100.5}}, "covered_calls.cap_pct"),
        ({"covered_calls": {"cap_pct": float("nan")}}, "covered_calls.cap_pct"),
        ({"covered_calls": {"cap_pct": float("inf")}}, "covered_calls.cap_pct"),
        ({"covered_calls": {"min_dte": 50}}, "covered_calls.max_dte"),  # above the default max of 45
        ({"covered_calls": {"max_delta": 0.10}}, "covered_calls.max_delta"),  # below the default min of 0.15
    ],
)
def test_invalid_settings_name_the_offending_path(settings, path):
    assert path in {problem["path"] for problem in validate(settings)}


def test_every_problem_is_reported_in_one_pass():
    problems = validate({"mask_values": "no", "fundamental_columns": ["x"], "covered_calls": {"cap_pct": 0}})
    assert [problem["path"] for problem in problems] == ["mask_values", "fundamental_columns", "covered_calls.cap_pct"]
