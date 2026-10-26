"""The database layer of the practice holds (`replay/hold_rows.py`): rows to and from the pure `Hold`, the entry and its
two undos, the one-open-hold-per-symbol backstop, and the ledger credit of a closed hold (idempotent per hold, with
the restated shares and prices, and no session or mark for an auto exit). Real Postgres (`scripts/test-db.sh`)."""

from datetime import date
from decimal import Decimal

import pandas as pd
import pytest
from sqlalchemy import insert, select
from swing_world import NOW, make_owner

from ai_trading.contracts.practice_thread import PracticeLedgerEntryV1
from ai_trading.db.models import PracticeLedger, PracticeMark, ReplaySession
from ai_trading.replay import hold_rows, holds
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.holds import HoldProblem
from ai_trading.replay.ledger import entry_out

DAY = date(2026, 9, 14)
AT = pd.Timestamp("2026-09-14 13:31", tz="UTC")
LATER = pd.Timestamp("2026-09-16 15:00", tz="UTC")


def _session(db_session, thread) -> int:
    """A bare replay session of the thread (the hold only links to it)."""
    values = {
        "owner_user_id": thread.owner_user_id,
        "thread_id": thread.id,
        "symbol": "S01",
        "day": DAY,
        "attempt": 1,
        "schema_version": 1,
        "spec": {},
        "armed": [],
        "signals": [],
        "window_start": NOW,
        "window_end": NOW,
        "revealed_through": NOW,
        "tape_feed": "off",
        "status": "active",
        "created_at": NOW,
        "updated_at": NOW,
    }
    return db_session.execute(insert(ReplaySession).values(**values).returning(ReplaySession.id)).scalar_one()


def _mark(db_session, session_id: int, seq: int, kind: str) -> int:
    values = {
        "session_id": session_id,
        "seq": seq,
        "kind": kind,
        "at": NOW,
        "price": Decimal("101.5"),
        "source": "her",
        "created_at": NOW,
    }
    return db_session.execute(insert(PracticeMark).values(**values).returning(PracticeMark.id)).scalar_one()


@pytest.fixture
def thread(db_session):
    user_id = make_owner(db_session)
    body = {"mode": "swing", "startingBalance": 50_000, "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"}}
    row = threads_mod.add_thread(db_session, user_id, body, NOW)
    db_session.commit()
    return row


def _enter(db_session, thread, symbol="S01", **changes):
    values = {
        "symbol": symbol,
        "side": "long",
        "shares": 100,
        "day": DAY,
        "at": AT,
        "price": 100.25,
        "stop": 98.5,
        "session_id": None,
        "mark_id": None,
        "now": NOW,
    }
    return hold_rows.add_entry(db_session, thread, **{**values, **changes})


def _close(row, *, price=104.0, source="her"):
    hold_rows.apply(
        row, holds.exit_hold(hold_rows.to_hold(row), day=date(2026, 9, 16), at=LATER, price=price, source=source)
    )


def test_an_entry_round_trips_between_the_row_and_the_pure_hold(db_session, thread) -> None:
    row = _enter(db_session, thread)
    db_session.commit()
    db_session.refresh(row)
    hold = hold_rows.to_hold(row)
    assert (hold.id, hold.symbol, hold.side, hold.shares, hold.status) == (row.id, "S01", "long", 100, "open")
    assert (hold.entry_day, hold.entry_at, hold.entry_price) == (DAY, AT, 100.25)
    assert (hold.stop_at_entry, hold.stop_price, hold.stop_hit_at) == (98.5, 98.5, None)
    assert hold.exit_day is None and hold.splits == () and hold.last_close is None
    hold_rows.apply(row, hold)  # applying an unchanged hold changes nothing
    assert (row.shares, float(row.entry_price), float(row.stop_price)) == (100, 100.25, 98.5)


