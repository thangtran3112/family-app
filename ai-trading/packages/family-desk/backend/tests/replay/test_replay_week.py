"""Golden weekly-review cases (02p §e, §g): a 12-symbol universe on straight-line closes, so every number below can be
checked by hand. Closes are `100 + step * k` for `k` sessions after the basis day (the close before Day 1), so a
symbol's return between two sessions is `(100 + step * j) / (100 + step * i) - 1` and the universe median is always the
mean of GGG (step 0.1) and FFF (step 0.0), the 6th and 7th of twelve.

Conventions pinned here (see the module docstring): edges are percentage points x100 to 2 dp; the SELECTION edge of a
side is `sign * (symbol return - universe median)`, so a short is rewarded for falling MORE than the median fell; the
TIMING edge is `sign * (exit/entry - close_at_exit/close_before_entry)`."""

import subprocess
import sys
from dataclasses import replace
from datetime import date, timedelta

import pandas as pd
import pytest

from ai_trading.replay.week import (
    DayFact,
    EntryFact,
    HoldFact,
    ReviewInputs,
    WeekPlan,
    WeekSpan,
    adherence_checks,
    compute_review,
    hold_span,
    is_last_day_of_week,
    mean,
    median,
    ordinal,
    score_pct,
    selection_edge,
    selection_rank,
    signed,
    span_for,
    timing_edge,
    to_adjusted,
    universe_returns,
    week_spans,
)

