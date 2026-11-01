"""The swing lifecycle on the synthetic swing world (`tests/swing_world.py`, 02p): opening a day (the board, splits, the
week row), starting sessions, ending and Passing a day (stop scan, marks at the official close, the day summary, the
ledger credit), the week freeze, the thread's last day and its early close, the thread's swing state and stats, and the
no-lookahead guarantees. Holds are created with `hold_rows.add_entry` and closed with the pure `holds.exit_hold` (the
mark routes that do this for her are the next step). Real Postgres (`scripts/test-db.sh`); the history is in memory."""

from dataclasses import replace
from datetime import date

import pandas as pd
import pytest
from daily_world import make_services
from sqlalchemy import func, select
from swing_world import (
    DAYS,
    FIRST_DAY,
    GAP_DOWN_DAY,
    GAP_UP_DAY,
    NOW,
    SOURCES,
    SPLIT_DAY,
    SYMBOLS,
    bar_close,
    create_swing_thread,
    make_owner,
    ready_thread,
    scrambled,
    swing_services,
    swing_world,
)
from test_replay_swing_setup import _filter

from ai_trading.contracts.practice_thread import SwingSetupV1
from ai_trading.core.calendar import et, previous_session
from ai_trading.db.models import (
    PracticeHold,
    PracticeLedger,
    PracticeMark,
    PracticePlan,
    PracticeThread,
    PracticeWeek,
    ReplayDayList,
    ReplaySession,
)
from ai_trading.replay import hold_rows, swing
from ai_trading.replay import holds as holds_mod
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay import week as week_mod
from ai_trading.replay.session import ReplayProblem

MINUTE = pd.Timedelta(minutes=1)
BASIS_DAY = previous_session("stock", FIRST_DAY)


@pytest.fixture
def world():
    return swing_world()


@pytest.fixture
def svc(world):
    return swing_services(world)


@pytest.fixture
def owner(db_session) -> int:
    return make_owner(db_session)


# -- helpers: walk the calendar and place holds ----------------------------------------------------------------------


def _open(db, owner, svc, thread):
    opened = swing.open_next(db, owner, svc, thread.id)
    db.commit()
    assert opened.day_list is not None
    return opened.day_list


def _end(db, owner, svc, row):
    swing.end_day(db, owner, row.id, svc)
    db.commit()
    db.refresh(row)
    return row


def _pass_days(db, owner, svc, thread, count):
    return [_end(db, owner, svc, _open(db, owner, svc, thread)) for _ in range(count)]


def _practice(db, owner, svc, row, *symbols):
    """Star `symbols` on the board and start a session on each (the day then counts as watched)."""
    plan_mod.patch_day_list(db, owner, row.id, svc, watch=list(symbols), notes=None, rating=None, fields={"watch"})
    sessions = [swing.start_session(db, owner, row.id, symbol, svc) for symbol in symbols]
    db.commit()
    return sessions


def _enter(db, thread, world, symbol, side, shares, day, *, hhmm="10:00", stop=None, session=None):
    """A hold opened at the close of the `hhmm` one-minute bar of `day` (what her entry mark will stamp)."""
    row = hold_rows.add_entry(
        db,
        thread,
        symbol=symbol,
        side=side,
        shares=shares,
        day=day,
        at=et(day, hhmm) + MINUTE,
        price=bar_close(world, symbol, day, hhmm),
        stop=stop,
        session_id=None if session is None else session.id,
        mark_id=None,
        now=NOW,
    )
    db.commit()
    return row


def _exit(db, row, day, *, hhmm="14:00", world, source="her"):
    """Close the hold at the `hhmm` bar's close of `day` (an exit mark in play)."""
    price = bar_close(world, row.symbol, day, hhmm)
    hold_rows.apply(
        row,
        holds_mod.exit_hold(hold_rows.to_hold(row), day=day, at=et(day, hhmm) + MINUTE, price=price, source=source),
    )
    db.commit()
    return price


def _raw_close(world, symbol, day):
    """The official close a hold is marked at: the raw daily close in whole cents (D-033, D-064)."""
    return journal_mod.fill_price(float(world.raw[symbol].loc[day, "close"]))


def _ledger(db, thread):
    return list(
        db.execute(select(PracticeLedger).where(PracticeLedger.thread_id == thread.id).order_by(PracticeLedger.id))
        .scalars()
        .all()
    )


def _hold(db, thread, symbol):
    return db.execute(
        select(PracticeHold).where(PracticeHold.thread_id == thread.id, PracticeHold.symbol == symbol)
    ).scalar_one()


def _approx(value, places=2):
    return pytest.approx(value, abs=10**-places * 1.1)


# -- opening a day: the board ----------------------------------------------------------------------------------------


def test_day_one_board_has_every_universe_name_sorted_with_figures_from_the_prior_close(
    db_session, owner, world, svc
) -> None:
    thread, plan = ready_thread(db_session, owner, svc)
    row = _open(db_session, owner, svc, thread)
    assert (row.day, row.day_no, row.status, row.plan_id) == (FIRST_DAY, 1, "listed", plan.id)
    assert (row.revealed_through, row.watch, row.journal, row.review) == (None, [], None, None)
    assert sorted(c["symbol"] for c in row.candidates) == SYMBOLS
    keys = [
        (-len(c["matches"]), week_mod.SOURCE_ORDER.index(c["source"]), -c["avg_dollar_volume_20d"], c["symbol"])
        for c in row.candidates
    ]
    assert keys == sorted(keys)  # matches, then source order, then dollar volume
    prior_close = pd.Timestamp(et(BASIS_DAY, "16:00"))
    assert pd.Timestamp(row.data_through) == prior_close and pd.Timestamp(row.list_at) == prior_close
    assert row.screen == {
        "filters": [],
        "listAt": "04:30",
        "maxList": 50,
        "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"},  # the week's plan (M3)
    }
    assert row.columns == swing.BOARD_COLUMNS
    assert row.universe["size"] == 12 and row.universe["source"] == "swing"
    assert row.universe["mix"] == {"watchlist": 4, "manual": 2, "filter": 2, "liquidity": 4}
    assert row.universe["label"].startswith("Fixed universe · 12 symbols") and "survivors" in row.universe["label"]
    assert "Dividends are not credited" in row.universe["footnote"] and "one-minute closes" in row.universe["footnote"]

    by = {c["symbol"]: c for c in row.candidates}
    for symbol in ("S01", "S09"):  # every figure checked against the world's split-adjusted closes
        frame = world.split[symbol]
        frame = frame[frame.index <= BASIS_DAY]
        close, last = frame["close"], float(frame["close"].iloc[-1])
        c = by[symbol]
        assert c["prior_close"] == pytest.approx(last, abs=1e-4)
        assert c["chg_1d_pct"] == _approx((last / close.iloc[-2] - 1) * 100)
        assert c["chg_5d_pct"] == _approx((last / close.iloc[-6] - 1) * 100)
        assert c["chg_20d_pct"] == _approx((last / close.iloc[-21] - 1) * 100)
        assert c["pct_from_20d_high"] == _approx((last / frame["high"].iloc[-20:].max() - 1) * 100)
        assert c["vs_50d_avg_pct"] == _approx((last / close.iloc[-50:].mean() - 1) * 100)
        assert c["avg_dollar_volume_20d"] == round((frame["close"] * frame["volume"]).iloc[-20:].mean())
        assert (c["matches"], c["earnings"]) == ([], None)
    assert by["S03"]["prior_close"] == pytest.approx(100.0, rel=0.01)  # on Day 1's own (pre-split) share basis
    week = db_session.get(PracticeWeek, (thread.id, 1))
    assert (week.status, week.first_day, week.last_day, week.review) == ("open", DAYS[0], DAYS[4], None)
    db_session.refresh(plan)
    assert (plan.day_cursor, plan.days_opened) == (FIRST_DAY, 1)


