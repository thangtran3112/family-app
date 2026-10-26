"""The swing weekly review wired to stored facts (`replay/swing_weeks.py`, 02p §e): the inputs built from the day
summaries, the hold rows and the cached split-adjusted closes, the freeze at a week's last day and at an early close,
the "Week to date" read, the weeks list, the notes and rating patch, and the holds read. The arithmetic itself is
`week.py`'s (pinned in `test_replay_week.py`); these tests check the wiring against hand calculations on the swing world
(`tests/swing_world.py`) and the guarantee that a review depends on nothing after its close. Holds are placed with the
lifecycle tests' helpers (`hold_rows.add_entry`, the pure `exit_hold`). Real Postgres; the history is in memory."""

import statistics
from dataclasses import replace
from datetime import date

import pandas as pd
import pytest
from swing_world import (
    DAYS,
    NOW,
    SOURCES,
    SYMBOLS,
    bar_close,
    make_owner,
    ready_thread,
    scrambled,
    swing_services,
    swing_world,
)
from test_replay_swing_lifecycle import _end, _enter, _exit, _open, _pass_days, _practice
from test_replay_swing_setup import _filter

from ai_trading.core.calendar import et, previous_session
from ai_trading.db.models import PracticeWeek
from ai_trading.replay import hold_rows, swing, swing_weeks
from ai_trading.replay import holds as holds_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay import week as week_mod
from ai_trading.replay.session import ReplayProblem, jsonable

START = DAYS[2]  # Wed 2026-09-16: Week 1 has 3 days, then two full weeks and a 2-day Week 4 (15 sessions)
BASIS = previous_session("stock", START)  # Tue 2026-09-15
W1, W2 = DAYS[2:5], DAYS[5:10]


@pytest.fixture
def world():
    return swing_world()


@pytest.fixture
def svc(world):
    return swing_services(world)


@pytest.fixture
def owner(db_session) -> int:
    return make_owner(db_session)


# -- hand calculations: the world's split-adjusted closes ------------------------------------------------------------


def _adj(world, symbol: str, day: date) -> float:
    return float(world.split[symbol].loc[day, "close"])


def _returns(world, a: date, b: date) -> dict[str, float]:
    """Every universe name's close-to-close return from the close of `a` to the close of `b`, split-adjusted."""
    return {s: _adj(world, s, b) / _adj(world, s, a) - 1 for s in SYMBOLS}


def _selection(world, symbol: str, sign: int, a: date, b: date) -> tuple[float, int]:
    """(selection edge in points, rank of 12) of `symbol` over a..b: the side-signed excess return over the median."""
    returns = _returns(world, a, b)
    edge = sign * (returns[symbol] - statistics.median(returns.values())) * 100
    order = sorted(SYMBOLS, key=lambda s: (-sign * returns[s], s))
    return round(edge, 2), order.index(symbol) + 1


def _timing(sign: int, entry_adj: float, exit_adj: float, close_before: float, close_after: float) -> float:
    """Her side-signed return over the span minus the symbol's side-signed close-to-close return, in points."""
    return round(sign * ((exit_adj / entry_adj - 1) - (close_after / close_before - 1)) * 100, 2)


def _row(review: dict, symbol: str) -> dict:
    (row,) = [h for h in review["holds"] if h["symbol"] == symbol]
    return row


def _approx(value: float):
    return pytest.approx(value, abs=0.011)


# -- the thread under test --------------------------------------------------------------------------------------------


def _play(db, owner, svc, world, *, through: int = 8, **thread_kwargs):
    """A 15-session thread from Wed 09-16 (weeks of 3, 5, 5 and 2 days), played for `through` days:

    Day 1 (W1, Wed): long S04 x100 (stop 70) and short S05 x50 (stop 125), both at 10:00.
    Day 2 (Thu): long S03 x40 at 11:00 (S03 splits 2-for-1 on Day 4).
    Day 3 (Fri): the S05 short exits at 14:00. Week 1 ends with S04 and S03 open.
    Day 4 (Mon, split day): the S04 long exits at 11:00, the first day of Week 2. Day 5 is passed. Day 6: the S03 long
    exits at 12:00 (post-split). Days 7 and 8 are passed; Week 2 ends with nothing open."""
    thread, plan = ready_thread(db, owner, svc, firstDay=START.isoformat(), **thread_kwargs)
    holds = {}
    played = {
        1: ("S04", "S05"),
        2: ("S03",),
        3: ("S05",),
        4: ("S04",),
        6: ("S03",),
    }
    for n in range(1, through + 1):
        row = _open(db, owner, svc, thread)
        sessions = _practice(db, owner, svc, row, *played[n]) if n in played else []
        day = DAYS[1 + n]
        if n == 1:
            holds["S04"] = _enter(db, thread, world, "S04", "long", 100, day, stop=70.0, session=sessions[0])
            holds["S05"] = _enter(db, thread, world, "S05", "short", 50, day, stop=125.0, session=sessions[1])
        elif n == 2:
            holds["S03"] = _enter(db, thread, world, "S03", "long", 40, day, hhmm="11:00", session=sessions[0])
        elif n == 3:
            _exit(db, holds["S05"], day, hhmm="14:00", world=world)
        elif n == 4:
            _exit(db, holds["S04"], day, hhmm="11:00", world=world)
        elif n == 6:
            _exit(db, holds["S03"], day, hhmm="12:00", world=world)
        _end(db, owner, svc, row)
    return thread, plan, holds