BASIS = date(2026, 9, 25)  # the Friday before Day 1
DAYS = [BASIS + timedelta(days=3 + i + 2 * (i // 5)) for i in range(10)]  # Mon 9/28 .. Fri 10/2, Mon 10/5 .. Fri 10/9
STEPS = {
    "AAA": 2.0,
    "BBB": 1.0,
    "CCC": 0.6,
    "DDD": 0.5,
    "EEE": 0.2,
    "FFF": 0.0,
    "GGG": 0.1,
    "HHH": -0.2,
    "III": -0.5,
    "JJJ": -0.6,
    "KKK": -1.0,
    "LLL": -1.6,
}
SOURCES = {s: "liquidity" for s in STEPS} | {"AAA": "watchlist", "BBB": "watchlist", "CCC": "manual"}
SOURCES |= {"DDD": "filter", "EEE": "filter"}


def line(step: float, start: float = 100.0) -> pd.Series:
    """Closes on the basis day and the ten sessions: `start + step * k`."""
    return pd.Series([round(start + step * k, 2) for k in range(11)], index=[BASIS, *DAYS])


CLOSES = {symbol: line(step) for symbol, step in STEPS.items()}
SPY = line(0.2)  # +1.0% over week 1


def poison(series: pd.Series, last: date) -> pd.Series:
    out = series.copy()
    out[[d > last for d in out.index]] = 1e9
    return out


PLAN = WeekPlan(stop_required=True, risk_per_hold_usd=100, max_open_holds=3, max_loss_usd=500, max_trades=4)

# Three holds in week 1. DDD long Mon-Thu, JJJ short Tue-Fri, HHH long Wed and still open at the Friday close.
H1 = HoldFact(1, "DDD", "long", 100, DAYS[0], 100.2, 100.2, DAYS[3], 101.8, 101.8, 160.0, 30.0, 1.6, "set")
H2 = HoldFact(2, "JJJ", "short", 50, DAYS[1], 99.0, 99.0, DAYS[4], 99.8, 99.8, -40.0, -5.0, -0.8, "set")
H3 = HoldFact(3, "HHH", "long", 100, DAYS[2], 99.5, 99.5, None, None, None, -50.0, -20.0, None, "none")

ENTRIES = (
    EntryFact(1, "DDD", 1, True, 100.0, False, True, 0.0),  # 100 * |100.20 - 99.20|
    EntryFact(2, "JJJ", 2, True, 50.0, False, True, 0.0),  # 50 * |99.00 - 100.00|
    EntryFact(3, "HHH", 3, False, None, False, False, 0.0),  # no stop; starred after the open
)


def day(
    i,
    *,
    open_=0,
    entries=0,
    exits=0,
    realized=0.0,
    gap=0.0,
    intraday=0.0,
    change=0.0,
    balance=50_000.0,
    equity=50_000.0,
):
    """The day summary of session `i`: `open_` is the most holds open at once that day."""
    return DayFact(
        DAYS[i], False, entries, exits, realized, gap, intraday, change, balance, equity, max_open_seen=open_
    )


# Week 1 as the day summaries would record it; week 2 is arbitrary and must never reach week 1's review.
WEEK1 = [
    day(0, open_=1, entries=1, intraday=30.0, change=30.0, equity=50_030.0),
    day(1, open_=2, entries=1, gap=10.0, intraday=50.0, change=60.0, equity=50_090.0),
    day(2, open_=3, entries=1, gap=5.0, intraday=65.0, change=70.0, equity=50_160.0),
    day(3, open_=3, exits=1, realized=160.0, gap=-5.0, intraday=45.0, change=-120.0, balance=50_160.0, equity=50_200.0),
    day(
        4, open_=2, exits=1, realized=-40.0, gap=-5.0, intraday=-125.0, change=-90.0, balance=50_120.0, equity=50_070.0
    ),
]
WEEK2_NOISE = [
    day(i, realized=777.0, gap=77.0, intraday=7.0, change=1.0, balance=60_000.0, equity=61_000.0) for i in range(5, 10)
]

FOCUS = {"DDD": DAYS[0], "JJJ": DAYS[1], "BBB": DAYS[0], "FFF": DAYS[1], "HHH": DAYS[2], "LLL": DAYS[5]}
FLAGS = {DAYS[0]: ["DDD", "EEE"], DAYS[1]: ["CCC", "DDD"], DAYS[7]: ["AAA"]}


def golden(**changes) -> ReviewInputs:
    base = ReviewInputs(
        days=DAYS,
        basis_day=BASIS,
        week_no=1,
        plan=PLAN,
        day_facts=[*WEEK1, *WEEK2_NOISE],
        holds=[H1, H2, H3],
        entries=ENTRIES,
        closes=CLOSES,
        sources=SOURCES,
        benchmark=SPY,
        focus=FOCUS,
        flags=FLAGS,
    )
    return replace(base, **changes)


# -- weeks -----------------------------------------------------------------------------------------------------


def test_week_spans_group_by_iso_week_and_label_partial_weeks():
    days = [date(2026, 9, 30), date(2026, 10, 1), date(2026, 10, 2)]  # Wed-Fri: a partial first week
    days += [date(2026, 10, 5) + timedelta(days=i) for i in range(5)]  # a full week
    days += [date(2026, 10, 13) + timedelta(days=i) for i in range(4)]  # a holiday week without its Monday
    days += [date(2026, 10, 19), date(2026, 10, 20)]  # a partial last week
    spans = week_spans(days)
    assert [(w.week_no, w.first_day_no, w.last_day_no, w.label) for w in spans] == [
        (1, 1, 3, "Week 1 · 3 days"),
        (2, 4, 8, "Week 2"),
        (3, 9, 12, "Week 3 · 4 days"),
        (4, 13, 14, "Week 4 · 2 days"),
    ]
    assert spans[0] == WeekSpan(1, tuple(days[:3]), 1, 3, "Week 1 · 3 days")
    assert week_spans(days[:1])[0].label == "Week 1 · 1 day"


def test_a_week_that_spans_new_year_stays_one_iso_week():
    days = [date(2026, 12, 30), date(2026, 12, 31), date(2027, 1, 1), date(2027, 1, 4)]
    assert [len(w.days) for w in week_spans(days)] == [3, 1]


def test_span_for_and_the_last_day_of_the_week():
    week2 = span_for(DAYS, DAYS[7])
    assert (week2.week_no, week2.first_day_no, week2.last_day_no) == (2, 6, 10)
    assert [is_last_day_of_week(DAYS, d) for d in DAYS] == [False] * 4 + [True] + [False] * 4 + [True]
    with pytest.raises(ValueError):
        span_for(DAYS, date(2026, 1, 1))


def test_hold_span_runs_from_the_close_before_entry_to_the_exit_close_clipped_to_the_week():
    week1, week2 = week_spans(DAYS)
    assert hold_span(DAYS, BASIS, week1, DAYS[0], DAYS[3]) == (BASIS, DAYS[3])  # Day 1's prior close is the basis day
    assert hold_span(DAYS, BASIS, week1, DAYS[2], None) == (DAYS[1], DAYS[4])  # still open: the week's last close
    assert hold_span(DAYS, BASIS, week2, DAYS[2], DAYS[6]) == (DAYS[4], DAYS[6])  # opened last week: starts at the week
    assert hold_span(DAYS, BASIS, week2, DAYS[2], None) == (DAYS[4], DAYS[9])  # opened last week, open all week
    assert hold_span(DAYS, BASIS, week1, DAYS[3], DAYS[7]) == (DAYS[2], DAYS[4])  # exits after the week: clipped
    assert hold_span(DAYS, BASIS, week2, DAYS[6], DAYS[7]) == (DAYS[5], DAYS[7])  # inside the week


# -- returns, rank and edges -----------------------------------------------------------------------------------


def test_universe_returns_use_two_closes_and_drop_symbols_lacking_either():
    closes = {"A": line(1.0), "B": line(-1.0), "NEW": line(1.0).drop(BASIS), "GONE": line(1.0).drop(DAYS[4])}
    got = universe_returns(closes, BASIS, DAYS[4])
    assert set(got) == {"A", "B"}
    assert got["A"] == pytest.approx(0.05) and got["B"] == pytest.approx(-0.05)  # 105 / 100 - 1, 95 / 100 - 1


def test_median_mean_and_signed():
    assert median([]) is None and mean([]) is None
    assert median([3.0, 1.0, 2.0]) == 2.0 and median([1.0, 2.0, 3.0, 10.0]) == 2.5
    assert mean([1.0, 2.0, 6.0]) == 3.0
    assert signed("long", 0.05) == 0.05 and signed("short", 0.05) == -0.05 and signed("short", 0.0) == 0.0


def test_selection_rank_orders_by_the_side_signed_return_with_ties_by_symbol():
    returns = {"B": 0.02, "A": 0.02, "C": -0.01}
    assert selection_rank("long", "A", returns) == (1, 3)
    assert selection_rank("long", "B", returns) == (2, 3)
    assert selection_rank("long", "C", returns) == (3, 3)
    assert selection_rank("short", "C", returns) == (1, 3)  # the biggest faller ranks first for a short
    assert selection_rank("short", "A", returns) == (2, 3) and selection_rank("short", "B", returns) == (3, 3)


def test_selection_edge_for_a_long_is_the_symbol_return_over_the_median():
    assert selection_edge("long", 0.03, 0.01) == 2.0  # +3% against a +1% median
    assert selection_edge("long", -0.02, 0.01) == -3.0


def test_selection_edge_for_a_short_is_positive_when_the_stock_fell_more_than_the_median_fell():
    assert selection_edge("short", -0.05, -0.01) == 4.0  # fell 5% against a median that fell 1%: right side
    assert selection_edge("short", -0.01, -0.05) == -4.0  # fell 1% while the median fell 5%: the wrong stock
    assert selection_edge("short", 0.02, 0.01) == -1.0  # rose 2% against a median that rose 1%
    assert selection_edge("short", 0.0, 0.01) == 1.0  # flat while the median rose: it lagged, a good short


def test_timing_edge_is_her_side_signed_return_minus_the_symbols_over_the_same_span():
    # long: bought 100 sold 110 (+10%) while the symbol went 100 -> 105 close to close (+5%)
    assert timing_edge("long", 100.0, 110.0, 100.0, 105.0) == 5.0
    # short: same prices lose 10% against a +5% symbol: -10 - (-5) = -5
    assert timing_edge("short", 100.0, 110.0, 100.0, 105.0) == -5.0
    # a winning short: sold at 100 covered at 90 (+10%), the symbol fell 100 -> 95 (+5% for a short)
    assert timing_edge("short", 100.0, 90.0, 100.0, 95.0) == 5.0
    assert timing_edge("long", 100.0, 100.0, 100.0, 100.0) == 0.0


def test_to_adjusted_restates_a_printed_price_onto_the_adjusted_basis():
    assert to_adjusted(1200.0, raw_close=1300.0, adj_close=130.0) == pytest.approx(120.0)  # a 10-for-1 split later
    assert to_adjusted(50.0, raw_close=50.0, adj_close=50.0) == 50.0


def test_ordinal():
    got = [ordinal(n) for n in (1, 2, 3, 4, 8, 11, 12, 13, 21, 22, 23, 50, 101, 111)]
    assert got == [
        "1st",
        "2nd",
        "3rd",
        "4th",
        "8th",
        "11th",
        "12th",
        "13th",
        "21st",
        "22nd",
        "23rd",
        "50th",
        "101st",
        "111th",
    ]


# -- adherence -------------------------------------------------------------------------------------------------


def by_id(checks):
    return {c["id"]: c for c in checks}


def test_adherence_checks_on_the_golden_entries():
    checks = adherence_checks(PLAN, ENTRIES, [], max_open_seen=3)
    assert [c["id"] for c in checks] == [
        "stop_set",
        "stop_honored",
        "risk_per_hold",
        "open_holds_within_plan",
        "week_loss_limit",
        "entries_per_week",
        "on_signal",
        "focus_before_open",
    ]
    got = {c["id"]: (c["passed"], c["detail"]) for c in checks if c["applicable"]}
    assert got == {
        "stop_set": (False, "2 of 3"),  # HHH had no stop
        "risk_per_hold": (False, "2 of 3"),  # 100 and 50 are within 100; no stop means no known risk
        "open_holds_within_plan": (True, "3 of 3"),
        "week_loss_limit": (True, "3 of 3"),
        "entries_per_week": (True, "3 of 4"),
        "focus_before_open": (False, "2 of 3"),  # HHH was starred after the open
    }
    assert {c["id"] for c in checks if not c["applicable"]} == {
        "stop_honored",
        "on_signal",
    }  # no stop hit; no signal rule
    assert all(set(c) == {"id", "label", "applicable", "passed", "detail"} for c in checks)
    assert score_pct(checks) == 50  # 3 of the 6 applicable checks passed


def test_stop_honored_applies_only_when_a_stop_was_hit():
    checks = adherence_checks(PLAN, ENTRIES, [(1, True), (2, False)], max_open_seen=1)
    assert (checks[1]["applicable"], checks[1]["passed"], checks[1]["detail"]) == (True, False, "1 of 2")
    assert by_id(adherence_checks(PLAN, ENTRIES, [(1, True)], 1))["stop_honored"]["passed"] is True


def test_risk_per_hold_allows_exactly_the_limit_and_refuses_one_cent_over():
    at_limit = (EntryFact(1, "A", 1, True, 100.0, False, True, 0.0),)
    over = (EntryFact(1, "A", 1, True, 100.01, False, True, 0.0),)
    assert by_id(adherence_checks(PLAN, at_limit, [], 1))["risk_per_hold"]["passed"] is True
    assert by_id(adherence_checks(PLAN, over, [], 1))["risk_per_hold"]["passed"] is False


def test_open_holds_within_plan_compares_the_peak_to_the_limit():
    checks = by_id(adherence_checks(replace(PLAN, max_open_holds=2), ENTRIES, [], max_open_seen=3))
    assert (checks["open_holds_within_plan"]["passed"], checks["open_holds_within_plan"]["detail"]) == (False, "3 of 2")


def test_week_loss_limit_counts_entries_made_after_the_limit_was_reached():
    late = (
        EntryFact(1, "A", 1, True, 10.0, False, True, 0.0),
        EntryFact(2, "B", 2, True, 10.0, False, True, -500.0),  # the week was already down the whole limit
        EntryFact(3, "C", 3, True, 10.0, False, True, -499.99),
    )
    check = by_id(adherence_checks(PLAN, late, [], 1))["week_loss_limit"]
    assert (check["applicable"], check["passed"], check["detail"]) == (True, False, "2 of 3")


def test_entries_per_week_fails_over_the_limit_and_on_signal_needs_every_entry_on_a_signal():
    entries = tuple(EntryFact(i, f"S{i}", 1, True, 10.0, i != 2, True, 0.0) for i in range(1, 6))
    checks = by_id(adherence_checks(replace(PLAN, signal_only=True), entries, [], 1))
    assert (checks["entries_per_week"]["passed"], checks["entries_per_week"]["detail"]) == (False, "5 of 4")
    assert (checks["on_signal"]["applicable"], checks["on_signal"]["passed"], checks["on_signal"]["detail"]) == (
        True,
        False,
        "4 of 5",
    )


def test_score_pct_rounds_and_is_none_when_nothing_applies():
    assert score_pct([]) is None
    assert score_pct([{"applicable": False, "passed": True}]) is None
    two_of_three = [{"applicable": True, "passed": p} for p in (True, True, False)]
    assert score_pct(two_of_three) == 67
    assert score_pct(adherence_checks(WeekPlan(), (), [], 0)) is None  # no plan, no entries: nothing to score


# -- the review ------------------------------------------------------------------------------------------------


def test_golden_review_numbers():
    r = compute_review(golden())
    assert r["week"] == {"week_no": 1, "label": "Week 1", "first_day_no": 1, "last_day_no": 5}

    t = r["tiles"]
    assert t["realized_usd"] == 120.0  # 160 - 40 credited on Thu and Fri
    assert t["unrealized_change_usd"] == -50.0  # 30 + 60 + 70 - 120 - 90: from 0 to -50 (H3 at 99.00)
    assert t["equity_change_usd"] == 70.0  # 120 + (-50)
    assert t["balance_usd"] == 50_120.0
    assert t["win_rate"] == 0.5 and t["avg_win_usd"] == 160.0 and t["avg_loss_usd"] == -40.0  # H1 won, H2 lost
    assert t["avg_days_held"] == 4.0  # H1 Mon-Thu, H2 Tue-Fri: 4 sessions each, H3 is still open
    assert t["gap_usd"] == 5.0  # 0 + 10 + 5 - 5 - 5
    assert t["gap_share_pct"] == 7.1  # 5 / 70
    assert t["adherence_pct"] == 50
    assert t["selection_pts"] == 0.05  # mean of the table's 1.40, -0.61, -0.65 (from her prices in, D-065)
    assert t["timing_pts"] == -1.17  # mean of -0.40, -3.22, +0.10
    assert t["spy_return_pct"] == 1.0  # 101 / 100 - 1
    assert t["universe_median_return_pct"] == 0.25  # (GGG +0.5% + FFF 0.0%) / 2
    assert (
        t["universe_mean_return_pct"] == 0.21
    )  # (10 + 5 + 3 + 2.5 + 1 + 0.5 + 0 - 1 - 2.5 - 3 - 5 - 8) / 12 = 2.5 / 12

    assert r["equity"] == [
        {"day_no": 1, "balance_usd": 50_000.0, "equity_usd": 50_030.0},
        {"day_no": 2, "balance_usd": 50_000.0, "equity_usd": 50_090.0},
        {"day_no": 3, "balance_usd": 50_000.0, "equity_usd": 50_160.0},
        {"day_no": 4, "balance_usd": 50_160.0, "equity_usd": 50_200.0},
        {"day_no": 5, "balance_usd": 50_120.0, "equity_usd": 50_070.0},
    ]

    assert [(d["day_no"], d["weekday"], d["watched"], d["entries"], d["exits"]) for d in r["days"]] == [
        (1, "Mon", "yes", 1, 0),
        (2, "Tue", "yes", 1, 0),
        (3, "Wed", "yes", 1, 0),
        (4, "Thu", "yes", 0, 1),
        (5, "Fri", "yes", 0, 1),
    ]
    assert [(d["realized_usd"], d["gap_usd"], d["intraday_usd"]) for d in r["days"]] == [
        (0.0, 0.0, 30.0),
        (0.0, 10.0, 50.0),
        (0.0, 5.0, 65.0),
        (160.0, -5.0, 45.0),
        (-40.0, -5.0, -125.0),
    ]
    assert [d["adherence_pct"] for d in r["days"]] == [100, 100, 25, None, None]  # the day's entries only

    assert r["adherence"]["score_pct"] == 50 and len(r["adherence"]["checks"]) == 8
    assert r["copy"] == [
        "Selection +0.1 pts vs the universe median · your holds ranked 4th, 8th and 8th of 12 · Timing −1.2 pts"
    ]


def test_golden_review_hold_rows():
    rows = {row["symbol"]: row for row in compute_review(golden())["holds"]}
    assert list(rows) == ["DDD", "JJJ", "HHH"]  # in entry order

    # Selection is scored from HER price in to her price out (D-065), the median close to close over the span.
    ddd = rows["DDD"]  # long, in 100.2 -> out 101.8 (+1.60%); median of the span 0.2%; rank 4th
    assert (ddd["side"], ddd["shares"], ddd["entry_day_no"], ddd["entry_price"]) == ("long", 100, 1, 100.2)
    assert (ddd["status"], ddd["exit_day_no"], ddd["exit_price"], ddd["days_held"]) == ("closed", 4, 101.8, 4)
    assert (ddd["pnl_usd"], ddd["r"], ddd["gap_usd"], ddd["stop"]) == (160.0, 1.6, 30.0, "set")
    assert (ddd["selection_rank"], ddd["selection_of"], ddd["selection_edge_pts"]) == (4, 12, 1.4)  # 1.597 - 0.2
    assert ddd["timing_edge_pts"] == -0.4  # (101.8 / 100.2 - 1) - (102 / 100 - 1) = 1.597% - 2.0%

    jjj = rows["JJJ"]  # short, in 99.0 -> out 99.8 (+0.81%, a losing short); median 0.20%; 8th of 12 for a short
    assert (jjj["status"], jjj["entry_day_no"], jjj["exit_day_no"], jjj["days_held"]) == ("closed", 2, 5, 4)
    assert (jjj["selection_rank"], jjj["selection_of"], jjj["selection_edge_pts"]) == (8, 12, -0.61)  # -(0.81 - 0.20)
    assert jjj["timing_edge_pts"] == -3.22  # -(99.8 / 99.0 - 97.0 / 99.4) x 100: covered 3 points too high
    assert (jjj["pnl_usd"], jjj["r"], jjj["gap_usd"]) == (-40.0, -0.8, -5.0)

    hhh = rows["HHH"]  # long, open at Fri: in 99.5 -> Fri close 99.0 (-0.50%); median 0.15%; 8th
    assert (hhh["status"], hhh["exit_day_no"], hhh["exit_price"], hhh["days_held"]) == ("open", None, None, 3)
    assert (hhh["selection_rank"], hhh["selection_edge_pts"]) == (8, -0.65)  # -0.50 - 0.15
    assert hhh["timing_edge_pts"] == 0.1  # (99.0 / 99.5 - 1) - (99.0 / 99.6 - 1) = -0.503% + 0.602%
    assert hhh["pnl_usd"] == -50.0 and hhh["r"] is None and hhh["stop"] == "none"


def test_golden_review_universe_pictures():
    r = compute_review(golden())
    assert [(h["symbol"], h["return_pct"]) for h in r["heat"]] == [
        ("AAA", 10.0),
        ("BBB", 5.0),
        ("CCC", 3.0),
        ("DDD", 2.5),
        ("EEE", 1.0),
        ("GGG", 0.5),
        ("FFF", 0.0),
        ("HHH", -1.0),
        ("III", -2.5),
        ("JJJ", -3.0),
        ("KKK", -5.0),
        ("LLL", -8.0),
    ]
    marks = {h["symbol"]: (h["held"], h["focus"]) for h in r["heat"]}
    assert marks["DDD"] == ("yes", "yes") and marks["HHH"] == ("yes", "yes") and marks["JJJ"] == ("yes", "yes")
    assert marks["BBB"] == ("no", "yes") and marks["FFF"] == ("no", "yes") and marks["AAA"] == ("no", "no")
    assert marks["LLL"] == ("no", "no")  # starred in week 2: not known in week 1
    assert {h["symbol"]: h["source"] for h in r["heat"]}["CCC"] == "manual"

    assert r["source_quality"] == [
        {"source": "watchlist", "median_return_pct": 7.5, "n": 2},  # (10 + 5) / 2
        {"source": "manual", "median_return_pct": 3.0, "n": 1},
        {"source": "filter", "median_return_pct": 1.75, "n": 2},  # (2.5 + 1) / 2
        {"source": "liquidity", "median_return_pct": -2.5, "n": 7},  # of -8, -5, -3, -2.5, -1, 0, 0.5
    ]
    # flagged: DDD and EEE on Mon (+2.5%, +1.0%), CCC on Tue from Mon's close 100.6 to 103.0 (+2.39%);
    # AAA's flag is in week 2
    assert r["filter_quality"] == {"n": 3, "median_return_pct": 2.39, "universe_median_pct": 0.25, "edge_pts": 2.14}
    # starred but not traded: BBB from the basis close (+5.0%, 2nd of 12), FFF from Mon's close (0.0%, 7th of 12)
    assert r["focus_untraded"] == [
        {"symbol": "BBB", "rank": 2, "of": 12, "return_pct": 5.0},
        {"symbol": "FFF", "rank": 7, "of": 12, "return_pct": 0.0},
    ]


def test_a_short_is_scored_with_the_opposite_sign_of_a_long_on_the_same_name():
    # LLL fell 8% over the week (100 -> 92) while the universe median rose 0.25%; she was in at 98.4 (-6.50% to 92)
    def review_of(side):
        hold = HoldFact(9, "LLL", side, 10, DAYS[0], 98.4, 98.4, DAYS[4], 92.0, 92.0, 0.0, None, None, "none")
        return compute_review(golden(holds=[hold], entries=(), focus={}))["holds"][0]

    short, long_ = review_of("short"), review_of("long")
    assert (short["selection_rank"], long_["selection_rank"]) == (1, 12)  # the biggest faller is the best short
    # from her 98.40: -(-6.50 - 0.25) for the short and (-6.50 - 0.25) for the long
    assert short["selection_edge_pts"] == 6.75 and long_["selection_edge_pts"] == -6.75
    # entered Monday at 98.40 (the close was 98.40), out at 92.00: 92 / 98.4 - 92 / 100 = +1.50 points for a long
    assert long_["timing_edge_pts"] == 1.5 and short["timing_edge_pts"] == -1.5


def test_a_long_bought_after_a_gap_up_is_not_credited_the_gap_it_never_traded():
    # D-065: AAA closed 100 -> 104 over the span (+4.0% close to close, ranked 1st), but she bought at 104 after a gap
    # up and sold at 102: she lost money, so the pick must not score a gain.
    hold = HoldFact(9, "AAA", "long", 10, DAYS[0], 104.0, 104.0, DAYS[1], 102.0, 102.0, -20.0, None, None, "none")
    (row,) = compute_review(golden(holds=[hold], entries=(), focus={}))["holds"]
    assert row["pnl_usd"] < 0
    assert row["selection_edge_pts"] < 0  # 102 / 104 - 1 = -1.92% against a positive median (close to close it was +4%)
    assert row["timing_edge_pts"] == pytest.approx(-5.92, abs=0.01)  # the gap she paid for shows as timing


def test_a_hold_opened_last_week_is_scored_over_this_weeks_span_only():
    carried = HoldFact(4, "CCC", "long", 100, DAYS[2], 101.0, 101.0, DAYS[6], 104.0, 104.0, 300.0, 40.0, None, "set")
    facts = [
        day(0),
        day(1),
        day(2, open_=1, entries=1, change=80.0, intraday=80.0, equity=50_080.0),
        day(3, open_=1, gap=10.0, change=60.0, intraday=50.0, equity=50_140.0),
        day(4, open_=1, gap=10.0, change=60.0, intraday=50.0, equity=50_200.0),
        day(5, open_=1, gap=20.0, change=60.0, intraday=40.0, equity=50_260.0),
        day(
            6,
            open_=1,
            exits=1,
            realized=300.0,
            gap=20.0,
            change=-260.0,
            intraday=20.0,
            balance=50_300.0,
            equity=50_300.0,
        ),
        *[day(i, balance=50_300.0, equity=50_300.0) for i in (7, 8, 9)],
    ]
    r = compute_review(golden(week_no=2, holds=[carried], entries=(), day_facts=facts, plan=WeekPlan(max_open_holds=3)))

    assert r["week"] == {"week_no": 2, "label": "Week 2", "first_day_no": 6, "last_day_no": 10}
    (row,) = r["holds"]
    # her leg: Fri close 103.0 (the week's prior close) -> out at 104.0 (+0.971%); median of the span 0.0995%
    assert (row["entry_day_no"], row["exit_day_no"], row["status"], row["days_held"]) == (3, 7, "closed", 5)
    assert (row["selection_rank"], row["selection_of"], row["selection_edge_pts"]) == (4, 12, 0.87)  # 0.971 - 0.0995
    # her leg starts at the week's prior close 103.0, not at her entry 101.0: 104/103 - 1 = 0.971% against 1.165%
    assert row["timing_edge_pts"] == -0.19

    t = r["tiles"]
    assert (t["realized_usd"], t["unrealized_change_usd"], t["equity_change_usd"]) == (300.0, -200.0, 100.0)
    assert (t["gap_usd"], t["gap_share_pct"], t["balance_usd"]) == (40.0, 40.0, 50_300.0)
    assert t["avg_days_held"] == 5.0 and t["win_rate"] == 1.0 and t["avg_loss_usd"] is None
    assert [e["day_no"] for e in r["equity"]] == list(range(1, 11))  # the curve runs from Day 1
    assert r["adherence"]["score_pct"] == 100  # nothing entered; the open-hold limit (1 of 3) held


def test_an_empty_week_keeps_its_tiles_and_has_no_selection_or_timing():
    passed = [replace(day(i), passed=True) for i in range(10)]
    r = compute_review(golden(week_no=2, holds=[], entries=(), day_facts=passed, plan=WeekPlan(), focus={}, flags={}))
    t = r["tiles"]
    assert (t["realized_usd"], t["equity_change_usd"], t["balance_usd"], t["gap_usd"]) == (0.0, 0.0, 50_000.0, 0.0)
    assert t["selection_pts"] is None and t["timing_pts"] is None
    assert t["win_rate"] is None and t["avg_win_usd"] is None and t["avg_loss_usd"] is None
    assert t["avg_days_held"] is None and t["gap_share_pct"] is None and t["adherence_pct"] is None
    assert t["spy_return_pct"] == 0.99  # 102 / 101 - 1
    assert t["universe_median_return_pct"] == 0.25  # (GGG 0.4975% + FFF 0.0%) / 2 over Fri -> Fri
    assert r["holds"] == [] and r["copy"] == [] and r["focus_untraded"] == [] and r["filter_quality"] is None
    assert [d["watched"] for d in r["days"]] == ["no"] * 5  # passed days
    assert [d["adherence_pct"] for d in r["days"]] == [None] * 5
    assert len(r["heat"]) == 12 and all(h["held"] == "no" and h["focus"] == "no" for h in r["heat"])


def test_nothing_after_the_weeks_last_close_changes_the_review():
    base = golden()
    last = DAYS[4]
    late_exit = replace(H3, exit_day=DAYS[6], exit_price=1e9, exit_price_adj=1e9)  # exits next week: still open
    garbage_entry = EntryFact(99, "AAA", 8, False, None, False, False, -1e9)
    poisoned = replace(
        base,
        closes={s: poison(c, last) for s, c in CLOSES.items()},
        benchmark=poison(SPY, last),
        day_facts=[
            *WEEK1,
            *[
                replace(d, realized_usd=1e9, gap_usd=-1e9, intraday_usd=1e9, balance_usd=1e9, equity_usd=-1e9)
                for d in WEEK2_NOISE
            ],
        ],
        holds=[H1, H2, late_exit],
        entries=(*ENTRIES, garbage_entry),
        focus={**FOCUS, "AAA": DAYS[7]},
        flags={**FLAGS, DAYS[8]: ["AAA", "LLL"]},
    )
    assert compute_review(poisoned) == compute_review(base)


def test_the_module_is_pure():
    code = (
        "import sys, ai_trading.replay.week\n"
        "bad = [m for m in sys.modules if m.startswith(('ai_trading.db', 'ai_trading.api', 'ai_trading.replay.session',"
        " 'sqlalchemy', 'fastapi'))]\n"
        "assert not bad, bad"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
