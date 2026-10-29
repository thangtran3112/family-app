"""The valuation inputs and the earnings-reaction wiring of `research/valuation.py` (02n §c3 #14), without a database:
each method's value is the engine's own number per share (recomputed here from the same canned filings), a missing
input makes its method null and says why, and the reaction is None below four usable reports."""

import pytest
from research_world import (
    FY_ENDS,
    PRICE,
    SHARES,
    announced,
    bar_frames,
    event_days,
    event_jumps,
    fact,
    filings,
)

from ai_trading.core import valuation as engine
from ai_trading.db.models import EarningsResult
from ai_trading.research.valuation import _closes as closes_of
from ai_trading.research.valuation import _methods, _reaction_block

CLOSES = {day: float(close) for day, close in bar_frames()["AAA"]["close"].items()}


def methods(**kwargs):
    facts = filings(without=kwargs.pop("without", ()))
    return _methods(facts, kwargs.pop("price", PRICE), kwargs.pop("closes", CLOSES))


def test_every_method_is_the_engines_value_per_share():
    got = methods()
    market_cap = PRICE * SHARES
    fcf = [10.0e9 - 1.1e9, 9.5e9 - 1.0e9, 9.0e9 - 1.0e9, 8.5e9 - 0.9e9, 8.0e9 - 0.9e9]
    growth = 40.0e9 / 38.0e9 - 1
    wacc = engine.calculate_wacc(market_cap, 11.0e9, 20.0e9, 10.0e9 / 2.0e8)
    dcf = engine.calculate_dcf_scenarios(fcf, wacc, market_cap, growth)["expected_value"]
    owner = engine.calculate_owner_earnings_value(8.0e9, 1.0e9, 1.1e9, 2.0e8, growth_rate=growth)
    residual = engine.calculate_residual_income_value(market_cap, 8.0e9, market_cap / 30.0e9)
    assert got["dcf"]["value"] == pytest.approx(dcf / SHARES, abs=0.01)
    assert got["owner_earnings"]["value"] == pytest.approx(owner / SHARES, abs=0.01)
    assert got["residual_income"]["value"] == pytest.approx(residual / SHARES, abs=0.01)
    assert got["ev_ebitda"]["value"] is not None and got["ev_ebitda"]["inputs"]["multiples_used"] == 3
    assert got["dcf"]["inputs"]["fcf_years"] == 5
    assert got["dcf"]["inputs"]["wacc_pct"] == pytest.approx(wacc * 100, abs=0.01)


def test_the_defaults_the_engine_takes_are_stated_in_words():
    got = methods()
    assert "Beta: 1.0 proxy, no beta source" in got["dcf"]["fallbacks"]
    assert any("15%" in line and "25%" in line for line in got["owner_earnings"]["fallbacks"])
    assert any("10%" in line for line in got["residual_income"]["fallbacks"])
    assert any("year-end multiples" in line for line in got["ev_ebitda"]["fallbacks"])


def test_without_revenue_history_the_growth_default_is_said():
    got = methods(without=("Revenues",))
    assert got["dcf"]["value"] is not None
    assert "Growth rate: 5% default, no revenue history" in got["dcf"]["fallbacks"]
    assert got["dcf"]["inputs"]["revenue_growth_pct"] is None


def test_a_method_with_a_missing_input_is_null_and_names_it():
    got = methods(without=("IncreaseDecreaseInOperatingCapital",))
    assert got["owner_earnings"]["value"] is None
    assert any("working-capital" in line for line in got["owner_earnings"]["fallbacks"])
    assert got["dcf"]["value"] is not None and got["residual_income"]["value"] is not None  # the others are unharmed
    no_cash_flow = methods(without=("NetCashProvidedByUsedInOperatingActivities",))
    assert no_cash_flow["dcf"]["value"] is None
    assert any("Free cash flow" in line for line in no_cash_flow["dcf"]["fallbacks"])


def test_without_a_price_only_owner_earnings_has_a_value():
    got = methods(price=None)
    assert got["owner_earnings"]["value"] is not None
    for name in ("dcf", "ev_ebitda", "residual_income"):
        assert got[name]["value"] is None
        assert "Price unavailable: the market value needs it" in got[name]["fallbacks"]


def test_without_shares_nothing_has_a_per_share_value():
    got = methods(without=("CommonStockSharesOutstanding",))
    for name, method in got.items():
        assert method["value"] is None, name
        assert "Shares outstanding: not in the filings, so no per-share value" in method["fallbacks"], name


def test_a_median_of_fewer_than_three_multiples_is_not_offered():
    got = methods(closes={})  # no price history: only the current multiple exists, and its median is the price itself
    assert got["ev_ebitda"]["value"] is None
    assert any("found 1" in line for line in got["ev_ebitda"]["fallbacks"])


def test_a_year_of_negative_free_cash_flow_gives_no_dcf_and_says_so():
    ocf = "NetCashProvidedByUsedInOperatingActivities"
    losing = [f for f in filings() if not (f.concept == ocf and f.period_end == FY_ENDS[0])]
    losing.append(fact(ocf, 0.5e9, FY_ENDS[0]))  # below that year's capital spending
    got = _methods(losing, PRICE, CLOSES)
    assert got["dcf"]["value"] is None
    assert any("not positive" in line for line in got["dcf"]["fallbacks"])


def _results(count: int) -> list[EarningsResult]:
    """One stored result per announcement, alternating beat and miss, as `event_jumps` alternates +5% and -3%."""
    days = bar_frames()["AAA"].index
    return [
        EarningsResult(
            symbol="AAA",
            period_end=days[day],
            report_date=days[day],
            eps_estimate=1.0,
            eps_actual=1.1 if k % 2 == 0 else 0.9,
        )
        for k, day in enumerate(event_days(count))
    ]


def _block(count: int, jumps=None):
    frames = bar_frames(event_jumps() if jumps is None else jumps)
    return _reaction_block(
        [a.announced_on for a in announced(count)],
        closes_of(frames["AAA"]),
        closes_of(frames["SPY"]),
        _results(count),
    )


def test_eight_reports_summarize_into_beats_misses_and_a_newest_first_series():
    block = _block(8)
    assert block["reports"] == 8
    assert block["beats"]["n"] == 4 and block["misses"]["n"] == 4
    assert block["beats"]["avg_excess_pct"] == pytest.approx(5.0, abs=0.5)  # the +5% jump after every beat
    assert block["misses"]["avg_excess_pct"] == pytest.approx(-3.0, abs=0.5)
    assert block["avg_excess_pct"] == pytest.approx(1.0, abs=0.5)
    assert block["avg_abs_move_pct"] > 3
    dates = [point["date"] for point in block["series"]]
    assert dates == sorted(dates, reverse=True) and len(dates) == 8
    assert block["implied_move_pct"] is None


def test_below_four_usable_reports_there_is_no_summary():
    assert _block(3) is None
    assert _block(4) is not None


def test_the_latest_session_has_no_next_day_so_it_is_left_out_not_half_counted():
    days = bar_frames()["AAA"].index
    frames = bar_frames(event_jumps(4))
    announcements = [a.announced_on for a in announced(4)] + [days[-1]]  # announced on the last bar: no day after
    block = _reaction_block(announcements, closes_of(frames["AAA"]), closes_of(frames["SPY"]), [])
    assert block is not None and block["reports"] == 4
    assert days[-1] not in [point["date"] for point in block["series"]]
