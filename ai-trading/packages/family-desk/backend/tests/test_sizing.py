import math

import pytest

from ai_trading.core.sizing import Bracket, Clamp, plan_order


def order(side="buy", size=None, stop=None, target=None):
    return {
        "side": side,
        "size": size or {"riskUsd": 200},
        "stop": stop or {"level": "opening_range_low", "minutes": 15},
        "target": target or {"r": 2},
    }


def test_risk_sized_bracket_from_a_level_stop():
    plan = plan_order(order(), entry=189.31, stop_level=187.31)
    assert plan == plan_order(order(), entry=189.31, stop_level=187.31)
    assert plan.bracket == Bracket("buy", 100, 189.31, 187.31, 193.31, ())
    assert plan.reason is None


def test_atr_stop_and_r_target():
    plan = plan_order(order(size={"riskUsd": 300}, stop={"atrMultiple": 2}, target={"r": 3}), entry=100.0, atr=1.5)
    assert plan.bracket == Bracket("buy", 100, 100.0, 97.0, 109.0, ())


def test_a_sell_bracket_mirrors_a_buy():
    plan = plan_order(order(side="sell", size={"riskUsd": 100}), entry=50.0, stop_level=51.0)
    assert plan.bracket == Bracket("sell", 100, 50.0, 51.0, 48.0, ())


def test_futures_risk_uses_the_point_value():
    plan = plan_order(order(size={"riskUsd": 1_000}), entry=5_000.0, stop_level=4_990.0, multiplier=50.0)
    assert plan.bracket.quantity == 2  # 10 points x $50 = $500 a contract


def test_percent_of_book_and_fixed_sizes():
    pct = plan_order(order(size={"pctOfBook": 10}), entry=189.31, stop_level=187.31, book_equity=100_000.0)
    assert pct.bracket.quantity == 52
    shares = plan_order(order(size={"shares": 25}), entry=189.31, stop_level=187.31)
    assert shares.bracket.quantity == 25


def test_max_position_clamps_and_records_it():
    plan = plan_order(order(), entry=100.0, stop_level=98.0, max_position_usd=5_000.0)
    assert plan.bracket.quantity == 50
    assert plan.bracket.clamps == (Clamp("maxPositionUsd", 100, 50),)


def test_binary_floating_point_does_not_lose_a_share():
    plan = plan_order(order(size={"riskUsd": 300}), entry=10.3, stop_level=10.0)
    assert plan.bracket.quantity == 1_000


@pytest.mark.parametrize(
    ("kwargs", "paper", "reason"),
    [
        ({"entry": 100.0, "stop_level": 101.0}, order(), "stop is not on the losing side of the entry"),
        ({"entry": 100.0}, order(), "stop level is unknown"),
        ({"entry": 100.0, "stop_level": math.nan}, order(), "stop level is unknown"),
        ({"entry": 100.0}, order(stop={"atrMultiple": 2}), "ATR is unknown"),
        ({"entry": 100.0, "stop_level": 80.0}, order(size={"riskUsd": 10}), "size rounds to zero"),
        (
            {"entry": 100.0, "stop_level": 98.0, "target_level": 99.0},
            order(target={"level": "prior_day_high"}),
            "target is not on the winning side of the entry",
        ),
        ({"entry": 100.0, "stop_level": 98.0}, order(size={"pctOfBook": 5}), "book equity is unknown"),
    ],
)
def test_no_order_and_why(kwargs, paper, reason):
    plan = plan_order(paper, **kwargs)
    assert plan.bracket is None and plan.reason == reason
