"""The day-trade thread's clock (ADR-0018): play, pause, speed, skip-day, and the clock and account a screen reads.
Pure orchestration over `session` (`move_clock`, `settle_locked`) and `plan` (`end_day`, `open_next`).

**The thread clock is real time, shifted.** Its time is `replay_day_lists.revealed_through`. While `clock_running` it
advances `clock_speed` x wall time since `clock_anchor_at`, and is *settled* (written back with a fresh anchor)
whenever a request reads or acts on it, under the day-list lock. Nothing ticks in a process, so a closed screen, a
logout, a deploy or a restart cannot stop it. While it runs at 1x the gap between the thread's time and real time is
constant: the clock goes through the close, after-hours, the night, the weekend and the next session without a jump or
a stop. Only Pause, the speed and Skip day change that gap. The clock exists from the day it belongs to opens: no name
has to be opened first.

**What a settle never does.** It never moves a name's session (a name is lifted to the clock only when she is on it:
`session.advance`, and only as far as its own tape goes) and never reveals anything past the clock, so the no-lookahead
cut is the day clock itself. The balance is read at that clock: realized P/L from the ledger plus every open position
priced at the clock (the last print at or before it: after-hours prints show, a night or a weekend adds none).

**The hand-over.** The day list is the unit that holds a day's names and book. It hands over to the next trading day
when the clock reaches that day's start (`roll`), carrying the clock unchanged. Nothing happens at the close.
"""

from datetime import datetime
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import et
from ai_trading.db.models import PracticePlan, PracticeThread, ReplayDayList
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


def _plan(db: Session, day: ReplayDayList) -> PracticePlan:
    plan = db.get(PracticePlan, day.plan_id)
    assert plan is not None
    return plan


def _window(db: Session, day: ReplayDayList) -> tuple[pd.Timestamp, pd.Timestamp]:
    """The day's tape: from where practice on it starts to the end of its extended session (the last time the day has
    bars). The clock itself is not bounded by it: it runs on past the end. Every name of the day shares it."""
    sessions = session_mod._sessions_of_day(db, day.id)
    start = _ts(sessions[0].window_start) if sessions else plan_mod.day_start(_plan(db, day), day.day)
    return start, session_mod.market_close(day.day, "extended")


def _focus_end(db: Session, day: ReplayDayList, tape_end: pd.Timestamp) -> pd.Timestamp | None:
    """Where her plan's practice window ends: a mark for the timeline, display only. None when it is not in the tape."""
    sessions = session_mod._sessions_of_day(db, day.id)
    window = sessions[0].spec["window"] if sessions else _plan(db, day).spec["setup"]["window"]
    mark = et(day.day, window["to"])
    return None if mark >= tape_end else mark


def _started(day: ReplayDayList | None) -> bool:
    """The day has a clock. Every open day has one from the moment it opens; a day stored before that rule gets its
    clock the first time it is read (`_ensure_clock`)."""
    return day is not None and day.status != "ended" and day.revealed_through is not None


def _ensure_clock(db: Session, day: ReplayDayList) -> None:
    if day.revealed_through is None and day.status != "ended":
        day.revealed_through = plan_mod.day_start(_plan(db, day), day.day).to_pydatetime()
        db.flush()


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
        "buying_power_usd": session_mod.day_buying_power(db, thread, day.id, books=books),
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
        "next_start": None,
        "server_now": svc.wall(),
        "account": None,
        "label": threads_mod.SIMULATED_LABEL,
    }
    if not _started(day):
        return out
    assert day is not None and day.revealed_through is not None
    clock = _ts(day.revealed_through)
    start, tape_end = _window(db, day)
    return {
        **out,
        "state": "running" if day.clock_running else "paused",
        "day_list_id": day.id,
        "day_no": day.day_no,
        "running": day.clock_running,
        "speed": day.clock_speed,
        "clock": clock,
        "window_start": start,
        "window_end": tape_end,
        "focus_end": _focus_end(db, day, tape_end),
        "next_start": plan_mod.next_day_start(db, day),
        "account": _account(db, svc, thread, day, clock),
    }