def _week(db, thread, week_no: int) -> PracticeWeek:
    return db.get(PracticeWeek, (thread.id, week_no))


# -- the frozen review: hand calculations -----------------------------------------------------------------------------


def test_week_one_freezes_with_a_review_whose_selection_and_timing_match_hand_calculations(
    db_session, owner, world, svc
) -> None:
    thread, _, _ = _play(db_session, owner, svc, world, through=3)
    week = _week(db_session, thread, 1)
    assert week.status == "closed" and week.review is not None
    review = week.review
    assert review["week"] == {"week_no": 1, "label": "Week 1 · 3 days", "first_day_no": 1, "last_day_no": 3}
    assert [d["day_no"] for d in review["days"]] == [1, 2, 3]
    assert [d["watched"] for d in review["days"]] == ["yes"] * 3

    # S04, a long that stays open: the span runs from the close before its entry to the week's last close
    long = _row(review, "S04")
    edge, rank = _selection(world, "S04", +1, BASIS, W1[-1])
    entry = bar_close(world, "S04", W1[0], "10:00")  # S04 has no split: raw is adjusted
    assert (long["status"], long["exit_day_no"], long["selection_edge_pts"], long["selection_rank"]) == (
        "open",
        None,
        _approx(edge),
        rank,
    )
    assert long["selection_of"] == 12 and rank == 2  # +1% a day, behind S01's 6% gap up on Thursday
    assert long["timing_edge_pts"] == _approx(
        _timing(+1, entry, _adj(world, "S04", W1[-1]), _adj(world, "S04", BASIS), _adj(world, "S04", W1[-1]))
    )
    assert long["days_held"] == 3 and long["stop"] == "set" and long["r"] is not None

    # S05, a short that exits Friday at 14:00: -1% a day is the best short in the universe
    short = _row(review, "S05")
    edge, rank = _selection(world, "S05", -1, BASIS, W1[-1])
    p_in, p_out = bar_close(world, "S05", W1[0], "10:00"), bar_close(world, "S05", W1[2], "14:00")
    assert (short["status"], short["exit_day_no"], short["days_held"]) == ("closed", 3, 3)
    assert short["exit_price"] == pytest.approx(p_out, abs=1e-5)
    assert short["selection_edge_pts"] == _approx(edge) and short["selection_rank"] == rank == 1
    assert short["timing_edge_pts"] == _approx(
        _timing(-1, p_in, p_out, _adj(world, "S05", BASIS), _adj(world, "S05", W1[-1]))
    )
    assert short["pnl_usd"] == _approx(50 * (p_in - p_out))

    # S03, bought Thursday before its split: its prices are restated onto the adjusted basis (raw / 2 here)
    split = _row(review, "S03")
    entry_raw = bar_close(world, "S03", W1[1], "11:00")
    assert entry_raw == pytest.approx(2 * _adj(world, "S03", W1[1]), rel=0.01)  # still 2x raw in Week 1
    edge, _ = _selection(world, "S03", +1, W1[0], W1[-1])
    assert split["selection_edge_pts"] == _approx(edge)
    assert split["timing_edge_pts"] == _approx(
        _timing(+1, entry_raw / 2, _adj(world, "S03", W1[-1]), _adj(world, "S03", W1[0]), _adj(world, "S03", W1[-1]))
    )

    # the tiles: selection and timing are the means of the holds' edges; the money is the day summaries'
    tiles = review["tiles"]
    rows = [long, short, split]
    assert tiles["selection_pts"] == _approx(statistics.mean(r["selection_edge_pts"] for r in rows))
    assert tiles["timing_pts"] == _approx(statistics.mean(r["timing_edge_pts"] for r in rows))
    assert (short["stop"], split["stop"]) == ("set", "none")
    assert tiles["realized_usd"] == _approx(short["pnl_usd"]) and tiles["win_rate"] == 1.0
    assert tiles["equity_change_usd"] == pytest.approx(
        round(tiles["realized_usd"] + tiles["unrealized_change_usd"], 2), abs=0.011
    )
    assert tiles["universe_median_return_pct"] == _approx(
        statistics.median(_returns(world, BASIS, W1[-1]).values()) * 100
    )
    assert tiles["spy_return_pct"] == _approx((_adj(world, "SPY", W1[-1]) / _adj(world, "SPY", BASIS) - 1) * 100)
    assert [e["day_no"] for e in review["equity"]] == [1, 2, 3]
    assert review["equity"][-1]["balance_usd"] == tiles["balance_usd"]
    assert len(review["heat"]) == 12 and {h["symbol"] for h in review["heat"] if h["held"] == "yes"} == {
        "S03",
        "S04",
        "S05",
    }
    by_source: dict[str, list[float]] = {}
    for symbol, r in _returns(world, BASIS, W1[-1]).items():
        by_source.setdefault(SOURCES[symbol], []).append(r)
    assert review["source_quality"] == [
        {"source": tag, "median_return_pct": _approx(statistics.median(by_source[tag]) * 100), "n": len(by_source[tag])}
        for tag in week_mod.SOURCE_ORDER
    ]
    places = [
        _selection(world, sym, sign, a, W1[-1])[1]
        for sym, sign, a in (("S04", 1, BASIS), ("S05", -1, BASIS), ("S03", 1, W1[0]))
    ]
    ranked = f"{', '.join(week_mod.ordinal(p) for p in places[:2])} and {week_mod.ordinal(places[2])}"
    assert f"your holds ranked {ranked} of 12" in review["copy"][0]


