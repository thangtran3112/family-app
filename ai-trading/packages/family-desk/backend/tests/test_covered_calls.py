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
