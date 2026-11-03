"""Helpers for the freestyle thread tests (ADR-0025): a thread started at an instant of the synthetic world of
`tests/daily_world.py`, lanes opened on its names, marks, orders and a clock the tests move.

The world: five sessions from Mon 2026-09-28 (`DAYS[0]`..`DAYS[4]`) and the ten sessions before them, three names.
GAPPER sits at 110 from the open to 11:30 on `DAYS[0]` and `DAYS[2]` (106 in their pre-market) and at 100 otherwise,
FLAT at 50 all the time, SPLITTER at 100 until `DAYS[2]` and 50 from `DAYS[3]` (a 2-for-1 split, ex-date `DAYS[3]`).
`svc.now` is Sat 2026-10-24, so the horizon is far past the data; a test that needs a nearer one moves `svc.now`.
"""

import pandas as pd
from daily_world import DAYS, NOW, SYMBOLS, make_thread
from sqlalchemy import select

from ai_trading.contracts.practice_setup import PracticeSetupV2
from ai_trading.core.calendar import ET, et
from ai_trading.db.models import FilterStrategy, PracticeLedger, PracticeThread, ReplaySession
from ai_trading.replay import clock as clock_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod

__all__ = ["DAYS", "NOW", "SYMBOLS"]


def at(day: int, hhmm: str) -> pd.Timestamp:
    """The UTC instant of `hhmm` ET on `DAYS[day]`."""
    return et(DAYS[day], hhmm)


def friday_before(hhmm: str) -> pd.Timestamp:
    """The Friday session before `DAYS[0]` (2026-09-25): the weekend sits between it and Monday."""
    return et(pd.Timestamp("2026-09-25").date(), hhmm)


def filter_id(db, user_id: int, name: str = "Gap up") -> int:
    return db.execute(
        select(FilterStrategy.id).where(FilterStrategy.owner_user_id == user_id, FilterStrategy.name == name)
    ).scalar_one()


def setup_body(db, user_id: int, start: pd.Timestamp, **screen) -> PracticeSetupV2:
    return PracticeSetupV2.model_validate(
        {
            "schemaVersion": 2,
            "startAt": start.tz_convert(ET).isoformat(timespec="seconds"),
            "screen": {"filters": [{"id": filter_id(db, user_id)}], "maxList": 30, **screen},
            "setup": {"interval": "5m", "session": "regular", "armed": []},
        }
    )


def start(db, user_id: int, svc, when: pd.Timestamp | None = None, *, balance: int = 50_000, **plan) -> PracticeThread:
    """A freestyle thread with its plan, its clock paused at `when` (default Mon 10:00), committed."""
    thread = make_thread(db, user_id, starting_balance=balance, **plan)
    plan_mod.create_plan(db, user_id, setup_body(db, user_id, at(0, "10:00") if when is None else when), svc, thread)
    db.commit()
    return thread


def lane(db, user_id: int, svc, thread: PracticeThread, symbol: str) -> ReplaySession:
    row = plan_mod.open_lane(db, user_id, thread.id, symbol, svc)
    db.commit()
    return row


def control(db, user_id: int, svc, thread: PracticeThread, **kw) -> dict:
    out = clock_mod.control(
        db, user_id, thread.id, svc, **{"running": None, "speed": None, "to": None, "step": None, **kw}
    )
    db.commit()
    return out


def read(db, user_id: int, svc, thread: PracticeThread) -> dict:
    out = clock_mod.read(db, user_id, thread.id, svc)
    db.commit()
    return out


def jump(db, user_id: int, svc, thread: PracticeThread, to: pd.Timestamp) -> dict:
    return control(db, user_id, svc, thread, to=to.to_pydatetime())


def sync(db, user_id: int, svc, row: ReplaySession) -> dict:
    """A screen following the thread's clock: the lane catches up to it (`advance(sync)`)."""
    out = session_mod.advance(
        db,
        user_id,
        row.id,
        svc,
        to=None,
        step=None,
        sync=True,
        interval=None,
        min_size=0,
        min_notional=0,
        max_prints=50,
    )
    db.commit()
    return out


def mark(db, user_id: int, svc, row: ReplaySession, kind: str, **extra) -> dict:
    out = session_mod.place_mark(db, user_id, row.id, svc, {"schemaVersion": 1, "kind": kind, **extra})
    db.commit()
    return out


def order(db, user_id: int, svc, row: ReplaySession, side: str, order_type: str, **extra) -> dict:
    out = session_mod.place_order(db, user_id, row.id, svc, {"side": side, "orderType": order_type, **extra})
    db.commit()
    return out


def portfolio(db, svc, thread: PracticeThread) -> dict:
    db.refresh(thread)
    return session_mod.portfolio(db, svc, thread)


def ledger(db, thread: PracticeThread) -> list[PracticeLedger]:
    return list(db.execute(select(PracticeLedger).where(PracticeLedger.thread_id == thread.id)).scalars())


def bend(world, symbol: str, day: int, start_hhmm: str, end_hhmm: str | None, **prices: float) -> None:
    """Set columns of `symbol`'s minute bars on `DAYS[day]` from `start_hhmm` (inclusive) to `end_hhmm` (exclusive;
    None: to the end of the day)."""
    frame = world.minutes[symbol]
    local = frame.index.tz_convert(ET)
    rows = (local.date == DAYS[day]) & (frame.index >= at(day, start_hhmm))
    if end_hhmm is not None:
        rows &= frame.index < at(day, end_hhmm)
    for column, value in prices.items():
        frame.loc[rows, column] = value
