"""Black-Scholes-Merton price, greeks, and implied volatility for European calls and puts.

Adapted from Vibe-Trading `agent/src/quantlib/options.py` (MIT License, Copyright (c) 2026
Vibe-Trading Contributors; see THIRD_PARTY_NOTICES.md). Changes: standard-library math instead of
numpy/scipy (bisection replaces brentq), calls and puts only, no barrier options.

Conventions: `T` is in years; `r` and `q` are continuously compounded annual rates; theta is per
calendar day; vega and rho are per 1 percentage point; delta and gamma are per 1.0 of spot.
Nothing is rounded. At expiry, or for a non-positive spot or strike, the price is the immediate
intrinsic value; with time left but `sigma <= 0`, it is the discounted forward intrinsic value.
"""

import math
from typing import Literal

OptionType = Literal["call", "put"]

MAX_SIGMA = 10.0  # widest volatility the solver considers (1000% a year)
MIN_SIGMA = 1e-6
MIN_VEGA = 1e-10  # below this, Newton's step is meaningless and bisection takes over
MAX_SEED_SIGMA = 5.0
MIN_SEED_SIGMA = 1e-3
SIGMA_RESOLUTION = 0.01  # a solved volatility counts only if one vol point moves the price by more than `tol`


def _check(option_type: str) -> None:
    if option_type not in ("call", "put"):
        raise ValueError(f"option_type must be 'call' or 'put', got {option_type!r}")


def _cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _intrinsic(S: float, K: float, option_type: OptionType) -> float:
    return float(max(S - K, 0.0) if option_type == "call" else max(K - S, 0.0))


def _d1_d2(S: float, K: float, T: float, r: float, sigma: float, q: float) -> tuple[float, float]:
    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + sigma * sigma / 2.0) * T) / (sigma * sqrt_t)
    return d1, d1 - sigma * sqrt_t


def bs_price(
    S: float, K: float, T: float, r: float, sigma: float, option_type: OptionType = "call", q: float = 0.0
) -> float:
    """Black-Scholes-Merton price, e.g. bs_price(100, 100, 1.0, 0.05, 0.2) == 10.4506 (rounded)."""
    _check(option_type)
    if T <= 0 or S <= 0 or K <= 0:
        return _intrinsic(S, K, option_type)
    spot_pv, strike_pv = S * math.exp(-q * T), K * math.exp(-r * T)
    if sigma <= 0:
        forward = spot_pv - strike_pv
        return float(max(forward, 0.0) if option_type == "call" else max(-forward, 0.0))
    d1, d2 = _d1_d2(S, K, T, r, sigma, q)
    if option_type == "call":
        return spot_pv * _cdf(d1) - strike_pv * _cdf(d2)
    return strike_pv * _cdf(-d2) - spot_pv * _cdf(-d1)


