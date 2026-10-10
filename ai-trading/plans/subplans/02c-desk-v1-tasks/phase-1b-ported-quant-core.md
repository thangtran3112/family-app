# Phase 1b: Ported Quant Core

Part of [02c-desk-v1-implementation-plan.md](../02c-desk-v1-implementation-plan.md). Read its Global Constraints, Review Focus, and Shared Interfaces first. Builds on [Phase 1](phase-1-strategy-core.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents work in a `.worktrees/` worktree on their own `feature/*` branch; the main session merges that branch into `feature/toby` (root `AGENTS.md`).

**Goal:** Copy the quant tools the Desk needs from the upstream apps into its own core, with attribution and tests: option pricing and greeks, covered-call math, support and resistance as a strategy level, and paper-order sizing. No I/O; nothing is deployed.

**Architecture:**
- Four modules in `ai-trading/packages/family-desk/backend/src/ai_trading/core/`:
  - `options_math.py`: Black-Scholes price, greeks, and implied volatility, adapted from Vibe-Trading;
  - `covered_calls.py`: 02 §6.3 eligibility, filters, metrics, flags, score, and short-call rules, built on `options_math`;
  - `sizing.py`: turns a spec's `paperOrder` into a bracket or a reason there is none;
  - `levels.support_resistance`: adapted from Vibe-Trading, and exposed to strategies as a new level operand.
- The level operand changes the Zod contract. Both generated files are regenerated, and the shared fixtures grow by one valid and one invalid spec.
- `packages/family-desk/THIRD_PARTY_NOTICES.md` lists every adapted file with its license.

**Tech Stack:** as Phase 1. No new dependencies: the option math uses the Python standard library (`math.erf`, bisection) instead of numpy/scipy.

**Spec:**
- [02 §6.3](../02-release-2-desk-design.md): covered-call eligibility, filters, metrics, flags, score, alerts, short-call risk, roll candidates
- [02a §4.4, §11](../02a-desk-v1-strategies-design.md): the block library (support/resistance) and the reuse map
- [02c](../02c-desk-v1-implementation-plan.md) Global Constraints and Shared Interfaces; `ai-trading/AGENTS.md` "Our Code"

## Global Constraints

- Everything in 02c's Global Constraints and in Phase 1's Global Constraints applies.
- Code lives in `ai-trading/packages/family-desk/`. It never imports another package. Code adapted from an upstream app carries an attribution header and a row in `packages/family-desk/THIRD_PARTY_NOTICES.md`. Nothing is copied from MiroFish.
- No new dependencies in `pyproject.toml` or `package.json`.
- `ai_trading.core` does no I/O and reads no clock.
- Never hand-edit the generated files. Regenerate with `pnpm generate:json-schema` (contracts), then `scripts/generate-contracts.sh` (backend).
- Commits are one line, with no trailer. Do not push.

## Decisions for Owner Review

1. **Standard library instead of scipy.** `options_math` uses `math.erf` and bisection. Before writing this plan, it was checked against Vibe-Trading's scipy implementation on 20,000 random inputs: prices agree within 2e-13, greeks within 4e-15, implied volatilities within 5e-10, and NaN and error cases match exactly. Barrier options and option-type aliases (`"c"`, `"calls"`, Chinese terms) are dropped.
2. **The coverable-contracts formula follows 02's example, not its text.** 02 §6.3 writes `floor(shares × cap% / 100) − open contracts`. Its own example (1,000 shares, 50%, 3 open, so 2 more) only works per 100-share contract: `floor(shares × cap% / 100 / 100) − open contracts`.
3. **Covered-call details 02 leaves open:**
   - average cost is per account;
   - `cover_tax_advantaged_first` flags a taxable-account candidate while tax-advantaged accounts still have coverable contracts;
   - an unknown IV rank (short history) adds nothing to the score and never makes an opportunity;
   - the scan keeps the first three candidates, as 02 says, by slicing the sorted list;
   - IV rank and IV percentile use the last 252 sessions; both are None before 60 sessions (02a §12), and IV rank is None when the year's IV never moved.
4. **Support and resistance as a strategy level.**
   - Operand: `{"level": "support" | "resistance", "days": 20–260}`.
   - It is the nearest cluster at or below (support), or at or above (resistance), the previous close.
   - Clusters come from the closing-price pivots of the last `days` daily bars, so the level works on every cadence.
   - Upstream's values stay: pivots use 5 bars on each side, clusters group prices within 5% of the range, and the 3 most-touched clusters per side count.
   - Upstream finds pivots with a centered window, which would repaint. Here a pivot counts only once the 5 bars after it have closed.
5. **Sizing semantics.**
   - `riskUsd` divides by `|entry − stop| ×` the point value. `pctOfBook` needs the book's equity. `shares` and `contracts` are fixed.
   - `maxPositionUsd` clamps the quantity and records the clamp.
   - There is no order, with a stated reason, when the stop or target is on the wrong side, an input is unknown, or the size rounds to zero.
   - Prices are not rounded to the tick; the Phase 6 broker does that.
6. **Not ported now:**
   - ai-hedge-fund's persona prompts wait for Phase 5, where the LLM call uses them.
   - ai-hedge-fund's clamp code itself sizes portfolio weights; only its audit-trail idea is used.
7. **Phase naming.** This is "Phase 1b" in 02c's Phases table. Like Phase 1, it deploys nothing.

## Review Focus

1. **The ported option math drifts from the original.** Pinned by textbook values and parity in `tests/test_options_math.py` (Task 1b.1); the cross-check above is the one-time proof.
2. **Floating-point boundaries on money thresholds** (a spread of exactly 10% of mid, a roll credit of exactly $0.05, $300 risk over $0.30 being 1,000 shares). Pinned in `test_filters_at_their_boundaries`, `test_roll_candidates` (Task 1b.2), and `test_binary_floating_point_does_not_lose_a_share` (Task 1b.4).
3. **Support or resistance repaints.** Pinned by `test_an_unconfirmed_pivot_is_not_a_level` (Task 1b.3).
4. **A bracket with its stop on the wrong side still produces an order.** Pinned by `test_no_order_and_why` (Task 1b.4).
5. **Zod and Pydantic disagree on the new operand.** Pinned by the two new shared fixtures (Task 1b.3).

All paths below are relative to `ai-trading/packages/family-desk/` unless they start with `ai-trading/`. Commands run in the directory a step names.

---

### Task 1b.1: Option pricing, greeks, and implied volatility

**Files:**
- Create: `backend/src/ai_trading/core/options_math.py`, `backend/tests/test_options_math.py`, `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `OptionType = Literal["call", "put"]`
  - `bs_price(S, K, T, r, sigma, option_type="call", q=0.0) -> float`
  - `bs_greeks(...) -> dict[str, float]` with keys `delta`, `gamma`, `theta` (per day), `vega`, and `rho` (per percentage point)
  - `implied_volatility(price, S, K, T, r, option_type="call", q=0.0, tol=1e-6, max_iter=200) -> float` (NaN when unidentified)

- [ ] **Step 1: Write the failing test** `backend/tests/test_options_math.py`:

```python
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
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_options_math.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.options_math'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/options_math.py`:

```python
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
    T <= 0, a non-positive S or K, a price more than `tol` below the discounted intrinsic value, or
    a price at or above the no-arbitrage ceiling.
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
```

- [ ] **Step 4: Create** `THIRD_PARTY_NOTICES.md` (the license text is Vibe-Trading's `LICENSE`, verbatim):

````markdown
# Third-Party Notices

The Family Desk adapts the code below. Each adapted file says so in its header.

## Vibe-Trading

Source: https://github.com/HKUDS/Vibe-Trading (pinned as `ai-trading/packages/vibe-trading`)

| Desk file | Adapted from | Changes |
|---|---|---|
| `backend/src/ai_trading/core/options_math.py` | `agent/src/quantlib/options.py` | Standard-library math instead of numpy/scipy; calls and puts only; no barrier options |

```text
MIT License

Copyright (c) 2026 Vibe-Trading Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
````

- [ ] **Step 5: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_options_math.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `10 passed`, ruff clean, then `117 passed`.

- [ ] **Step 6: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/options_math.py ai-trading/packages/family-desk/backend/tests/test_options_math.py ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): Desk option pricing, greeks, and implied volatility (adapted from Vibe-Trading)"
```

### Task 1b.2: Covered-call math and short-call risk rules

**Files:**
- Create: `backend/src/ai_trading/core/covered_calls.py`, `backend/tests/test_covered_calls.py`

**Interfaces:**
- Consumes: `bs_greeks` (Task 1b.1).
- Produces (Phase 5's scan and alerts rely on these):
  - data classes `OptionQuote`, `Lot`, `Filters` (02 defaults), `DEFAULT_FILTERS`, `Candidate`, `ShortCall`
  - `coverable_contracts(shares, max_cover_pct, open_contracts) -> int`
  - `candidates(spot, quotes, today, *, filters, lots, taxable, tax_advantaged_contracts_free, ex_dividend, earnings, iv_rank, rate, keep=3) -> list[Candidate]`, best score first
  - `is_opportunity(candidate, iv_rank) -> bool`
  - `extrinsic_value(call_mid, spot, strike) -> float`
  - `short_call_risks(call, *, spot, today, delta, extrinsic, next_trading_day, ex_dividend, dividend, earnings) -> list[str]`
  - `roll_candidates(call, *, buyback_ask, quotes, today, max_dte=60, min_credit=0.05) -> list[tuple[OptionQuote, float]]`
  - `iv_rank(iv30_history) -> float | None` and `iv_percentile(iv30_history) -> float | None` (latest value last; None before 60 sessions)
- Flag names: `ex_dividend_before_expiry`, `strike_below_cost_basis`, `short_term_lots`, `cover_tax_advantaged_first`.
- Risk names: `delta_above_0_50`, `near_strike_near_expiry`, `early_assignment_before_dividend`, `earnings_before_expiry`.

- [ ] **Step 1: Write the failing test** `backend/tests/test_covered_calls.py`:

```python
from dataclasses import replace
from datetime import date, timedelta

import pytest

from ai_trading.core.covered_calls import (
    Lot,
    OptionQuote,
    ShortCall,
    candidates,
    coverable_contracts,
    extrinsic_value,
    is_opportunity,
    iv_percentile,
    iv_rank,
    roll_candidates,
    short_call_risks,
)
from ai_trading.core.options_math import bs_greeks

TODAY = date(2026, 10, 12)


def call(days: int = 30, strike: float = 105.0, bid: float = 1.00, ask: float = 1.04, **kw) -> OptionQuote:
    values = {"open_interest": 500, "delta": 0.22} | kw
    return OptionQuote(expiry=TODAY + timedelta(days=days), strike=strike, bid=bid, ask=ask, **values)


@pytest.mark.parametrize(
    ("shares", "cap", "open_", "expected"),
    [(1_000, 50, 3, 2), (300, 50, 0, 1), (150, 50, 0, 0), (1_000, 0, 0, 0), (400, 50, 3, 0)],
)
def test_coverable_contracts(shares, cap, open_, expected):
    assert coverable_contracts(shares, cap, open_) == expected


def test_metrics_for_one_candidate():
    [c] = candidates(100.0, [call()], TODAY)
    assert (c.dte, c.premium_yield, c.annualized_yield) == (30, 0.01, 0.121667)
    assert (c.upside_cap, c.return_if_called, c.flags) == (0.05, 0.06, ())
    assert c.score == pytest.approx(12.1667)  # 100 x 0.121667, no flags, tight spread, delta <= 0.25


@pytest.mark.parametrize(
    ("quote", "passes"),
    [
        (call(days=20), False),
        (call(days=21), True),
        (call(days=45), True),
        (call(days=46), False),
        (call(delta=0.15), True),
        (call(delta=0.31), False),
        (call(open_interest=99), False),
        (call(bid=0.09, ask=0.095), False),
        (call(bid=1.90, ask=2.10), True),  # spread exactly 10% of mid
        (call(bid=1.90, ask=2.12), False),
    ],
)
def test_filters_at_their_boundaries(quote, passes):
    assert bool(candidates(100.0, [quote], TODAY)) is passes


def test_earnings_before_expiry_excludes_the_call():
    assert candidates(100.0, [call()], TODAY, earnings=TODAY + timedelta(days=10)) == []
    assert candidates(100.0, [call()], TODAY, earnings=TODAY + timedelta(days=31)) != []


def test_delta_comes_from_iv_when_the_broker_sent_none():
    quote = call(delta=None, iv=0.25)
    [c] = candidates(100.0, [quote], TODAY, rate=0.04)
    assert c.delta == pytest.approx(bs_greeks(100.0, 105.0, 30 / 365, 0.04, 0.25)["delta"])  # about 0.27
    assert candidates(100.0, [call(delta=None)], TODAY) == []  # neither delta nor IV: skip


def test_flags_lower_the_score():
    lots = (Lot(100, 110.0, date(2021, 3, 1)), Lot(100, 100.0, TODAY - timedelta(days=90)))
    [c] = candidates(
        100.0,
        [call()],
        TODAY,
        lots=lots,
        tax_advantaged_contracts_free=1,
        ex_dividend=TODAY + timedelta(days=12),
    )
    # Average cost 105.00 equals the strike, so "strike_below_cost_basis" stays off.
    assert c.flags == ("ex_dividend_before_expiry", "short_term_lots", "cover_tax_advantaged_first")
    assert c.score == pytest.approx(12.1667 - 30)


def test_tax_advantaged_accounts_skip_tax_flags():
    lots = (Lot(200, 150.0, TODAY - timedelta(days=30)),)
    [c] = candidates(100.0, [call()], TODAY, lots=lots, taxable=False, tax_advantaged_contracts_free=2)
    assert c.flags == ("strike_below_cost_basis",)


def test_best_score_first_and_spread_and_delta_penalties():
    wide = call(strike=106.0, bid=1.00, ask=1.08)  # spread 7.7% of mid: -5
    hot = call(strike=104.0, delta=0.27)  # delta above 0.25: -5
    clean = call(strike=107.0, bid=0.95, ask=0.98)
    ranked = candidates(100.0, [wide, hot, clean], TODAY, iv_rank=60)  # IV rank 60 adds 6
    assert {c.quote.strike: c.score for c in ranked} == {107.0: 17.5583, 106.0: 13.1667, 104.0: 13.1667}
    assert ranked[0].quote.strike == 107.0


def test_the_scan_keeps_the_best_three():
    quotes = [
        call(strike=104.0, bid=1.30, ask=1.34),
        call(strike=105.0, bid=1.20, ask=1.24),
        call(strike=106.0, bid=1.10, ask=1.14),
        call(strike=107.0, bid=1.00, ask=1.04),
    ]
    kept = candidates(100.0, quotes, TODAY)
    assert [c.quote.strike for c in kept] == [104.0, 105.0, 106.0]  # highest yields
    assert len(candidates(100.0, quotes, TODAY, keep=4)) == 4


def test_opportunity_rule():
    [c] = candidates(100.0, [call(bid=1.40, ask=1.44)], TODAY)  # 17% a year
    assert is_opportunity(c, 55)
    assert not is_opportunity(c, 45)
    assert not is_opportunity(c, None)
    assert not is_opportunity(replace(c, flags=("short_term_lots",)), 55)


def test_short_call_risk_rules():
    short = ShortCall(expiry=TODAY + timedelta(days=7), strike=100.0, contracts=2)
    common = {"today": TODAY, "next_trading_day": TODAY + timedelta(days=1)}
    assert short_call_risks(short, spot=98.0, delta=0.40, extrinsic=1.0, **common) == ["near_strike_near_expiry"]
    later = replace(short, expiry=TODAY + timedelta(days=8))
    assert short_call_risks(later, spot=98.0, delta=0.40, extrinsic=1.0, **common) == []
    assert short_call_risks(later, spot=104.0, delta=0.51, extrinsic=1.0, **common) == ["delta_above_0_50"]
    dividend = {"ex_dividend": TODAY + timedelta(days=1), "dividend": 0.26}
    assert short_call_risks(later, spot=104.0, delta=0.45, extrinsic=0.20, **common, **dividend) == [
        "early_assignment_before_dividend"
    ]
    assert short_call_risks(
        later, spot=90.0, delta=0.10, extrinsic=0.3, earnings=TODAY + timedelta(days=8), **common
    ) == ["earnings_before_expiry"]
    assert extrinsic_value(5.30, 104.0, 100.0) == 1.3


def test_roll_candidates():
    short = ShortCall(expiry=TODAY + timedelta(days=5), strike=100.0, contracts=1)
    quotes = [
        call(days=33, strike=100.0, bid=2.15, ask=2.20),  # credit 0.05: kept (boundary)
        call(days=33, strike=105.0, bid=2.50, ask=2.60),  # credit 0.40
        call(days=33, strike=95.0, bid=6.00, ask=6.10),  # lower strike
        call(days=61, strike=105.0, bid=3.50, ask=3.60),  # beyond 60 DTE
        call(days=5, strike=105.0, bid=2.50, ask=2.60),  # same expiry
        call(days=33, strike=110.0, bid=2.14, ask=2.20),  # credit 0.04
    ]
    rolled = roll_candidates(short, buyback_ask=2.10, quotes=quotes, today=TODAY)
    assert [(q.strike, credit) for q, credit in rolled] == [(105.0, 0.4), (100.0, 0.05)]


def test_iv_rank_and_percentile():
    year = [0.20 + 0.001 * n for n in range(251)] + [0.30]  # low 0.20, high 0.45, now 0.30
    assert iv_rank(year) == 40.0
    assert iv_percentile(year) == pytest.approx(100 * 100 / 251, abs=1e-6)  # 0.200 .. 0.299 lie below 0.30
    assert iv_rank(year[:59]) is None and iv_percentile(year[:59]) is None  # under 60 sessions: hidden
    assert iv_rank([0.25] * 100) is None  # a year that never moved has no rank


def test_thresholds_survive_floating_point_noise():
    lots = (Lot(1, 100.01, date(2021, 3, 1)), Lot(1, 100.03, date(2021, 3, 1)))  # average 100.02000000000001 in binary
    [c] = candidates(100.0, [call(strike=100.02, delta=0.22)], TODAY, lots=lots, taxable=False)
    assert "strike_below_cost_basis" not in c.flags
    short = ShortCall(expiry=TODAY + timedelta(days=7), strike=110.0, contracts=1)
    risks = short_call_risks(
        short, spot=112.2, today=TODAY, delta=0.4, extrinsic=1.0, next_trading_day=TODAY + timedelta(days=1)
    )
    assert risks == ["near_strike_near_expiry"]  # 112.2 - 110.0 is 2.200000000000003 in binary
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_covered_calls.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.covered_calls'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/covered_calls.py`:

```python
"""Covered-call scan math and short-call risk rules (02 section 6.3). Prices come in; nothing is fetched.

Money and percentage values are rounded to 6 decimals before they meet a threshold, so a spread of
exactly 10% of mid passes a 10% filter despite binary floating point.
"""

import math
from dataclasses import dataclass
from datetime import date, timedelta

from ai_trading.core.options_math import bs_greeks


@dataclass(frozen=True)
class OptionQuote:
    """One call on the chain. `delta` is the broker's model delta; `iv` computes one when it is missing."""

    expiry: date
    strike: float
    bid: float
    ask: float
    open_interest: int
    delta: float | None = None
    iv: float | None = None


@dataclass(frozen=True)
class Lot:
    shares: float
    cost_per_share: float
    acquired: date


@dataclass(frozen=True)
class Filters:
    """02 section 6.3 defaults; every value is a user setting."""

    min_dte: int = 21
    max_dte: int = 45
    min_delta: float = 0.15
    max_delta: float = 0.30
    min_open_interest: int = 100
    max_spread_pct: float = 10.0  # of mid
    min_bid: float = 0.10


DEFAULT_FILTERS = Filters()


@dataclass(frozen=True)
class Candidate:
    quote: OptionQuote
    dte: int
    delta: float
    premium_yield: float  # bid / spot
    annualized_yield: float  # premium yield x 365 / DTE
    upside_cap: float  # (strike - spot) / spot
    return_if_called: float  # (strike - spot + bid) / spot
    spread_pct: float
    flags: tuple[str, ...]
    score: float


@dataclass(frozen=True)
class ShortCall:
    expiry: date
    strike: float
    contracts: int


def _r(value: float) -> float:
    return round(value, 6)


def coverable_contracts(shares: float, max_cover_pct: float, open_contracts: int) -> int:
    """Contracts that may still be sold: 1,000 shares under a 50% cap with 3 open leaves 2."""
    return max(0, math.floor(_r(shares * max_cover_pct / 100 / 100)) - open_contracts)


def _delta(quote: OptionQuote, spot: float, dte: int, rate: float) -> float | None:
    if quote.delta is not None:
        return quote.delta
    if quote.iv is None or quote.iv <= 0:
        return None
    return bs_greeks(spot, quote.strike, dte / 365, rate, quote.iv, "call")["delta"]


def candidates(
    spot: float,
    quotes: list[OptionQuote],
    today: date,
    *,
    filters: Filters = DEFAULT_FILTERS,
    lots: tuple[Lot, ...] = (),
    taxable: bool = True,
    tax_advantaged_contracts_free: int = 0,
    ex_dividend: date | None = None,
    earnings: date | None = None,
    iv_rank: float | None = None,
    rate: float = 0.0,
    keep: int = 3,
) -> list[Candidate]:
    """Calls that pass the filters for one account and symbol, best score first.

    `lots` are this account's lots of the symbol. `tax_advantaged_contracts_free` is how many
    contracts the same owner could still sell in tax-advantaged accounts. An unknown IV rank
    (short history) adds nothing to the score. Returns at most `keep` (02: the scan keeps the top
    three).
    """
    shares = sum(lot.shares for lot in lots)
    average_cost = sum(lot.shares * lot.cost_per_share for lot in lots) / shares if shares else None
    short_term = taxable and any(lot.acquired > today - timedelta(days=365) for lot in lots)
    out = []
    for quote in quotes:
        dte = (quote.expiry - today).days
        mid = (quote.bid + quote.ask) / 2
        if not filters.min_dte <= dte <= filters.max_dte or mid <= 0:
            continue
        spread_pct = _r((quote.ask - quote.bid) / mid * 100)
        if (
            _r(quote.bid) < _r(filters.min_bid)
            or quote.open_interest < filters.min_open_interest
            or spread_pct > filters.max_spread_pct
            or (earnings is not None and today <= earnings <= quote.expiry)
        ):
            continue
        delta = _delta(quote, spot, dte, rate)
        if delta is None or not filters.min_delta <= delta <= filters.max_delta:
            continue
        flags = []
        if ex_dividend is not None and today <= ex_dividend <= quote.expiry:
            flags.append("ex_dividend_before_expiry")
        if average_cost is not None and _r(quote.strike) < _r(average_cost):
            flags.append("strike_below_cost_basis")
        if short_term:
            flags.append("short_term_lots")
        if taxable and tax_advantaged_contracts_free > 0:
            flags.append("cover_tax_advantaged_first")
        premium = _r(quote.bid / spot)
        annualized = _r(premium * 365 / dte)
        score = (
            100 * min(annualized, 0.40)
            + 0.1 * (iv_rank or 0.0)
            - 10 * len(flags)
            - (5 if spread_pct > 5 else 0)
            - (5 if delta > 0.25 else 0)
        )
        out.append(
            Candidate(
                quote=quote,
                dte=dte,
                delta=delta,
                premium_yield=premium,
                annualized_yield=annualized,
                upside_cap=_r((quote.strike - spot) / spot),
                return_if_called=_r((quote.strike - spot + quote.bid) / spot),
                spread_pct=spread_pct,
                flags=tuple(flags),
                score=_r(score),
            )
        )
    return sorted(out, key=lambda c: c.score, reverse=True)[:keep]


def is_opportunity(candidate: Candidate, iv_rank: float | None) -> bool:
    """Opportunity alert: at least 15% a year, IV rank at least 50, and no flags."""
    return candidate.annualized_yield >= 0.15 and iv_rank is not None and iv_rank >= 50 and not candidate.flags


def extrinsic_value(call_mid: float, spot: float, strike: float) -> float:
    return _r(call_mid - max(spot - strike, 0.0))


def short_call_risks(
    call: ShortCall,
    *,
    spot: float,
    today: date,
    delta: float,
    extrinsic: float,
    next_trading_day: date,
    ex_dividend: date | None = None,
    dividend: float | None = None,
    earnings: date | None = None,
) -> list[str]:
    """Risk-alert reasons for one open short call; empty when there is nothing to report."""
    risks = []
    if delta > 0.50:
        risks.append("delta_above_0_50")
    if (call.expiry - today).days <= 7 and _r(abs(spot - call.strike)) <= _r(0.02 * call.strike):
        risks.append("near_strike_near_expiry")
    if ex_dividend == next_trading_day and dividend is not None and _r(extrinsic) < _r(dividend):
        risks.append("early_assignment_before_dividend")
    if earnings is not None and today <= earnings <= call.expiry:
        risks.append("earnings_before_expiry")
    return risks


def roll_candidates(
    call: ShortCall,
    *,
    buyback_ask: float,
    quotes: list[OptionQuote],
    today: date,
    max_dte: int = 60,
    min_credit: float = 0.05,
) -> list[tuple[OptionQuote, float]]:
    """Same or higher strike, later expiry within `max_dte`, net credit per share of at least `min_credit`."""
    out = []
    for quote in quotes:
        if quote.strike < call.strike or quote.expiry <= call.expiry or (quote.expiry - today).days > max_dte:
            continue
        credit = _r(quote.bid - buyback_ask)
        if credit >= min_credit:
            out.append((quote, credit))
    return sorted(out, key=lambda pair: pair[1], reverse=True)


def iv_rank(iv30_history: list[float]) -> float | None:
    """(IV30 now - 52-week low) / (52-week high - 52-week low) x 100 over the last 252 sessions,
    latest last. None before 60 sessions (02a section 12 hides it); callers label it "short
    history" before 252, and None when the year's IV never moved."""
    if len(iv30_history) < 60:
        return None
    window = iv30_history[-252:]
    low, high = min(window), max(window)
    return None if high == low else _r((window[-1] - low) / (high - low) * 100)


def iv_percentile(iv30_history: list[float]) -> float | None:
    """Share of the last 252 sessions (latest excluded) with IV30 below today's, x 100."""
    if len(iv30_history) < 60:
        return None
    window = iv30_history[-253:-1]
    return _r(sum(value < iv30_history[-1] for value in window) / len(window) * 100)
```

- [ ] **Step 4: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_covered_calls.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `27 passed`, ruff clean, then `144 passed`.

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/covered_calls.py ai-trading/packages/family-desk/backend/tests/test_covered_calls.py
git commit -m "feat(ai-trading): Desk covered-call math and short-call risk rules (02 section 6.3)"
```

### Task 1b.3: Support and resistance as a strategy level

**Files:**
- Modify: `backend/src/ai_trading/core/levels.py` (append), `backend/src/ai_trading/core/evaluate.py` (one branch), `contracts/src/strategy-spec-v1.ts` (one union member), `THIRD_PARTY_NOTICES.md` (one row)
- Modify: `backend/tests/test_levels.py` (append), `backend/tests/test_evaluate.py` (append)
- Create: `contracts/fixtures/strategy-spec-v1/valid/support-and-resistance.json`, `contracts/fixtures/strategy-spec-v1/invalid/support-lookback-too-short.json`
- Regenerate: `contracts/generated/strategy-spec-v1.schema.json`, `backend/src/ai_trading/contracts/strategy_spec_v1.py`

**Interfaces:**
- Consumes: `levels.n_day`-style per-day series (Phase 1), `evaluate._compute` (Phase 1).
- Produces:
  - `levels.support_resistance(daily, days, lookback, side, window=5, count=3) -> pd.Series` indexed by `days`;
  - the level operand `{"level": "support" | "resistance", "days": 20–260}`, whose evidence key is `support(<days>)` or `resistance(<days>)`.

- [ ] **Step 1: Write the failing tests.**

Append to `backend/tests/test_levels.py`:

```python
def _wave_days() -> tuple[list[date], list[float]]:
    days = trading_days("stock", date(2026, 10, 6), 61)
    wave = [100.0, 102.0, 104.0, 106.0, 108.0, 110.0, 108.0, 106.0, 104.0, 102.0] * 6  # lows 100, highs 110
    return days, wave


def test_support_and_resistance_come_from_pivots_around_the_previous_close():
    days, wave = _wave_days()
    daily = daily_bars(days[:-1], wave)
    today = pd.Index([days[-1]])
    assert levels.support_resistance(daily, today, 60, "support").iloc[0] == 100.0
    assert levels.support_resistance(daily, today, 60, "resistance").iloc[0] == 110.0


def test_an_unconfirmed_pivot_is_not_a_level():
    days, wave = _wave_days()
    daily = daily_bars(days[:-1], wave[:-2] + [95.0, 96.0])  # a new low two bars ago, not yet confirmed
    out = levels.support_resistance(daily, pd.Index([days[-1]]), 60, "support")
    assert np.isnan(out.iloc[0])  # 100 is above the previous close and 95 needs 5 more bars


def test_support_needs_enough_history():
    days, wave = _wave_days()
    daily = daily_bars(days[:10], wave[:10])
    assert np.isnan(levels.support_resistance(daily, pd.Index([days[10]]), 60, "support").iloc[0])
```

Append to `backend/tests/test_evaluate.py`:

```python
def test_a_close_below_support_fires_with_the_level_as_evidence():
    days = trading_days("stock", DAY, 62)
    wave = [100.0, 102.0, 104.0, 106.0, 108.0, 110.0, 108.0, 106.0, 104.0, 102.0] * 6
    daily = daily_bars(days, wave + [101.0, 97.0])
    spec = make_spec(
        {"op": "crosses_below", "left": CLOSE, "right": {"level": "support", "days": 60}}, run_on="daily_close"
    )
    found = evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=daily, as_of=et(DAY, "20:00"))
    assert times(found) == ["10-06 16:00"]
    assert found[0].evidence == {"close": 97.0, "support(60)": 100.0}
```

Create `contracts/fixtures/strategy-spec-v1/valid/support-and-resistance.json`:

```json
{
  "schemaVersion": 1,
  "name": "Fixture",
  "watch": { "universe": { "watchlist": "Swing" }, "session": "regular", "runOn": "daily_close" },
  "when": {
    "any": [
      { "op": "crosses_below", "left": { "series": "close" }, "right": { "level": "support", "days": 60 } },
      { "op": "within_pct", "left": { "series": "close" }, "right": { "level": "resistance", "days": 120 }, "pct": 1 }
    ]
  },
  "then": { "alert": { "channels": ["inbox"], "severity": "risk" } }
}
```

Create `contracts/fixtures/strategy-spec-v1/invalid/support-lookback-too-short.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Swing" }, "session": "regular", "runOn": "daily_close" }, "when": { "op": "lt", "left": { "series": "close" }, "right": { "level": "support", "days": 10 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

- [ ] **Step 2: Run them and watch them fail.**

Run (in `contracts/`): `pnpm test`
Expected: `accepts support-and-resistance.json` fails (`not ok`). The invalid fixture already fails validation, so its test passes.

Run (in `backend/`): `uv run pytest -q tests/test_levels.py tests/test_evaluate.py tests/test_contracts.py`
Expected: `AttributeError: module 'ai_trading.core.levels' has no attribute 'support_resistance'`, and a `ValidationError` for the new valid fixture.

- [ ] **Step 3: Add the operand to the contract.** In `contracts/src/strategy-spec-v1.ts`, `LevelOperandSchema`'s union gets a fourth member after the `n_day_high`/`n_day_low` member:

```typescript
    z.strictObject({
      level: z.enum(["support", "resistance"]),
      days: z.int().min(20).max(260),
    }),
```

Regenerate both files:

Run (in `contracts/`): `pnpm generate:json-schema && pnpm test && pnpm typecheck`
Expected: `# pass 40`, `# fail 0`.

Run (in `backend/`): `scripts/generate-contracts.sh`
Expected: `strategy_spec_v1.py` gains `class LevelOperand4(SpecModel)` with `level: Literal["support", "resistance"]`.

- [ ] **Step 4: Implement the level.** Append to `backend/src/ai_trading/core/levels.py`:

```python
def _clusters(prices: list[float], count: int) -> list[float]:
    """Centers of the `count` most-touched price clusters (prices within 5% of the range)."""
    if len(prices) <= count:
        return sorted(prices)
    ordered = sorted(prices)
    spread = ordered[-1] - ordered[0]
    threshold = spread * 0.05 if spread > 0 else 1.0
    groups: list[list[float]] = [[ordered[0]]]
    for price in ordered[1:]:
        if abs(price - float(np.mean(groups[-1]))) <= threshold:
            groups[-1].append(price)
        else:
            groups.append([price])
    ranked = sorted(((len(group), float(np.mean(group))) for group in groups), reverse=True)
    return [center for _, center in ranked[:count]]


def support_resistance(
    daily: pd.DataFrame, days: pd.Index, lookback: int, side: str, window: int = 5, count: int = 3
) -> pd.Series:
    """Nearest support at or below ("support"), or resistance at or above ("resistance"), the
    previous close. Levels are cluster centers of the closing-price pivots in the `lookback`
    daily bars before each day; a pivot counts only once `window` bars after it have closed, so a
    level never moves on bars that are already known.

    Adapted from Vibe-Trading `agent/src/tools/pattern_tool.py` (`find_peaks_valleys`,
    `support_resistance`; MIT License, see THIRD_PARTY_NOTICES.md). Changes: confirmed pivots only,
    and the nearest level to the previous close instead of the whole list.
    """
    closes = daily["close"].to_numpy(dtype=float)
    out = []
    for day in days:
        end = int(daily.index.searchsorted(day, side="left"))
        history = closes[max(0, end - lookback) : end]
        level = float("nan")
        if len(history) > 2 * window:
            pivots = []
            for i in range(window, len(history) - window):
                segment = history[i - window : i + window + 1]
                is_pivot = history[i] == segment.min() if side == "support" else history[i] == segment.max()
                if is_pivot and not np.isnan(history[i]):
                    pivots.append(float(history[i]))
            reference = history[-1]
            centers = _clusters(pivots, count)
            if side == "support":
                below = [c for c in centers if c <= reference]
                level = max(below) if below else level
            else:
                above = [c for c in centers if c >= reference]
                level = min(above) if above else level
        out.append(level)
    return pd.Series(out, index=days, dtype=float)
```

In `backend/src/ai_trading/core/evaluate.py`, inside `_compute`'s `if "level" in operand:` block, add this branch right before `if name in _SESSION_LEVELS:`:

```python
        if name in ("support", "resistance"):
            return frame.per_day(levels.support_resistance(frame.daily, unique_days, operand["days"], name))
```

Add this row to the Vibe-Trading table in `THIRD_PARTY_NOTICES.md`:

```markdown
| `backend/src/ai_trading/core/levels.py` (`support_resistance`, `_clusters`) | `agent/src/tools/pattern_tool.py` (`find_peaks_valleys`, `support_resistance`) | Confirmed pivots only; the nearest level to the previous close |
```

- [ ] **Step 5: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_levels.py tests/test_evaluate.py tests/test_contracts.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: all pass, ruff clean, then `150 passed`.

- [ ] **Step 6: Commit.**

```bash
git add ai-trading/packages/family-desk/contracts ai-trading/packages/family-desk/backend ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): support and resistance level for Desk strategies (adapted from Vibe-Trading)"
```

### Task 1b.4: Paper-order sizing, and phase status

**Files:**
- Create: `backend/src/ai_trading/core/sizing.py`, `backend/tests/test_sizing.py`
- Modify: `ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md` (Phases table), `ai-trading/plans/STATUS.md` (the "5+" row)

**Interfaces:**
- Consumes: the spec's `then.paperOrder` as stored (`spec.model_dump(by_alias=True, exclude_none=True)["then"]["paperOrder"]`).
- Produces (the Phase 6 broker relies on these):
  - `Clamp(limit, before, after)`, `Bracket(side, quantity, entry, stop, target, clamps)`, `OrderPlan(bracket, reason)`
  - `plan_order(paper_order, *, entry, stop_level=None, target_level=None, atr=None, book_equity=None, multiplier=1.0, max_position_usd=None) -> OrderPlan`
- Reasons: `ATR is unknown`, `stop level is unknown`, `stop is not on the losing side of the entry`, `target level is unknown`, `target is not on the winning side of the entry`, `book equity is unknown`, `size rounds to zero`.

- [ ] **Step 1: Write the failing test** `backend/tests/test_sizing.py`:

```python
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
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_sizing.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.sizing'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/sizing.py`:

```python
"""Paper-order sizing: a signal's `paperOrder` becomes an exact bracket, or a reason there is none.

Deterministic arithmetic: the paper broker (Phase 6) sends what this returns and nothing else.
Every clamp is recorded so a smaller order can be explained, after the clamp audit trail in
ai-hedge-fund `hedge_fund/risk/limits.py` (the idea, not the code). Prices are not rounded to the
instrument's tick here; the broker does that.
"""

import math
from dataclasses import dataclass
from typing import Any, Literal

Side = Literal["buy", "sell"]


@dataclass(frozen=True)
class Clamp:
    limit: str
    before: int
    after: int


@dataclass(frozen=True)
class Bracket:
    side: Side
    quantity: int
    entry: float
    stop: float
    target: float
    clamps: tuple[Clamp, ...]


@dataclass(frozen=True)
class OrderPlan:
    bracket: Bracket | None
    reason: str | None  # why there is no order


def _floor(value: float) -> int:
    return math.floor(round(value, 9))  # 300 / 0.3 is 999.9999999999999 in binary floating point


def _known(value: float | None) -> bool:
    return value is not None and not math.isnan(value)


def plan_order(
    paper_order: dict[str, Any],
    *,
    entry: float,
    stop_level: float | None = None,
    target_level: float | None = None,
    atr: float | None = None,
    book_equity: float | None = None,
    multiplier: float = 1.0,
    max_position_usd: float | None = None,
) -> OrderPlan:
    """Size `paper_order` (the spec's `then.paperOrder`, as stored) for an entry price.

    `stop_level` and `target_level` are the current values of the spec's level operands, when the
    stop or target is a level. `multiplier` is the futures point value (1 for stocks).
    """

    def no(reason: str) -> OrderPlan:
        return OrderPlan(None, reason)

    side: Side = paper_order["side"]
    sign = 1.0 if side == "buy" else -1.0
    stop_spec, target_spec, size = paper_order["stop"], paper_order["target"], paper_order["size"]

    if "atrMultiple" in stop_spec:
        if not _known(atr) or atr <= 0:
            return no("ATR is unknown")
        stop = entry - sign * stop_spec["atrMultiple"] * atr
    else:
        if not _known(stop_level):
            return no("stop level is unknown")
        stop = stop_level
    risk = round(sign * (entry - stop), 9)
    if risk <= 0:
        return no("stop is not on the losing side of the entry")

    if "r" in target_spec:
        target = entry + sign * target_spec["r"] * risk
    else:
        if not _known(target_level):
            return no("target level is unknown")
        target = target_level
    if sign * (target - entry) <= 0:
        return no("target is not on the winning side of the entry")

    if "riskUsd" in size:
        quantity = _floor(size["riskUsd"] / (risk * multiplier))
    elif "pctOfBook" in size:
        if not _known(book_equity) or book_equity <= 0:
            return no("book equity is unknown")
        quantity = _floor(book_equity * size["pctOfBook"] / 100 / (entry * multiplier))
    else:
        quantity = int(size.get("shares", size.get("contracts")))

    clamps: list[Clamp] = []
    if max_position_usd is not None:
        cap = _floor(max_position_usd / (entry * multiplier))
        if quantity > cap:
            clamps.append(Clamp("maxPositionUsd", quantity, cap))
            quantity = cap
    if quantity < 1:
        return no("size rounds to zero")
    bracket = Bracket(side, quantity, entry, round(stop, 6), round(target, 6), tuple(clamps))
    return OrderPlan(bracket, None)
```

- [ ] **Step 4: Run every suite.**

Run (in `backend/`): `uv run pytest -q tests/test_sizing.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `14 passed`, ruff clean, then `164 passed`.

Run (in `contracts/`): `pnpm typecheck && pnpm test`
Expected: `# pass 40`, `# fail 0`.

- [ ] **Step 5: Record the phase.**
  - In 02c's Phases table, set the status of the "1b. Ported quant core" row to `Done`.
  - In `STATUS.md`'s "5+" row, append: "Phase 1b (ported quant core) done: option math, covered-call math, support/resistance, order sizing."

- [ ] **Step 6: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/sizing.py ai-trading/packages/family-desk/backend/tests/test_sizing.py ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md ai-trading/plans/STATUS.md
git commit -m "feat(ai-trading): Desk paper-order sizing with recorded clamps; mark Desk Phase 1b done"
```

## After the Tasks (main session)

1. Merge the subagent's branch into `feature/toby`, then remove its worktree and delete the branch.
2. Phase 1b ships in the same pull request as the next phase, or on its own if nothing follows soon (one pull request per finished phase or meaningful batch).