def read(db: Session, user_id: int, thread_id: int, svc: Services) -> dict[str, Any]:
    """The thread's clock now. A running clock is settled first (written back, committed with the request), so what a
    screen reads is the time the market is at, whether or not anyone was looking in between."""
    thread = _day_thread(db, user_id, thread_id)
    day = _open_day(db, thread, lock=False)
    if day is not None:
        if day.revealed_through is None:
            _ensure_clock(db, day)
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
        interval = sessions[0].spec["interval"] if sessions else _plan(db, day).spec["setup"]["interval"]
        return session_mod.next_bar_boundary(clock, INTERVAL_MINUTES[interval])
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
    """Play, pause or set the speed of the thread's clock (and, for a test or a tool, step or jump it), then answer it.
    The clock is settled first, so a speed change or a pause never re-prices time that already passed. The clock runs
    from the day's start with no name opened: the Summary is where time is controlled. `to` and `step` are forward
    only; no close, window or stop of hers stops them or a run."""
    thread = _day_thread(db, user_id, thread_id)
    day = _open_day(db, thread, lock=True)
    if day is None:
        raise ReplayProblem("No practice day is under way", path="clock", status=409)
    _ensure_clock(db, day)
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
        day.clock_running, day.clock_anchor_at = True, now
    elif running is False:
        day.clock_running, day.clock_anchor_at = False, None
    day.updated_at = now
    db.flush()
    return view(db, svc, thread, day)


def due(db: Session, day: ReplayDayList | None) -> bool:
    """The clock of an open day has reached the start of the plan's next trading day: the day hands over."""
    if not _started(day):
        return False
    assert day is not None and day.revealed_through is not None
    following = plan_mod.next_day_start(db, day)
    return following is not None and _ts(day.revealed_through) >= following


def roll(db: Session, user_id: int, thread_id: int, svc: Services) -> plan_mod.Opened | None:
    """The clock reached the next trading day's start: the day it was on ends (every open position books at its tape's
    end, the price the clock showed since) and the next day opens, with the clock carried over as it is (same time,
    speed and Play state). The clock is settled first, so a clock that ran past the start while nobody looked hands over
    on the next look. A clock left running for several days hands over day by day. None while the clock is short of the
    next start (the usual answer; a paused clock costs one read, no lock). The next list may not be ready (its data is
    being prepared): the caller then polls the hub, as after a Skip day."""
    thread = _day_thread(db, user_id, thread_id)
    opened: plan_mod.Opened | None = None
    while True:
        day = _open_day(db, thread, lock=False)
        if day is None:
            return opened
        _ensure_clock(db, day)
        session_mod.settle_day(db, svc, day.id)
        db.refresh(day)
        if not due(db, day):
            return opened
        day = _open_day(db, thread, lock=True)  # the day again, locked: a parallel poll may have handed it over already
        if day is None or not due(db, day):
            return opened
        assert day.revealed_through is not None
        carry = plan_mod.ClockCarry(at=day.revealed_through, running=day.clock_running, speed=day.clock_speed)
        plan_mod.end_day(db, user_id, day.id, svc)
        opened = plan_mod.open_next(db, user_id, svc, thread.id, carry=carry)
        if opened.day_list is None:
            return opened


def roll_of_session(db: Session, user_id: int, session_id: int, svc: Services) -> plan_mod.Opened | None:
    """`roll` for the thread a day-thread session belongs to (a chart that follows a running clock is what finds the
    next start first when nobody has the Summary open). None for a standalone or swing session."""
    row = db.get(session_mod.ReplaySession, session_id)
    if row is None or row.owner_user_id != user_id or row.day_list_id is None or row.thread_id is None:
        return None
    thread = db.get(PracticeThread, row.thread_id)
    return roll(db, user_id, row.thread_id, svc) if thread is not None and thread.mode == "day" else None


def skip_day(db: Session, user_id: int, thread_id: int, svc: Services) -> tuple[ReplayDayList, plan_mod.Opened]:
    """Skip to the next day: the one deliberate way to move time past what she watched. The clock jumps to the start of
    the plan's next trading day (over the night and the weekend), the day it leaves ends (every open position
    flattens at that day's tape end) and the next day's list opens with the clock there, at the same speed and Play
    state. On the plan's last day it runs to the end of that day's tape and ends it. A day never started is a Pass.
    The next day may not be ready yet (its data is still being prepared): the caller then polls the hub as it does
    after any open."""
    thread = _day_thread(db, user_id, thread_id)
    day = _open_day(db, thread, lock=True)
    if day is None:
        raise ReplayProblem("No practice day is under way", path="clock", status=409)
    _ensure_clock(db, day)
    session_mod.settle_locked(db, svc, day)
    following = plan_mod.next_day_start(db, day)
    target = following if following is not None else _window(db, day)[1]
    clock = session_mod.move_clock(db, svc, day, target)
    carry = (
        None
        if following is None
        else plan_mod.ClockCarry(at=clock.to_pydatetime(), running=day.clock_running, speed=day.clock_speed)
    )
    ended = plan_mod.end_day(db, user_id, day.id, svc)
    return ended, plan_mod.open_next(db, user_id, svc, thread.id, carry=carry)