def test_week_two_scores_holds_carried_in_from_the_opening_close_and_keeps_the_split_symbol_whole(
    db_session, owner, world, svc
) -> None:
    thread, _, _ = _play(db_session, owner, svc, world)
    week = _week(db_session, thread, 2)
    assert week.status == "closed" and week.last_day == W2[-1]
    review = week.review
    assert review["week"] == {"week_no": 2, "label": "Week 2", "first_day_no": 4, "last_day_no": 8}
    assert [(d["day_no"], d["watched"]) for d in review["days"]] == [
        (4, "yes"),
        (5, "no"),
        (6, "yes"),
        (7, "no"),
        (8, "no"),
    ]
    assert {h["symbol"] for h in review["holds"]} == {"S04", "S03"}  # the S05 short left in Week 1

    # S04 came in from Week 1 and left on the new week's first day: the span runs from the opening close to that close
    s04 = _row(review, "S04")
    exit_price = bar_close(world, "S04", W2[0], "11:00")
    assert (s04["status"], s04["entry_day_no"], s04["exit_day_no"], s04["days_held"]) == ("closed", 1, 4, 4)
    assert s04["stop"] == "set"
    edge, rank = _selection(world, "S04", +1, W1[-1], W2[0])
    assert (s04["selection_edge_pts"], s04["selection_rank"]) == (_approx(edge), rank)
    assert s04["timing_edge_pts"] == _approx(
        _timing(+1, _adj(world, "S04", W1[-1]), exit_price, _adj(world, "S04", W1[-1]), _adj(world, "S04", W2[0]))
    )  # her leg starts at the opening close, not at her Wednesday entry
    entry = bar_close(world, "S04", W1[0], "10:00")
    assert s04["pnl_usd"] == _approx(100 * (exit_price - entry))  # but the P/L is the whole hold's

    # S03 crossed its 2-for-1 split on Day 4: shares and prices are restated, the returns come from adjusted closes
    s03 = _row(review, "S03")
    entry_raw, exit_price = bar_close(world, "S03", W1[1], "11:00"), bar_close(world, "S03", W2[2], "12:00")
    assert (s03["shares"], s03["entry_day_no"], s03["exit_day_no"], s03["days_held"]) == (80, 2, 6, 5)
    assert s03["entry_price"] == pytest.approx(entry_raw / 2, rel=1e-3)
    assert s03["pnl_usd"] == _approx(80 * (exit_price - entry_raw / 2))
    edge, rank = _selection(world, "S03", +1, W1[-1], W2[2])
    assert abs(edge) < 3 and (s03["selection_edge_pts"], s03["selection_rank"]) == (_approx(edge), rank)  # not -50
    assert s03["timing_edge_pts"] == _approx(
        _timing(+1, _adj(world, "S03", W1[-1]), exit_price, _adj(world, "S03", W1[-1]), _adj(world, "S03", W2[2]))
    )
    assert abs(s03["gap_usd"]) < 1 and s03["stop"] == "none"  # the split morning is no gap
    heat = {h["symbol"]: h for h in review["heat"]}
    assert abs(heat["S03"]["return_pct"]) < 3 and heat["S03"]["held"] == "yes"  # adjusted: the week is flat, not -50%

    tiles = review["tiles"]
    assert tiles["realized_usd"] == _approx(s04["pnl_usd"] + s03["pnl_usd"])
    assert (tiles["avg_days_held"], tiles["win_rate"]) == (4.5, sum(h["pnl_usd"] > 0 for h in (s04, s03)) / 2)
    assert tiles["selection_pts"] == _approx((s04["selection_edge_pts"] + s03["selection_edge_pts"]) / 2)
    assert tiles["universe_median_return_pct"] == _approx(
        statistics.median(_returns(world, W1[-1], W2[-1]).values()) * 100
    )


def test_a_review_depends_on_nothing_after_its_close(db_session, owner, world, svc) -> None:
    """Every ended day's review (a frozen week, or Week to date) is identical when the bars after that day are replaced
    by garbage, even though the thread has since marked, restated and closed its holds."""
    thread, plan, _ = _play(db_session, owner, svc, world)
    days = swing._days(plan)
    seen = []
    for day in DAYS[2:10]:
        week_no = week_mod.span_for(days, day).week_no
        plain = week_mod.compute_review(
            swing_weeks.build_inputs(db_session, svc, thread, plan, week_no, through_day=day)
        )
        other = swing_services(scrambled(world, day))
        later = DAYS[DAYS.index(day) + 1]
        assert _adj(scrambled(world, day), "S04", later) != _adj(world, "S04", later)  # the garbage is really there
        scrambled_review = week_mod.compute_review(
            swing_weeks.build_inputs(db_session, other, thread, plan, week_no, through_day=day)
        )
        assert scrambled_review == plain, day
        seen.append(plain)
    assert [len(r["holds"]) for r in seen] == [2, 3, 3, 2, 2, 2, 2, 2]  # Day 1: S04, S05; Day 2: S03 joins; ...
    # a frozen week is the same function through its last day
    for week_no, last in ((1, W1[-1]), (2, W2[-1])):
        stored = _week(db_session, thread, week_no).review
        fresh = swing_weeks._review(db_session, svc, thread, plan, week_no, last)
        assert stored == jsonable(fresh)


