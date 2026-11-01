"""A swing name holds one average-cost position, any number of fills (ADR-0016, "One position per name, many fills"): a
second buy adds to the open hold and re-averages its cost, a sale of part closes a slice as a row of its own and leaves
the cost, a sale past the hold flips it, and each is undone to the digit. Buying power stays the only size rule. Same
synthetic swing world and helpers as the swing play tests (a day runs open to close in a straight line, so fills at
different clocks have different prices). Real Postgres (`scripts/test-db.sh`)."""

from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from swing_world import make_owner, ready_thread, swing_services, swing_world
from test_replay_swing_lifecycle import _end
from test_replay_swing_play import D1, _advance, _day, _hold, _ledger, _mark, _rejected, _undo, bar_close

from ai_trading.db.models import PracticeHold, PracticeMark, ReplayDayList
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import swing


@pytest.fixture
def world():
    return swing_world()


@pytest.fixture
def svc(world):
    return swing_services(world)


@pytest.fixture
def owner(db_session) -> int:
    return make_owner(db_session)


def _rows(db, thread, symbol="S01") -> list[PracticeHold]:
    db.expire_all()
    query = select(PracticeHold).where(PracticeHold.thread_id == thread.id, PracticeHold.symbol == symbol)
    return list(db.execute(query.order_by(PracticeHold.id)).scalars())


def _scaled(db_session, owner, world, svc, **thread_args):
    """A day on S01 with 40 shares bought at 10:00, the clock then at 10:30: `(thread, session, first price, second
    price)`, where the second is the price a fill at 10:30 gets. The day list is `session.day_list_id`."""
    thread, _ = ready_thread(db_session, owner, svc, **thread_args)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00")
    first = bar_close(world, "S01", D1, "09:59")
    _mark(db_session, owner, svc, session, "long_entry", shares=40)
    _advance(db_session, owner, svc, session, "10:30")
    second = bar_close(world, "S01", D1, "10:29")
    assert second != first  # the world trends, so the two fills differ
    return thread, session, first, second


def test_a_second_buy_adds_to_the_one_open_hold_at_the_average_cost(db_session, owner, world, svc) -> None:
    thread, session, first, second = _scaled(db_session, owner, world, svc)
    out = _mark(db_session, owner, svc, session, "long_entry", shares=60)
    (hold,) = _rows(db_session, thread)  # still one row: the name's one position
    average = journal_mod.average_cost(40, first, 60, second)
    assert (hold.status, hold.side, hold.shares, float(hold.entry_price)) == ("open", "long", 100, average)
    assert out["hold"]["id"] == hold.id and out["hold"]["shares"] == 100
    assert out["open_trade"]["shares"] == 100 and out["open_trade"]["entry_price"] == average
    assert out["open_trade"]["trade_no"] == hold.id and out["mark"]["trade_no"] == hold.id
    assert hold.entry_session_id == session.id  # the position keeps the fill that opened it
    marks = db_session.execute(select(PracticeMark).order_by(PracticeMark.seq)).scalars().all()
    assert marks[0].position_before is None
    assert marks[1].position_before == {
        "shares": 40,
        "entry_price": first,
        "stop_at_entry": None,
        "stop_price": None,
        "stop_hit_at": None,
    }  # what an undo restores, to the digit


def test_undoing_a_scale_in_restores_the_cost_exactly(db_session, owner, world, svc) -> None:
    thread, session, first, _ = _scaled(db_session, owner, world, svc)
    added = _mark(db_session, owner, svc, session, "long_entry", shares=61)  # a share count that averages badly
    back = _undo(db_session, owner, svc, session, added["mark"]["id"])
    (hold,) = _rows(db_session, thread)
    assert (hold.shares, float(hold.entry_price), hold.status) == (40, first, "open")
    assert back["hold"]["shares"] == 40 and back["open_trade"]["entry_price"] == first
    assert db_session.get(PracticeMark, added["mark"]["id"]) is None


def test_selling_part_closes_a_slice_as_its_own_row_and_the_open_row_keeps_its_cost(
    db_session, owner, world, svc
) -> None:
    thread, session, first, second = _scaled(db_session, owner, world, svc)
    _mark(db_session, owner, svc, session, "long_entry", shares=60)
    average = journal_mod.average_cost(40, first, 60, second)
    sold = _mark(db_session, owner, svc, session, "short_entry", shares=30)  # fewer than all 100: a partial exit
    opened, part = _rows(db_session, thread)
    assert (opened.status, opened.shares, float(opened.entry_price), opened.part_exit) == ("open", 70, average, False)
    assert (part.status, part.shares, float(part.entry_price), part.part_exit) == ("closed", 30, average, True)
    assert (float(part.exit_price), part.exit_source, part.exit_mark_id) == (second, "her", sold["mark"]["id"])
    assert part.exit_session_id == session.id and part.entry_day == D1 and part.entry_at == opened.entry_at
    assert sold["hold"]["id"] == opened.id and sold["hold"]["shares"] == 70  # the position the mark changed
    assert sold["open_trade"]["shares"] == 70 and sold["open_trade"]["entry_price"] == average
    assert sold["journal"]["totals"]["trades"] == 1  # the slice is a trade of this session
    pnl = journal_mod.pnl_usd(1, average, second, 30)
    assert sold["journal"]["totals"]["pnl_usd"] == pnl and sold["journal"]["trades"][0]["shares"] == 30
    assert _ledger(db_session, thread) == []  # credited when the day ends, as every swing exit is


