"""`check()` is the save-time gate for the 02k contract features. Every feature the engine now runs passes it;
the one combination it cannot run (a candle pattern where the cadence has no closed candle) is rejected,
so no tick crashes on a stored spec or silently ignores part of it."""

import pytest

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.evaluate import check

BASE = {
    "schemaVersion": 1,
    "name": "gate",
    "watch": {"universe": {"symbols": ["AAPL"]}, "session": "regular", "runOn": "bar_close_15m"},
    "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 1}},
    "then": {"alert": {"channels": ["inbox"]}},
}
PATTERN = {"op": "pattern", "pattern": "hammer"}


def _spec(**changes) -> StrategySpecV1:
    return StrategySpecV1.model_validate({**BASE, **changes})


def _run_on(run_on: str, **changes) -> StrategySpecV1:
    return _spec(watch={**BASE["watch"], "runOn": run_on}, **changes)


def test_a_plain_spec_has_no_problems():
    assert check(_spec()) == []


@pytest.mark.parametrize(
    "changes",
    [
        {"watch": {**BASE["watch"], "universe": {"filter": "Volume leaders"}}},
        {"when": PATTERN},
        {"when": {"not": {"all": [PATTERN]}}},
        {"when": {"op": "crosses_above", "left": {"series": "close"}, "right": {"level": "session_high"}}},
        {"when": {"op": "crosses_below", "left": {"series": "close"}, "right": {"level": "session_low"}}},
        {"then": {"alert": {"channels": ["inbox"], "frequency": "once"}}},
        {"then": {"alert": {"channels": ["inbox"], "expiresOn": "2026-12-31"}}},
        {"then": {"alert": {"channels": ["inbox"], "message": "{symbol} at {close}"}}},
    ],
)
def test_a_feature_the_engine_runs_is_accepted(changes):
    assert check(_spec(**changes)) == []


@pytest.mark.parametrize("run_on", ["premarket_0830", "weekly"])
def test_a_pattern_is_rejected_where_the_cadence_has_no_closed_candle(run_on):
    [problem] = check(_run_on(run_on, when={"not": {"all": [PATTERN]}}))
    assert problem.startswith("the pattern condition is not supported by the engine yet")


@pytest.mark.parametrize("run_on", ["bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h", "daily_close"])
def test_a_pattern_is_accepted_on_candle_cadences(run_on):
    assert check(_run_on(run_on, when=PATTERN)) == []


@pytest.mark.parametrize("run_on", ["daily_close", "weekly"])
def test_session_levels_need_intraday_bars(run_on):
    when = {"op": "crosses_above", "left": {"series": "close"}, "right": {"level": "session_high"}}
    assert check(_run_on(run_on, when=when)) == [f"session_high needs intraday bars; {run_on} uses daily bars"]


def test_session_levels_are_not_known_at_the_premarket_scan():
    when = {"op": "crosses_below", "left": {"series": "close"}, "right": {"level": "session_low"}}
    assert "session_low is not known at 08:30 ET" in check(_run_on("premarket_0830", when=when))


@pytest.mark.parametrize("leg", ["stop", "target"])
def test_an_intraday_level_in_a_paper_orders_exit_needs_intraday_bars(leg):
    order = {"side": "buy", "size": {"shares": 1}, "stop": {"atrMultiple": 1}, "target": {"r": 2}}
    order[leg] = {"level": "session_low"}
    spec = _run_on("daily_close", then={"alert": {"channels": ["inbox"]}, "paperOrder": order})
    assert check(spec) == ["session_low needs intraday bars; daily_close uses daily bars"]
    assert check(_run_on("bar_close_15m", then=spec.model_dump(by_alias=True, exclude_none=True)["then"])) == []