def test_the_open_week_serves_week_to_date_and_the_closed_one_its_frozen_review(db_session, owner, world, svc) -> None:
    thread, _, _ = _play(db_session, owner, svc, world, through=6)
    with pytest.raises(ReplayProblem) as caught:
        swing_weeks.week_out(db_session, svc, thread, 3)
    assert (caught.value.status, caught.value.message) == (404, "Week 3 has not started yet")

    out = swing_weeks.week_out(db_session, svc, thread, 2)
    assert (out["week_no"], out["status"], out["to_date"], out["label"]) == (2, "open", "yes", "Week 2 · 3 of 5 days")
    assert out["review"]["week"] == {"week_no": 2, "label": "Week 2 · 3 of 5 days", "first_day_no": 4, "last_day_no": 6}
    assert [d["day_no"] for d in out["review"]["days"]] == [4, 5, 6]  # through the last ended close, no further
    assert (out["notes"], out["rating"]) == (None, None)
    assert (
        out["universe_label"] == swing.survivorship_label(12)
        and out["footnote"] == "Dividends are not credited in practice"
    )
    assert _week(db_session, thread, 2).review is None  # computed on read, never stored

    closed = swing_weeks.week_out(db_session, svc, thread, 1)
    assert (closed["status"], closed["to_date"], closed["label"]) == ("closed", "no", "Week 1 · 3 days")
    assert closed["review"] == _week(db_session, thread, 1).review

    for _ in range(2):  # Days 7 and 8: the week ends and freezes
        _end(db_session, owner, svc, _open(db_session, owner, svc, thread))
    frozen = swing_weeks.week_out(db_session, svc, thread, 2)
    assert (frozen["status"], frozen["to_date"], frozen["label"]) == ("closed", "no", "Week 2")
    assert frozen["review"] == _week(db_session, thread, 2).review
    assert frozen["review"]["week"]["last_day_no"] == 8 and len(frozen["review"]["days"]) == 5

    _open(db_session, owner, svc, thread)  # Day 9 opens Week 3, but nothing in it has ended
    with pytest.raises(ReplayProblem) as caught:
        swing_weeks.week_out(db_session, svc, thread, 3)
    assert (caught.value.status, caught.value.message) == (404, "Week 3 has no finished day yet · end a day first")


def test_the_weeks_list_has_a_row_for_each_opened_week(db_session, owner, world, svc) -> None:
    thread, _, _ = _play(db_session, owner, svc, world)
    _open(db_session, owner, svc, thread)  # Week 3 opens
    out = swing_weeks.weeks_out(db_session, thread)
    assert out["thread_id"] == thread.id and out["label"] == threads_mod.SIMULATED_LABEL
    one, two, three = out["weeks"]
    assert [
        (w["week_no"], w["label"], w["days"], w["first_day_no"], w["last_day_no"], w["status"])
        for w in (one, two, three)
    ] == [
        (1, "Week 1 · 3 days", 3, 1, 3, "closed"),
        (2, "Week 2", 5, 4, 8, "closed"),
        (3, "Week 3", 5, 9, 13, "open"),
    ]
    for row, number in ((one, 1), (two, 2)):
        tiles = _week(db_session, thread, number).review["tiles"]
        assert (row["realized_usd"], row["equity_change_usd"], row["adherence_pct"]) == (
            tiles["realized_usd"],
            tiles["equity_change_usd"],
            tiles["adherence_pct"],
        )
        assert (row["selection_pts"], row["timing_pts"]) == (tiles["selection_pts"], tiles["timing_pts"])
    assert one["selection_pts"] is not None and one["realized_usd"] is not None
    assert [
        three[k] for k in ("realized_usd", "equity_change_usd", "adherence_pct", "selection_pts", "timing_pts")
    ] == [None] * 5


def test_notes_and_rating_patch_on_an_open_or_a_closed_week(db_session, owner, world, svc) -> None:
    thread, _, _ = _play(db_session, owner, svc, world, through=4)  # Week 1 closed, Week 2 open
    for number in (1, 2):
        week = swing_weeks.patch_week(
            db_session, thread, number, notes="felt rushed", rating=4, fields={"notes", "rating"}, now=NOW
        )
        assert (week.notes, week.rating) == ("felt rushed", 4)
    week = swing_weeks.patch_week(db_session, thread, 1, notes=None, rating=2, fields={"rating"}, now=NOW)
    assert (week.notes, week.rating) == ("felt rushed", 2)  # a field left out is untouched
    week = swing_weeks.patch_week(db_session, thread, 1, notes=None, rating=None, fields={"notes", "rating"}, now=NOW)
    assert (week.notes, week.rating) == (None, None)  # null clears
    served = swing_weeks.week_out(db_session, svc, thread, 2)
    assert (served["notes"], served["rating"]) == ("felt rushed", 4)

    for rating in (0, 6):
        with pytest.raises(ReplayProblem) as caught:
            swing_weeks.patch_week(db_session, thread, 1, notes=None, rating=rating, fields={"rating"}, now=NOW)
        assert (caught.value.status, caught.value.path) == (422, "rating")
    with pytest.raises(ReplayProblem) as caught:
        swing_weeks.patch_week(db_session, thread, 1, notes="x" * 2001, rating=None, fields={"notes"}, now=NOW)
    assert (caught.value.status, caught.value.path) == (422, "notes")
    assert (
        swing_weeks.patch_week(db_session, thread, 1, notes="x" * 2000, rating=None, fields={"notes"}, now=NOW).notes
        == "x" * 2000
    )
    with pytest.raises(ReplayProblem) as caught:
        swing_weeks.patch_week(db_session, thread, 3, notes="late", rating=None, fields={"notes"}, now=NOW)
    assert caught.value.status == 404
    assert _week(db_session, thread, 1).review is not None  # the review is never touched by the patch


