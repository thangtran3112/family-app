"""Futures contract specs, last-trade/first-notice/roll dates, the front month, and the
micro-first sizer (02g §4).

The parametrized sweep below cross-checks `futures.py` against an *independent* business-day
calculator (plain Python, no `exchange_calendars`): `_is_business_day`/`_business_days_before`/
`_last_business_day_of_month`/`_nth_last_business_day_of_month` here, driven by an explicit,
hand-maintained CME full-holiday list for 2026-2027 (`CME_HOLIDAYS_2026_27`), not by reading the
same calendar library `futures.py` itself uses. Two independent implementations landing on the
same date for every contract month of 2026 and 2027, across all six contract families, is much
stronger evidence than one implementation agreeing with itself.

`CME_HOLIDAYS_2026_27` is CME Globex's full-day closures only (CME almost never closes all day;
most US holidays are early closes, not closures) -- cross-checked 2026-10-10 against
https://www.financecalendar.com/futures-market-holidays ("full closures in this period are
December 25, 2026, January 1, 2027, March 26, 2027 and December 24, 2027, with every other listed
date an early close rather than a full holiday") and against `exchange_calendars`' own `CMES`
calendar (same six dates). Early closes (Presidents Day, Memorial Day, Juneteenth, July 4,
Labor Day, Thanksgiving, the day after Thanksgiving, Christmas Eve) do not block a trading day
from counting as a CME business day for last-trade/roll arithmetic.

Spot-checked against public sources, 2026-10-10:
- GC/MGC "third last business day of the delivery month" and "first notice day is the last
  business day of the month before": CME Group's own Gold Futures and Options fact card and
  COMEX Rulebook Chapter 113 (113102.E, "Termination of Trading"), and independently
  discounttrading.com's contract-specs page (same two rules, same wording).
- The CME Globex session (Sunday 18:00 ET to Friday 17:00 ET, with a daily 17:00-18:00 ET
  maintenance break): CME's Gold Futures and Options fact card ("CME Globex: Sunday - 5:00 p.m. -
  Friday 4:00 p.m. CT with a 60-minute break each day beginning at 5:00 p.m."; CT+1 hour = ET).
- The equity-index third-Friday expiration and the CL/MCL 25th-of-the-prior-month rule are
  standard, widely published CME conventions; not separately spot-checked here.

The sweep below covers every contract month of 2026 and 2027 for all six families, with no skips:
`ai_trading.core.calendar`'s `exchange_calendars` instances are built over a fixed, explicit range
(2015-01-01 to 2030-12-31), not `exchange_calendars`' own today-relative default, so every date in
this file is independent of the day this test happens to run.
"""

from datetime import date, timedelta

import pytest

from ai_trading.core import futures

# --- an independent business-day calculator, for the parametrized sweep below -------------------

CME_HOLIDAYS_2026_27 = {
    date(2025, 12, 25),  # Christmas Day (CL/MCL's rule looks back into December for a January
    #                      contract month, so this one extra, uncontroversial date is needed too)
    date(2026, 1, 1),  # New Year's Day
    date(2026, 4, 3),  # Good Friday
    date(2026, 12, 25),  # Christmas Day
    date(2027, 1, 1),  # New Year's Day
    date(2027, 3, 26),  # Good Friday
    date(2027, 12, 24),  # Christmas Day (observed: Dec 25, 2027 is a Saturday)
}


def _is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in CME_HOLIDAYS_2026_27


def _business_days_before(d: date, n: int) -> date:
    while n > 0:
        d -= timedelta(days=1)
        if _is_business_day(d):
            n -= 1
    return d


def _last_business_day_of_month(year: int, month: int) -> date:
    d = date(year, 12, 31) if month == 12 else date(year, month + 1, 1) - timedelta(days=1)
    while not _is_business_day(d):
        d -= timedelta(days=1)
    return d


def _nth_last_business_day_of_month(year: int, month: int, n: int) -> date:
    return _business_days_before(_last_business_day_of_month(year, month), n - 1)


def _third_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    first_friday = first + timedelta(days=(4 - first.weekday()) % 7)
    return first_friday + timedelta(days=14)


# --- golden, hand-pinned dates --------------------------------------------------------------


def test_es_mes_december_2026_last_trade_and_roll():
    assert futures.last_trade_date("ES", date(2026, 12, 1)) == date(2026, 12, 18)  # 3rd Friday
    assert futures.roll_date("ES", date(2026, 12, 1)) == date(2026, 12, 14)  # Monday
    assert futures.last_trade_date("MES", date(2026, 12, 1)) == date(2026, 12, 18)
    assert futures.roll_date("MES", date(2026, 12, 1)) == date(2026, 12, 14)