def test_armed_daily_filters_mark_matches_and_sort_those_names_first(db_session, owner, svc) -> None:
    fid = _filter(db_session, owner, "Price above 85", above=85)
    thread, _ = ready_thread(db_session, owner, svc, armed=[{"source": "filter", "id": fid}])
    row = _open(db_session, owner, svc, thread)
    matched = {c["symbol"]: c["matches"] for c in row.candidates if c["matches"]}
    # S03 is on Day 1's own (pre-split) share basis, around 100
    assert matched == dict.fromkeys(("S01", "S02", "S03", "S05"), ["Price above 85"])
    assert {c["symbol"] for c in row.candidates[:4]} == set(matched)  # matches first
    assert row.screen["filters"] == [
        {"id": fid, "version_id": row.screen["filters"][0]["version_id"], "name": "Price above 85"}
    ]


def test_an_armed_filter_that_was_deleted_since_matches_nothing_and_the_thread_goes_on(db_session, owner, svc) -> None:
    from ai_trading.db.models import FilterStrategy

    fid = _filter(db_session, owner, "Price above 85", above=85)
    thread, _ = ready_thread(db_session, owner, svc, armed=[{"source": "filter", "id": fid}])
    db_session.get(FilterStrategy, fid).archived_at = NOW
    db_session.commit()
    row = _open(db_session, owner, svc, thread)
    assert all(c["matches"] == [] for c in row.candidates) and row.screen["filters"] == []


def test_the_board_is_identical_when_every_bar_after_the_prior_close_is_replaced(db_session, world) -> None:
    fid_rows = {}
    for label, svc_world in (("a", world), ("b", scrambled(world, BASIS_DAY))):
        user = make_owner(db_session, f"{label}@example.com")
        fid = _filter(db_session, user, "Price above 85", above=85)
        service = swing_services(svc_world)
        thread, _ = ready_thread(db_session, user, service, armed=[{"source": "filter", "id": fid}])
        row = _open(db_session, user, service, thread)
        out = swing.day_list_out(db_session, user, row.id, service, peek="S01")
        fid_rows[label] = (row.candidates, row.universe, row.columns, out["peek"])
    assert fid_rows["a"] == fid_rows["b"]
    assert fid_rows["a"][3]["daily"][-1]["t"] == BASIS_DAY  # Peek ends at the prior session


def test_the_second_board_reads_the_ended_days_before_it_and_nothing_later(db_session, world) -> None:
    runs = []
    for label, svc_world in (("a", world), ("b", scrambled(world, DAYS[0]))):
        user = make_owner(db_session, f"{label}@example.com")
        service = swing_services(svc_world)
        thread, _ = ready_thread(db_session, user, service)
        _pass_days(db_session, user, service, thread, 1)
        runs.append(_open(db_session, user, service, thread).candidates)
    assert runs[0] == runs[1]


def test_earnings_chips_are_explicit_dates_with_a_stated_timing_within_ten_sessions(db_session, owner, svc) -> None:
    class Report:
        def __init__(self, report_date, report_time):
            self.report_date, self.report_time = report_date, report_time

    events = {
        "S01": [Report(DAYS[3], "pre-market")],  # 3 sessions ahead, before the open
        "S02": [Report(DAYS[1], "post-market")],  # tomorrow, after the close
        "S03": [Report(DAYS[2], None)],  # no stated time: never a chip
        "S04": [Report(DAYS[11], "pre-market")],  # 11 sessions ahead: beyond the horizon
        "S05": [Report(BASIS_DAY, "pre-market")],  # already reported
        "S06": [Report(DAYS[2], "post-market"), Report(DAYS[4], "pre-market")],  # the nearer one
    }
    chain = type(
        "Chain", (), {"providers": [type("Cal", (), {"earnings_results": lambda self, s, *, now: events.get(s, [])})()]}
    )()
    svc.sources = replace(svc.sources, earnings=chain)
    thread, _ = ready_thread(db_session, owner, svc)
    row = _open(db_session, owner, svc, thread)
    chips = {c["symbol"]: c["earnings"] for c in row.candidates if c["earnings"]}
    assert chips == {
        "S01": {"in_sessions": 3, "timing": "before open"},
        "S02": {"in_sessions": 1, "timing": "after close"},
        "S06": {"in_sessions": 2, "timing": "after close"},
    }
    # no calendar at all: no chips, no failure
    svc.sources = None
    _end(db_session, owner, svc, row)
    assert all(c["earnings"] is None for c in _open(db_session, owner, svc, thread).candidates)


def test_open_next_is_idempotent_and_walks_the_calendar_in_order(db_session, owner, svc) -> None:
    thread, plan = ready_thread(db_session, owner, svc)
    first = _open(db_session, owner, svc, thread)
    again = _open(db_session, owner, svc, thread)
    assert again.id == first.id
    assert db_session.scalar(select(func.count()).select_from(type(first))) == 1
    _end(db_session, owner, svc, first)
    second = _open(db_session, owner, svc, thread)
    assert (second.day, second.day_no) == (DAYS[1], 2)
    assert db_session.get(PracticeWeek, (thread.id, 1)).status == "open"  # still the same week: opened once
    assert db_session.scalar(select(func.count()).select_from(PracticeWeek)) == 1
    db_session.refresh(plan)
    assert plan.days_opened == 2 and plan.day_cursor == DAYS[1]


def test_data_that_is_not_ready_yet_opens_no_list_and_a_dead_prep_says_to_restart(db_session, owner, svc) -> None:
    from datetime import timedelta

    thread, plan = create_swing_thread(db_session, owner, svc)  # SPY is not prepared yet
    opened = swing.open_next(db_session, owner, svc, thread.id)
    assert opened.day_list is None and opened.restart_prep is False
    plan.prep = {**plan.prep, "updated_at": (NOW - timedelta(minutes=10)).isoformat()}
    db_session.commit()
    opened = swing.open_next(db_session, owner, svc, thread.id)
    assert opened.day_list is None and opened.restart_prep is True
    plan_mod.run_prep(db_session, svc, plan.id)
    assert swing.open_next(db_session, owner, svc, thread.id).day_list is not None


def test_a_closed_or_foreign_or_day_thread_cannot_open_a_day(db_session, owner, svc) -> None:
    from daily_world import make_thread

    thread, _ = ready_thread(db_session, owner, svc)
    day_thread = make_thread(db_session, owner)
    with pytest.raises(ReplayProblem) as caught:
        swing.open_next(db_session, owner, svc, day_thread.id)
    assert caught.value.message == "This is not a swing thread"
    stranger = make_owner(db_session, "stranger@example.com")
    with pytest.raises(threads_mod.ThreadNotFound):
        swing.open_next(db_session, stranger, svc, thread.id)
    threads_mod.close_thread(db_session, owner, thread.id, NOW)
    db_session.commit()
    with pytest.raises(ReplayProblem) as caught:
        swing.open_next(db_session, owner, svc, thread.id)
    assert (caught.value.status, caught.value.message) == (409, threads_mod.CLOSED_THREAD)


def test_the_plan_module_entry_points_dispatch_to_the_swing_thread(db_session, owner, svc) -> None:
    thread, plan = ready_thread(db_session, owner, svc)
    with pytest.raises(ReplayProblem) as caught:  # without the thread id there is no DAY plan to continue
        plan_mod.open_next(db_session, owner, svc)
    assert caught.value.status == 409
    opened = plan_mod.open_next(db_session, owner, svc, thread.id)
    db_session.commit()
    row = opened.day_list
    out = plan_mod.day_list_out(db_session, owner, row.id, svc)
    assert out["kind"] == "swing" and out["plan"]["mode"] == "swing" and out["day_no"] == 1
    assert plan_mod.plan_out(db_session, plan)["current"] == {"id": row.id, "day_no": 1, "status": "listed"}
    plan_mod.patch_day_list(db_session, owner, row.id, svc, watch=["S04"], notes=None, rating=None, fields={"watch"})
    created = plan_mod.start_session(db_session, owner, row.id, "S04", svc)
    assert created.thread_id == thread.id and created.day_list_id == row.id
    ended = plan_mod.end_day(db_session, owner, row.id, svc)
    assert ended.status == "ended" and ended.journal["passed"] == "no"


