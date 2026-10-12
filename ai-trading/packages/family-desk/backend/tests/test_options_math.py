import math

import pytest

from ai_trading.core.options_math import bs_greeks, bs_price, implied_volatility


def test_textbook_prices_and_put_call_parity():
    assert bs_price(100, 100, 1.0, 0.05, 0.2) == pytest.approx(10.450583572185565, abs=1e-12)
    assert bs_price(100, 100, 1.0, 0.05, 0.2, "put") == pytest.approx(5.573526022256971, abs=1e-12)
    S, K, T, r, q, sigma = 187.3, 195.0, 0.25, 0.043, 0.006, 0.31
    call, put = bs_price(S, K, T, r, sigma, "call", q), bs_price(S, K, T, r, sigma, "put", q)
    assert call - put == pytest.approx(S * math.exp(-q * T) - K * math.exp(-r * T), abs=1e-12)


def test_textbook_greeks_and_units():
    g = bs_greeks(100, 100, 1.0, 0.05, 0.2)
    assert g["delta"] == pytest.approx(0.6368306511756191, abs=1e-12)
    assert g["gamma"] == pytest.approx(0.018762017345846895, abs=1e-12)
    assert g["theta"] == pytest.approx(-6.414027546438197 / 365, abs=1e-12)  # per calendar day
    assert g["vega"] == pytest.approx(0.3752403469169379, abs=1e-12)  # per vol point
    assert g["rho"] == pytest.approx(0.5323248154537634, abs=1e-12)  # per rate point
    put = bs_greeks(100, 100, 1.0, 0.05, 0.2, "put")
    assert g["delta"] - put["delta"] == pytest.approx(1.0, abs=1e-12)


def test_expiry_and_zero_volatility():
    assert bs_price(105, 100, 0.0, 0.05, 0.2) == 5.0
    assert bs_greeks(105, 100, 0.0, 0.05, 0.2)["delta"] == 1.0  # still exposed to spot
    assert bs_greeks(100, 100, 0.0, 0.05, 0.2)["delta"] == 0.5
    assert bs_greeks(100, 100, 0.0, 0.05, 0.2, "put")["delta"] == -0.5
    assert bs_price(105, 100, 0.5, 0.05, 0.0) == pytest.approx(105 - 100 * math.exp(-0.025), abs=1e-12)


def test_implied_volatility_round_trip():
    for option_type in ("call", "put"):
        price = bs_price(210, 220, 0.12, 0.04, 0.35, option_type, 0.005)
        assert implied_volatility(price, 210, 220, 0.12, 0.04, option_type, 0.005) == pytest.approx(0.35, abs=1e-6)


def test_implied_volatility_refuses_a_quote_that_pins_nothing():
    price = bs_price(100, 50, 20 / 365, 0.03, 0.30)  # deep in the money, 20 days: flat in volatility
    assert math.isnan(implied_volatility(price, 100, 50, 20 / 365, 0.03))


@pytest.mark.parametrize(
    ("price", "T", "message"),
    [(0.5, 0.5, "below the discounted intrinsic"), (101.0, 0.5, "no-arbitrage ceiling"), (5.0, 0.0, "T must be > 0")],
)
def test_implied_volatility_rejects_impossible_inputs(price, T, message):
    with pytest.raises(ValueError, match=message):
        implied_volatility(price, 100, 95, T, 0.03)


def test_unknown_option_type_is_refused():
    with pytest.raises(ValueError, match="'call' or 'put'"):
        bs_price(100, 100, 1.0, 0.05, 0.2, "c")  # type: ignore[arg-type]


def test_float_noise_at_the_intrinsic_floor_is_tolerated_but_a_real_violation_raises():
    lower = 100 - 95 * math.exp(-0.03 * 0.5)  # discounted intrinsic of a 95 call, spot 100, half a year
    implied_volatility(lower - 5e-7, 100, 95, 0.5, 0.03)  # within tol: no error
    with pytest.raises(ValueError, match="below the discounted intrinsic"):
        implied_volatility(lower - 2e-6, 100, 95, 0.5, 0.03)
