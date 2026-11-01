"""Regression tests for the independent backend review of the swing build (02p, FIX1): an undone exit may not break the
cap or the cash rule, a swing session runs on a half day, the thread's free cash and equity agree with the entry rule
mid-day, an undone stop note keeps a stop that was already crossed from pausing again, and a week is scored under the
plan its days started with. Same world and helpers as the swing play tests. Real Postgres (`scripts/test-db.sh`)."""

from datetime import date
from types import SimpleNamespace

import pandas as pd
import pytest
import swing_world as sw
from bars import trading_days
from daily_world import SyntheticBars, make_services
from swing_world import DAYS, NOW, make_owner, ready_thread, swing_services, swing_world
from test_replay_swing_lifecycle import _end, _enter, _open, _pass_days, _practice
from test_replay_swing_play import _advance, _carry, _day, _dip, _first_cross, _hold, _mark, _rejected, _undo

from ai_trading.contracts.practice_thread import PracticeThreadPatchV1
from ai_trading.core.calendar import et
from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import PracticeMark
from ai_trading.replay import hold_rows, swing, swing_weeks
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod

D1, D2, D3 = DAYS[:3]
UNDO_CASH = "Can't undo that exit · it would leave you without enough practice cash"


@pytest.fixture
def world():
    return swing_world()


@pytest.fixture
def svc(world):
    return swing_services(world)


@pytest.fixture
def owner(db_session) -> int:
    return make_owner(db_session)


# -- I1: undoing an exit re-checks the cash rule ---


def test_undoing_an_exit_that_would_leave_her_without_practice_cash_is_a_409_and_changes_nothing(
    db_session, owner, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc, balance=50_000)
    _, (a, b) = _day(db_session, owner, svc, thread, "S01", "S02")
    _advance(db_session, owner, svc, a, "10:00")
    _mark(db_session, owner, svc, a, "long_entry", shares=450)  # about $45,000 of the $50,000
    exit_ = _mark(db_session, owner, svc, a, "long_exit")  # the cash comes back ...
    _advance(db_session, owner, svc, b, "10:00")  # ... and B, at the same clock, spends it
    _mark(db_session, owner, svc, b, "long_entry", shares=500)
    exit_id = exit_["mark"]["id"]
    problem = _rejected(session_mod.undo_mark, db_session, owner, a.id, exit_id, svc)
    assert (problem.message, problem.path, problem.status) == (UNDO_CASH, "kind", 409)
    hold = _hold(db_session, thread, "S01")
    assert (hold.status, hold.exit_mark_id) == ("closed", exit_id)
    assert db_session.get(PracticeMark, exit_id) is not None


def test_undoing_an_exit_with_other_holds_open_is_accepted_when_the_cash_is_there(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc, balance=50_000)
    row, sessions = _day(db_session, owner, svc, thread, "S01", "S02", "S04", "S05", "S06")
    for s in sessions:
        _advance(db_session, owner, svc, s, "10:00")
        _mark(db_session, owner, svc, s, "long_entry", shares=10)
    exit_ = _mark(db_session, owner, svc, sessions[0], "long_exit")
    plan_mod.patch_day_list(
        db_session, owner, row.id, svc, watch=["S02", "S04", "S05", "S06", "S07"], notes=None, rating=None,
        fields={"watch"},
    )  # fmt: skip
    seventh = swing.start_session(db_session, owner, row.id, "S07", svc)
    db_session.commit()
    _mark(db_session, owner, svc, seventh, "long_entry", shares=10)  # five open again, a sixth with the undo
    out = session_mod.undo_mark(db_session, owner, sessions[0].id, exit_["mark"]["id"], svc)
    assert out["removed_mark_id"] == exit_["mark"]["id"]
    assert len(hold_rows.open_holds(db_session, thread.id)) == 6


# -- I2: a swing session ends at the day's real regular close ---