# -- sessions --------------------------------------------------------------------------------------------------------


def test_a_session_needs_a_focus_name_or_a_hold_and_many_names_are_allowed(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    row = _open(db_session, owner, svc, thread)
    with pytest.raises(ReplayProblem) as caught:
        swing.start_session(db_session, owner, row.id, "S09", svc)
    assert (caught.value.message, caught.value.path, caught.value.status) == (
        "S09 is not a focus name or a practice hold",
        "symbol",
        422,
    )
    first, second = _practice(db_session, owner, svc, row, "S04", "S01")
    assert (first.symbol, second.symbol) == ("S04", "S01") and first.tape_feed == second.tape_feed == "off"
    assert first.thread_id == second.thread_id == thread.id and first.day_list_id == row.id
    spec = first.spec
    assert (spec["window"], spec["session"], spec["interval"], spec["shares"], spec["hideDate"]) == (
        {"from": "09:30", "to": "16:00"},
        "regular",
        "15m",
        100,
        "yes",
    )
    assert spec["plan"] == threads_mod.session_plan(thread)
    db_session.refresh(row)
    assert row.status == "practicing" and pd.Timestamp(row.revealed_through) == et(FIRST_DAY, "09:30")
    again = swing.start_session(db_session, owner, row.id, "S04", svc)  # idempotent per name
    assert again.id == first.id
    # a hold is a session name without a star
    _enter(db_session, thread, world, "S05", "long", 10, FIRST_DAY)
    _end(db_session, owner, svc, row)
    next_row = _open(db_session, owner, svc, thread)
    assert swing.start_session(db_session, owner, next_row.id, "S05", svc).symbol == "S05"


def test_a_second_name_starts_at_the_day_clock_and_the_tape_setting_picks_the_feed(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc, tape="on")
    row = _open(db_session, owner, svc, thread)
    (first,) = _practice(db_session, owner, svc, row, "S04")
    assert first.tape_feed == "sip"  # tape on: the normal probe
    row.revealed_through = et(FIRST_DAY, "11:00")
    db_session.commit()
    plan_mod.patch_day_list(
        db_session, owner, row.id, svc, watch=["S04", "S01"], notes=None, rating=None, fields={"watch"}
    )
    second = swing.start_session(db_session, owner, row.id, "S01", svc)
    assert pd.Timestamp(second.revealed_through) == et(FIRST_DAY, "11:00")


def test_a_day_that_has_ended_takes_no_session(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    row = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))
    with pytest.raises(ReplayProblem) as caught:
        swing.start_session(db_session, owner, row.id, "S04", svc)
    assert caught.value.status == 409


def test_ending_a_day_ends_its_sessions_without_an_auto_exit_or_a_ledger_row(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    row = _open(db_session, owner, svc, thread)
    open_session, round_trip = _practice(db_session, owner, svc, row, "S04", "S01")
    assert session_mod.context(db_session, svc, open_session).swing is True

    def mark(session, seq, kind):
        db_session.add(
            PracticeMark(
                session_id=session.id,
                seq=seq,
                kind=kind,
                at=et(FIRST_DAY, "10:00"),
                price=80.0,
                shares=100,
                trade_no=1,
                source="her",
                created_at=NOW,
            )
        )

    mark(open_session, 1, "long_entry")  # still open when the day ends
    mark(round_trip, 1, "long_entry")
    mark(round_trip, 2, "long_exit")  # a session-keyed ledger row would book this one
    db_session.commit()
    _end(db_session, owner, svc, row)
    for session in (open_session, round_trip):
        db_session.refresh(session)
        assert session.status == "ended" and pd.Timestamp(session.revealed_through) == et(FIRST_DAY, "16:00")
        assert session.journal is not None and session.ended_at is not None
    kinds = db_session.execute(select(PracticeMark.kind).where(PracticeMark.session_id == open_session.id)).scalars()
    assert list(kinds) == ["long_entry"]  # nothing was exited for her
    assert _ledger(db_session, thread) == []  # the day's end credits holds, never session trades
    assert (row.status, pd.Timestamp(row.revealed_through)) == ("ended", et(FIRST_DAY, "16:00"))
    assert row.journal["passed"] == "no"


# -- ending a day, Pass, the ledger ----------------------------------------------------------------------------------


def test_pass_marks_the_holds_at_the_official_close_and_leaves_the_ledger_alone(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S04")
    entry = _enter(db_session, thread, world, "S04", "long", 100, DAYS[0], session=session)
    _end(db_session, owner, svc, day1)
    db_session.refresh(entry)
    assert (float(entry.last_close), entry.last_close_day) == (_raw_close(world, "S04", DAYS[0]), DAYS[0])

    day2 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))  # Pass: no session on Day 2
    db_session.refresh(entry)
    assert (float(entry.last_close), entry.last_close_day) == (_raw_close(world, "S04", DAYS[1]), DAYS[1])
    summary = day2.journal
    assert summary["passed"] == "yes" and summary["entries"] == 0 and summary["exits"] == 0
    assert summary["realized_usd"] == 0 and _ledger(db_session, thread) == []
    assert summary["balance_usd"] == 50_000
    assert [h["symbol"] for h in summary["holds"]] == ["S04"] and summary["holds"][0]["status"] == "open"
    price_change = 100 * (_raw_close(world, "S04", DAYS[1]) - _raw_close(world, "S04", DAYS[0]))
    assert summary["equity_change_usd"] == _approx(price_change)
    assert (day2.status, pd.Timestamp(day2.revealed_through)) == ("ended", et(DAYS[1], "16:00"))
    assert swing.end_day(db_session, owner, day2.id, svc) is day2  # idempotent


