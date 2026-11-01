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
    """The day's practice window: every name of the day shares it. None before the first name is opened."""
    sessions = session_mod._sessions_of_day(db, day.id)
    return None if not sessions else (_ts(sessions[0].window_start), _ts(sessions[0].window_end))


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
        "server_now": svc.wall(),
        "pause": None,
        "account": None,
        "label": threads_mod.SIMULATED_LABEL,
    }
    if day is None:
        return out
    window = _window(db, day) if _started(day) else None
    clock = _ts(day.revealed_through) if _started(day) else None
    state = "listed"
    if clock is not None and window is not None:
        state = "at_close" if clock >= window[1] else "running" if day.clock_running else "paused"
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
        "pause": day.clock_pause,
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
    speed change or a pause never re-prices time that already passed. `to` and `step` are forward only and stop at a
    crossed stop or the close (like a Play does); `running: true` at the close is a 409 (end the day or skip it)."""
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
        if _ts(day.revealed_through) >= window[1]:
            raise ReplayProblem(
                "The clock is at the close · end the day or skip to the next", path="running", status=409
            )
        day.clock_running, day.clock_anchor_at, day.clock_pause = True, now, None
    elif running is False:
        day.clock_running, day.clock_anchor_at, day.clock_pause = False, None, None
    day.updated_at = now
    db.flush()
    return view(db, svc, thread, day)


def skip_day(db: Session, user_id: int, thread_id: int, svc: Services) -> tuple[ReplayDayList, plan_mod.Opened]:
    """Skip to the next day: run the clock to the window end (a stop crossed on the way does not pause a skip), end
    the day so every open position flattens at that close, and open the next day's list. A day she never started is
    a Pass.
    The next day may not be ready yet (its data is still being prepared): the caller then polls the hub as it does after
    any open."""
    thread = _day_thread(db, user_id, thread_id)
    day = _open_day(db, thread, lock=True)
    if day is None:
        raise ReplayProblem("No practice day is under way", path="clock", status=409)
    window = _window(db, day) if _started(day) else None
    if window is not None:
        session_mod.settle_locked(db, svc, day)
        session_mod.move_clock(db, svc, day, window[1], stop_pause=False)
    ended = plan_mod.end_day(db, user_id, day.id, svc)
    return ended, plan_mod.open_next(db, user_id, svc, thread.id)