@pytest.mark.parametrize(("day", "close"), [(date(2025, 11, 26), "16:00"), (date(2025, 11, 28), "13:00")])
def test_the_swing_session_window_ends_at_the_days_regular_close(day, close) -> None:
    plan = SimpleNamespace(spec={"interval": "15m", "armed": [], "hideDates": "yes"})
    thread = SimpleNamespace(
        stop_note_on_entry="no", trade_only_on_signal="no", max_loss_usd=None, max_trades=None, plan_note=None
    )
    spec = swing._session_spec(plan, day, "S01", thread)
    assert spec.model_dump(mode="json", by_alias=True)["window"] == {"from": "09:30", "to": close}


@pytest.fixture
def half_day_world(monkeypatch):
    """The swing world moved to start on Wed 2025-11-26, so Day 2 is the Friday after Thanksgiving (closes at 13:00).
    The generator reads its dates from module globals at call time; its cache is bypassed for the shifted frames."""
    days, cursor = [], date(2025, 11, 26)
    while len(days) < 20:
        if trading_session("stock", cursor) is not None:
            days.append(cursor)
        cursor = date.fromordinal(cursor.toordinal() + 1)
    history = trading_days("stock", days[-1], sw.HISTORY_SESSIONS)
    shifted = {
        "FIRST_DAY": days[0],
        "DAYS": days,
        "HISTORY": history,
        "GAP_UP_DAY": days[3],
        "SPLIT_DAY": days[5],
        "GAP_DOWN_DAY": days[6],
    }
    for name, value in shifted.items():
        monkeypatch.setattr(sw, name, value)
    raw, split, minutes = (dict(frames) for frames in sw._frames.__wrapped__())
    return days, make_services(SyntheticBars(raw, split, minutes))


def test_a_swing_session_starts_and_plays_on_a_half_day_and_the_day_ends_at_13_00(db_session, owner, half_day_world):
    days, svc = half_day_world
    half = days[1]
    assert trading_session("stock", half).regular_close == et(half, "13:00")
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 1)
    row, (session,) = _day(db_session, owner, svc, thread, "S01")
    assert pd.Timestamp(session.window_end) == et(half, "13:00")
    _advance(db_session, owner, svc, session, "12:30", day=half)
    _mark(db_session, owner, svc, session, "long_entry", shares=10)
    out = _advance(db_session, owner, svc, session, "13:00", day=half)
    assert out["at_end"] is True and pd.Timestamp(out["revealed_through"]) == et(half, "13:00")
    _end(db_session, owner, svc, row)
    assert pd.Timestamp(row.revealed_through) == et(half, "13:00")
    following = _open(db_session, owner, svc, thread)  # the next board reads up to the half day's own close
    assert pd.Timestamp(following.data_through) == et(half, "13:00")
    assert _hold(db_session, thread, "S01").last_close_day == half


# -- I3: free cash and equity mid-day ---


def test_mid_day_after_an_exit_free_cash_is_what_the_entry_rule_uses_and_equity_has_not_moved(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc, balance=50_000)
    _carry(db_session, owner, svc, world, thread, "S04", 0, shares=100)  # S04 trends up 1% a day
    db_session.expire_all()
    before = swing.state(db_session, thread)
    hold = _hold(db_session, thread, "S04")
    unrealized = round(100 * (float(hold.last_close) - float(hold.entry_price)), 2)
    assert unrealized > 0 and before["equity_usd"] == round(50_000 + unrealized, 2)
    row, (session,) = _day(db_session, owner, svc, thread, "S04")
    _advance(db_session, owner, svc, session, "10:00", day=D2)
    _mark(db_session, owner, svc, session, "long_exit")
    exited = _hold(db_session, thread, "S04")
    realized = round(100 * (float(exited.exit_price) - float(exited.entry_price)), 2)
    mid = swing.state(db_session, thread)
    assert mid["free_cash_usd"] == round(50_000 + realized, 2)  # the cash the next entry may spend
    assert mid["equity_usd"] == before["equity_usd"]  # still valued at the last close, as the thread's stats are
    assert (mid["holds_open"], before["holds_open"]) == (0, 1)
    assert swing.day_list_out(db_session, owner, row.id, svc)["free_cash_usd"] == mid["free_cash_usd"]
    brief = threads_mod.brief(db_session, thread.id)
    assert (brief["equity_usd"], brief["free_cash_usd"]) == (mid["equity_usd"], mid["free_cash_usd"])
    _end(db_session, owner, svc, row)  # the day's end credits it: the ended numbers are the ledger's
    ended = swing.state(db_session, thread)
    assert ended["free_cash_usd"] == ended["equity_usd"] == round(50_000 + realized, 2)