def test_every_mutable_field_is_copied_back(db_session, thread) -> None:
    row = _enter(db_session, thread, side="short", stop=104.0)
    hold = hold_rows.to_hold(row)
    hold = holds.restate(hold, 2.0, date(2026, 9, 15))  # a 2-for-1 split
    hold = holds.mark_close(hold, 49.5, date(2026, 9, 15))
    hold = holds.set_stop(hold, 51.0)
    hold = holds.exit_hold(hold, day=date(2026, 9, 16), at=LATER, price=48.0, source="auto")
    hold_rows.apply(row, hold)
    db_session.commit()
    db_session.refresh(row)
    back = hold_rows.to_hold(row)
    assert back == hold
    assert (row.shares, float(row.entry_price), float(row.stop_at_entry), float(row.stop_price)) == (
        200,
        50.125,
        52.0,
        51.0,
    )
    assert row.splits == [{"day": "2026-09-15", "ratio": 2.0, "shares_before": 100, "shares_after": 200}]
    assert (row.status, row.exit_day, float(row.exit_price), row.exit_source) == (
        "closed",
        date(2026, 9, 16),
        48.0,
        "auto",
    )


def test_load_filters_by_status_and_orders_by_entry(db_session, thread) -> None:
    first = _enter(db_session, thread, "S02", at=AT)
    second = _enter(db_session, thread, "S01", at=AT + pd.Timedelta(minutes=5))
    _close(first)
    db_session.commit()
    assert [r.symbol for r in hold_rows.load(db_session, thread.id)] == ["S02", "S01"]
    assert [r.symbol for r in hold_rows.load(db_session, thread.id, "closed")] == ["S02"]
    assert [r.id for r in hold_rows.open_holds(db_session, thread.id)] == [second.id]
    assert [r.id for r in hold_rows.open_holds(db_session, thread.id, lock=True)] == [second.id]
    assert hold_rows.load(db_session, thread.id + 1000) == []


def test_a_second_open_hold_on_a_symbol_is_a_plain_problem_and_the_transaction_survives(db_session, thread) -> None:
    _enter(db_session, thread)
    db_session.commit()
    with pytest.raises(HoldProblem) as caught:
        _enter(db_session, thread)
    assert caught.value.message == "Close your open S01 practice hold first" and caught.value.status == 422
    assert len(hold_rows.load(db_session, thread.id)) == 1  # the savepoint kept the session usable
    _enter(db_session, thread, "S02")  # another symbol is fine


def test_a_closed_symbol_can_be_entered_again(db_session, thread) -> None:
    row = _enter(db_session, thread)
    _close(row)
    again = _enter(db_session, thread, at=LATER + pd.Timedelta(minutes=1))
    assert again.id != row.id and again.status == "open"


def test_undo_of_an_entry_deletes_the_hold(db_session, thread) -> None:
    row = _enter(db_session, thread)
    hold_rows.delete(db_session, row)
    assert hold_rows.load(db_session, thread.id) == []


def test_undo_of_an_exit_reopens_the_hold(db_session, thread) -> None:
    session_id = _session(db_session, thread)
    exit_mark = _mark(db_session, session_id, 1, "long_exit")
    row = _enter(db_session, thread)
    _close(row)
    row.exit_session_id, row.exit_mark_id = session_id, exit_mark
    db_session.flush()
    hold_rows.reopen(db_session, row)
    db_session.commit()
    db_session.refresh(row)
    assert row.status == "open"
    assert (row.exit_day, row.exit_at, row.exit_price, row.exit_source) == (None, None, None, None)
    assert (row.exit_session_id, row.exit_mark_id) == (None, None)
    assert float(row.entry_price) == 100.25 and row.shares == 100  # the entry is untouched


def test_reopening_onto_a_symbol_that_has_an_open_hold_is_a_clean_error(db_session, thread) -> None:
    row = _enter(db_session, thread)
    _close(row)
    _enter(db_session, thread, at=LATER + pd.Timedelta(minutes=1))
    db_session.commit()
    with pytest.raises(HoldProblem):
        hold_rows.reopen(db_session, row)
    assert len(hold_rows.open_holds(db_session, thread.id)) == 1  # the session is still usable