def test_a_hold_exited_today_reaches_the_ledger_only_when_the_day_ends(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    session, *_ = _practice(db_session, owner, svc, day1, "S04", "S01")
    sold = _enter(db_session, thread, world, "S04", "long", 100, DAYS[0], session=session)
    kept = _enter(db_session, thread, world, "S01", "long", 50, DAYS[0], session=session)
    _end(db_session, owner, svc, day1)

    day2 = _open(db_session, owner, svc, thread)
    exit_price = _exit(db_session, sold, DAYS[1], world=world)
    assert _ledger(db_session, thread) == []  # exited, but the day is not over: nothing is credited
    assert threads_mod.brief(db_session, thread.id, day2.id)["balance"] == 50_000
    assert threads_mod.brief(db_session, thread.id, day2.id)["today_pnl_usd"] == 0
    assert swing.state(db_session, thread)["holds_open"] == 1

    _end(db_session, owner, svc, day2)
    (entry,) = _ledger(db_session, thread)
    pnl = round(100 * (exit_price - float(sold.entry_price)), 2)
    assert (entry.hold_id, entry.session_id, entry.mark_id, entry.day) == (sold.id, None, None, DAYS[1])
    assert (entry.symbol, entry.side, entry.shares, float(entry.pnl_usd)) == ("S04", "long", 100, pnl)
    assert float(entry.exit_price) == pytest.approx(exit_price, abs=1e-6) and pd.Timestamp(entry.realized_at) == et(
        DAYS[1], "14:01"
    )
    summary = day2.journal
    assert summary["realized_usd"] == pnl and summary["exits"] == 1 and summary["passed"] == "yes"
    assert summary["balance_usd"] == _approx(50_000 + pnl)
    kept_close = _raw_close(world, "S01", DAYS[1])
    open_pnl = round(50 * (kept_close - float(kept.entry_price)), 2)
    assert summary["equity_usd"] == _approx(50_000 + pnl + open_pnl)
    assert threads_mod.brief(db_session, thread.id, day2.id)["today_pnl_usd"] == pnl
    state = swing.state(db_session, thread)
    assert state["holds_open"] == 1 and state["equity_usd"] == _approx(50_000 + pnl + open_pnl)
    assert state["free_cash_usd"] == _approx(50_000 + pnl - 50 * float(kept.entry_price))
    assert holds_mod.pnl(hold_rows.to_hold(sold), exit_price) == pnl
    assert hold_rows.credit(db_session, sold, NOW) is None  # a second credit writes nothing
    views = {h["symbol"]: h for h in summary["holds"]}  # the strip lists what is open and what left today
    assert (
        views["S04"]["status"],
        views["S04"]["pnl_usd"],
        views["S04"]["price_basis"],
        views["S04"]["exit_source"],
    ) == (
        "closed",
        pnl,
        None,
        "her",
    )
    assert (views["S01"]["status"], views["S01"]["price_basis"], views["S01"]["last_close"]) == (
        "open",
        "last",
        kept_close,
    )
    assert (summary["max_open_seen"], summary["entries"]) == (2, 0)


def test_a_gap_day_splits_the_equity_change_into_the_overnight_gap_and_the_rest(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 2)
    day3 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day3, "S01")
    hold = _enter(db_session, thread, world, "S01", "long", 100, DAYS[2], session=session)
    _end(db_session, owner, svc, day3)
    day4 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))  # S01 gaps up 6% on Day 4
    assert DAYS[3] == GAP_UP_DAY
    prior, first = _raw_close(world, "S01", DAYS[2]), journal_mod.fill_price(bar_close(world, "S01", DAYS[3], "09:30"))
    close = _raw_close(world, "S01", DAYS[3])
    gap = round(100 * (first - prior), 2)
    assert gap > 500  # a real 6% gap
    summary = day4.journal
    assert summary["gap_usd"] == gap
    assert summary["equity_change_usd"] == _approx(100 * (close - prior))
    assert summary["intraday_usd"] == _approx(100 * (close - prior) - gap)
    assert summary["unrealized_change_usd"] == summary["equity_change_usd"] and summary["realized_usd"] == 0
    db_session.refresh(hold)
    assert summary["holds"][0]["gap_usd"] == gap


def test_a_short_gains_from_a_gap_down(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 5)
    day6 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day6, "S02")
    _enter(db_session, thread, world, "S02", "short", 100, DAYS[5], session=session)
    _end(db_session, owner, svc, day6)
    day7 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))
    assert DAYS[6] == GAP_DOWN_DAY
    prior, first = _raw_close(world, "S02", DAYS[5]), journal_mod.fill_price(bar_close(world, "S02", DAYS[6], "09:30"))
    assert day7.journal["gap_usd"] == round(-100 * (first - prior), 2) > 600


# -- splits ----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("side", ["long", "short"])
def test_a_two_for_one_split_restates_shares_and_prices_and_leaves_the_pnl_alone(
    db_session, owner, world, svc, side
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 4)
    day5 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day5, "S03")
    price = bar_close(world, "S03", DAYS[4], "10:00")
    stop = price - 2 if side == "long" else price + 2
    hold = _enter(db_session, thread, world, "S03", side, 100, DAYS[4], stop=stop, session=session)
    _end(db_session, owner, svc, day5)
    db_session.refresh(hold)
    before = hold_rows.to_hold(hold)
    assert before.shares == 100 and before.last_close == _raw_close(world, "S03", DAYS[4]) and before.splits == ()

    day6 = _open(db_session, owner, svc, thread)  # the 2-for-1 takes effect on Day 6
    assert day6.day == SPLIT_DAY
    db_session.refresh(hold)
    after = hold_rows.to_hold(hold)
    assert after.shares == 200
    for field in ("entry_price", "stop_at_entry", "stop_price", "last_close"):
        assert getattr(after, field) == pytest.approx(getattr(before, field) / 2, abs=1e-5)
    assert after.splits == ({"day": SPLIT_DAY.isoformat(), "ratio": 2.0, "shares_before": 100, "shares_after": 200},)
    assert holds_mod.pnl(after, after.last_close) == _approx(holds_mod.pnl(before, before.last_close))
    out = swing.day_list_out(db_session, owner, day6.id, svc)
    (view,) = out["holds"]
    assert view["shares"] == 200 and view["price_basis"] == "prior_close" and view["days_held"] == 1
    assert (
        view["split_note"] == f"Split 2-for-1 before today's open · 100 shares are now 200 at {after.last_close:,.2f}"
    )
    assert out["free_cash_usd"] == _approx(50_000 - 200 * after.entry_price)  # the notional is unchanged

    _end(db_session, owner, svc, day6)
    db_session.refresh(hold)
    assert float(hold.last_close) == _raw_close(world, "S03", SPLIT_DAY)  # marked on the new share basis
    assert abs(day6.journal["gap_usd"]) < 2  # the split made no false gap
    other = swing.day_list_out(db_session, owner, day6.id, svc)["holds"][0]
    assert other["split_note"] is None or other["split_note"].startswith("Split 2-for-1")  # ended day: the stored view


def _reverse_split(world, symbol, factor=3.0):
    """`symbol` reverse-splits 1-for-`factor` effective SPLIT_DAY: raw prices jump `factor`x from then on, the adjusted
    series is `factor`x throughout."""
    raw, split = world.raw[symbol].copy(), world.split[symbol].copy()
    prices = ["open", "high", "low", "close"]
    raw.loc[[d >= SPLIT_DAY for d in raw.index], prices] *= factor
    split[prices] *= factor
    world.raw[symbol], world.split[symbol] = raw, split
    minutes = world.minutes[symbol].copy()
    late = [d >= SPLIT_DAY for d in minutes.index.tz_convert("America/New_York").date]
    minutes.loc[late, prices] *= factor
    world.minutes[symbol] = minutes


def test_a_reverse_split_rounds_shares_down_and_a_hold_that_rounds_to_zero_closes_flat(
    db_session, owner, world
) -> None:
    _reverse_split(world, "S06")
    svc = swing_services(world)
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 1)
    day2 = _open(db_session, owner, svc, thread)
    session, *_ = _practice(db_session, owner, svc, day2, "S06", "S07")
    tiny = _enter(db_session, thread, world, "S06", "long", 2, DAYS[1], session=session)
    wide = _enter(db_session, thread, world, "S07", "long", 10, DAYS[1], session=session)
    _end(db_session, owner, svc, day2)
    _pass_days(db_session, owner, svc, thread, 3)
    day6 = _open(db_session, owner, svc, thread)  # S06 reverse-splits 1-for-3 on Day 6
    assert day6.day == SPLIT_DAY
    db_session.refresh(tiny)
    # 2 shares would be 0.67 of a share: the hold closes flat at the open, earning nothing, with no crash
    assert (tiny.status, tiny.exit_source, tiny.exit_day) == ("closed", "auto", SPLIT_DAY)
    assert (tiny.exit_session_id, tiny.exit_mark_id, tiny.shares) == (None, None, 2)
    assert float(tiny.exit_price) == float(tiny.entry_price)
    assert tiny.splits[0]["shares_after"] == 0 and tiny.splits[0]["shares_before"] == 2
    note = swing.day_list_out(db_session, owner, day6.id, svc)["holds"][0]
    assert "round down to 0" in note["split_note"] and note["status"] == "closed" and note["pnl_usd"] == 0
    assert _ledger(db_session, thread) == []  # credited when its exit day ends
    _end(db_session, owner, svc, day6)
    (entry,) = _ledger(db_session, thread)
    assert (entry.hold_id, float(entry.pnl_usd), entry.day) == (tiny.id, 0.0, SPLIT_DAY)
    assert db_session.get(PracticeHold, wide.id).shares == 10  # S07 does not split


