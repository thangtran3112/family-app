import math

import pytest

from ai_trading.core import valuation


def test_intrinsic_value_matches_the_growing_annuity_closed_form():
    # Cross-checked offline against the closed-form growing annuity
    # fcf*(1+g)/(r-g) * (1 - ((1+g)/(1+r))**n) for the PV of years 1..n (ref-venv, no reference
    # library needed: this is independent algebra on the same inputs). Largest diff: 7e-13.
    assert valuation.calculate_intrinsic_value(100.0, 0.05, 0.10, 0.02, 5) == pytest.approx(
        1446.2118899836075, abs=1e-6
    )
    assert valuation.calculate_intrinsic_value(250.0, 0.08, 0.12, 0.025, 5) == pytest.approx(3371.17430425782, abs=1e-6)


def test_intrinsic_value_is_unavailable_for_non_positive_or_missing_cash_flow():
    assert valuation.calculate_intrinsic_value(0.0) is None
    assert valuation.calculate_intrinsic_value(-5.0) is None
    assert valuation.calculate_intrinsic_value(None) is None


def test_intrinsic_value_is_unavailable_when_the_discount_rate_does_not_clear_terminal_growth():
    assert valuation.calculate_intrinsic_value(100.0, discount_rate=0.02, terminal_growth_rate=0.02) is None
    assert valuation.calculate_intrinsic_value(100.0, discount_rate=0.01, terminal_growth_rate=0.02) is None


def test_owner_earnings_value_hand_checked():
    # owner earnings = 100 + 20 - 30 - 10 = 80; discounted at 15%, grown 5%, margin of safety 25%.
    value = valuation.calculate_owner_earnings_value(
        net_income=100.0, depreciation=20.0, capex=30.0, working_capital_change=10.0
    )
    assert value == pytest.approx(557.028187435008, abs=1e-6)  # ref-venv closed-form cross-check


def test_owner_earnings_value_is_unavailable_for_non_positive_earnings_or_missing_input():
    assert valuation.calculate_owner_earnings_value(10.0, 0.0, 20.0, 0.0) is None  # owner earnings -10
    assert valuation.calculate_owner_earnings_value(10.0, None, 20.0, 0.0) is None


def test_ev_ebitda_value_uses_the_median_multiple_and_floors_at_zero():
    # ebitda_now = 12000/12 = 1000; median([12,11,13,10,14]) = 12; implied = 12000; net_debt = 3000.
    value = valuation.calculate_ev_ebitda_value(12000.0, 9000.0, [12.0, 11.0, 13.0, 10.0, 14.0])
    assert value == pytest.approx(9000.0)
    # ebitda_now = 10000/20 = 500; median([20,2,2,2,2]) = 2; implied = 1000; net_debt = 9500.
    floored = valuation.calculate_ev_ebitda_value(10000.0, 500.0, [20.0, 2.0, 2.0, 2.0, 2.0])
    assert floored == 0.0  # implied equity value (1000) is below net debt (9500)


def test_ev_ebitda_value_is_unavailable_without_a_current_ratio_or_enterprise_value():
    assert valuation.calculate_ev_ebitda_value(None, 9000.0, [12.0]) is None
    assert valuation.calculate_ev_ebitda_value(12000.0, 9000.0, [0.0, 11.0]) is None
    assert valuation.calculate_ev_ebitda_value(12000.0, 9000.0, []) is None


def test_residual_income_value_hand_checked():
    # book = 5000/2.5 = 2000; ri0 = 400 - 0.10*2000 = 200.
    value = valuation.calculate_residual_income_value(market_cap=5000.0, net_income=400.0, price_to_book_ratio=2.5)
    assert value == pytest.approx(3954.2857142857138, abs=1e-6)  # ref-venv closed-form cross-check


def test_residual_income_value_is_unavailable_for_non_positive_residual_income_or_missing_input():
    assert valuation.calculate_residual_income_value(5000.0, 10.0, 2.5) is None  # ri0 = 10 - 200 < 0
    assert valuation.calculate_residual_income_value(None, 400.0, 2.5) is None
    assert valuation.calculate_residual_income_value(5000.0, 400.0, 0.0) is None


