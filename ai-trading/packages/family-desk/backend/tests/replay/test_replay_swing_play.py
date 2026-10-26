"""Swing play inside a session (02p b2, b5, a3-a4, d2): the price basis, marks through the practice holds, the stop
pause, the strip and the daily block, and the no-lookahead guarantee across days. Runs on the synthetic swing world
(`tests/swing_world.py`) with a day opened through `swing.open_next` / `swing.start_session`. Real Postgres
(`scripts/test-db.sh`); the history is in memory.

World facts used here: a day runs open to close in a straight line over the regular session with flat one-minute
OHLC (the 09:30 bar's close IS the open), so the price at clock `10:00` is the close of the bar that STARTS at
`09:59`. Because the bars are flat, a stop crossed by the trend alone reads as a `gap` (the bar opened beyond it); the
`cross` kind needs a bar that dips (`_dip`)."""

import functools
import random
import zlib
from dataclasses import replace

import numpy as np
import pandas as pd
import pytest
from ai_trading_common.testing import FakeTrades
from sqlalchemy import select
from swing_world import (
    DAYS,
    GAP_DOWN_DAY,
    NOW,
    SPLIT_DAY,
    SYMBOLS,
    make_owner,
    ready_thread,
    swing_services,
    swing_world,
)
from swing_world import bar_close as raw_bar_close
from test_replay_swing_lifecycle import _end, _open, _pass_days, _practice

from ai_trading.api.schemas.replay import JournalOut, MarkOut
from ai_trading.core.calendar import ET, et
from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import PracticeHold, PracticeLedger, PracticeMark, ReplaySession
from ai_trading.replay import hold_rows, screen, swing
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay.session import ReplayProblem
from ai_trading.replay.tape import Tape

MINUTE = pd.Timedelta(minutes=1)
D1, D2 = DAYS[0], DAYS[1]
DRIVE_DAYS = 10  # two weeks


@pytest.fixture
def world():
    return swing_world()


@pytest.fixture
def svc(world):
    return swing_services(world)


@pytest.fixture
def owner(db_session) -> int:
    return make_owner(db_session)


# -- helpers ---------------------------------------------------------------------------------------------------------


def bar_close(world, symbol, day, hhmm):
    """The close of the one-minute bar that STARTS at `hhmm`, as a practice fill is priced: the whole cent (D-033)."""
    return journal_mod.fill_price(raw_bar_close(world, symbol, day, hhmm))


def off(price, delta):
    return round(price + delta, 6)


def _advance(db, owner, svc, session, hhmm=None, *, day=D1, step=None):
    """`advance` to `hhmm` ET of `day` (or one `step`); committed."""
    out = session_mod.advance(
        db,
        owner,
        session.id,
        svc,
        to=None if hhmm is None else et(day, hhmm).to_pydatetime(),
        step=step,
        interval=None,
        min_size=0,
        min_notional=0,
        max_prints=500,
    )
    db.commit()
    return out


def _mark(db, owner, svc, session, kind, **body):
    """`place_mark` at the session's playhead; committed."""
    out = session_mod.place_mark(db, owner, session.id, svc, {"kind": kind, **body})
    db.commit()
    return out


def _undo(db, owner, svc, session, mark_id):
    out = session_mod.undo_mark(db, owner, session.id, mark_id, svc)
    db.commit()
    return out


def _feed(db, owner, svc, session):
    return session_mod.feed(db, owner, session.id, svc, interval=None)


def _rejected(call, *args, **kwargs) -> ReplayProblem:
    with pytest.raises(ReplayProblem) as caught:
        call(*args, **kwargs)
    return caught.value


def _hold(db, thread, symbol, status=None) -> PracticeHold:
    query = select(PracticeHold).where(PracticeHold.thread_id == thread.id, PracticeHold.symbol == symbol)
    if status is not None:
        query = query.where(PracticeHold.status == status)
    db.expire_all()
    return db.execute(query).scalar_one()


def _ledger(db, thread):
    return list(db.execute(select(PracticeLedger).where(PracticeLedger.thread_id == thread.id)).scalars())


def _day(db, owner, svc, thread, *symbols):
    """Open the thread's next day, star `symbols` and start a session on each: `(day list, [sessions])`."""
    row = _open(db, owner, svc, thread)
    return row, _practice(db, owner, svc, row, *symbols)


def _carry(db, owner, svc, world, thread, symbol, day_index, *, side="long", shares=100, stop=None, hhmm="10:00"):
    """Open days up to `day_index` (earlier ones passed), enter `symbol` at `hhmm` of that day, end it: the hold is
    carried into the next day."""
    _pass_days(db, owner, svc, thread, day_index)
    row, (session,) = _day(db, owner, svc, thread, symbol)
    _advance(db, owner, svc, session, hhmm, day=DAYS[day_index])
    _mark(db, owner, svc, session, f"{side}_entry", shares=shares, **({} if stop is None else {"stopPrice": stop}))
    _end(db, owner, svc, row)
    return _hold(db, thread, symbol)


def _dip(world, symbol, day, hhmm, low):
    """Make the `hhmm` bar of `symbol` on `day` dip to `low` (its other prices stay), in this test's own world copy."""
    frame = world.minutes[symbol].copy()
    frame.loc[et(day, hhmm), "low"] = low
    world.minutes[symbol] = frame


# -- the price basis (a4) --------------------------------------------------------------------------------------------