def test_holds_are_marked_at_the_last_ended_close_and_never_later(db_session, owner, world, svc) -> None:
    thread, _, _ = _play(db_session, owner, svc, world, through=3)
    day4 = _open(db_session, owner, svc, thread)  # the split day is listed: S03 is restated, nothing of it has played
    (session,) = _practice(db_session, owner, svc, day4, "S01")
    _enter(db_session, thread, world, "S01", "long", 10, DAYS[5], hhmm="10:00", session=session)

    out = swing_weeks.holds_out(db_session, svc, thread, "all")
    assert (out["thread_id"], out["as_of_day_no"], out["label"]) == (thread.id, 3, threads_mod.SIMULATED_LABEL)
    by = {h["symbol"]: h for h in out["holds"]}
    assert [h["symbol"] for h in out["holds"]] == ["S04", "S05", "S03", "S01"]  # entry order
    close = float(world.raw["S04"].loc[W1[-1], "close"])  # the last ended close, nothing later
    entry = bar_close(world, "S04", W1[0], "10:00")
    assert (by["S04"]["status"], by["S04"]["last_close"], by["S04"]["price_basis"], by["S04"]["days_held"]) == (
        "open",
        close,
        "prior_close",
        3,
    )
    assert by["S04"]["unrealized_usd"] == _approx(100 * (close - entry))
    assert (by["S05"]["status"], by["S05"]["exit_day_no"], by["S05"]["pnl_usd"] is not None) == ("closed", 3, True)
    assert (by["S03"]["shares"], by["S03"]["split_note"].startswith("Split 2-for-1 before today's open")) == (80, True)
    assert by["S03"]["last_close"] == pytest.approx(float(world.raw["S03"].loc[W1[-1], "close"]) / 2, rel=1e-3)
    assert (by["S01"]["last_close"], by["S01"]["price_basis"], by["S01"]["unrealized_usd"], by["S01"]["days_held"]) == (
        None,
        None,
        0.0,
        1,
    )

    assert [h["symbol"] for h in swing_weeks.holds_out(db_session, svc, thread, "open")["holds"]] == [
        "S04",
        "S03",
        "S01",
    ]
    assert [h["symbol"] for h in swing_weeks.holds_out(db_session, svc, thread, "closed")["holds"]] == ["S05"]
    garbage = swing_services(scrambled(world, W1[-1]))
    assert swing_weeks.holds_out(db_session, garbage, thread, "all") == out  # later bars are never read
    with pytest.raises(ReplayProblem) as caught:
        swing_weeks.holds_out(db_session, svc, thread, "pending")
    assert (caught.value.status, caught.value.path) == (422, "status")


def test_holds_before_any_day_has_ended_read_as_of_nothing(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc, firstDay=START.isoformat())
    assert swing_weeks.holds_out(db_session, svc, thread, "all") == {
        "thread_id": thread.id,
        "as_of_day_no": None,
        "holds": [],
        "label": threads_mod.SIMULATED_LABEL,
    }


def test_a_hold_carried_into_the_next_week_reports_only_that_weeks_gaps_and_stops(
    db_session, owner, world, svc
) -> None:
    """A short on S01 from Day 1 with a stop: S01 gaps up on Day 2 (Week 1), the stop is crossed unwatched, and the
    hold is never exited. Week 2 sees neither the gap nor the crossing, only a hold still open at its Friday close."""
    thread, _ = ready_thread(db_session, owner, svc, firstDay=START.isoformat())
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S01")
    entry = bar_close(world, "S01", DAYS[2], "10:00")
    _enter(db_session, thread, world, "S01", "short", 10, DAYS[2], stop=round(entry + 2, 2), session=session)
    _end(db_session, owner, svc, day1)
    _pass_days(db_session, owner, svc, thread, 7)
    one, two = (_row(_week(db_session, thread, n).review, "S01") for n in (1, 2))
    gap_up = bar_close(world, "S01", DAYS[3], "09:30") - float(world.raw["S01"].loc[DAYS[2], "close"])
    assert (one["gap_usd"], one["stop"], one["days_held"]) == (_approx(-10 * gap_up), "away", 3)
    assert (two["gap_usd"], two["stop"], two["status"], two["days_held"], two["entry_day_no"]) == (
        0.0,
        "set",
        "open",
        8,
        1,
    )
    assert two["pnl_usd"] == _approx(
        10 * (entry - float(world.raw["S01"].loc[W2[-1], "close"]))
    )  # marked at the Friday close
    (check,) = [c for c in _week(db_session, thread, 2).review["adherence"]["checks"] if c["id"] == "stop_honored"]
    assert check["applicable"] is False


