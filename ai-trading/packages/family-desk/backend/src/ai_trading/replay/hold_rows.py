"""The database layer of the practice holds (02p §b): `PracticeHold` rows to and from the pure `holds.Hold`, the writes
the day lifecycle makes (enter, undo an entry, undo an exit), and the ledger credit of a closed hold.

The rules live in `holds.py`; this module only moves rows. A caller reads a row with `to_hold`, applies a pure rule, and
writes the answer back with `apply`. The exit session and mark are not fields of `Hold`: the caller sets
`row.exit_session_id` and `row.exit_mark_id` itself when her exit mark closes a hold (an auto exit at a close has
neither). Lock order for every swing write (02p §f4): day list, session, thread, holds.
"""

from collections.abc import Callable, Sequence
from datetime import date, datetime
from decimal import Decimal

import pandas as pd
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.db.models import PracticeHold, PracticeLedger, PracticeThread
from ai_trading.replay import holds


def _num(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def _dec(value: float | None) -> Decimal | None:
    """A price as the column stores it (six decimals), via its shortest text so float noise never reaches the row."""
    return None if value is None else Decimal(str(round(value, 6)))


def _stamp(value: datetime | None) -> pd.Timestamp | None:
    return None if value is None else pd.Timestamp(value).tz_convert("UTC")


def to_hold(row: PracticeHold) -> holds.Hold:
    return holds.Hold(
        id=row.id,
        symbol=row.symbol,
        side=row.side,
        shares=row.shares,
        entry_day=row.entry_day,
        entry_at=_stamp(row.entry_at),
        entry_price=float(row.entry_price),
        stop_at_entry=_num(row.stop_at_entry),
        stop_price=_num(row.stop_price),
        stop_hit_at=_stamp(row.stop_hit_at),
        status=row.status,
        exit_day=row.exit_day,
        exit_at=_stamp(row.exit_at),
        exit_price=_num(row.exit_price),
        exit_source=row.exit_source,
        last_close=_num(row.last_close),
        last_close_day=row.last_close_day,
        splits=tuple(row.splits or ()),
    )


def apply(row: PracticeHold, hold: holds.Hold) -> None:
    """Copy every field a pure rule can change back to the row: the share basis (a split), the stop, the exit, and
    the last close. The entry day and time, the side and the symbol never change."""
    row.shares = hold.shares
    row.entry_price = _dec(hold.entry_price)
    row.stop_at_entry = _dec(hold.stop_at_entry)
    row.stop_price = _dec(hold.stop_price)
    row.stop_hit_at = None if hold.stop_hit_at is None else hold.stop_hit_at.to_pydatetime()
    row.status = hold.status
    row.exit_day = hold.exit_day
    row.exit_at = None if hold.exit_at is None else hold.exit_at.to_pydatetime()
    row.exit_price = _dec(hold.exit_price)
    row.exit_source = hold.exit_source
    row.last_close = _dec(hold.last_close)
    row.last_close_day = hold.last_close_day
    row.splits = [dict(split) for split in hold.splits]


# -- reading ------------------------------------------------------------------------------------------------


def load(db: Session, thread_id: int, status: str | None = None, *, lock: bool = False) -> list[PracticeHold]:
    """The thread's holds in entry order, optionally only the `open` or the `closed` ones."""
    query = select(PracticeHold).where(PracticeHold.thread_id == thread_id)
    if status is not None:
        query = query.where(PracticeHold.status == status)
    query = query.order_by(PracticeHold.entry_at, PracticeHold.id)
    return list(db.execute(query.with_for_update() if lock else query).scalars())


def open_holds(db: Session, thread_id: int, *, lock: bool = False) -> list[PracticeHold]:
    return load(db, thread_id, "open", lock=lock)


def unrealized_total(open_rows: Sequence[PracticeHold], price_of: Callable[[str], float]) -> float:
    """The open holds' unrealized P/L, each valued at `price_of(symbol)` (the caller picks the price: the last ended
    close for a read outside the day, the revealed price during it)."""
    return round(sum(holds.pnl(to_hold(row), price_of(row.symbol)) for row in open_rows), 2)


# -- writing ------------------------------------------------------------------------------------------------


def _taken(symbol: str) -> holds.HoldProblem:
    return holds.HoldProblem(f"Close your open {symbol} practice hold first")


def add_entry(
    db: Session,
    thread: PracticeThread,
    *,
    symbol: str,
    side: str,
    shares: int,
    day: date,
    at: pd.Timestamp,
    price: float,
    stop: float | None,
    session_id: int | None,
    mark_id: int | None,
    now: datetime,
) -> PracticeHold:
    """Open a hold. The partial unique index (one open hold per symbol in a thread) is the backstop for two requests
    racing past `holds.check_entry`: it surfaces as the same plain `HoldProblem`, and the savepoint keeps the
    caller's transaction usable."""
    row = PracticeHold(
        thread_id=thread.id,
        owner_user_id=thread.owner_user_id,
        symbol=symbol,
        side=side,
        shares=shares,
        entry_day=day,
        entry_at=at.to_pydatetime(),
        entry_price=_dec(price),
        entry_session_id=session_id,
        entry_mark_id=mark_id,
        stop_at_entry=_dec(stop),
        stop_price=_dec(stop),
        stop_hit_at=None,
        status="open",
        splits=[],
        created_at=now,
        updated_at=now,
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        raise _taken(symbol) from None
    return row


def delete(db: Session, row: PracticeHold) -> None:
    """Undo of an entry mark: the hold never existed. (No ledger row exists yet: it is written when the exit day
    ends, and an entry can only be undone while it is the last mark of its day.)"""
    db.delete(row)
    db.flush()


def reopen(db: Session, row: PracticeHold) -> None:
    """Undo of an exit mark before the day ends: clear the exit and open the hold again. Nothing was credited."""
    try:
        with db.begin_nested():
            row.status = "open"
            row.exit_day = row.exit_at = row.exit_price = row.exit_source = None
            row.exit_session_id = row.exit_mark_id = None
            db.flush()
    except IntegrityError:
        raise _taken(row.symbol) from None


def credit(db: Session, row: PracticeHold, now: datetime) -> PracticeLedger | None:
    """Write the ledger row of a closed hold when the day it exited ends (02p §b3). Idempotent per hold: an open hold
    or one already credited writes nothing and returns None. The row carries the hold's restated shares and prices,
    the exit's session and mark when she exited it herself (none for an auto exit at a close), and the hold id."""
    if row.status != "closed":
        return None
    if db.execute(select(PracticeLedger.id).where(PracticeLedger.hold_id == row.id)).first() is not None:
        return None
    hold = to_hold(row)
    assert hold.exit_price is not None and hold.exit_day is not None and hold.exit_at is not None
    r = holds.r_multiple(hold, hold.exit_price)
    entry = PracticeLedger(
        thread_id=row.thread_id,
        session_id=row.exit_session_id,
        mark_id=row.exit_mark_id,
        hold_id=row.id,
        day=hold.exit_day,
        symbol=row.symbol,
        side=row.side,
        shares=row.shares,
        entry_price=row.entry_price,
        exit_price=row.exit_price,
        pnl_usd=Decimal(str(holds.closed_pnl(hold))),
        r=None if r is None else Decimal(str(r)),
        realized_at=row.exit_at,
        created_at=now,
    )
    db.add(entry)
    db.flush()
    return entry
