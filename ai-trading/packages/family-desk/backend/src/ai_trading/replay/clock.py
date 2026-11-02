"""The day-trade thread's clock (ADR-0018): play, pause, speed, step, jump and skip-day, and the clock and account a
screen reads. Pure orchestration over `session` (`move_clock`, `settle_locked`) and `plan` (`end_day`, `open_next`).

**Why it is a function of wall time.** The thread's time is `replay_day_lists.revealed_through`. While `clock_running`
it advances `clock_speed` x wall time since `clock_anchor_at`, and is *settled* (written back with a fresh anchor)
whenever a request reads or acts on it, under the day-list lock. Nothing ticks in a process, so a closed screen, a
logout, a deploy or a restart cannot stop it. A viewer neither owns the time nor keeps it: it asks.

**What a settle never does.** It never moves a name's session (a name is lifted to the clock only when she is on it:
`session.advance`) and never reveals anything past the clock, so the no-lookahead cut is the day clock itself. The
balance is read at that clock: realized P/L from the ledger plus every open position priced at the clock.
"""

from datetime import datetime
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import et
from ai_trading.db.models import PracticeThread, ReplayDayList
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import signals as signals_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.model import INTERVAL_MINUTES
from ai_trading.replay.session import ReplayProblem, Services

SPEEDS = (1, 2, 5, 10)


def _ts(value: datetime | pd.Timestamp) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


def _day_thread(db: Session, user_id: int, thread_id: int) -> PracticeThread:
    """The thread when it is hers and a day thread (a swing thread's clock is its own, per session: 404 here)."""
    thread = threads_mod.get_thread(db, user_id, thread_id)
    if thread.mode != "day":
        raise threads_mod.ThreadNotFound(thread_id)
    return thread


def _open_day(db: Session, thread: PracticeThread, *, lock: bool) -> ReplayDayList | None:
    day = threads_mod.open_day(db, thread.id)
    if day is not None and lock:
        day = db.execute(select(ReplayDayList).where(ReplayDayList.id == day.id).with_for_update()).scalar_one()
    return day if day is not None and day.status != "ended" else None


def _window(db: Session, day: ReplayDayList) -> tuple[pd.Timestamp, pd.Timestamp] | None:
    """The day's run, from where she started it to the exchange close; every name of the day shares it. None before the
    first name is opened. Her plan's `window.to` is not in it: that is the focus mark (`_focus_end`), never a stop."""
    sessions = session_mod._sessions_of_day(db, day.id)
    return None if not sessions else (_ts(sessions[0].window_start), session_mod.window_end_of(sessions[0]))


def _focus_end(db: Session, day: ReplayDayList, close: pd.Timestamp) -> pd.Timestamp | None:
    """Where her plan's practice window ends: a mark for the timeline, display only. None when it is the close."""
    sessions = session_mod._sessions_of_day(db, day.id)
    mark = None if not sessions else et(sessions[0].day, sessions[0].spec["window"]["to"])
    return None if mark is None or mark >= close else mark


def _started(day: ReplayDayList | None) -> bool:
    return day is not None and day.status == "practicing" and day.revealed_through is not None


def _account(
    db: Session, svc: Services, thread: PracticeThread, day: ReplayDayList, clock: pd.Timestamp
) -> dict[str, Any]:
    """The simulated account at the clock: the ledger's balance (realized, to the cent), what every open position is
    worth over its cost at the clock, and the two together. Priced from the tape up to the clock and never past it."""
    books = session_mod.day_books(db, day.id)
    held = session_mod.positions(db, svc, day.id, clock, books) if _started(day) else []
    pnl = session_mod.day_pnl(books, held, clock)
    balance = threads_mod.brief(db, thread.id, day.id)["balance"]
    return {
        "balance": balance,
        "open_pnl_usd": pnl["open_usd"],
        "equity_usd": journal_mod.usd_sum([balance, pnl["open_usd"]]),
        "day_pnl_usd": pnl["total_usd"],
        "positions": pnl["open_count"],
        "as_of": clock,
    }


def view(db: Session, svc: Services, thread: PracticeThread, day: ReplayDayList | None) -> dict[str, Any]:
    """`ThreadClockOut`: the clock as it stands now (the caller settled it), and the account at that clock."""
    out: dict[str, Any] = {
        "thread_id": thread.id,
        "state": "no_day",
        "day_list_id": None,
        "day_no": None,
        "running": False,
        "speed": 1,
        "clock": None,
        "window_start": None,
        "window_end": None,
        "focus_end": None,
        "server_now": svc.wall(),
        "account": None,
        "label": threads_mod.SIMULATED_LABEL,
    }
    if day is None:
        return out
    window = _window(db, day) if _started(day) else None
    clock = _ts(day.revealed_through) if _started(day) else None
    state = "listed" if clock is None or window is None else "running" if day.clock_running else "paused"
    return {
        **out,
        "state": state,
        "day_list_id": day.id,
        "day_no": day.day_no,
        "running": day.clock_running,
        "speed": day.clock_speed,
        "clock": clock,
        "window_start": None if window is None else window[0],
        "window_end": None if window is None else window[1],
        "focus_end": None if window is None else _focus_end(db, day, window[1]),
        "account": _account(db, svc, thread, day, clock if clock is not None else _ts(day.data_through)),
    }


