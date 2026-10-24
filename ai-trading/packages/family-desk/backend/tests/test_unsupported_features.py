"""`check()` rejects the 02k contract features the engine cannot run yet, so no tick crashes on them."""

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


def test_a_plain_spec_has_no_problems():
    assert check(_spec()) == []


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"watch": {**BASE["watch"], "universe": {"filter": "Volume leaders"}}}, "watch.universe.filter"),
        ({"when": PATTERN}, "the pattern condition"),
        ({"when": {"not": {"all": [PATTERN]}}}, "the pattern condition"),
        (
            {"when": {"op": "crosses_above", "left": {"series": "close"}, "right": {"level": "session_high"}}},
            "session_high",
        ),
        ({"then": {"alert": {"channels": ["inbox"], "frequency": "once"}}}, "then.alert.frequency"),
        ({"then": {"alert": {"channels": ["inbox"], "expiresOn": "2026-12-31"}}}, "then.alert.expiresOn"),
        ({"then": {"alert": {"channels": ["inbox"], "message": "{symbol} at {close}"}}}, "then.alert.message"),
    ],
)
def test_unsupported_feature_is_reported(changes, message):
    assert f"{message} is not supported by the engine yet" in check(_spec(**changes))