def test_a_hold_a_reverse_split_closed_flat_is_priced_on_the_session_before_the_split() -> None:
    ts = pd.Timestamp(et(DAYS[5], "09:30"))
    split = {"day": DAYS[5].isoformat(), "ratio": 0.333333, "shares_before": 2, "shares_after": 0}
    flat = holds_mod.Hold(
        id=1, symbol="S06", side="long", shares=2, entry_day=DAYS[2], entry_at=ts, entry_price=60.0,
        stop_at_entry=None, stop_price=None, stop_hit_at=None, status="closed", exit_day=DAYS[5], exit_at=ts,
        exit_price=60.0, exit_source="auto", splits=(split,),
    )  # fmt: skip
    assert swing_weeks._price_day(flat) == DAYS[4]
    assert swing_weeks._price_day(replace(flat, splits=(), exit_day=DAYS[6])) == DAYS[6]
    assert swing_weeks._price_day(replace(flat, splits=({**split, "shares_after": 1},))) == DAYS[5]


# -- stops: watched or away -------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("watched", "exit_at", "honored"),
    [
        (True, "09:40", True),  # she paused at the crossing and got out within a bar
        (True, "09:45", True),  # the exit mark at 09:46 is 15 minutes after the 09:31 crossing: one 15m bar
        (True, "09:46", False),  # ... and 16 minutes is not
        (True, "13:00", False),  # she paused, kept it, and got out hours later
        (False, "09:35", True),  # the gap hit while she was away; she got out in the first bar of her next watched day
        (False, "14:00", False),  # ... and only in the afternoon
    ],
)
def test_a_stop_crossing_is_honored_by_a_prompt_exit_at_the_moment_she_could_act(
    db_session, owner, world, svc, watched, exit_at, honored
) -> None:
    """S01 gaps up 6% on Day 2 (Thu). Her short from Day 1 has a stop just above its entry, so the open crosses it."""
    thread, _ = ready_thread(db_session, owner, svc, firstDay=START.isoformat())
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S01")
    entry = bar_close(world, "S01", DAYS[2], "10:00")
    hold = _enter(db_session, thread, world, "S01", "short", 10, DAYS[2], stop=round(entry + 2, 2), session=session)
    _end(db_session, owner, svc, day1)

    day2 = _open(db_session, owner, svc, thread)
    if watched:  # play pauses at the crossing: the playhead flags the hold at the gap bar's close
        _practice(db_session, owner, svc, day2, "S01")
        hold_rows.apply(hold, replace(hold_rows.to_hold(hold), stop_hit_at=et(DAYS[3], "09:31")))
        _exit(db_session, hold, DAYS[3], hhmm=exit_at, world=world)
    _end(db_session, owner, svc, day2)
    assert day2.journal["stop_hits"] == [{"symbol": "S01", "at": "09:31", "watched": "yes" if watched else "no"}]

    day3 = _open(db_session, owner, svc, thread)
    if not watched:  # her next watched day
        _practice(db_session, owner, svc, day3, "S01")
        _exit(db_session, hold, DAYS[4], hhmm=exit_at, world=world)
    _end(db_session, owner, svc, day3)

    review = _week(db_session, thread, 1).review
    (check,) = [c for c in review["adherence"]["checks"] if c["id"] == "stop_honored"]
    assert (check["applicable"], check["passed"], check["detail"]) == (True, honored, f"{int(honored)} of 1")
    row = _row(review, "S01")
    assert row["stop"] == ("honored" if honored else "set" if watched else "away")
    gap_up = bar_close(world, "S01", DAYS[3], "09:30") - float(world.raw["S01"].loc[DAYS[2], "close"])
    assert row["gap_usd"] == _approx(-10 * gap_up) and row["gap_usd"] < -50  # a short loses on a gap up


def test_an_away_crossing_on_a_weeks_last_day_waits_for_the_next_watched_day(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc, firstDay=START.isoformat())
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S05")
    hold = _enter(
        db_session, thread, world, "S05", "long", 10, DAYS[2], stop=116.9, session=session
    )  # S05 slides 1%/day
    _end(db_session, owner, svc, day1)
    _pass_days(db_session, owner, svc, thread, 2)  # crossed on Day 1 after she left; Days 2 and 3 pass
    review = _week(db_session, thread, 1).review
    (check,) = [c for c in review["adherence"]["checks"] if c["id"] == "stop_honored"]
    assert (check["applicable"], _row(review, "S05")["stop"]) == (False, "away")  # no later watched day yet: not judged
    db_session.refresh(hold)
    assert hold.status == "open"  # a stop never exits


# -- adherence: the plan, the entries, the board ----------------------------------------------------------------------


def _checks(out: dict) -> dict[str, dict]:
    return {c["id"]: c for c in out["review"]["adherence"]["checks"]}