def test_a_slice_is_credited_to_the_ledger_when_the_day_ends_and_the_rest_rides_overnight(
    db_session, owner, world, svc
) -> None:
    thread, session, first, second = _scaled(db_session, owner, world, svc)
    _mark(db_session, owner, svc, session, "long_entry", shares=60)
    average = journal_mod.average_cost(40, first, 60, second)
    _mark(db_session, owner, svc, session, "short_entry", shares=30)
    _end(db_session, owner, svc, db_session.get(ReplayDayList, session.day_list_id))
    credited = _ledger(db_session, thread)
    assert [(entry.shares, float(entry.entry_price), float(entry.pnl_usd)) for entry in credited] == [
        (30, average, journal_mod.pnl_usd(1, average, second, 30))
    ]
    assert _hold(db_session, thread, "S01", "open").shares == 70  # carried, still at the average cost


def test_undoing_a_partial_exit_puts_the_slice_back_into_the_open_hold(db_session, owner, world, svc) -> None:
    thread, session, first, second = _scaled(db_session, owner, world, svc)
    _mark(db_session, owner, svc, session, "long_entry", shares=60)
    average = journal_mod.average_cost(40, first, 60, second)
    sold = _mark(db_session, owner, svc, session, "short_entry", shares=30)
    back = _undo(db_session, owner, svc, session, sold["mark"]["id"])
    (hold,) = _rows(db_session, thread)  # the slice row is gone
    assert (hold.status, hold.shares, float(hold.entry_price), hold.part_exit) == ("open", 100, average, False)
    assert back["hold"]["shares"] == 100 and back["journal"]["totals"]["trades"] == 0


def test_a_sale_with_a_stop_moves_the_remaining_holds_line_and_its_undo_puts_everything_back(
    db_session, owner, world, svc
) -> None:
    thread, session, first, second = _scaled(db_session, owner, world, svc)
    sold = _mark(db_session, owner, svc, session, "short_entry", shares=10, stopPrice=round(first - 1, 2))
    opened, part = _rows(db_session, thread)
    assert (opened.shares, float(opened.stop_price), part.shares, part.part_exit) == (30, round(first - 1, 2), 10, True)
    back = _undo(db_session, owner, svc, session, sold["mark"]["id"])
    (hold,) = _rows(db_session, thread)
    assert (hold.shares, hold.stop_price, hold.stop_at_entry) == (40, None, None) and back["hold"]["shares"] == 40
    assert float(hold.entry_price) == first and second != first


def test_a_sale_past_the_hold_closes_it_and_opens_a_short_with_the_rest(db_session, owner, world, svc) -> None:
    thread, session, first, second = _scaled(db_session, owner, world, svc)
    flipped = _mark(db_session, owner, svc, session, "short_entry", shares=100)  # 40 held: closes 40, shorts 60
    old, new = _rows(db_session, thread)
    assert (old.status, old.side, old.shares, old.part_exit, float(old.exit_price)) == (
        "closed",
        "long",
        40,
        False,
        second,
    )
    assert (new.status, new.side, new.shares, float(new.entry_price), new.entry_mark_id) == (
        "open", "short", 60, second, flipped["mark"]["id"]
    )  # fmt: skip
    assert flipped["hold"]["id"] == new.id and flipped["open_trade"]["side"] == "short"
    assert flipped["mark"]["trade_no"] == new.id and old.exit_mark_id == flipped["mark"]["id"]

    back = _undo(db_session, owner, svc, session, flipped["mark"]["id"])  # the short goes, the long comes back
    (hold,) = _rows(db_session, thread)
    assert (hold.id, hold.status, hold.side, hold.shares, float(hold.entry_price)) == (
        old.id,
        "open",
        "long",
        40,
        first,
    )
    assert hold.exit_price is None and back["hold"]["id"] == old.id


def test_buying_power_is_the_only_size_rule_for_a_swing_name_already_held(db_session, owner, world, svc) -> None:
    thread, _ = ready_thread(db_session, owner, svc, balance=10_000)
    _, (session,) = _day(db_session, owner, svc, thread, "S01")
    _advance(db_session, owner, svc, session, "10:00")
    price = bar_close(world, "S01", D1, "09:59")
    fits = int(10_000 // price)
    _mark(db_session, owner, svc, session, "long_entry", shares=fits - 5)
    problem = _rejected(session_mod.place_mark, db_session, owner, session.id, svc, {"kind": "long_entry", "shares": 6})
    assert (problem.path, problem.status) == ("shares", 422) and problem.message.startswith("Not enough practice cash")
    _mark(db_session, owner, svc, session, "long_entry", shares=5)  # what is left: allowed
    assert _hold(db_session, thread, "S01").shares == fits
    _mark(db_session, owner, svc, session, "short_entry", shares=3)  # selling needs no cash
    flip = {"kind": "short_entry", "shares": 2 * fits}  # closes fits - 3, shorts fits + 3: more than the cash it frees
    assert _rejected(session_mod.place_mark, db_session, owner, session.id, svc, flip).status == 422
    assert len(_rows(db_session, thread)) == 2  # the hold and its 3-share slice: the refused flip wrote nothing


def test_a_slice_is_not_a_hold_opened_for_the_day_summary_counts() -> None:
    def hold(**kw):
        base = {"entry_day": D1, "entry_at": datetime(2026, 1, 5, 15), "status": "open", "exit_day": None}
        return SimpleNamespace(**{**base, "exit_at": None, "part_exit": False, **kw})

    opened = hold()
    part = hold(status="closed", exit_day=D1, exit_at=datetime(2026, 1, 5, 16), part_exit=True)
    assert swing._max_open([opened, part], D1) == 1  # one position, however many pieces were sold off it