def read(db: Session, user_id: int, thread_id: int, svc: Services) -> dict[str, Any]:
    """The thread's clock now. A running clock is settled first (written back, committed with the request), so what a
    screen reads is the time the market is at, whether or not anyone was looking in between."""
    thread = _day_thread(db, user_id, thread_id)
    day = _open_day(db, thread, lock=False)
    if day is not None:
        session_mod.settle_day(db, svc, day.id)
        db.refresh(day)
    return view(db, svc, thread, day)


def _target(db: Session, day: ReplayDayList, *, to: datetime | None, step: str | None) -> pd.Timestamp:
    clock = _ts(day.revealed_through)
    if to is not None:
        if pd.Timestamp(to).tzinfo is None:
            raise ReplayProblem("Send the time with its UTC offset", path="to")
        return _ts(to)
    sessions = session_mod._sessions_of_day(db, day.id)
    if step == "bar":
        return session_mod.next_bar_boundary(clock, INTERVAL_MINUTES[sessions[0].spec["interval"]])
    fires = [fire for s in sessions for fire in signals_mod.load_fires(s.signals)]
    upcoming = signals_mod.next_after(fires, clock)
    if upcoming is None:
        raise ReplayProblem("No more signals today", path="step")
    return upcoming.bar_close


def control(
    db: Session,
    user_id: int,
    thread_id: int,
    svc: Services,
    *,
    running: bool | None,
    speed: int | None,
    to: datetime | None,
    step: str | None,
) -> dict[str, Any]:
    """Play, pause, set the speed, step or jump the thread's clock, then answer it. The clock is settled first, so a
    speed change or a pause never re-prices time that already passed. `to` and `step` are forward only and stop at the
    close, where the day rolls over (`roll`); no stop crossing and no window of hers stops them."""
    thread = _day_thread(db, user_id, thread_id)
    day = _open_day(db, thread, lock=True)
    if not _started(day):
        raise ReplayProblem("Open a name from the day list to start the day", path="clock", status=409)
    assert day is not None
    if speed is not None and speed not in SPEEDS:
        raise ReplayProblem("Pick 1x, 2x, 5x or 10x", path="speed")
    if to is not None and step is not None:
        raise ReplayProblem("Send either to or step", path="to")
    session_mod.settle_locked(db, svc, day)
    now = svc.wall()
    if speed is not None:
        day.clock_speed = speed
        if day.clock_running:
            day.clock_anchor_at = now
    if to is not None or step is not None:
        session_mod.move_clock(db, svc, day, _target(db, day, to=to, step=step))
    if running:
        window = _window(db, day)
        assert window is not None
        if _ts(day.revealed_through) < window[1]:  # at the close there is nothing left to run: `roll` takes the day on
            day.clock_running, day.clock_anchor_at = True, now
    elif running is False:
        day.clock_running, day.clock_anchor_at = False, None
    day.updated_at = now
    db.flush()
    return view(db, svc, thread, day)


def closed(db: Session, day: ReplayDayList | None) -> bool:
    """The clock of a started day is at the exchange close."""
    window = _window(db, day) if day is not None and _started(day) else None
    return window is not None and _ts(day.revealed_through) >= window[1]


def roll(db: Session, user_id: int, thread_id: int, svc: Services) -> plan_mod.Opened | None:
    """The market closed: end the day (every open position books at the close) and open the next one, with nothing for
    her to press. The clock is settled first, so a day that ran into the close while nobody looked rolls on the next
    look. None while the clock is short of the close (the usual answer; a paused clock costs one read, no lock). The
    next list may not be ready (its data is being prepared): the caller then polls the hub, as after a Skip day."""
    thread = _day_thread(db, user_id, thread_id)
    day = _open_day(db, thread, lock=False)
    if day is None:
        return None
    session_mod.settle_day(db, svc, day.id)
    db.refresh(day)
    if not closed(db, day):
        return None
    day = _open_day(db, thread, lock=True)  # the day again, locked: a parallel poll may have rolled it already
    if day is None or not closed(db, day):
        return None
    plan_mod.end_day(db, user_id, day.id, svc)
    return plan_mod.open_next(db, user_id, svc, thread.id)


def roll_of_session(db: Session, user_id: int, session_id: int, svc: Services) -> plan_mod.Opened | None:
    """`roll` for the thread a day-thread session belongs to (a chart that follows the clock is what finds the close
    first when nobody has the Summary open). None for a standalone or swing session."""
    row = db.get(session_mod.ReplaySession, session_id)
    if row is None or row.owner_user_id != user_id or row.day_list_id is None or row.thread_id is None:
        return None
    thread = db.get(PracticeThread, row.thread_id)
    return roll(db, user_id, row.thread_id, svc) if thread is not None and thread.mode == "day" else None


def skip_day(db: Session, user_id: int, thread_id: int, svc: Services) -> tuple[ReplayDayList, plan_mod.Opened]:
    """Skip to the next day: run the clock to the close, end the day so every open position flattens at that close, and
    open the next day's list. The one deliberate way to move time past what she watched. A day never started is a Pass.
    The next day may not be ready yet (its data is still being prepared): the caller then polls the hub as it does after
    any open."""
    thread = _day_thread(db, user_id, thread_id)
    day = _open_day(db, thread, lock=True)
    if day is None:
        raise ReplayProblem("No practice day is under way", path="clock", status=409)
    window = _window(db, day) if _started(day) else None
    if window is not None:
        session_mod.settle_locked(db, svc, day)
        session_mod.move_clock(db, svc, day, window[1])
    ended = plan_mod.end_day(db, user_id, day.id, svc)
    return ended, plan_mod.open_next(db, user_id, svc, thread.id)