@pytest.mark.parametrize(
    ("month", "roll"),
    [
        (3, date(2027, 3, 15)),
        (6, date(2027, 6, 14)),
        (9, date(2027, 9, 13)),
        (12, date(2027, 12, 13)),
    ],
)
def test_2027_equity_index_quarterly_rolls(month, roll):
    assert futures.roll_date("NQ", date(2027, month, 1)) == roll  # the rule is the same for every pair
    assert futures.roll_date("YM", date(2027, month, 1)) == roll
    assert futures.roll_date("RTY", date(2027, month, 1)) == roll


def test_cl_last_trade_when_the_25th_falls_on_a_weekend():
    # Oct 25, 2026 is a Sunday, so the rule falls back to 4 business days before it
    assert futures.last_trade_date("CL", date(2026, 11, 1)) == date(2026, 10, 20)  # Tuesday
    assert futures.last_trade_date("MCL", date(2026, 11, 1)) == date(2026, 10, 19)  # one business day earlier


def test_cl_last_trade_when_the_25th_is_a_holiday():
    # Dec 25, 2026 (Christmas) is a CME holiday though a weekday, so the rule still falls back to 4
    assert futures.last_trade_date("CL", date(2027, 1, 1)) == date(2026, 12, 21)  # Monday
    assert futures.last_trade_date("MCL", date(2027, 1, 1)) == date(2026, 12, 18)


def test_cl_mcl_roll_is_five_business_days_before_last_trade():
    # Golden test for the uniform physically-settled roll rule (owner ruling, 02g §4 review):
    # CL/MCL now roll PHYSICAL_ROLL_LEAD_DAYS business days before their own last trade date,
    # not on the last trade date itself.
    last_trade = futures.last_trade_date("CL", date(2026, 11, 1))
    assert last_trade == date(2026, 10, 20)
    assert futures.roll_date("CL", date(2026, 11, 1)) == date(2026, 10, 13)  # 5 business days earlier
    mcl_last_trade = futures.last_trade_date("MCL", date(2026, 11, 1))
    assert mcl_last_trade == date(2026, 10, 19)
    assert futures.roll_date("MCL", date(2026, 11, 1)) == date(2026, 10, 12)


def test_gc_mgc_december_2026_last_trade_first_notice_and_roll():
    # Golden test for GC/MGC's dates and the uniform 5-business-day physical roll lead.
    assert futures.last_trade_date("GC", date(2026, 12, 1)) == date(2026, 12, 29)  # 3rd-last biz day of Dec
    assert futures.last_trade_date("MGC", date(2026, 12, 1)) == date(2026, 12, 29)
    assert futures.first_notice_date("GC", date(2026, 12, 1)) == date(2026, 11, 30)  # last biz day of Nov
    assert futures.first_notice_date("MGC", date(2026, 12, 1)) == date(2026, 11, 30)
    assert futures.roll_date("GC", date(2026, 12, 1)) == date(2026, 11, 23)  # 5 business days before Nov 30
    assert futures.roll_date("MGC", date(2026, 12, 1)) == date(2026, 11, 23)


def test_first_notice_date_is_only_defined_for_gc_mgc():
    with pytest.raises(ValueError, match="no first notice day"):
        futures.first_notice_date("ES", date(2026, 12, 1))
    with pytest.raises(ValueError, match="no first notice day"):
        futures.first_notice_date("CL", date(2026, 12, 1))


def test_a_symbol_with_a_month_code_resolves_to_its_product():
    assert futures.last_trade_date("MESZ6", date(2026, 12, 1)) == date(2026, 12, 18)
    assert futures.roll_date("ESZ26", date(2026, 12, 1)) == date(2026, 12, 14)


def test_front_month_switches_on_the_roll_date_not_the_last_trade_date():
    assert futures.front_month("ES", date(2026, 12, 13)) == date(2026, 12, 1)  # the Sunday before roll
    assert futures.front_month("ES", date(2026, 12, 14)) == date(2027, 3, 1)  # rolls Monday itself
    assert futures.front_month("ES", date(2026, 12, 18)) == date(2027, 3, 1)  # last trade day, already rolled


def test_an_unknown_symbol_is_rejected():
    with pytest.raises(ValueError, match="not one of the Desk's futures products"):
        futures._extract_product("ZC25")  # not one of the Desk's 12 products


# --- session hours, shared by every contract -------------------------------------------------


def test_globex_session_hours_shared_by_every_contract():
    assert futures.GLOBEX_SESSION.open_time == "18:00"  # Sunday ET
    assert futures.GLOBEX_SESSION.close_time == "17:00"  # Friday ET, and every day's break start
    for spec in futures.SPECS.values():
        assert spec.session is futures.GLOBEX_SESSION  # one shared constant, not 12 copies


# --- the sizer ---------------------------------------------------------------------------------


def test_sizer_prefers_the_micro_and_notes_the_mini():
    out = futures.size_futures(500, 6_820, 6_770, "MES")
    assert out.symbol == "MES"
    assert out.contracts == 2
    assert out.risk_per_contract == 250.0
    assert out.mini_symbol == "ES"
    assert out.mini_note == "one ES would risk $2,500"
    assert out.reason is None