def test_a_reverse_split_floors_the_shares_that_remain(db_session, owner, world) -> None:
    _reverse_split(world, "S06")
    svc = swing_services(world)
    thread, _ = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S06")
    hold = _enter(
        db_session, thread, world, "S06", "short", 10, DAYS[0], stop=bar_close(world, "S06", DAYS[0], "10:00") + 3
    )
    before = hold_rows.to_hold(hold)
    _end(db_session, owner, svc, day1)
    _pass_days(db_session, owner, svc, thread, 4)
    _open(db_session, owner, svc, thread)
    db_session.refresh(hold)
    assert (hold.status, hold.shares) == ("open", 3)  # 10 shares / 3, cash in lieu not modeled
    # prices divide by the six-decimal ratio (0.333333), so they sit a millionth above exactly 3x
    assert float(hold.entry_price) == pytest.approx(before.entry_price * 3, rel=1e-5)
    assert float(hold.stop_price) == pytest.approx(before.stop_price * 3, rel=1e-5)
    assert hold.splits[0]["ratio"] == pytest.approx(1 / 3, abs=1e-5)


# -- stops -----------------------------------------------------------------------------------------------------------


def _first_cross(world, symbol, day, stop, *, after="09:30"):
    """The close time (ET HH:MM) of the first regular one-minute bar of `day` after `after` whose low reaches `stop`."""
    frame = world.minutes[symbol]
    bars = frame[(frame.index >= et(day, after)) & (frame.index < et(day, "16:00"))]
    hit = bars[bars["low"] <= stop]
    return (hit.index[0] + MINUTE).tz_convert("America/New_York").strftime("%H:%M")


def test_a_stop_crossed_while_away_is_flagged_once_as_not_watched(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S05")
    hold = _enter(db_session, thread, world, "S05", "long", 100, DAYS[0], stop=118.5, session=session)
    _end(db_session, owner, svc, day1)
    db_session.refresh(hold)
    assert hold.stop_hit_at is None and day1.journal["stop_hits"] == []  # Day 1 stayed above 118.5

    day2 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))  # Pass: crossed while away
    at = _first_cross(world, "S05", DAYS[1], 118.5)
    assert day2.journal["stop_hits"] == [{"symbol": "S05", "at": at, "watched": "no"}]
    db_session.refresh(hold)
    assert hold.stop_hit_at is not None and hold.status == "open"  # a stop never exits
    assert pd.Timestamp(hold.stop_hit_at) == pd.Timestamp(f"{DAYS[1]} {at}", tz="America/New_York")
    day3 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))
    assert day3.journal["stop_hits"] == []  # one flag per stop note
    # a new stop note clears the flag; a hold that stays under it is flagged again when its day passes
    hold_rows.apply(hold, holds_mod.set_stop(hold_rows.to_hold(hold), 118.0))
    db_session.commit()
    day4 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))
    assert [(h["symbol"], h["watched"]) for h in day4.journal["stop_hits"]] == [("S05", "no")]


def test_a_crossing_flagged_in_play_is_watched_and_one_before_the_clock_is_not_scanned_again(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S05")
    hold = _enter(db_session, thread, world, "S05", "long", 100, DAYS[0], stop=118.5, session=session)
    _end(db_session, owner, svc, day1)
    day2 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day2, "S05")
    cross = pd.Timestamp(f"{DAYS[1]} {_first_cross(world, 'S05', DAYS[1], 118.5)}", tz="America/New_York")
    hold_rows.apply(hold, replace(hold_rows.to_hold(hold), stop_hit_at=cross))  # the playhead paused here
    day2.revealed_through = et(DAYS[1], "14:00")  # and she played on to 14:00 before ending the day
    db_session.commit()
    _end(db_session, owner, svc, day2)
    assert day2.journal["stop_hits"] == [
        {"symbol": "S05", "at": cross.tz_convert("America/New_York").strftime("%H:%M"), "watched": "yes"}
    ]
    # the scan starts at the clock: a hold whose stop is first crossed before 14:00 but was never flagged is not found
    # (play pauses at every crossing, so such a crossing cannot exist after a real session; this pins the window)
    day3 = _open(db_session, owner, svc, thread)
    hold_rows.apply(hold, holds_mod.set_stop(hold_rows.to_hold(hold), 117.0))  # crossed early on Day 3
    day3.revealed_through = et(DAYS[2], "16:00")  # the clock is already at the close: nothing is left to scan
    db_session.commit()
    _end(db_session, owner, svc, day3)
    assert day3.journal["stop_hits"] == []


def test_the_day_summary_lists_late_stars_the_stop_free_entries_and_the_most_holds_open_at_once(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    plan_mod.patch_day_list(db_session, owner, day1.id, svc, watch=["S04"], notes=None, rating=None, fields={"watch"})
    swing.start_session(db_session, owner, day1.id, "S04", svc)
    plan_mod.patch_day_list(  # the session is open at 09:30 but nothing has been revealed yet: not late
        db_session, owner, day1.id, svc, watch=["S04", "S05"], notes=None, rating=None, fields={"watch"}
    )
    day1.revealed_through = et(FIRST_DAY, "11:00")  # the clock moved on
    db_session.commit()
    plan_mod.patch_day_list(
        db_session, owner, day1.id, svc, watch=["S04", "S05", "S01"], notes=None, rating=None, fields={"watch"}
    )
    first = _enter(db_session, thread, world, "S04", "long", 10, DAYS[0], hhmm="10:00")
    second = _enter(db_session, thread, world, "S01", "long", 10, DAYS[0], hhmm="12:00")
    _exit(db_session, first, DAYS[0], hhmm="13:00", world=world)  # two were open from 12:00 to 13:00
    third = _enter(db_session, thread, world, "S05", "short", 10, DAYS[0], hhmm="14:00")
    _end(db_session, owner, svc, day1)
    summary = day1.journal
    # S04 was starred before the open and S05 at 09:30 before anything was revealed; S01 only after 11:00
    assert summary["late_stars"] == ["S01"]
    assert (summary["entries"], summary["exits"], summary["max_open_seen"]) == (3, 1, 2)
    assert [h["symbol"] for h in summary["holds"]] == ["S04", "S01", "S05"] and summary["passed"] == "no"
    assert {h["symbol"] for h in summary["holds"] if h["status"] == "open"} == {"S01", "S05"}
    del second, third
    # a hold that left on an earlier day is not "open at once" on a later one
    day2 = _open(db_session, owner, svc, thread)
    _exit(db_session, _hold(db_session, thread, "S01"), DAYS[1], world=world)
    _end(db_session, owner, svc, day2)
    day3 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))
    assert (day3.journal["max_open_seen"], day3.journal["exits"], day3.journal["entries"]) == (1, 0, 0)


def test_a_gap_through_the_stop_is_flagged_at_the_first_bar_of_the_unwatched_day(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 5)
    day6 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day6, "S02")
    hold = _enter(db_session, thread, world, "S02", "long", 100, DAYS[5], stop=87.0, session=session)
    _end(db_session, owner, svc, day6)
    day7 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))  # S02 opens 8% lower on Day 7
    assert DAYS[6] == GAP_DOWN_DAY and bar_close(world, "S02", DAYS[6], "09:30") < 87.0
    assert day7.journal["stop_hits"] == [{"symbol": "S02", "at": "09:31", "watched": "no"}]
    db_session.refresh(hold)
    assert hold.status == "open" and hold.stop_hit_at is not None