def test_adherence_is_scored_from_the_plan_the_entries_the_board_and_the_signals(db_session, owner, world, svc) -> None:
    fid = _filter(db_session, owner, "Price above 85", above=85)  # S01, S02, S03 and S05 match on the Day 1 board
    thread, _ = ready_thread(
        db_session,
        owner,
        svc,
        firstDay=START.isoformat(),
        plan={"stopNoteOnEntry": "yes", "tradeOnlyOnSignal": "yes", "maxLossUsd": 1, "maxTrades": 3},
        riskPerHoldUsd=100,
        maxOpenHolds=1,
        armed=[{"source": "filter", "id": fid}],
    )
    day = DAYS[2]
    day1 = _open(db_session, owner, svc, thread)
    s04, s05 = _practice(db_session, owner, svc, day1, "S04", "S05")
    p04 = bar_close(world, "S04", day, "10:30")
    first = _enter(
        db_session, thread, world, "S04", "short", 100, day, hhmm="10:30", stop=round(p04 + 1.5, 2), session=s04
    )
    _exit(db_session, first, day, hhmm="11:00", world=world)  # a small loss: the S04 short is against a +1% a day trend
    p05 = bar_close(world, "S05", day, "12:00")
    _enter(db_session, thread, world, "S05", "long", 10, day, hhmm="12:00", stop=round(p05 - 0.5, 2), session=s05)
    day1.revealed_through = et(day, "12:30")
    db_session.commit()
    plan_mod.patch_day_list(  # S01 is starred after the clock has moved: not before the open
        db_session, owner, day1.id, svc, watch=["S04", "S05", "S01", "S06"], notes=None, rating=None, fields={"watch"}
    )
    third = _enter(db_session, thread, world, "S01", "long", 10, day, hhmm="13:00")
    _exit(db_session, third, day, hhmm="13:30", world=world)
    _enter(db_session, thread, world, "S01", "long", 10, day, hhmm="14:00")  # back into a name she had just held
    # an armed intraday would-fire three display bars (45 minutes) before the S04 entry at 10:31
    entry_at = et(day, "10:31")
    fire = {"source": "filter", "id": fid, "name": "x", "bias": "long", "close": p04, "evidence": {}}
    s04.signals = [
        {
            **fire,
            "bar_time": (entry_at - pd.Timedelta(minutes=60)).isoformat(),
            "bar_close": (entry_at - pd.Timedelta(minutes=45)).isoformat(),
        }
    ]
    db_session.commit()
    _end(db_session, owner, svc, day1)

    out = swing_weeks.week_out(db_session, svc, thread, 1)  # Week to date through Day 1
    checks = _checks(out)
    assert list(checks) == [
        "stop_set", "stop_honored", "risk_per_hold", "open_holds_within_plan",
        "week_loss_limit", "entries_per_week", "on_signal", "focus_before_open",
    ]  # fmt: skip
    got = {k: (c["applicable"], c["passed"], c["detail"]) for k, c in checks.items()}
    assert got == {
        "stop_set": (True, False, "2 of 4"),  # the two S01 entries have no stop
        "stop_honored": (False, True, "0 of 0"),
        "risk_per_hold": (True, False, "1 of 4"),  # $150 is over $100, $5 is within; no stop is no known risk
        "open_holds_within_plan": (True, False, "2 of 1"),  # S05 and the first S01 were open together
        "week_loss_limit": (True, False, "1 of 4"),  # the other three were entered after the S04 loss passed -$1
        "entries_per_week": (True, False, "4 of 3"),
        "on_signal": (True, True, "4 of 4"),  # S04 by the intraday fire, the rest by the board
        "focus_before_open": (True, False, "3 of 4"),  # the first S01 was starred late; its re-entry was a name held
    }
    assert out["review"]["adherence"]["score_pct"] == 14  # 1 of the 7 applicable checks
    assert out["review"]["days"][0]["entries"] == 4 and out["review"]["days"][0]["adherence_pct"] == 20

    # the same board and stars feed the quality pictures: four names were flagged, S06 was starred and never held
    returns = _returns(world, BASIS, day)
    flagged = [returns[s] for s in ("S01", "S02", "S03", "S05")]
    assert out["review"]["filter_quality"] == {
        "n": 4,
        "median_return_pct": _approx(statistics.median(flagged) * 100),
        "universe_median_pct": _approx(statistics.median(returns.values()) * 100),
        "edge_pts": _approx((statistics.median(flagged) - statistics.median(returns.values())) * 100),
    }
    rank = sorted(SYMBOLS, key=lambda s: (-returns[s], s)).index("S06") + 1
    assert out["review"]["focus_untraded"] == [
        {"symbol": "S06", "rank": rank, "of": 12, "return_pct": _approx(returns["S06"] * 100)}
    ]

    fire_row = s04.signals[0]
    s04.signals = [{**fire_row, "bar_close": (entry_at - pd.Timedelta(minutes=46)).isoformat()}]  # a bar too far
    db_session.flush()
    again = _checks(swing_weeks.week_out(db_session, svc, thread, 1))
    assert (again["on_signal"]["passed"], again["on_signal"]["detail"]) == (False, "3 of 4")