def test_wacc_hand_checked_and_clamped():
    # coe = .045+.06=.105; cod=max(.055, .045+10/20=.545)=.545; net_debt=1500; total=6500.
    # we=5000/6500=.7692; wd=1500/6500=.2308; wacc=.7692*.105+.2308*.545*.75=.17509615...
    assert valuation.calculate_wacc(5000.0, 2000.0, 500.0, 20.0) == pytest.approx(0.17509615384615385, abs=1e-9)
    assert valuation.calculate_wacc(5000.0, None, None, None) == pytest.approx(0.105, abs=1e-9)
    assert valuation.calculate_wacc(0.0, 0.0, 0.0, None) == pytest.approx(0.105, abs=1e-9)
    assert valuation.calculate_wacc(5000.0, 0.0, 0.0, None, beta_proxy=10.0) == 0.20  # capped
    assert valuation.calculate_wacc(5000.0, 0.0, 0.0, None, beta_proxy=-5.0) == 0.06  # floored


def test_dcf_scenarios_hand_checked():
    # ref-venv reimplementation of the same formula from independent code gave identical floats
    # (0 diff): bear 966.0718963882485, base 1521.141545812627, bull 2095.560234922769.
    fcf_history = [100.0, 95.0, 90.0, 80.0, 70.0, 60.0, 50.0, 40.0]
    result = valuation.calculate_dcf_scenarios(fcf_history, wacc=0.10, market_cap=5_000_000_000.0, revenue_growth=0.08)
    assert result["scenarios"]["bear"] == pytest.approx(966.0718963882485, abs=1e-6)
    assert result["scenarios"]["base"] == pytest.approx(1521.141545812627, abs=1e-6)
    assert result["scenarios"]["bull"] == pytest.approx(2095.560234922769, abs=1e-6)
    assert result["expected_value"] == pytest.approx(1525.0113537497796, abs=1e-6)
    assert result["upside"] == result["scenarios"]["bull"]
    assert result["downside"] == result["scenarios"]["bear"]
    assert result["range"] == pytest.approx(result["scenarios"]["bull"] - result["scenarios"]["bear"])


def test_dcf_scenarios_is_unavailable_for_non_positive_or_missing_cash_flow():
    assert valuation.calculate_dcf_scenarios([], wacc=0.10, market_cap=1.0) is None
    assert valuation.calculate_dcf_scenarios([0.0, 10.0], wacc=0.10, market_cap=1.0) is None
    assert valuation.calculate_dcf_scenarios([-5.0], wacc=0.10, market_cap=1.0) is None


def test_blended_value_with_all_three_other_methods_is_the_literal_02h_blend():
    blend = valuation.blended_value(
        dcf_value=1000.0, owner_earnings_value=800.0, ev_ebitda_value=900.0, residual_income_value=1300.0
    )
    assert blend.value == pytest.approx(0.6 * 1000.0 + 0.4 * ((800.0 + 900.0 + 1300.0) / 3))
    assert blend.methods_used == ("owner_earnings", "ev_ebitda", "residual_income")


def test_blended_value_with_two_other_methods_averages_over_those_two():
    blend = valuation.blended_value(
        dcf_value=1000.0, owner_earnings_value=800.0, ev_ebitda_value=900.0, residual_income_value=None
    )
    assert blend.value == pytest.approx(0.6 * 1000.0 + 0.4 * ((800.0 + 900.0) / 2))
    assert blend.methods_used == ("owner_earnings", "ev_ebitda")


def test_blended_value_with_one_other_method_uses_it_alone():
    blend = valuation.blended_value(
        dcf_value=1000.0, owner_earnings_value=None, ev_ebitda_value=900.0, residual_income_value=None
    )
    assert blend.value == pytest.approx(0.6 * 1000.0 + 0.4 * 900.0)
    assert blend.methods_used == ("ev_ebitda",)


def test_blended_value_with_zero_other_methods_is_unavailable():
    blend = valuation.blended_value(
        dcf_value=1000.0, owner_earnings_value=None, ev_ebitda_value=None, residual_income_value=None
    )
    assert blend is None


def test_blended_value_is_unavailable_without_dcf():
    assert valuation.blended_value(None, 800.0, 900.0, 1300.0) is None


def test_fcf_volatility_defaults_are_internal_but_feed_the_dcf_quality_factor():
    # A single flat-FCF history (no volatility) should value higher than an identical-average but
    # erratic one, because the quality factor only ever discounts, never boosts (max(0.7, ...)).
    erratic_history = [100.0, 10.0, 190.0, 10.0, 190.0, 10.0, 190.0, 10.0]
    flat = valuation.calculate_dcf_scenarios([100.0] * 8, wacc=0.10, market_cap=1.0)
    erratic = valuation.calculate_dcf_scenarios(erratic_history, wacc=0.10, market_cap=1.0)
    assert not math.isnan(flat["expected_value"])
    assert flat["expected_value"] >= erratic["expected_value"]