def test_credit_writes_the_closed_hold_once(db_session, thread) -> None:
    row = _enter(db_session, thread)
    _close(row, price=104.0)
    credited = hold_rows.credit(db_session, row, NOW)
    assert credited is not None
    assert (credited.thread_id, credited.hold_id, credited.symbol, credited.side, credited.shares) == (
        thread.id,
        row.id,
        "S01",
        "long",
        100,
    )
    assert (credited.day, float(credited.entry_price), float(credited.exit_price)) == (date(2026, 9, 16), 100.25, 104.0)
    assert float(credited.pnl_usd) == 375.0 and credited.realized_at == row.exit_at
    assert float(credited.r) == 2.14  # 3.75 a share over a 1.75 stop distance
    assert hold_rows.credit(db_session, row, NOW) is None  # idempotent per hold
    assert db_session.scalars(select(PracticeLedger).where(PracticeLedger.hold_id == row.id)).all() == [credited]


def test_credit_of_an_open_hold_writes_nothing(db_session, thread) -> None:
    row = _enter(db_session, thread)
    assert hold_rows.credit(db_session, row, NOW) is None
    assert db_session.scalars(select(PracticeLedger)).all() == []


def test_credit_keeps_the_exit_session_and_mark_when_she_exited_it_herself(db_session, thread) -> None:
    session_id = _session(db_session, thread)
    entry_mark, exit_mark = (
        _mark(db_session, session_id, 1, "long_entry"),
        _mark(db_session, session_id, 2, "long_exit"),
    )
    row = _enter(db_session, thread, session_id=session_id, mark_id=entry_mark)
    assert (row.entry_session_id, row.entry_mark_id) == (session_id, entry_mark)
    _close(row)
    row.exit_session_id, row.exit_mark_id = session_id, exit_mark
    credited = hold_rows.credit(db_session, row, NOW)
    assert credited is not None and (credited.session_id, credited.mark_id) == (session_id, exit_mark)
    out = entry_out(credited)
    assert (out["sessionId"], out["markId"], out["holdId"]) == (session_id, exit_mark, row.id)


def test_credit_of_an_auto_exit_has_no_session_or_mark_and_a_short_wins_when_it_falls(db_session, thread) -> None:
    row = _enter(db_session, thread, side="short", stop=None, price=100.0)
    _close(row, price=96.0, source="auto")
    credited = hold_rows.credit(db_session, row, NOW)
    assert credited is not None
    assert (credited.session_id, credited.mark_id) == (None, None)
    assert float(credited.pnl_usd) == 400.0 and credited.r is None  # no stop at entry, no R


def test_credit_uses_the_restated_shares_and_prices_after_a_split(db_session, thread) -> None:
    row = _enter(db_session, thread, price=100.0, stop=95.0)
    hold_rows.apply(row, holds.restate(hold_rows.to_hold(row), 2.0, date(2026, 9, 15)))
    _close(row, price=52.0)
    credited = hold_rows.credit(db_session, row, NOW)
    assert credited is not None
    assert (credited.shares, float(credited.entry_price), float(credited.exit_price)) == (200, 50.0, 52.0)
    assert float(credited.pnl_usd) == 400.0  # the same dollars as 100 shares from 100 to 104
    assert float(credited.r) == 0.8  # 2 over a stop distance of 2.5


def test_a_swing_ledger_row_is_served_without_a_session_or_mark_and_with_its_hold(db_session, thread) -> None:
    row = _enter(db_session, thread)
    _close(row, source="auto")
    credited = hold_rows.credit(db_session, row, NOW)
    out = entry_out(credited)
    assert "sessionId" not in out and "markId" not in out and out["holdId"] == row.id
    assert PracticeLedgerEntryV1.model_validate(out).holdId == row.id


def test_unrealized_total_values_each_open_hold_at_the_price_asked_for(db_session, thread) -> None:
    long_ = _enter(db_session, thread, "S01", price=100.0, shares=10)
    short = _enter(db_session, thread, "S02", side="short", price=50.0, shares=20, stop=None)
    prices = {"S01": 103.0, "S02": 52.0}
    assert hold_rows.unrealized_total([long_, short], prices.__getitem__) == 30.0 - 40.0
    assert hold_rows.unrealized_total([], prices.__getitem__) == 0.0