# -- M2: undoing a stop note recomputes whether the restored stop was already crossed ---


def test_undoing_a_stop_note_keeps_the_restored_stop_from_pausing_again_when_it_was_already_crossed(
    db_session, owner, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 1)
    _, (session,) = _day(db_session, owner, svc, thread, "S05")
    _advance(db_session, owner, svc, session, "09:31", day=D2)
    _mark(db_session, owner, svc, session, "long_entry", stopPrice=118.5)
    crossing = pd.Timestamp(_advance(db_session, owner, svc, session, "16:00", day=D2)["paused"]["at"])
    note = _mark(db_session, owner, svc, session, "stop", stopPrice=117.9)  # a new note re-arms the pause ...
    assert _hold(db_session, thread, "S05").stop_hit_at is None
    _undo(db_session, owner, svc, session, note["mark"]["id"])  # ... taking it back restores the old, crossed stop
    hold = _hold(db_session, thread, "S05")
    assert float(hold.stop_price) == 118.5 and pd.Timestamp(hold.stop_hit_at) == crossing
    assert _advance(db_session, owner, svc, session, "16:00", day=D2)["paused"] is None  # one pause per stop note


def test_undoing_a_stop_note_finds_a_crossing_from_an_earlier_day(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _carry(db_session, owner, svc, world, thread, "S05", 0, shares=10, stop=118.0)  # not crossed on Day 1 (118.8 low)
    row, (session,) = _day(db_session, owner, svc, thread, "S05")
    paused = _advance(db_session, owner, svc, session, "16:00", day=D2)["paused"]  # S05 slides through 118 on Day 2
    assert pd.Timestamp(paused["at"]) == _first_cross(world, "S05", D2, 118.0)
    _end(db_session, owner, svc, row)
    _, (session,) = _day(db_session, owner, svc, thread, "S05")
    _advance(db_session, owner, svc, session, "10:00", day=D3)
    note = _mark(db_session, owner, svc, session, "stop", stopPrice=117.0)
    _undo(db_session, owner, svc, session, note["mark"]["id"])
    hold = _hold(db_session, thread, "S05")
    assert float(hold.stop_price) == 118.0 and pd.Timestamp(hold.stop_hit_at) == pd.Timestamp(paused["at"])
    assert _advance(db_session, owner, svc, session, "16:00", day=D3)["paused"] is None


def test_undoing_a_stop_note_reads_the_earlier_day_on_the_holds_share_basis_after_a_split(
    db_session, owner, world, svc
) -> None:
    _dip(world, "S03", DAYS[4], "14:00", 99.0)  # Day 5, before the 2-for-1 split on Day 6: raw ~100 dips under 99.5
    thread, _ = ready_thread(db_session, owner, svc)
    _carry(db_session, owner, svc, world, thread, "S03", 4, shares=10, stop=99.5)  # the away scan flags the dip
    flagged = pd.Timestamp(_hold(db_session, thread, "S03").stop_hit_at)
    assert flagged == et(DAYS[4], "14:01")
    _, (session,) = _day(db_session, owner, svc, thread, "S03")
    _advance(db_session, owner, svc, session, "10:00", day=DAYS[5])
    note = _mark(db_session, owner, svc, session, "stop", stopPrice=49.0)  # the split halved the stop to 49.75
    assert _hold(db_session, thread, "S03").stop_hit_at is None
    _undo(db_session, owner, svc, session, note["mark"]["id"])
    hold = _hold(db_session, thread, "S03")
    assert float(hold.stop_price) == 49.75 and pd.Timestamp(hold.stop_hit_at) == flagged


# -- M3: a week is scored under the plan its days started with ---


START = DAYS[2]  # Wed: Week 1 has 3 days (Wed to Fri), Week 2 starts on the Monday after


def _patch(**plan):
    body = {"schemaVersion": 1, "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no", **plan}}
    return PracticeThreadPatchV1.model_validate(body)