def test_the_loss_limit_counts_each_week_on_its_own(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc, firstDay=START.isoformat(), plan={"maxLossUsd": 1})
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S04")
    loser = _enter(db_session, thread, world, "S04", "short", 100, DAYS[2], hhmm="10:30", session=session)
    _exit(db_session, loser, DAYS[2], hhmm="11:00", world=world)  # against the trend: a loss of a few dollars
    _end(db_session, owner, svc, day1)
    _pass_days(db_session, owner, svc, thread, 2)
    assert _week(db_session, thread, 1).review["tiles"]["realized_usd"] < -1  # Week 1 is past the limit
    day4 = _open(db_session, owner, svc, thread)  # ... but Week 2 starts clean
    (session,) = _practice(db_session, owner, svc, day4, "S05")
    _enter(db_session, thread, world, "S05", "long", 10, DAYS[5], session=session)
    _end(db_session, owner, svc, day4)
    check = _checks(swing_weeks.week_out(db_session, svc, thread, 2))["week_loss_limit"]
    assert (check["applicable"], check["passed"], check["detail"]) == (True, True, "1 of 1")


def test_with_no_plan_set_only_the_open_hold_limit_applies(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc, firstDay=START.isoformat())
    _end(db_session, owner, svc, _open(db_session, owner, svc, thread))
    out = swing_weeks.week_out(db_session, svc, thread, 1)
    applicable = [c["id"] for c in out["review"]["adherence"]["checks"] if c["applicable"]]
    # every swing plan carries `maxOpenHolds`, so a week can never score None the way a day thread's can
    assert applicable == ["open_holds_within_plan"] and out["review"]["adherence"]["score_pct"] == 100


# -- the end of a thread, and a review that cannot be built -----------------------------------------------------------


def test_an_early_close_freezes_the_partial_week_and_books_the_exits_in_it(db_session, owner, world, svc) -> None:
    thread, _, _ = _play(db_session, owner, svc, world, through=5)  # Week 2: Day 4 passed, Day 5 exits S04; S03 is open
    threads_mod.close_thread(db_session, owner, thread.id, NOW, svc)
    db_session.commit()
    week = _week(db_session, thread, 2)
    assert (week.status, week.last_day) == ("closed", W2[1])  # the week the thread actually played
    review = week.review
    assert review["week"] == {"week_no": 2, "label": "Week 2 · 2 of 5 days", "first_day_no": 4, "last_day_no": 5}
    assert [d["day_no"] for d in review["days"]] == [4, 5]

    s03, s04 = _row(review, "S03"), _row(review, "S04")
    close = float(world.raw["S03"].loc[W2[1], "close"])  # raw is adjusted after the split
    entry = bar_close(world, "S03", W1[1], "11:00") / 2
    assert (s03["status"], s03["exit_day_no"], s03["days_held"]) == ("closed", 5, 4)  # the last ended close, Day 5
    assert s03["exit_price"] == pytest.approx(close, abs=1e-4) and s03["pnl_usd"] == _approx(80 * (close - entry))
    tiles = review["tiles"]
    assert tiles["realized_usd"] == _approx(s03["pnl_usd"] + s04["pnl_usd"])  # the auto exit counts as realized
    assert tiles["balance_usd"] == swing.balance(db_session, thread)  # and the balance is the ledger's
    journals = [d.journal for d in threads_mod._ended_days(db_session, thread.id) if d.day >= W2[0]]
    assert tiles["equity_change_usd"] == _approx(sum(j["equity_change_usd"] for j in journals))
    assert review["equity"][-1]["equity_usd"] == tiles["balance_usd"]  # nothing is open any more

    (row,) = [w for w in swing_weeks.weeks_out(db_session, thread)["weeks"] if w["week_no"] == 2]
    assert (row["label"], row["days"], row["last_day_no"], row["status"]) == ("Week 2 · 2 of 5 days", 2, 5, "closed")
    assert swing_weeks.week_out(db_session, svc, thread, 2)["review"] == review


def test_an_early_close_without_services_closes_the_week_and_the_read_builds_its_review(
    db_session, owner, world, svc
) -> None:
    thread, _, _ = _play(db_session, owner, svc, world, through=5)
    threads_mod.close_thread(db_session, owner, thread.id, NOW)  # a caller with no data services
    db_session.commit()
    week = _week(db_session, thread, 2)
    assert (week.status, week.review) == ("closed", None)
    out = swing_weeks.week_out(db_session, svc, thread, 2)
    assert (out["to_date"], out["label"], out["status"]) == ("no", "Week 2 · 2 of 5 days", "closed")
    assert out["review"]["tiles"]["realized_usd"] is not None and out["review"]["week"]["last_day_no"] == 5
    assert _week(db_session, thread, 2).review is None
    (row,) = [w for w in swing_weeks.weeks_out(db_session, thread)["weeks"] if w["week_no"] == 2]
    assert (row["label"], row["realized_usd"]) == ("Week 2 · 2 of 5 days", None)


def test_a_review_that_fails_never_blocks_ending_the_day(db_session, owner, world, svc, monkeypatch) -> None:
    def boom(*args, **kwargs):
        raise RuntimeError("no review today")

    with monkeypatch.context() as patched:
        patched.setattr(swing_weeks, "build_inputs", boom)
        thread, _, _ = _play(db_session, owner, svc, world, through=3)
    week = _week(db_session, thread, 1)
    assert (week.status, week.review) == ("closed", None) and week.closed_at is not None
    assert threads_mod._ended_days(db_session, thread.id)[-1].status == "ended"
    out = swing_weeks.week_out(db_session, svc, thread, 1)  # the read builds it once the fault is gone
    assert out["review"]["tiles"]["realized_usd"] is not None