def bs_greeks(
    S: float, K: float, T: float, r: float, sigma: float, option_type: OptionType = "call", q: float = 0.0
) -> dict[str, float]:
    """Delta, gamma, theta (per day), vega and rho (per 1 percentage point)."""
    _check(option_type)
    if T <= 0 or S <= 0 or K <= 0:
        # An expiring in-the-money option keeps unit exposure to spot. At S == K the one-sided
        # limits disagree, so the midpoint keeps call delta - put delta == 1.
        if S == K:
            delta = 0.5 if option_type == "call" else -0.5
        elif option_type == "call":
            delta = 1.0 if S > K else 0.0
        else:
            delta = -1.0 if S < K else 0.0
        return {"delta": delta, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "rho": 0.0}
    disc_q, disc_r = math.exp(-q * T), math.exp(-r * T)
    if sigma <= 0:
        forward = S * disc_q - K * disc_r
        if forward == 0:
            weight = 0.5
        elif option_type == "call":
            weight = 1.0 if forward > 0 else 0.0
        else:
            weight = 1.0 if forward < 0 else 0.0
        sign = 1.0 if option_type == "call" else -1.0
        carry = (q * S * disc_q - r * K * disc_r) / 365.0
        return {
            "delta": sign * weight * disc_q,
            "gamma": 0.0,
            "theta": sign * weight * carry,
            "vega": 0.0,
            "rho": sign * weight * K * T * disc_r / 100.0,
        }
    sqrt_t = math.sqrt(T)
    d1, d2 = _d1_d2(S, K, T, r, sigma, q)
    pdf_d1 = _pdf(d1)
    decay = -(S * disc_q * pdf_d1 * sigma) / (2.0 * sqrt_t)
    if option_type == "call":
        delta = disc_q * _cdf(d1)
        theta = decay - r * K * disc_r * _cdf(d2) + q * S * disc_q * _cdf(d1)
        rho = K * T * disc_r * _cdf(d2) / 100.0
    else:
        delta = disc_q * (_cdf(d1) - 1.0)
        theta = decay + r * K * disc_r * _cdf(-d2) - q * S * disc_q * _cdf(-d1)
        rho = -K * T * disc_r * _cdf(-d2) / 100.0
    return {
        "delta": delta,
        "gamma": disc_q * pdf_d1 / (S * sigma * sqrt_t),
        "theta": theta / 365.0,
        "vega": S * disc_q * pdf_d1 * sqrt_t / 100.0,
        "rho": rho,
    }


def implied_volatility(
    price: float,
    S: float,
    K: float,
    T: float,
    r: float,
    option_type: OptionType = "call",
    q: float = 0.0,
    tol: float = 1e-6,
    max_iter: int = 200,
) -> float:
    """Volatility that reprices `price`: Newton from the Brenner-Subrahmanyam seed, then bisection.

    Returns NaN when no volatility in [MIN_SIGMA, MAX_SIGMA] reprices the quote, and also when the
    quote does not pin a volatility down (very deep in or out of the money, or right before
    expiry, where a whole band of volatilities reprices within `tol`). Raises ValueError for
    T <= 0, a non-positive S or K, or a price outside the no-arbitrage interval.
    """
    _check(option_type)
    if T <= 0:
        raise ValueError(f"T must be > 0 to imply a volatility, got {T}")
    if S <= 0 or K <= 0:
        raise ValueError(f"S and K must be > 0, got S={S}, K={K}")
    spot_pv, strike_pv = S * math.exp(-q * T), K * math.exp(-r * T)
    if option_type == "call":
        lower, upper = max(spot_pv - strike_pv, 0.0), spot_pv
    else:
        lower, upper = max(strike_pv - spot_pv, 0.0), strike_pv
    if price < lower - tol:
        raise ValueError(f"price {price} is below the discounted intrinsic value {lower}")
    if price >= upper:
        raise ValueError(f"price {price} is at or above the no-arbitrage ceiling {upper}")

    def identified(sigma: float) -> float:
        vega = bs_greeks(S, K, T, r, sigma, option_type, q)["vega"] * 100.0
        return sigma if abs(vega) * SIGMA_RESOLUTION >= tol else math.nan

    def gap(sigma: float) -> float:
        return bs_price(S, K, T, r, sigma, option_type, q) - price

    sigma = min(max(math.sqrt(2.0 * math.pi / T) * price / S, MIN_SEED_SIGMA), MAX_SEED_SIGMA)
    for _ in range(max_iter):
        diff = gap(sigma)
        if abs(diff) < tol:
            return identified(sigma)
        vega = bs_greeks(S, K, T, r, sigma, option_type, q)["vega"] * 100.0
        if abs(vega) < MIN_VEGA:
            break
        sigma = min(max(sigma - diff / vega, MIN_SIGMA), MAX_SIGMA)

    low, high = MIN_SIGMA, MAX_SIGMA
    if gap(low) > 0 or gap(high) < 0:  # the price rises with volatility; no root in the bracket
        return math.nan
    for _ in range(max_iter):
        mid = (low + high) / 2.0
        if gap(mid) < 0:
            low = mid
        else:
            high = mid
    candidate = (low + high) / 2.0
    return identified(candidate) if abs(gap(candidate)) < tol else math.nan