def _entries_check(db, svc, thread, week_no) -> tuple[bool, bool, str]:
    checks = {c["id"]: c for c in swing_weeks.week_out(db, svc, thread, week_no)["review"]["adherence"]["checks"]}
    check = checks["entries_per_week"]
    return check["applicable"], check["passed"], check["detail"]


def test_a_plan_edit_applies_from_the_next_week_and_the_weeks_own_days_keep_the_plan_they_started_with(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc, firstDay=START.isoformat(), plan={"maxTrades": 1})
    day1 = _open(db_session, owner, svc, thread)
    snapshot = {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no", "maxTrades": 1}
    assert day1.screen["plan"] == snapshot
    _enter(db_session, thread, world, "S04", "long", 10, START, hhmm="10:00")
    _enter(db_session, thread, world, "S05", "long", 10, START, hhmm="10:30")
    threads_mod.patch_thread(db_session, owner, thread.id, _patch(maxTrades=5), NOW)  # Thursday's change of mind
    db_session.commit()
    _end(db_session, owner, svc, day1)
    assert _entries_check(db_session, svc, thread, 1) == (True, False, "2 of 1")  # Week to date: still the Monday plan
    _pass_days(db_session, owner, svc, thread, 2)  # Week 1 freezes on its Friday
    frozen = swing_weeks.week_out(db_session, svc, thread, 1)
    assert frozen["status"] == "closed" and _entries_check(db_session, svc, thread, 1) == (True, False, "2 of 1")

    day4 = _open(db_session, owner, svc, thread)  # Week 2 opens under the edited plan
    assert day4.screen["plan"]["maxTrades"] == 5
    _end(db_session, owner, svc, day4)
    assert _entries_check(db_session, svc, thread, 2) == (True, True, "0 of 5")


def test_a_day_list_without_a_plan_snapshot_scores_its_week_under_the_live_plan(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc, firstDay=START.isoformat(), plan={"maxTrades": 1})
    day1 = _open(db_session, owner, svc, thread)
    _enter(db_session, thread, world, "S04", "long", 10, START, hhmm="10:00")
    _enter(db_session, thread, world, "S05", "long", 10, START, hhmm="10:30")
    day1.screen = {key: value for key, value in day1.screen.items() if key != "plan"}  # a row from before the snapshot
    threads_mod.patch_thread(db_session, owner, thread.id, _patch(maxTrades=5), NOW)
    db_session.commit()
    _end(db_session, owner, svc, day1)
    assert _entries_check(db_session, svc, thread, 1) == (True, True, "2 of 5")


def test_returning_to_a_name_that_fell_behind_the_day_clock_lifts_it_to_the_clock(db_session) -> None:
    """A name opened earlier falls behind the shared clock while she plays another one; `start_session` (the strip's
    switch, Resume, the stop toast's Exit) lifts it, so the next mark is not refused as 'behind the day clock'."""
    svc = swing_services(swing_world())
    owner = make_owner(db_session)
    thread, _ = ready_thread(db_session, owner, svc)
    row = _open(db_session, owner, svc, thread)
    a, b = _practice(db_session, owner, svc, row, "S01", "S02")
    _advance(db_session, owner, svc, a, "10:00", day=DAYS[0])
    _advance(db_session, owner, svc, b, "11:00", day=DAYS[0])  # the clock is 11:00; S01 is still at 10:00
    again = swing.start_session(db_session, owner, row.id, "S01", svc)
    db_session.commit()
    assert again.id == a.id
    assert again.revealed_through == b.revealed_through
    assert _mark(db_session, owner, svc, again, "long_entry", shares=10)["hold"]["symbol"] == "S01"