def test_a_mark_before_the_first_regular_bar_has_closed_is_the_market_not_open_yet(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    for hhmm in (None, "09:30"):  # the playhead starts at 09:30:00
        if hhmm:
            _advance(db_session, owner, svc, session, hhmm)
        problem = _rejected(session_mod.place_mark, db_session, owner, session.id, svc, {"kind": "long_entry"})
        assert (problem.message, problem.path, problem.status) == (
            "Market not open yet · step to the first bar",
            "kind",
            422,
        )
    half = session_mod.advance(
        db_session,
        owner,
        session.id,
        svc,
        to=et(D1, "09:30") + pd.Timedelta(seconds=30),
        step=None,
        interval=None,
        min_size=0,
        min_notional=0,
        max_prints=500,
    )
    assert half["last"] is None  # the first bar has not closed yet
    assert _rejected(session_mod.place_mark, db_session, owner, session.id, svc, {"kind": "stop", "stopPrice": 1}).path
    assert db_session.execute(select(PracticeHold)).first() is None


def test_the_first_markable_price_is_the_open_bars_close_at_09_31_and_a_note_needs_no_price(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    note = _mark(db_session, owner, svc, session, "note", note="watching the open")
    assert note["mark"]["price"] is None and note["hold"] is None and note["open_trade"] is None
    out = _advance(db_session, owner, svc, session, "09:31")
    assert out["last"]["price"] == bar_close(world, "S01", D1, "09:30") and out["last"]["at"] == et(D1, "09:31")
    placed = _mark(db_session, owner, svc, session, "long_entry")
    assert placed["mark"]["price"] == bar_close(world, "S01", D1, "09:30")
    assert placed["warning"] is None  # one-minute closes are never a "quiet tape"


def test_a_premarket_print_never_prices_a_swing_mark_and_the_tape_prices_it_once_the_market_is_open(
    db_session, owner, world, svc
) -> None:
    prints = pd.DataFrame(
        {
            "t": pd.DatetimeIndex(
                [et(D1, "09:29") + pd.Timedelta(seconds=30), et(D1, "09:30") + pd.Timedelta(seconds=2)]
            ),
            "p": [111.11, 100.5],
            "s": [100, 100],
            "x": ["Q", "Q"],
            "c": ["@", "@"],
        }
    )
    sources = replace(svc.sources, trades=FakeTrades({("S01", "sip"): prints}))
    svc.tape = Tape(sources, now=lambda: NOW)
    thread, _ = ready_thread(db_session, owner, svc, tape="on")
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    assert session.tape_feed == "sip"
    _advance(db_session, owner, svc, session, "09:30")  # no regular print yet
    problem = _rejected(session_mod.place_mark, db_session, owner, session.id, svc, {"kind": "long_entry"})
    assert problem.message == "Market not open yet · step to the first bar"  # the 09:29:30 print does not count
    _advance(db_session, owner, svc, session, "09:31")
    placed = _mark(db_session, owner, svc, session, "long_entry")
    assert placed["mark"]["price"] == 100.5  # the opening print, not the 09:30 bar's close
    assert placed["warning"] == "Priced off a print 58 s old · the tape has been quiet"


def test_a_tape_off_thread_never_touches_the_tape_and_serves_an_empty_prints_block(db_session, owner, svc) -> None:
    class NoTape:
        def __getattr__(self, name):
            raise AssertionError(f"the tape was called: {name}")

    svc.tape = NoTape()
    thread, _ = ready_thread(db_session, owner, svc)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    assert session.tape_feed == "off"
    out = _advance(db_session, owner, svc, session, "10:00")
    assert out["prints"] == {
        "feed": "off",
        "rows": [],
        "count": 0,
        "volume": 0,
        "shown": 0,
        "big_print_usd": out["prints"]["big_print_usd"],
        "pace": None,
    }
    assert out["quiet_s"] is None
    _mark(db_session, owner, svc, session, "long_entry")
    assert _feed(db_session, owner, svc, session)["prints"]["feed"] == "off"


def test_a_carried_hold_reads_the_prior_close_until_a_regular_price_is_revealed_and_then_the_last(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    entry = _carry(db_session, owner, svc, world, thread, "S01", 0, shares=100)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    card = session_mod.session_out(session_mod.context(db_session, svc, session))["open_trade"]
    assert card["price_basis"] == "prior_close" and card["last_price"] == float(entry.last_close)
    assert (card["opened_day_no"], card["days_held"], card["gap_usd"], card["trade_no"]) == (1, 2, None, entry.id)
    _advance(db_session, owner, svc, session, "09:31", day=D2)
    card = session_mod.session_out(session_mod.context(db_session, svc, session))["open_trade"]
    first = bar_close(world, "S01", D2, "09:30")
    assert card["price_basis"] == "last" and card["last_price"] == first
    assert card["gap_usd"] == pytest.approx(100 * (first - float(entry.last_close)), abs=0.01)
    assert card["unrealized_usd"] == pytest.approx(100 * (first - float(entry.entry_price)), abs=0.01)
    _advance(db_session, owner, svc, session, "10:00", day=D2)  # later: the gap stays the first price's, the last moves
    card = session_mod.session_out(session_mod.context(db_session, svc, session))["open_trade"]
    assert card["last_price"] == bar_close(world, "S01", D2, "09:59") != first
    assert card["gap_usd"] == pytest.approx(100 * (first - float(entry.last_close)), abs=0.01)
    held = _mark(db_session, owner, svc, session, "note")["hold"]  # the hold card is valued at the revealed price too
    assert held["unrealized_usd"] == pytest.approx(100 * (card["last_price"] - float(entry.entry_price)), abs=0.01)
    assert held["gap_usd"] == card["gap_usd"] and held["price_basis"] == "last"


# -- marks through the holds (b2) ------------------------------------------------------------------------------------


def test_an_entry_creates_the_mark_and_the_hold_and_credits_nothing(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    row, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00")
    price = bar_close(world, "S01", D1, "09:59")
    out = _mark(db_session, owner, svc, session, "long_entry", shares=40, stopPrice=off(price, -1))
    hold = _hold(db_session, thread, "S01")
    assert (hold.side, hold.shares, hold.status, hold.entry_day) == ("long", 40, "open", D1)
    assert float(hold.entry_price) == price and pd.Timestamp(hold.entry_at) == et(D1, "10:00")
    assert (float(hold.stop_at_entry), float(hold.stop_price), hold.stop_hit_at) == (
        off(price, -1),
        off(price, -1),
        None,
    )
    mark = db_session.execute(select(PracticeMark)).scalar_one()
    assert (hold.entry_session_id, hold.entry_mark_id, mark.trade_no) == (session.id, mark.id, hold.id)
    assert (mark.kind, float(mark.price), mark.shares, mark.source) == ("long_entry", price, 40, "her")
    assert out["hold"]["id"] == hold.id and out["hold"]["status"] == "open" and out["hold"]["price_basis"] == "last"
    assert out["hold"]["unrealized_usd"] == 0 and out["hold"]["entry_day_no"] == 1 and out["hold"]["days_held"] == 1
    assert out["open_trade"]["trade_no"] == hold.id and out["open_trade"]["price_basis"] == "last"
    assert _ledger(db_session, thread) == []
    MarkOut.model_validate(out["mark"])
    JournalOut.model_validate(out["journal"])
    assert out["journal"]["totals"]["trades"] == 0  # an open hold is not a trade of this session yet
    assert swing.day_list_out(db_session, owner, row.id, svc)["holds"][0]["id"] == hold.id


def test_a_second_entry_on_a_held_symbol_is_a_422_and_the_sixth_hold_is_a_409(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    row, sessions = _day(db_session, owner, svc, thread, "S01", "S02", "S03", "S04", "S05")
    for session in sessions:
        _advance(db_session, owner, svc, session, "10:00")
        _mark(db_session, owner, svc, session, "long_entry", shares=10)
    problem = _rejected(session_mod.place_mark, db_session, owner, sessions[0].id, svc, {"kind": "short_entry"})
    assert (problem.message, problem.status) == ("Close your open S01 practice hold first", 422)
    plan_mod.patch_day_list(db_session, owner, row.id, svc, watch=["S06"], notes=None, rating=None, fields={"watch"})
    sixth = swing.start_session(db_session, owner, row.id, "S06", svc)
    _advance(db_session, owner, svc, sixth, "10:00")
    problem = _rejected(session_mod.place_mark, db_session, owner, sixth.id, svc, {"kind": "long_entry", "shares": 10})
    assert (problem.message, problem.status) == ("Five practice holds is the most at once", 409)
    assert len(hold_rows.open_holds(db_session, thread.id)) == 5


@pytest.mark.parametrize("side", ["long", "short"])
def test_free_cash_refuses_an_entry_that_costs_more_and_a_short_counts_like_a_long(
    db_session, owner, world, svc, side
) -> None:
    thread, _ = ready_thread(db_session, owner, svc, balance=50_000)
    _, (a, b) = _day(db_session, owner, svc, thread, "S01", "S02")
    _advance(db_session, owner, svc, a, "10:00")
    problem = _rejected(session_mod.place_mark, db_session, owner, a.id, svc, {"kind": f"{side}_entry", "shares": 1000})
    assert (problem.message, problem.path) == ("Not enough practice cash · $50,000 free", "shares")
    price_a = bar_close(world, "S01", D1, "09:59")
    _mark(db_session, owner, svc, a, f"{side}_entry", shares=400)  # about $40,000 tied up, a short's included
    _advance(db_session, owner, svc, b, "10:00")
    free = 50_000 - 400 * price_a
    problem = _rejected(session_mod.place_mark, db_session, owner, b.id, svc, {"kind": "long_entry", "shares": 200})
    assert problem.message == f"Not enough practice cash · ${free:,.0f} free"
    _mark(db_session, owner, svc, b, "long_entry", shares=int(free // bar_close(world, "S02", D1, "09:59")))


def test_an_exit_closes_the_whole_hold_at_the_revealed_price_and_writes_no_ledger_row(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    row, (session,) = _day(db_session, owner, svc, thread, "S04")
    _advance(db_session, owner, svc, session, "10:00")
    _mark(db_session, owner, svc, session, "long_entry", shares=50)
    _advance(db_session, owner, svc, session, "14:00")
    out = _mark(db_session, owner, svc, session, "long_exit")
    hold = _hold(db_session, thread, "S04")
    exit_price = bar_close(world, "S04", D1, "13:59")
    assert (hold.status, hold.exit_source, hold.exit_day, float(hold.exit_price)) == ("closed", "her", D1, exit_price)
    mark = db_session.execute(select(PracticeMark).where(PracticeMark.kind == "long_exit")).scalar_one()
    assert (hold.exit_session_id, hold.exit_mark_id, mark.trade_no) == (session.id, mark.id, hold.id)
    assert pd.Timestamp(hold.exit_at) == et(D1, "14:00")
    assert _ledger(db_session, thread) == []  # the day's end credits it, never the mark
    assert out["open_trade"] is None
    assert (out["hold"]["status"], out["hold"]["exit_source"], out["hold"]["unrealized_usd"]) == ("closed", "her", None)
    pnl = round(50 * (exit_price - bar_close(world, "S04", D1, "09:59")), 2)
    assert out["hold"]["pnl_usd"] == pnl
    totals = out["journal"]["totals"]
    assert (totals["trades"], totals["pnl_usd"]) == (1, pnl) and out["journal"]["trades"][0]["no"] == hold.id
    _end(db_session, owner, svc, row)
    (credit,) = _ledger(db_session, thread)
    assert (credit.hold_id, credit.session_id, credit.mark_id, float(credit.pnl_usd)) == (
        hold.id,
        session.id,
        mark.id,
        pnl,
    )


def test_an_exit_needs_an_open_hold_of_the_same_side_and_a_stop_needs_one_on_the_right_side_of_the_price(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00")
    for kind in ("long_exit", "short_exit"):
        assert _rejected(session_mod.place_mark, db_session, owner, session.id, svc, {"kind": kind}).message == (
            "No open practice hold to exit"
        )
    problem = _rejected(session_mod.place_mark, db_session, owner, session.id, svc, {"kind": "stop", "stopPrice": 90})
    assert problem.message == "Open a practice hold before setting a stop"
    price = bar_close(world, "S01", D1, "09:59")
    problem = _rejected(
        session_mod.place_mark, db_session, owner, session.id, svc, {"kind": "long_entry", "stopPrice": off(price, 1)}
    )
    assert (problem.message, problem.path) == ("A long stop goes below the last price", "stopPrice")
    assert db_session.execute(select(PracticeHold)).first() is None  # a refused entry leaves no hold
    _mark(db_session, owner, svc, session, "long_entry")
    assert _rejected(session_mod.place_mark, db_session, owner, session.id, svc, {"kind": "short_exit"}).status == 422
    problem = _rejected(
        session_mod.place_mark, db_session, owner, session.id, svc, {"kind": "stop", "stopPrice": off(price, 1)}
    )
    assert (problem.message, problem.path) == ("A long stop goes below the last price", "stopPrice")
    short = _rejected(
        session_mod.place_mark, db_session, owner, session.id, svc, {"kind": "short_entry", "stopPrice": off(price, -1)}
    )
    assert short.message == "Close your open S01 practice hold first"


def test_a_stop_mark_moves_the_line_keeps_the_r_basis_and_clears_the_pause_flag(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00")
    price = bar_close(world, "S01", D1, "09:59")
    _mark(db_session, owner, svc, session, "long_entry", stopPrice=off(price, -2))
    hold = _hold(db_session, thread, "S01")
    hold.stop_hit_at = et(D1, "10:00").to_pydatetime()
    db_session.commit()
    out = _mark(db_session, owner, svc, session, "stop", stopPrice=off(price, -1))
    hold = _hold(db_session, thread, "S01")
    assert (float(hold.stop_price), float(hold.stop_at_entry), hold.stop_hit_at) == (
        off(price, -1),
        off(price, -2),
        None,
    )
    assert out["hold"]["stop_price"] == off(price, -1) and out["hold"]["stop_hit"] == "no"
    assert out["open_trade"]["stop_price"] == off(price, -1)
    mark = db_session.execute(select(PracticeMark).where(PracticeMark.kind == "stop")).scalar_one()
    assert mark.trade_no == hold.id and float(mark.stop_price) == off(price, -1)


def test_undoing_an_entry_deletes_the_hold_an_exit_reopens_it_and_a_stop_puts_the_previous_stop_back(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00")
    price = bar_close(world, "S01", D1, "09:59")
    entry = _mark(db_session, owner, svc, session, "long_entry", stopPrice=off(price, -3))
    undone = _undo(db_session, owner, svc, session, entry["mark"]["id"])
    assert undone["hold"] is None and undone["open_trade"] is None and undone["removed_mark_id"] == entry["mark"]["id"]
    assert db_session.execute(select(PracticeHold)).first() is None
    assert db_session.execute(select(PracticeMark)).first() is None

    _mark(db_session, owner, svc, session, "long_entry", stopPrice=off(price, -3))
    _advance(db_session, owner, svc, session, "10:15")
    first = _mark(db_session, owner, svc, session, "stop", stopPrice=off(price, -2))
    _advance(db_session, owner, svc, session, "10:30")
    second = _mark(db_session, owner, svc, session, "stop", stopPrice=off(price, -1))
    hold = _hold(db_session, thread, "S01")
    hold.stop_hit_at = et(D1, "10:30").to_pydatetime()  # flagged: the undo clears it with the stop
    db_session.commit()
    back = _undo(db_session, owner, svc, session, second["mark"]["id"])
    hold = _hold(db_session, thread, "S01")
    assert (float(hold.stop_price), hold.stop_hit_at) == (off(price, -2), None) and back["hold"]["stop_price"] == off(
        price, -2
    )
    assert db_session.get(PracticeMark, second["mark"]["id"]) is None
    _advance(db_session, owner, svc, session, "10:45")
    _mark(db_session, owner, svc, session, "stop", stopPrice=off(price, -1))
    _advance(db_session, owner, svc, session, "11:00")  # a stop mark placed at the playhead: undo before it moves
    out = _mark(db_session, owner, svc, session, "long_exit")
    reopened = _undo(db_session, owner, svc, session, out["mark"]["id"])
    hold = _hold(db_session, thread, "S01")
    assert (hold.status, hold.exit_price, hold.exit_session_id, hold.exit_mark_id) == ("open", None, None, None)
    assert reopened["hold"]["status"] == "open" and reopened["open_trade"]["trade_no"] == hold.id
    assert first["mark"]["id"] != second["mark"]["id"]
    _advance(db_session, owner, svc, session, "11:15")  # the playhead moved: only the last mark, before it moves
    last = db_session.execute(select(PracticeMark).order_by(PracticeMark.seq.desc())).scalars().first()
    problem = _rejected(session_mod.undo_mark, db_session, owner, session.id, last.id, svc)
    assert problem.status == 409


def test_undoing_the_first_stop_of_a_hold_without_an_entry_stop_clears_the_line(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00")
    price = bar_close(world, "S01", D1, "09:59")
    _mark(db_session, owner, svc, session, "long_entry")
    _advance(db_session, owner, svc, session, "10:15")
    stop = _mark(db_session, owner, svc, session, "stop", stopPrice=off(price, -1))
    assert _undo(db_session, owner, svc, session, stop["mark"]["id"])["hold"]["stop_price"] is None
    assert _hold(db_session, thread, "S01").stop_price is None


def test_a_mark_is_sealed_once_another_name_moves_the_day_clock_past_it(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (a, b) = _day(db_session, owner, svc, thread, "S01", "S02")
    _advance(db_session, owner, svc, a, "10:00")
    entry = _mark(db_session, owner, svc, a, "long_entry")
    _advance(db_session, owner, svc, b, "11:00")  # the clock moves on through the other name
    problem = _rejected(session_mod.undo_mark, db_session, owner, a.id, entry["mark"]["id"], svc)
    assert problem.status == 409 and _hold(db_session, thread, "S01").status == "open"
    behind = _rejected(session_mod.place_mark, db_session, owner, a.id, svc, {"kind": "note"})
    assert "behind the day clock" in behind.message


def test_a_carried_hold_exits_in_a_later_session_and_the_session_journal_lists_it(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    entry = _carry(db_session, owner, svc, world, thread, "S01", 0, shares=100)
    row, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "11:00", day=D2)
    out = _mark(db_session, owner, svc, session, "long_exit")
    exit_price = bar_close(world, "S01", D2, "10:59")
    pnl = round(100 * (exit_price - float(entry.entry_price)), 2)
    assert out["hold"]["pnl_usd"] == pnl and out["hold"]["days_held"] == 2 and out["hold"]["entry_day_no"] == 1
    assert out["journal"]["totals"]["pnl_usd"] == pnl
    trade = out["journal"]["trades"][0]
    assert (trade["no"], trade["shares"], trade["exit_source"], trade["on_signal"]) == (entry.id, 100, "her", False)
    assert out["journal"]["adherence"] == {"score_pct": None, "hint": "Scored weekly", "checks": []}
    assert (out["journal"]["signals_vs_trades"], out["journal"]["pnl_series"]) == ([], [])
    hub = session_mod.summary_out(db_session, session)
    assert (hub["trades"], hub["pnl_usd"]) == (1, pnl)  # an active swing session reads the holds closed in it
    _end(db_session, owner, svc, row)
    db_session.refresh(session)
    assert session.journal["totals"]["pnl_usd"] == pnl and session.journal["adherence"]["hint"] == "Scored weekly"
    assert session_mod.summary_out(db_session, session)["trades"] == 1
    assert session_mod.refresh_journal(db_session, owner, session.id, svc) is None
    JournalOut.model_validate(session_mod.session_out(session_mod.context(db_session, svc, session))["journal"])


def test_ending_a_day_never_auto_exits_and_stores_the_swing_journal(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    row, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00")
    _mark(db_session, owner, svc, session, "long_entry")
    _end(db_session, owner, svc, row)
    db_session.refresh(session)
    assert session.status == "ended" and _hold(db_session, thread, "S01").status == "open"
    assert session.journal["totals"]["trades"] == 0 and session.journal["adherence"]["checks"] == []
    kinds = list(db_session.execute(select(PracticeMark.kind)).scalars())
    assert kinds == ["long_entry"] and _ledger(db_session, thread) == []


# -- the stop pause (b5) ---------------------------------------------------------------------------------------------


def _first_cross(world, symbol, day, stop, *, long_=True):
    """The close of the first regular one-minute bar of `day` whose low (long) or high (short) crosses `stop`."""
    frame = world.minutes[symbol]
    regular = frame[(frame.index >= et(day, "09:30")) & (frame.index < et(day, "16:00"))]
    hit = regular[regular["low" if long_ else "high"] <= stop] if long_ else regular[regular["high"] >= stop]
    return hit.index[0] + MINUTE


def test_play_stops_exactly_on_the_bar_that_crossed_the_stop_and_pauses_once_per_stop_note(
    db_session, owner, world, svc
) -> None:
    _dip(world, "S05", D2, "13:20", 117.5)  # S05 slides 1% a day (118.8 to 117.6 on Day 2): one bar dips below 118
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 1)
    row, (session,) = _day(db_session, owner, svc, thread, "S05")
    _advance(db_session, owner, svc, session, "09:31", day=D2)
    _mark(db_session, owner, svc, session, "long_entry", stopPrice=118.0)
    crossing = _first_cross(world, "S05", D2, 118.0)
    assert crossing == et(D2, "13:21")
    out = _advance(db_session, owner, svc, session, "16:00", day=D2)  # a jump to the close lands on the crossing bar
    assert pd.Timestamp(out["revealed_through"]) == crossing and out["at_end"] is False
    paused = out["paused"]
    assert (paused["symbol"], paused["stop_price"], paused["kind"], paused["also"]) == ("S05", 118.0, "cross", [])
    assert paused["at"] == crossing and paused["price"] == bar_close(world, "S05", D2, "13:20")
    hold = _hold(db_session, thread, "S05")
    assert pd.Timestamp(hold.stop_hit_at) == crossing
    db_session.refresh(row)
    assert pd.Timestamp(row.revealed_through) == crossing  # the day clock stops with the playhead
    assert pd.Timestamp(db_session.get(ReplaySession, session.id).revealed_through) == crossing
    assert all(pd.Timestamp(b["t"]) + MINUTE <= crossing for b in out["bars"])
    again = _advance(db_session, owner, svc, session, "16:00", day=D2)  # one pause per stop note
    assert again["paused"] is None and pd.Timestamp(again["revealed_through"]) == et(D2, "16:00")
    assert again["at_end"] is True


def test_a_new_stop_note_arms_the_pause_again(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 1)
    _, (session,) = _day(db_session, owner, svc, thread, "S05")
    _advance(db_session, owner, svc, session, "09:31", day=D2)
    _mark(db_session, owner, svc, session, "long_entry", stopPrice=118.5)
    first = _advance(db_session, owner, svc, session, "16:00", day=D2)
    assert first["paused"]["stop_price"] == 118.5
    _mark(db_session, owner, svc, session, "stop", stopPrice=117.9)  # lower: below the price at the pause, a new note
    assert _hold(db_session, thread, "S05").stop_hit_at is None
    second = _advance(db_session, owner, svc, session, "16:00", day=D2)
    assert second["paused"]["stop_price"] == 117.9
    assert pd.Timestamp(second["paused"]["at"]) == _first_cross(world, "S05", D2, 117.9)
    assert pd.Timestamp(second["paused"]["at"]) > pd.Timestamp(first["paused"]["at"])


def test_a_gap_open_through_the_stop_pauses_at_09_31_at_the_opening_price(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    entry = _carry(db_session, owner, svc, world, thread, "S02", 5, stop=88.0)  # S02 gaps down 8% on Day 7
    prior = float(entry.entry_price)
    assert prior > 88.0
    _, (session,) = _day(db_session, owner, svc, thread, "S02")  # a hold is a valid name to start
    out = _advance(db_session, owner, svc, session, "10:00", day=GAP_DOWN_DAY)
    open_ = bar_close(world, "S02", GAP_DOWN_DAY, "09:30")
    assert open_ < 88.0
    paused = out["paused"]
    assert paused["kind"] == "gap" and paused["price"] == open_ and paused["stop_price"] == 88.0
    assert paused["at"] == et(GAP_DOWN_DAY, "09:31") == pd.Timestamp(out["revealed_through"])
    assert pd.Timestamp(_hold(db_session, thread, "S02").stop_hit_at) == et(GAP_DOWN_DAY, "09:31")


def test_two_holds_crossed_in_the_same_minute_make_one_pause_that_lists_the_other(
    db_session, owner, world, svc
) -> None:
    _dip(world, "S06", D2, "11:00", 50.0)
    _dip(world, "S07", D2, "11:00", 60.0)
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 1)
    _, (a, b, c) = _day(db_session, owner, svc, thread, "S06", "S07", "S08")
    for session, stop in ((a, 55.0), (b, 65.0), (c, 5.0)):
        _advance(db_session, owner, svc, session, "09:31", day=D2)
        _mark(db_session, owner, svc, session, "long_entry", shares=10, stopPrice=stop)
    out = _advance(db_session, owner, svc, c, "16:00", day=D2)  # advancing the THIRD name still pauses for the others
    assert pd.Timestamp(out["revealed_through"]) == et(D2, "11:01")
    assert (out["paused"]["symbol"], out["paused"]["also"], out["paused"]["kind"]) == ("S06", ["S07"], "cross")
    for symbol, flagged in (("S06", True), ("S07", True), ("S08", False)):
        assert (_hold(db_session, thread, symbol).stop_hit_at is not None) is flagged
    strip = {r["symbol"]: r for r in out["strip"]}
    assert strip["S06"]["hold"]["stopped"] == "yes" and strip["S08"]["hold"]["stopped"] == "no"


def test_a_step_clamps_to_a_crossing_inside_the_bar_and_next_signal_is_just_another_target(
    db_session, owner, world, svc
) -> None:
    _dip(world, "S06", D2, "10:07", 50.0)
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 1)
    _, (session,) = _day(db_session, owner, svc, thread, "S06")
    _advance(db_session, owner, svc, session, "10:00", day=D2)
    _mark(db_session, owner, svc, session, "long_entry", shares=10, stopPrice=55.0)
    out = _advance(db_session, owner, svc, session, step="bar")  # the 10:15 boundary is past the 10:07 bar
    assert pd.Timestamp(out["revealed_through"]) == et(D2, "10:08") and out["paused"]["symbol"] == "S06"
    out = _advance(db_session, owner, svc, session, step="bar")  # not paused again: the next boundary
    assert pd.Timestamp(out["revealed_through"]) == et(D2, "10:15") and out["paused"] is None
    problem = _rejected(
        session_mod.advance,
        db_session,
        owner,
        session.id,
        svc,
        to=None,
        step="next_signal",
        interval=None,
        min_size=0,
        min_notional=0,
        max_prints=500,
    )
    assert problem.message == "No more signals in this session"


def test_a_stop_set_after_the_minute_it_would_have_crossed_is_not_a_crossing_and_no_stop_means_no_pause(
    db_session, owner, world, svc
) -> None:
    _dip(world, "S06", D2, "10:07", 50.0)
    thread, _ = ready_thread(db_session, owner, svc)
    _pass_days(db_session, owner, svc, thread, 1)
    _, (a, b) = _day(db_session, owner, svc, thread, "S06", "S07")
    _advance(db_session, owner, svc, a, "09:31", day=D2)
    _mark(db_session, owner, svc, a, "long_entry", shares=10)  # no stop: nothing to cross
    out = _advance(db_session, owner, svc, a, "10:30", day=D2)
    assert out["paused"] is None
    _mark(db_session, owner, svc, a, "stop", stopPrice=55.0)  # the dip is already behind the clock
    out = _advance(db_session, owner, svc, b, "16:00", day=D2)
    assert out["paused"] is None and pd.Timestamp(out["revealed_through"]) == et(D2, "16:00")


# -- the strip and the daily block (d2, a3 rule 4) -------------------------------------------------------------------


def test_the_strip_lists_holds_then_focus_names_with_data_at_the_day_clock_only(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    row, (a, b) = _day(db_session, owner, svc, thread, "S01", "S04")
    first = _advance(db_session, owner, svc, a, "09:30")
    assert [(r["symbol"], r["source"], r["last"], r["chg_pct"]) for r in first["strip"]] == [
        ("S01", "focus", None, None),
        ("S04", "focus", None, None),
    ]
    _advance(db_session, owner, svc, a, "10:00")
    _mark(db_session, owner, svc, a, "short_entry", shares=10, stopPrice=110)
    out = _advance(db_session, owner, svc, a, "11:00")
    assert [(r["symbol"], r["source"]) for r in out["strip"]] == [("S01", "hold"), ("S04", "focus")]
    hold_row, focus_row = out["strip"]
    last = bar_close(world, "S01", D1, "10:59")
    assert hold_row["last"] == last  # b never advanced: the strip reads the day clock, not its playhead
    entry = bar_close(world, "S01", D1, "09:59")
    assert hold_row["hold"] == {
        "side": "short",
        "shares": 10,
        "unrealized_usd": round(10 * (entry - last), 2),
        "stop_price": 110.0,
        "stop_distance_pct": round((110 - last) / last * 100, 2),
        "stopped": "no",
    }
    assert focus_row["last"] == bar_close(world, "S04", D1, "10:59") and focus_row["hold"] is None
    asof = screen.asof_loader(svc.history, svc.store_factory(db_session), D1)("S04")
    assert focus_row["chg_pct"] == round((focus_row["last"] / float(asof["close"].iloc[-1]) - 1) * 100, 2)
    assert len(out["strip"]) <= 10
    assert session_mod.feed(db_session, owner, b.id, svc, interval=None)["strip"] == out["strip"]
    db_session.refresh(row)


def test_the_strip_lists_the_holds_in_entry_order_before_the_focus_names(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (focus, early, late) = _day(db_session, owner, svc, thread, "S02", "S04", "S01")
    _advance(db_session, owner, svc, early, "10:00")
    _mark(db_session, owner, svc, early, "long_entry", shares=10)
    _advance(db_session, owner, svc, late, "10:15")
    _mark(db_session, owner, svc, late, "short_entry", shares=10)
    strip = _advance(db_session, owner, svc, focus, "10:30")["strip"]
    assert [(r["symbol"], r["source"]) for r in strip] == [("S04", "hold"), ("S01", "hold"), ("S02", "focus")]


def test_a_tape_off_mark_between_bars_carries_no_quiet_tape_warning(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    out = session_mod.advance(
        db_session,
        owner,
        session.id,
        svc,
        to=et(D1, "10:00") + pd.Timedelta(seconds=45),
        step=None,
        interval=None,
        min_size=0,
        min_notional=0,
        max_prints=500,
    )
    assert out["last"]["age_s"] == 45 and out["quiet_s"] is None
    assert _mark(db_session, owner, svc, session, "long_entry")["warning"] is None  # a one-minute close is not a print


def test_the_strip_measures_a_carried_hold_against_its_restated_prior_close_after_a_split(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _carry(db_session, owner, svc, world, thread, "S03", 4, shares=100)  # S03 splits 2-for-1 on Day 6
    _, (session,) = _day(db_session, owner, svc, thread, "S03")
    out = _advance(db_session, owner, svc, session, "10:00", day=SPLIT_DAY)
    (row,) = out["strip"]
    hold = _hold(db_session, thread, "S03")
    assert hold.shares == 200 and float(hold.last_close) == pytest.approx(50.0, rel=0.02)  # restated, not the raw 100
    assert abs(row["chg_pct"]) < 2  # the raw prior close would read -50%
    assert out["levels"]["prior_close"] == float(hold.last_close)
    raw_prior = float(world.raw["S03"].loc[DAYS[4], "close"])
    assert raw_prior == pytest.approx(100.0, rel=0.02) and out["levels"]["prior_close"] != raw_prior


def test_the_daily_block_is_the_rebased_frame_through_the_prior_close_plus_the_forming_candle(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    entry = _carry(db_session, owner, svc, world, thread, "S01", 0, shares=100, stop=95.0)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00", day=D2)
    daily = _feed(db_session, owner, svc, session)["daily"]
    assert 0 < len(daily["bars"]) <= 120
    assert max(b["t"] for b in daily["bars"]) == D1 and all(b["t"] < D2 for b in daily["bars"])  # no bar dated Day 2
    asof = screen.asof_loader(svc.history, svc.store_factory(db_session), D2)("S01")
    assert [b["c"] for b in daily["bars"]] == [float(c) for c in asof["close"].tail(120)]
    minutes = world.minutes["S01"].loc[et(D2, "09:30") : et(D2, "09:59")]  # closed by 10:00
    assert daily["forming"] == {
        "t": D2,
        "o": round(float(minutes["open"].iloc[0]), 6),
        "h": round(float(minutes["high"].max()), 6),
        "l": round(float(minutes["low"].min()), 6),
        "c": round(float(minutes["close"].iloc[-1]), 6),
        "v": float(minutes["volume"].sum()),
    }
    assert daily["holds"] == [
        {"entry_t": D1, "side": "long", "entry_price": float(entry.entry_price), "stop_price": 95.0}
    ]
    out = _advance(db_session, owner, svc, session, "10:15", day=D2)
    assert out["daily_forming"]["t"] == D2 and out["daily_forming"]["v"] == 1000.0 * 45
    _mark(db_session, owner, svc, session, "long_exit")
    assert _feed(db_session, owner, svc, session)["daily"]["holds"] == []  # no open hold, no marker


def test_before_the_first_bar_closes_there_is_no_forming_candle_and_no_pause(db_session, owner, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    out = _advance(db_session, owner, svc, session, "09:30")
    assert out["daily_forming"] is None and out["paused"] is None
    assert _feed(db_session, owner, svc, session)["daily"]["forming"] is None
    assert {"paused", "strip", "daily_forming"} <= set(out)


def test_a_split_morning_shows_the_restated_hold_on_the_card_and_in_the_note_response(
    db_session, owner, world, svc
) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    _carry(db_session, owner, svc, world, thread, "S03", 4, shares=100)
    _, (session,) = _day(db_session, owner, svc, thread, "S03")
    _advance(db_session, owner, svc, session, "09:31", day=SPLIT_DAY)
    out = _mark(db_session, owner, svc, session, "note", note="split morning")
    hold = out["hold"]
    assert hold["shares"] == 200 and hold["entry_price"] == pytest.approx(50.0, rel=0.02)
    assert hold["split_note"].startswith("Split 2-for-1 before today's open · 100 shares are now 200 at ")
    assert hold["last_close"] == pytest.approx(50.0, rel=0.02) and hold["price_basis"] == "last"
    assert abs(hold["gap_usd"]) < 200  # the open is within a percent of the restated prior close (200 shares)
    card = out["open_trade"]
    assert (card["shares"], card["opened_day_no"], card["days_held"]) == (200, 5, 2)
    assert out["mark"]["price"] is None and out["mark"]["trade_no"] is None


def test_a_hold_out_response_has_the_keys_of_the_wire_shape(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    row, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00")
    out = _mark(db_session, owner, svc, session, "long_entry", stopPrice=95.0)
    assert set(out["hold"]) == set(swing.hold_view(_hold(db_session, thread, "S01"), DAYS, as_of=D1))
    assert out["hold"]["stop_at_entry"] == 95.0 and out["hold"]["stop_price"] == 95.0


# -- no lookahead across days (02p k) --------------------------------------------------------------------------------


@functools.cache
def _regular_close(day):
    return trading_session("stock", day).regular_close


def _poisoned(world, ts: pd.Timestamp):
    """`world` with every bar that closes after `ts` replaced by garbage: the one-minute bars of the rest of that day
    and of every later day, and the daily bars of the days that have not closed by `ts` (scaled by one factor per
    symbol and day in the raw and the split series alike, so a day's split ratios, known before its open, survive)."""

    def factor(symbol: str, day) -> float:
        return 0.3 + (zlib.crc32(f"{symbol}{day}".encode()) % 1000) / 1000

    daily = {}
    for source, frames in (("raw", world.raw), ("split", world.split)):
        daily[source] = {
            symbol: frame.mul(
                pd.Series(
                    [1.0 if _regular_close(d) <= ts else factor(symbol, d) for d in frame.index], index=frame.index
                ),
                axis=0,
            )
            for symbol, frame in frames.items()
        }
    minutes = {}
    for symbol, frame in world.minutes.items():
        codes, days = pd.factorize(frame.index.tz_convert(ET).date)
        scales = np.array([factor(symbol, d) for d in days])[codes]
        minutes[symbol] = frame.mul(np.where(frame.index + MINUTE > ts, scales, 1.0), axis=0)
    return type(world)(daily["raw"], daily["split"], minutes)


def _same(a, b, path="") -> None:
    """Deep equality with a tolerance for floats (the poisoned world serves unrounded first reads)."""
    if isinstance(a, dict):
        assert a.keys() == b.keys(), path
        for key in a:
            _same(a[key], b[key], f"{path}.{key}")
    elif isinstance(a, list | tuple):
        assert len(a) == len(b), path
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            _same(x, y, f"{path}[{i}]")
    elif isinstance(a, float):
        assert a == pytest.approx(b, abs=1e-4), path
    else:
        assert a == b, path


def _clock(db, row):
    db.refresh(row)
    return None if row.revealed_through is None else pd.Timestamp(row.revealed_through)


class _Drive:
    """A seeded random walk over a swing thread's days: advances, switches, marks (entries, exits, stops, undos, notes),
    End days and Passes. `check` runs after every step."""

    def __init__(self, db, owner, svc, world, thread, seed):
        self.db, self.owner, self.svc, self.world, self.thread = db, owner, svc, world, thread
        self.rng = random.Random(seed)
        self.stats = dict.fromkeys(("steps", "entries", "exits", "stops", "undos", "pauses", "rejected", "passes"), 0)
        self.reasons: dict[str, int] = {}
        self._poison: dict[pd.Timestamp, object] = {}

    # -- one day ----------------------------------------------------------------------------------------------------

    def play(self, number: int) -> None:
        db, owner, svc, rng = self.db, self.owner, self.svc, self.rng
        row = _open(db, owner, svc, self.thread)
        assert row.day == DAYS[number]
        previous_clock = None
        if rng.random() < 0.2:
            self.stats["passes"] += 1
            _end(db, owner, svc, row)
            self.after_end(row)
            return
        stars = list(dict.fromkeys([rng.choice(["S04", "S05", *SYMBOLS]), *rng.sample(SYMBOLS, rng.randint(0, 3))]))
        plan_mod.patch_day_list(db, owner, row.id, svc, watch=stars, notes=None, rating=None, fields={"watch"})
        held = [h.symbol for h in hold_rows.open_holds(db, self.thread.id)]
        sessions = {}
        for symbol in dict.fromkeys([*held[:2], stars[0]]):
            sessions[symbol] = swing.start_session(db, owner, row.id, symbol, svc)
        db.commit()
        for _ in range(rng.randint(5, 11)):
            self.stats["steps"] += 1
            op = rng.choices(["advance", "switch", "mark", "late_star"], [4, 1, 5, 1])[0]
            if op == "advance":
                self.advance(row, sessions)
            elif op == "switch":
                candidates = [s for s in dict.fromkeys([*stars, *held]) if s not in sessions]
                if candidates:
                    symbol = rng.choice(candidates)
                    sessions[symbol] = swing.start_session(db, owner, row.id, symbol, svc)
                    db.commit()
            elif op == "late_star":
                more = list(dict.fromkeys([*stars, rng.choice(SYMBOLS)]))[:5]
                plan_mod.patch_day_list(db, owner, row.id, svc, watch=more, notes=None, rating=None, fields={"watch"})
                db.commit()
                stars = more
            else:
                self.mark(row, sessions)
            clock = _clock(db, row)
            assert previous_clock is None or clock >= previous_clock  # the day clock never decreases
            previous_clock = clock
            self.check(row, sessions)
        _end(db, owner, svc, row)
        self.after_end(row)
        problem = _rejected(swing.start_session, db, owner, row.id, rng.choice(SYMBOLS), svc)
        assert problem.status == 409  # an ended day takes no second attempt

    # -- steps ------------------------------------------------------------------------------------------------------

    def advance(self, row, sessions) -> None:
        db, owner, svc, rng = self.db, self.owner, self.svc, self.rng
        session = rng.choice(list(sessions.values()))
        clock = _clock(db, row) or et(row.day, "09:30")
        if rng.random() < 0.3:
            out = _advance(db, owner, svc, session, step="bar", day=row.day)
        else:
            to = clock + pd.Timedelta(minutes=rng.choice([1, 2, 7, 15, 45, 90, 400]))
            out = session_mod.advance(
                db, owner, session.id, svc, to=to.to_pydatetime(), step=None, interval=None,
                min_size=0, min_notional=0, max_prints=500,
            )  # fmt: skip
            db.commit()
        self.stats["pauses"] += out["paused"] is not None
        if out["paused"] is not None:  # the playhead stopped exactly on the crossing bar
            assert pd.Timestamp(out["revealed_through"]) == pd.Timestamp(out["paused"]["at"])

    def mark(self, row, sessions) -> None:
        db, owner, svc, rng = self.db, self.owner, self.svc, self.rng
        symbol = rng.choice(list(sessions))
        session = sessions[symbol]
        clock = _clock(db, row) or et(row.day, "09:30")
        caught = session_mod.advance(  # catch the name up to the clock first: a name behind it cannot be marked
            db, owner, session.id, svc, to=clock.to_pydatetime(), step=None, interval=None,
            min_size=0, min_notional=0, max_prints=500,
        )  # fmt: skip
        db.commit()
        price = None if caught["last"] is None else caught["last"]["price"]
        mine = next((h for h in hold_rows.open_holds(db, self.thread.id) if h.symbol == symbol), None)
        if mine is None:
            long_ = rng.random() < {"S04": 0.2, "S05": 0.8}.get(
                symbol, 0.6
            )  # S04 climbs and S05 slides: their stops cross
            body = {"kind": "long_entry" if long_ else "short_entry", "shares": rng.choice([5, 10, 25])}
            if price is not None and rng.random() < 0.6:
                body["stopPrice"] = round(price * (1 - 0.0004 if long_ else 1 + 0.0004), 2)
            kind = "entries"
        else:
            roll = rng.random()
            if roll < 0.3:
                body, kind = {"kind": f"{mine.side}_exit"}, "exits"
            elif roll < 0.7 and price is not None:
                near = 1 - 0.0004 if mine.side == "long" else 1 + 0.0004
                body, kind = {"kind": "stop", "stopPrice": round(price * near, 2)}, "stops"
            elif roll < 0.85:
                body, kind = {"kind": "note", "note": "x"}, None
            else:
                last = session_mod.context(db, svc, session).marks
                if not last:
                    return
                try:
                    _undo(db, owner, svc, session, last[-1].id)
                    self.stats["undos"] += 1
                except ReplayProblem:
                    db.rollback()
                    self.stats["rejected"] += 1
                return
        try:
            _mark(db, owner, svc, session, **body)
            if kind:
                self.stats[kind] += 1
        except ReplayProblem as exc:
            db.rollback()
            self.stats["rejected"] += 1
            self.reasons[exc.message] = self.reasons.get(exc.message, 0) + 1

    # -- the invariants -----------------------------------------------------------------------------------------------

    def check(self, row, sessions) -> None:
        db, owner, svc, world = self.db, self.owner, self.svc, self.world
        clock = _clock(db, row)
        day = row.day
        if clock is None:
            return
        poisoned = self.poisoned(clock)
        for session in sessions.values():
            true = _feed(db, owner, svc, session)
            _same(true, _feed(db, owner, poisoned, session))  # nothing past the clock reaches any read
            assert (
                max((b["t"] for b in true["daily"]["bars"]), default=None) is None
                or max(b["t"] for b in true["daily"]["bars"]) < day
            )  # no daily bar dated today or later
            assert pd.Timestamp(true["revealed_through"]) <= clock
            for strip_row in true["strip"]:  # independent of the code under test: the world's own bars
                frame = world.minutes[strip_row["symbol"]]
                closed = frame[(frame.index >= et(day, "09:30")) & (frame.index + MINUTE <= clock)]
                expected = None if closed.empty else journal_mod.fill_price(float(closed["close"].iloc[-1]))
                assert strip_row["last"] == (None if expected is None else pytest.approx(expected, abs=1e-6))
            forming = true["daily"]["forming"]
            if forming is not None:
                assert forming["t"] == day and forming["v"] <= 1000.0 * 390
        peek = self.rng.choice(SYMBOLS)
        board = swing.day_list_out(db, owner, row.id, svc, peek=peek)
        _same(board, swing.day_list_out(db, owner, row.id, poisoned, peek=peek))
        assert board["peek"]["daily"][-1]["t"] < day  # the board's chart ends at the prior session
        for hold in db.execute(select(PracticeHold).where(PracticeHold.thread_id == self.thread.id)).scalars():
            if hold.status == "open":
                assert hold.last_close_day is None or hold.last_close_day < day  # valued at no close of today or later
            for stamp in (hold.stop_hit_at, hold.exit_at if hold.exit_day == day else None):
                assert stamp is None or pd.Timestamp(stamp) <= clock or hold.entry_day < day
            if hold.entry_day == day:
                assert pd.Timestamp(hold.entry_at) <= clock
        counts = db.execute(
            select(ReplaySession.day_list_id, ReplaySession.symbol, ReplaySession.attempt).where(
                ReplaySession.thread_id == self.thread.id
            )
        ).all()
        assert len(counts) == len(set(counts)) == len({(d, s) for d, s, _ in counts})  # one attempt per name per day
        assert {attempt for _, _, attempt in counts} == {1}

    def poisoned(self, ts: pd.Timestamp):
        """Services over the world with everything after `ts` replaced (kept per reading: many steps share one)."""
        if ts not in self._poison:
            self._poison[ts] = swing_services(_poisoned(self.world, ts))
        return self._poison[ts]

    def after_end(self, row) -> None:
        """The ended day and the thread's reads depend on nothing past that day's close."""
        db, owner, svc = self.db, self.owner, self.svc
        close = pd.Timestamp(et(row.day, "16:00"))
        poisoned = self.poisoned(close)
        _same(swing.day_list_out(db, owner, row.id, svc), swing.day_list_out(db, owner, row.id, poisoned))
        _same(swing.state(db, self.thread), swing.state(db, self.thread))
        db.refresh(row)
        assert pd.Timestamp(row.revealed_through) == close and row.status == "ended"
        for hold in hold_rows.open_holds(db, self.thread.id):
            assert hold.last_close_day == row.day  # marked at the official close of the day that just ended


@pytest.mark.parametrize("seed", [7, 23])
def test_a_random_walk_over_two_weeks_never_reads_past_the_day_clock(db_session, owner, world, svc, seed) -> None:
    thread, _ = ready_thread(db_session, owner, svc)
    drive = _Drive(db_session, owner, svc, world, thread, seed)
    for number in range(DRIVE_DAYS):
        drive.play(number)
    assert drive.stats["steps"] >= 30
    pytest.drive_stats = getattr(pytest, "drive_stats", {}) | {seed: drive.stats}
    print(seed, drive.stats, drive.reasons)
    # the walk really did something: marks went through the holds, the ledger credits what the ended days closed
    credited = db_session.execute(select(PracticeLedger.hold_id).where(PracticeLedger.thread_id == thread.id)).scalars()
    closed = db_session.execute(
        select(PracticeHold.id).where(PracticeHold.thread_id == thread.id, PracticeHold.status == "closed")
    ).scalars()
    assert {h for h in credited} <= set(closed)