def test_sizer_accepts_the_mini_symbol_and_still_sizes_the_micro():
    out = futures.size_futures(500, 6_820, 6_770, "ES")
    assert out.symbol == "MES"
    assert out.contracts == 2


def test_sizer_zero_contracts_comes_with_a_reason():
    out = futures.size_futures(100, 6_820, 6_770, "MES")  # $100 / $250 per micro rounds to 0
    assert out.contracts is None
    assert out.reason == "risk is too small for even one micro contract"


@pytest.mark.parametrize(
    ("risk_usd", "entry", "stop", "reason"),
    [
        (0.0, 6_820, 6_770, "risk is unknown or not positive"),
        (float("nan"), 6_820, 6_770, "risk is unknown or not positive"),
        (500, float("nan"), 6_770, "entry or stop is unknown"),
        (500, 6_820, 6_820, "stop equals entry"),
    ],
)
def test_sizer_no_order_and_why(risk_usd, entry, stop, reason):
    out = futures.size_futures(risk_usd, entry, stop, "MES")
    assert out.contracts is None and out.reason == reason


def test_sizer_rejects_a_product_with_no_micro_mini_pair():
    out = futures.size_futures(500, 6_820, 6_770, "ZC")
    assert out.contracts is None
    assert "not one of the Desk's futures products" in out.reason


# --- the exhaustive sweep: every contract month of 2026 and 2027, all six families -------------

_EQUITY_FAMILIES = [("ES", "MES"), ("NQ", "MNQ"), ("RTY", "M2K"), ("YM", "MYM")]
_EQUITY_MONTHS = (3, 6, 9, 12)
_YEARS = (2026, 2027)


@pytest.mark.parametrize("mini,micro", _EQUITY_FAMILIES)
@pytest.mark.parametrize("year", _YEARS)
@pytest.mark.parametrize("month", _EQUITY_MONTHS)
def test_equity_index_last_trade_and_roll_every_month_both_years(month, year, mini, micro):
    expected_last_trade = _third_friday(year, month)
    expected_roll = expected_last_trade - timedelta(days=4)
    for product in (mini, micro):
        assert futures.last_trade_date(product, date(year, month, 1)) == expected_last_trade
        assert futures.roll_date(product, date(year, month, 1)) == expected_roll


@pytest.mark.parametrize("year", _YEARS)
@pytest.mark.parametrize("month", range(1, 13))
def test_cl_mcl_last_trade_and_roll_every_month_both_years(month, year):
    contract_month = date(year, month, 1)
    prior_25th = date(year - 1, 12, 25) if month == 1 else date(year, month - 1, 25)
    n = 3 if _is_business_day(prior_25th) else 4
    expected_cl = _business_days_before(prior_25th, n)
    expected_mcl = _business_days_before(expected_cl, 1)
    assert futures.last_trade_date("CL", contract_month) == expected_cl
    assert futures.last_trade_date("MCL", contract_month) == expected_mcl
    assert futures.roll_date("CL", contract_month) == _business_days_before(expected_cl, 5)
    assert futures.roll_date("MCL", contract_month) == _business_days_before(expected_mcl, 5)


@pytest.mark.parametrize("year", _YEARS)
@pytest.mark.parametrize("month", futures.GOLD_MONTHS)
def test_gc_last_trade_first_notice_and_roll_every_listed_month_both_years(month, year):
    contract_month = date(year, month, 1)
    expected_last_trade = _nth_last_business_day_of_month(year, month, 3)
    before = date(year, month - 1, 1) if month > 1 else date(year - 1, 12, 1)
    expected_first_notice = _last_business_day_of_month(before.year, before.month)
    expected_roll = _business_days_before(expected_first_notice, 5)
    assert futures.last_trade_date("GC", contract_month) == expected_last_trade
    assert futures.first_notice_date("GC", contract_month) == expected_first_notice
    assert futures.roll_date("GC", contract_month) == expected_roll


@pytest.mark.parametrize("year", _YEARS)
@pytest.mark.parametrize("month", futures.MICRO_GOLD_MONTHS)
def test_mgc_last_trade_first_notice_and_roll_every_listed_month_both_years(month, year):
    contract_month = date(year, month, 1)
    expected_last_trade = _nth_last_business_day_of_month(year, month, 3)
    before = date(year, month - 1, 1) if month > 1 else date(year - 1, 12, 1)
    expected_first_notice = _last_business_day_of_month(before.year, before.month)
    expected_roll = _business_days_before(expected_first_notice, 5)
    assert futures.last_trade_date("MGC", contract_month) == expected_last_trade
    assert futures.first_notice_date("MGC", contract_month) == expected_first_notice
    assert futures.roll_date("MGC", contract_month) == expected_roll