# -- weeks -----------------------------------------------------------------------------------------------------------


def test_a_week_closes_once_on_its_last_day_and_a_partial_first_week_is_labelled(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc, firstDay="2026-09-16")  # Wed: Week 1 has 3 days
    days = plan_mod.plan_days(date(2026, 9, 16), 15)
    assert [s.label for s in week_mod.week_spans(days)] == ["Week 1 · 3 days", "Week 2", "Week 3", "Week 4 · 2 days"]
    first = _open(db_session, owner, svc, thread)
    out = swing.day_list_out(db_session, owner, first.id, svc)
    assert (out["week_no"], out["week_label"], out["day_no"], out["of"]) == (1, "Week 1 · 3 days", 1, 15)
    _end(db_session, owner, svc, first)
    _pass_days(db_session, owner, svc, thread, 1)
    week = db_session.get(PracticeWeek, (thread.id, 1))
    assert (week.status, week.closed_at) == ("open", None)
    day3 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))  # Friday: the week's last day
    db_session.refresh(week)
    assert week.status == "closed" and week.closed_at is not None
    assert week.review["week"] == {"week_no": 1, "label": "Week 1 · 3 days", "first_day_no": 1, "last_day_no": 3}
    closed_at = week.closed_at
    assert swing.state(db_session, thread)["next"] == "week_review"
    swing.end_day(db_session, owner, day3.id, svc)  # idempotent: the week is not re-closed
    db_session.refresh(week)
    assert week.closed_at == closed_at

    day4 = _open(db_session, owner, svc, thread)  # Monday: Week 2 opens
    assert swing.state(db_session, thread)["next"] == "day"
    week2 = db_session.get(PracticeWeek, (thread.id, 2))
    assert (week2.status, week2.first_day, week2.last_day) == ("open", date(2026, 9, 21), date(2026, 9, 25))
    assert db_session.scalar(select(func.count()).select_from(PracticeWeek)) == 2
    _end(db_session, owner, svc, day4)
    _pass_days(db_session, owner, svc, thread, 4)  # through Friday 09-25
    db_session.refresh(week2)
    assert week2.status == "closed"
    assert db_session.scalar(select(func.count()).select_from(PracticeWeek).where(PracticeWeek.status == "open")) == 0


def test_the_last_day_exits_every_open_hold_at_its_close_credits_them_and_archives_the_plan(
    db_session, owner, world, svc
) -> None:
    thread, plan = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S04")
    carried = _enter(db_session, thread, world, "S04", "long", 100, DAYS[0], session=session)
    _end(db_session, owner, svc, day1)
    _pass_days(db_session, owner, svc, thread, 13)
    last = _open(db_session, owner, svc, thread)
    assert (last.day, last.day_no) == (DAYS[14], 15)
    (session,) = _practice(db_session, owner, svc, last, "S01")
    late = _enter(db_session, thread, world, "S01", "short", 40, DAYS[14], session=session)
    assert swing.state(db_session, thread)["next"] == "day"
    _end(db_session, owner, svc, last)

    for row in (carried, late):
        db_session.refresh(row)
        close = _raw_close(world, row.symbol, DAYS[14])
        assert (row.status, row.exit_source, row.exit_day, float(row.exit_price)) == ("closed", "auto", DAYS[14], close)
        assert (row.exit_session_id, row.exit_mark_id) == (None, None)
        assert pd.Timestamp(row.exit_at) == et(DAYS[14], "16:00")
    rows = _ledger(db_session, thread)
    assert {r.hold_id for r in rows} == {carried.id, late.id} and all(r.session_id is None for r in rows)
    pnls = [holds_mod.closed_pnl(hold_rows.to_hold(r)) for r in (carried, late)]
    assert sum(float(r.pnl_usd) for r in rows) == _approx(sum(pnls))
    summary = last.journal
    assert summary["exits"] == 2 and summary["entries"] == 1 and summary["realized_usd"] == _approx(sum(pnls))
    assert (
        summary["balance_usd"] == summary["equity_usd"] == _approx(50_000 + sum(pnls)) and summary["max_open_seen"] == 2
    )
    assert [h["status"] for h in summary["holds"]] == ["closed", "closed"]

    db_session.refresh(plan)
    assert plan.status == "archived"
    state = swing.state(db_session, thread)
    assert (state["next"], state["holds_open"], state["days_ended"], state["day_no"]) == ("finished", 0, 15, 15)
    assert state["equity_usd"] == state["free_cash_usd"] == _approx(50_000 + sum(pnls))
    assert [w.status for w in db_session.execute(select(PracticeWeek).order_by(PracticeWeek.week_no)).scalars()] == [
        "closed"
    ] * 3
    again = swing.open_next(db_session, owner, svc, thread.id)  # every day done: no list, the thread reads finished
    assert again.day_list is None and swing.plan_out(db_session, again.plan)["finished"] is True
    assert (
        threads_mod.close_thread(db_session, owner, thread.id, NOW).status == "closed"
    )  # her close: nothing left to do


def test_an_early_close_waits_for_the_open_day_then_exits_at_the_last_ended_close(
    db_session, owner, world, svc
) -> None:
    thread, plan = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S04")
    hold = _enter(db_session, thread, world, "S04", "long", 100, DAYS[0], session=session)
    _end(db_session, owner, svc, day1)
    day2 = _end(db_session, owner, svc, _open(db_session, owner, svc, thread))
    day3 = _open(db_session, owner, svc, thread)
    with pytest.raises(ReplayProblem) as caught:
        threads_mod.close_thread(db_session, owner, thread.id, NOW)
    # 02p b7: a swing thread names the open day's number, not the day thread's sentence.
    assert (caught.value.status, caught.value.message) == (409, "End Day 3 first")
    db_session.rollback()
    db_session.refresh(hold)
    assert hold.status == "open"  # the refusal changed nothing

    _end(db_session, owner, svc, day3)
    closed = threads_mod.close_thread(db_session, owner, thread.id, NOW)
    db_session.commit()
    assert closed.status == "closed"
    db_session.refresh(hold)
    close = _raw_close(world, "S04", DAYS[2])
    assert (hold.status, hold.exit_source, hold.exit_day, float(hold.exit_price)) == ("closed", "auto", DAYS[2], close)
    assert (hold.exit_session_id, hold.exit_mark_id) == (None, None)
    (entry,) = _ledger(db_session, thread)
    assert (entry.hold_id, entry.day) == (hold.id, DAYS[2])
    assert float(entry.pnl_usd) == round(100 * (close - float(hold.entry_price)), 2)
    week = db_session.get(PracticeWeek, (thread.id, 1))
    assert week.status == "closed" and week.last_day == DAYS[2]  # the partial week the thread actually played
    db_session.refresh(plan)
    assert plan.status == "archived"
    assert swing.state(db_session, thread)["next"] == "finished"
    assert threads_mod.close_thread(db_session, owner, thread.id, NOW).status == "closed"  # idempotent
    assert len(_ledger(db_session, thread)) == 1
    del day2


# -- the thread's numbers --------------------------------------------------------------------------------------------


def test_the_ledger_the_closed_holds_and_the_thread_series_agree(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    session, *_ = _practice(db_session, owner, svc, day1, "S04", "S01", "S05")
    a = _enter(db_session, thread, world, "S04", "long", 100, DAYS[0], session=session)
    b = _enter(db_session, thread, world, "S01", "short", 60, DAYS[0], session=session)
    c = _enter(db_session, thread, world, "S05", "long", 20, DAYS[0], session=session)
    _end(db_session, owner, svc, day1)
    day2 = _open(db_session, owner, svc, thread)  # a watched day
    _practice(db_session, owner, svc, day2, "S04")
    _exit(db_session, a, DAYS[1], world=world)
    _end(db_session, owner, svc, day2)
    _pass_days(db_session, owner, svc, thread, 1)  # Day 3 passed: skipped
    day4 = _open(db_session, owner, svc, thread)
    _practice(db_session, owner, svc, day4, "S01")
    _exit(db_session, b, DAYS[3], hhmm="12:00", world=world)
    _end(db_session, owner, svc, day4)

    ledger = _ledger(db_session, thread)
    assert len(ledger) == 2
    closed = [hold_rows.to_hold(h) for h in (a, b)]
    assert sum(float(r.pnl_usd) for r in ledger) == _approx(sum(holds_mod.closed_pnl(h) for h in closed))
    detail = threads_mod.detail(db_session, thread)
    daily = detail["daily"]
    assert [(r["n"], r["kind"], r["trades"]) for r in daily] == [
        (1, "practiced", 0),
        (2, "practiced", 1),
        (3, "skipped", 0),
        (4, "practiced", 1),
    ]
    assert [r["pnl_usd"] for r in daily] == [0, float(ledger[0].pnl_usd), 0, float(ledger[1].pnl_usd)]
    total = 50_000 + sum(float(r.pnl_usd) for r in ledger)
    assert daily[-1]["balance"] == _approx(total) == detail["curve"][-1]["balance"] == detail["thread"].stats.balance
    assert [p["balance"] for p in detail["curve"]][0] == 50_000 and len(detail["curve"]) == 5
    assert (detail["thread"].stats.daysPracticed, detail["thread"].stats.daysSkipped) == (3, 1)
    state = detail["swing"]
    assert [p["day_no"] for p in state["equity_series"]] == [1, 2, 3, 4]
    assert state["equity_series"][-1]["balance_usd"] == _approx(total) and state["holds_open"] == 1
    assert state["equity_series"][-1]["equity_usd"] == state["equity_usd"]
    assert detail["thread"].swing is not None and detail["swing"] == threads_mod.summary(db_session, thread)["swing"]
    # the day series rows read the stored summaries: equity - balance is the open hold's unrealized, never recomputed
    stored = [d.journal for d in threads_mod._ended_days(db_session, thread.id)]
    assert [p["equity_usd"] for p in state["equity_series"]] == [j["equity_usd"] for j in stored]
    del c


def test_a_swing_thread_reads_back_through_the_contract_summary_brief_and_state(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    listed = threads_mod.list_threads(db_session, owner)
    assert len(listed) == 1 and listed[0]["thread"].mode == "swing"
    block = listed[0]["thread"].swing
    assert isinstance(block, SwingSetupV1)
    assert block.model_dump(mode="json", by_alias=True, exclude_none=True) == {
        "firstDay": FIRST_DAY.isoformat(),
        "sessions": 15,
        "hideDates": "yes",
        "universe": [{"symbol": s, "source": SOURCES[s]} for s in SYMBOLS],
        "interval": "15m",
        "tape": "off",
        "armed": [],
    }
    brief = threads_mod.brief(db_session, thread.id)
    assert brief["balance"] == 50_000 and brief["today_pnl_usd"] is None
    assert (brief["equity_usd"], brief["free_cash_usd"], brief["day_no"], brief["days"], brief["week_no"]) == (
        50_000,
        50_000,
        1,
        15,
        1,
    )
    state = swing.state(db_session, thread)
    assert state == {
        "day_no": 1,
        "days": 15,
        "days_ended": 0,
        "week_no": 1,
        "weeks": 3,
        "holds_open": 0,
        "free_cash_usd": 50_000,
        "equity_usd": 50_000,
        "equity_series": [],
        "next": "day",
    }
    day1 = _open(db_session, owner, svc, thread)
    assert threads_mod.brief(db_session, thread.id, day1.id)["today_pnl_usd"] == 0
    assert threads_mod.brief(db_session, thread.id)["today_pnl_usd"] == 0  # a day is under way
    assert threads_mod.summary(db_session, thread)["today"]["day_no"] == 1
    _practice(db_session, owner, svc, day1, "S04")
    _enter(db_session, thread, world, "S04", "long", 100, DAYS[0])
    _end(db_session, owner, svc, day1)
    after = swing.state(db_session, thread)
    assert (after["day_no"], after["days_ended"], after["holds_open"], after["next"]) == (2, 1, 1, "day")
    assert after["free_cash_usd"] < 50_000 and len(after["equity_series"]) == 1
    assert after["equity_series"][0] == {
        "day_no": 1,
        "weekday": "Mon",
        "balance_usd": 50_000,
        "equity_usd": day1.journal["equity_usd"],
    }


def test_the_day_list_out_reads_holds_live_at_the_prior_close_and_serves_the_stored_summary_once_ended(
    db_session, owner, world, svc
) -> None:
    class Report:
        def __init__(self, report_date, report_time):
            self.report_date, self.report_time = report_date, report_time

    chain = type(
        "Chain",
        (),
        {
            "providers": [
                type(
                    "Cal",
                    (),
                    {"earnings_results": lambda self, s, *, now: [Report(DAYS[2], "pre-market")] if s == "S01" else []},
                )()
            ]
        },
    )()
    svc.sources = replace(svc.sources, earnings=chain)
    thread, _ = ready_thread(db_session, owner, svc)
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S01")
    stop = bar_close(world, "S01", DAYS[0], "10:00") - 3
    hold = _enter(db_session, thread, world, "S01", "long", 100, DAYS[0], stop=stop, session=session)
    out = swing.day_list_out(db_session, owner, day1.id, svc)
    assert out["kind"] == "swing" and out["journal"] is None and out["status"] == "practicing"
    (live,) = out["holds"]  # entered today: no close yet, so no prior-close value
    assert (live["last_close"], live["price_basis"], live["days_held"], live["unrealized_usd"]) == (None, None, 1, 0)
    assert out["free_cash_usd"] == _approx(50_000 - 100 * float(hold.entry_price))
    _end(db_session, owner, svc, day1)
    ended = swing.day_list_out(db_session, owner, day1.id, svc)
    assert ended["status"] == "ended" and ended["journal"] == day1.journal and ended["holds"] == day1.journal["holds"]
    assert ended["holds"][0]["price_basis"] == "last"

    day2 = _open(db_session, owner, svc, thread)
    out = swing.day_list_out(db_session, owner, day2.id, svc)
    (view,) = out["holds"]
    close = _raw_close(world, "S01", DAYS[0])
    assert (view["last_close"], view["price_basis"], view["days_held"], view["entry_day_no"]) == (
        close,
        "prior_close",
        1,
        1,
    )
    assert view["unrealized_usd"] == _approx(100 * (close - float(hold.entry_price)))
    assert view["r"] == _approx((close - float(hold.entry_price)) / (float(hold.entry_price) - stop))
    assert view["earnings"] == {"in_sessions": 1, "timing": "before open"}
    assert (view["stop_hit"], view["split_note"], view["entry_weekday"], view["gap_usd"]) == ("no", None, "Mon", None)
    assert (out["day"], out["weekday"], out["day_no"], out["week_label"], out["of"]) == (
        DAYS[1],
        "Tue",
        2,
        "Week 1",
        15,
    )
    assert (
        out["sessions"] == [] and out["watch"] == [] and out["peek"] is None and out["label"] == day2.universe["label"]
    )
    peeked = swing.day_list_out(db_session, owner, day2.id, svc, peek="S01")["peek"]
    assert peeked["daily"][-1]["t"] == DAYS[0] and peeked["levels"]["prior_close"] == pytest.approx(close, abs=0.005)
    with pytest.raises(ReplayProblem) as caught:
        swing.day_list_out(db_session, owner, day2.id, svc, peek="ZZZZ")
    assert caught.value.message == "ZZZZ is not on today's board"
    with pytest.raises(plan_mod.SessionNotFound):
        swing.day_list_out(db_session, make_owner(db_session, "x@example.com"), day2.id, svc)


# -- a day thread and a swing thread side by side --------------------------------------------------------------------


def test_a_day_thread_and_a_swing_thread_run_side_by_side_without_touching_each_other(
    db_session, owner, world, svc
) -> None:
    from daily_world import make_thread
    from test_replay_plan import _block

    day_svc = make_services()
    day_thread = make_thread(db_session, owner)
    day_plan = plan_mod.create_plan(db_session, owner, _block(db_session, owner), day_svc, day_thread)
    plan_mod.run_prep(db_session, day_svc, day_plan.id)
    db_session.commit()
    thread, _ = ready_thread(db_session, owner, svc)

    day_row = plan_mod.open_next(db_session, owner, day_svc).day_list  # her DAY plan, untouched by the swing one
    assert plan_mod.open_next(db_session, owner, day_svc, day_thread.id).day_list.id == day_row.id  # a day thread id
    swing_row = _open(db_session, owner, svc, thread)
    db_session.commit()
    assert day_row.plan_id == day_plan.id and swing_row.plan_id != day_plan.id
    _enter(db_session, thread, world, "S04", "long", 10, DAYS[0])
    _end(db_session, owner, svc, swing_row)
    db_session.refresh(day_row)
    assert day_row.status == "listed" and day_row.journal is None
    assert plan_mod.hub(db_session, owner)["thread"]["thread"].mode == "day"
    assert threads_mod.detail(db_session, day_thread)["thread"].stats.balance == 50_000
    assert plan_mod.active_plan(db_session, owner).id == day_plan.id
    plan_mod.end_day(db_session, owner, day_row.id, day_svc)
    db_session.commit()
    assert _hold(db_session, thread, "S04").status == "open" and _ledger(db_session, thread) == []
    assert threads_mod.active_thread(db_session, owner, "day").id == day_thread.id
    assert threads_mod.close_thread(db_session, owner, day_thread.id, NOW).status == "closed"
    assert swing.open_next(db_session, owner, svc, thread.id).day_list is not None  # the swing thread keeps going


# -- no lookahead across days ----------------------------------------------------------------------------------------


def _scenario(db, label, world, ended_days):
    """Two holds over `ended_days` days; everything a reader serves afterwards, with the row ids taken out."""
    user = make_owner(db, f"{label}@example.com")
    service = swing_services(world)
    thread, _ = ready_thread(db, user, service)
    day1 = _open(db, user, service, thread)
    session, *_ = _practice(db, user, service, day1, "S01", "S04")
    _enter(db, thread, world, "S01", "long", 100, DAYS[0], stop=95.0, session=session)
    short = _enter(db, thread, world, "S04", "short", 50, DAYS[0], session=session)
    _end(db, user, service, day1)
    for index in range(1, ended_days):
        row = _open(db, user, service, thread)
        if index == 1:
            _exit(db, short, DAYS[1], world=world)
        _end(db, user, service, row)
    last = threads_mod._ended_days(db, thread.id)[-1]

    def clean(value):
        if isinstance(value, dict):
            return {
                k: clean(v)
                for k, v in value.items()
                if k not in ("id", "day_list_id", "plan", "created_at", "ended_at", "updated_at", "stamp")
            }
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value

    holds = [
        swing.hold_view(h, plan_mod.plan_days(FIRST_DAY, 15), as_of=last.day) for h in hold_rows.load(db, thread.id)
    ]
    return clean(
        {
            "state": swing.state(db, thread),
            "holds": holds,
            "journal": last.journal,
            "series": threads_mod.detail(db, thread)["daily"],
            "brief": threads_mod.brief(db, thread.id),
            "out": {k: v for k, v in swing.day_list_out(db, user, last.id, service).items() if k != "thread"},
            "ledger": [(r.symbol, float(r.pnl_usd), r.day) for r in _ledger(db, thread)],
        }
    )


@pytest.mark.parametrize("ended_days", [1, 3, 6])
def test_nothing_read_after_a_day_ends_depends_on_a_bar_later_than_that_close(db_session, ended_days) -> None:
    normal = _scenario(db_session, "a", swing_world(), ended_days)
    replaced = _scenario(db_session, "b", scrambled(swing_world(), DAYS[ended_days - 1]), ended_days)
    assert normal == replaced
    assert normal["state"]["days_ended"] == ended_days and len(normal["state"]["equity_series"]) == ended_days


def test_an_open_day_is_marked_at_no_price_the_day_has_not_revealed(db_session, owner, world, svc) -> None:
    """Between Day 2's open and its end the holds and the thread read the Day 1 close: replacing Day 2's bars changes
    nothing a screen shows."""
    snapshots = []
    for label, svc_world in (("a", world), ("b", scrambled(world, DAYS[0]))):
        user = make_owner(db_session, f"{label}@example.com")
        service = swing_services(svc_world)
        thread, _ = ready_thread(db_session, user, service)
        day1 = _open(db_session, user, service, thread)
        (session,) = _practice(db_session, user, service, day1, "S04")
        _enter(db_session, thread, svc_world, "S04", "long", 100, DAYS[0], session=session)
        _end(db_session, user, service, day1)
        day2 = _open(db_session, user, service, thread)
        out = swing.day_list_out(db_session, user, day2.id, service)
        snapshots.append(
            (
                [{k: v for k, v in h.items() if k != "id"} for h in out["holds"]],
                out["free_cash_usd"],
                swing.state(db_session, thread),
            )
        )
    assert snapshots[0] == snapshots[1]


def test_deleting_a_swing_thread_waits_for_the_open_day_then_removes_holds_weeks_days_and_ledger(
    db_session, owner, world, svc
) -> None:
    other, _ = ready_thread(db_session, owner, svc)  # a second swing thread that must survive the delete
    thread, _ = ready_thread(db_session, owner, svc)
    thread_id, other_id = thread.id, other.id
    day1 = _open(db_session, owner, svc, thread)
    (session,) = _practice(db_session, owner, svc, day1, "S04")
    _enter(db_session, thread, world, "S04", "long", 100, DAYS[0], session=session)
    _end(db_session, owner, svc, day1)
    _open(db_session, owner, svc, thread)  # Day 2 is open now
    with pytest.raises(ReplayProblem) as caught:
        threads_mod.delete_thread(db_session, owner, thread_id)
    assert (caught.value.status, caught.value.message) == (409, "End Day 2 first")
    db_session.rollback()
    assert db_session.get(PracticeThread, thread_id) is not None and _hold(db_session, thread, "S04").status == "open"

    day2 = db_session.execute(
        select(ReplayDayList)
        .join(PracticePlan, PracticePlan.id == ReplayDayList.plan_id)
        .where(PracticePlan.thread_id == thread.id, ReplayDayList.status != "ended")
    ).scalar_one()
    _end(db_session, owner, svc, day2)
    threads_mod.delete_thread(db_session, owner, thread_id)  # the hold is still open: it goes with the thread
    db_session.commit()
    assert db_session.get(PracticeThread, thread_id) is None and db_session.get(PracticeThread, other_id) is not None
    for model in (PracticeHold, PracticeWeek, PracticeLedger, PracticePlan, ReplaySession):
        assert (
            db_session.execute(select(func.count()).select_from(model).where(model.thread_id == thread_id)).scalar_one()
            == 0
        )
    assert (
        db_session.execute(select(func.count()).select_from(PracticeMark)).scalar_one() == 0
    )  # cascaded with its session
    assert (
        db_session.execute(select(func.count()).select_from(ReplayDayList)).scalar_one() == 0
    )  # `other` opened no day
