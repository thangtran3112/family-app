"""The freestyle thread's clock (ADR-0025, built on ADR-0018): play, pause, speed, jump, and the one move that crosses
time, `advance_thread`.

**The thread clock is real time, shifted.** Its time `T` is `practice_threads.clock_at`. While `clock_running` it
advances `clock_speed` x wall time since `clock_anchor_at`, and is *settled* (written back with a fresh anchor)
whenever a request reads or acts on it, under the thread row lock. Nothing ticks in a process, so a closed screen, a
logout, a deploy or a restart cannot stop it. While it runs at 1x the gap between the thread's time and real time is
constant: the clock goes through the close, after-hours, the night, the weekend and the next open without a jump or a
stop. Only Pause, the speed, a Jump and the horizon change that gap.

**Nothing happens at the close or the open.** There is no hand-over, no day to end and no review: a position changes
only when she trades it, when an order she placed fills, or when a split restates it. Every way time moves (a run, a
Jump, Next open, a step) is one call, `advance_thread(thread, T1)`, which walks the trading days in `(T0, T1]` in order
and, for the names the thread holds or has orders on: restates a split (a `split` mark), fills the working orders the
tape reached (earliest fill first, each against the cash as it then is), expires Day orders at their session's extended
close, and flags the stops that were crossed. Then `T` is `T1`. Everything is cut at `T1`.

**Forward only.** A `to` in the past is a 422 (`to == T` changes nothing), the write is `UPDATE ... WHERE clock_at <=
:t` so two tabs can never rewind each other (409), and the upper bound is the `horizon`: the extended close of the
latest session whose data is available under the 15-minute embargo. A `to` past it is a 422; a running clock reaches it
and pauses with `pause = {"kind": "horizon"}`, the only thing that stops time on its own, because the data does not
exist.
"""

from datetime import datetime, timedelta
from typing import Any

import pandas as pd
from sqlalchemy import update
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, previous_session
from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import PracticeMark, PracticeThread, ReplaySession
from ai_trading.replay import frames as frames_mod
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import orders as orders_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import positions as positions_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.data import EMBARGO, ReplayDayError
from ai_trading.replay.model import INTERVAL_MINUTES, Mark
from ai_trading.replay.session import ReplayProblem, Services

SPEEDS = (1, 2, 5, 10)
TIME_FORWARD_ONLY = "Time only moves forward · that time has passed"
CLOCK_MOVED = "The clock moved while this request ran · try again"
NO_CLOCK = "This thread has no clock yet · start its plan first"
CLOSED = "This thread is closed · its clock is frozen"
SPLIT_NO_SHARE = "A split left no whole share"
HORIZON_PAUSE = {"kind": "horizon"}


def _ts(value: datetime | pd.Timestamp) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


def horizon(now: datetime | pd.Timestamp) -> pd.Timestamp:
    """The latest instant the clock can be at (R3): the extended close of the most recent session whose data has passed
    the 15-minute embargo at `now`."""
    at = _ts(now)
    day = previous_session("stock", at.tz_convert(ET).date() + timedelta(days=1))  # latest session up to today
    while True:
        found = trading_session("stock", day)
        assert found is not None
        if found.extended_close + EMBARGO <= at:
            return found.extended_close
        day = previous_session("stock", day)


def _horizon_text(limit: pd.Timestamp) -> str:
    return f"There is no data past {limit.tz_convert(ET):%a %Y-%m-%d %H:%M} ET yet · jump to a time before it"


# -- the view ---------------------------------------------------------------------------------------------------------


def view(db: Session, svc: Services, thread: PracticeThread) -> dict[str, Any]:
    """`ThreadClockOut`: the clock as it stands now (the caller settled it), and the account at that clock."""
    limit = horizon(svc.now())
    out: dict[str, Any] = {
        "thread_id": thread.id,
        "state": "not_started",
        "running": False,
        "speed": thread.clock_speed,
        "clock": None,
        "start_at": None if thread.start_at is None else _ts(thread.start_at),
        "horizon": limit,
        "next_open": None,
        "pause": thread.clock_pause,
        "market": None,
        "server_now": svc.wall(),
        "account": None,
        "label": threads_mod.SIMULATED_LABEL,
    }
    if thread.clock_at is None:
        return out
    clock = _ts(thread.clock_at)
    following = positions_mod.next_open(clock)
    return {
        **out,
        "state": "running" if thread.clock_running else "paused",
        "running": thread.clock_running,
        "clock": clock,
        "next_open": following if following <= limit else None,
        "market": frames_mod.market_block(positions_mod.data_day(clock), clock, None, following),
        "account": session_mod.account(db, svc, thread, clock),
    }


def read(db: Session, user_id: int, thread_id: int, svc: Services) -> dict[str, Any]:
    """The thread's clock now. A running clock is settled first (written back, committed with the request), so what a
    screen reads is the time the market is at, whether or not anyone was looking in between."""
    thread = threads_mod.get_thread(db, user_id, thread_id)
    session_mod.settle_thread(db, svc, thread.id)
    db.refresh(thread)
    return view(db, svc, thread)


# -- moving time ------------------------------------------------------------------------------------------------------


def settle(db: Session, svc: Services, thread: PracticeThread) -> None:
    """Bring a running clock to now (ADR-0018): `T + speed x (now - anchor)`, through `advance_thread`, then a fresh
    anchor; at the horizon it stops there and pauses. Called with the thread lock held, by every request that reads or
    acts on the clock. A paused clock, a thread that never started, or an anchor in the future (clock skew) changes
    nothing."""
    if not thread.clock_running or thread.clock_at is None or thread.clock_anchor_at is None:
        return
    now = svc.wall()
    elapsed = (_ts(now) - _ts(thread.clock_anchor_at)).total_seconds()
    if elapsed <= 0:
        return
    thread.clock_anchor_at = now
    target = _ts(thread.clock_at) + pd.Timedelta(seconds=elapsed * thread.clock_speed)
    limit = horizon(svc.now())
    if target >= limit:
        advance_thread(db, svc, thread, max(limit, _ts(thread.clock_at)))
        thread.clock_running, thread.clock_anchor_at, thread.clock_pause = False, None, HORIZON_PAUSE
    else:
        advance_thread(db, svc, thread, target)


def advance_thread(db: Session, svc: Services, thread: PracticeThread, t1: datetime | pd.Timestamp) -> None:
    """Move the thread's time to `t1` (the caller holds the thread lock): the one pipeline every mover runs (R7). The
    clock only moves forward (an earlier `t1` is clamped to `T`, and the guarded write below is a 409 if a rewind ever
    slipped through); what lies in `(T, t1]` happens in order, and nothing there closes a position."""
    assert thread.clock_at is not None
    t0 = _ts(thread.clock_at)
    t1 = max(_ts(t1), t0).floor("us")  # a settled clock is a float of seconds: drop what Postgres cannot hold
    if t1 > t0:
        _cross(db, svc, thread, t0, t1)
    done = db.execute(
        update(PracticeThread)
        .where(PracticeThread.id == thread.id, PracticeThread.clock_at <= t1.to_pydatetime())
        .values(clock_at=t1.to_pydatetime(), updated_at=svc.now())
        .execution_options(synchronize_session=False)
    )
    if done.rowcount == 0:  # defence in depth: the lock already serialises writers
        raise ReplayProblem(CLOCK_MOVED, path="to", status=409)
    db.refresh(thread, ["clock_at", "updated_at"])


def _cross(db: Session, svc: Services, thread: PracticeThread, t0: pd.Timestamp, t1: pd.Timestamp) -> None:
    """What happens to the thread's book between `t0` and `t1`: splits, fills, Day expiry, stop flags (R7). Only the
    lanes that hold a position or a working order are touched."""
    books = session_mod.book(db, thread.id)
    work = [
        lane
        for lane in session_mod.lanes(db, thread.id, active=True)
        if books[lane.id][1] is not None or any(o["status"] == "working" for o in lane.orders or [])
    ]
    if not work:
        return
    store = svc.store_factory(db)
    first, last = positions_mod.data_day(t0), positions_mod.data_day(t1)
    events: list[tuple[pd.Timestamp, int, float]] = []
    if first <= last:
        for lane in work:
            for ex_date, ratio in positions_mod.split_events(svc.history, store, lane.symbol, first, last):
                found = trading_session("stock", ex_date)
                assert found is not None
                if t0 < found.extended_open <= t1:  # raw bars are post-split from the ex-date's first bar
                    events.append((found.extended_open, lane.id, ratio))
    cursor = t0
    for when, lane_id, ratio in sorted(events):
        _fills(db, svc, store, work, cursor, when)
        _split(db, svc, next(lane for lane in work if lane.id == lane_id), when, ratio)
        cursor = when
    _fills(db, svc, store, work, cursor, t1)
    for lane in work:
        session_mod.expire_orders(lane, t1, svc.now())
    _flag_stops(db, svc, store, work, t0, t1)
    db.flush()


def _split(db: Session, svc: Services, lane: ReplaySession, when: pd.Timestamp, ratio: float) -> None:
    """A split took effect at `when`: the position is restated by a `split` mark (shares x k, average cost / k, no P/L:
    `journal.assemble`) and every working order with it (shares x k rounded down, prices / k). ADR-0025 P7.
    ponytail: a reverse split's fraction is dropped (no cash in lieu), and a 3-for-1 limit of $100.00 becomes $33.33.
    The restatement is stamped at the ex-date's 04:00 ET, the first raw bar on the new basis; the thread's marks use
    the previous session's print until 09:30 (ADR-0025 D8), so T in the pre-market of an ex-date prices a restated
    position at an old-basis print until the open. Fix by dividing a pre-split print by the ratio in `mark_at`."""
    rows = session_mod._load_marks(db, lane.id)
    seq = (rows[-1].seq if rows else 0) + 1
    marks = session_mod._marks_of(rows)
    open_ = journal_mod.assemble(marks)[1]
    if open_ is not None:
        after = journal_mod.assemble([*marks, Mark(seq=seq, kind="split", at=when, price=None, ratio=ratio)])[1]
        db.add(
            PracticeMark(
                session_id=lane.id,
                seq=seq,
                kind="split",
                at=when.to_pydatetime(),
                price=None,
                shares=None,
                stop_price=None,
                note=f"Split {ratio:g}-for-1",
                trade_no=open_.no,
                source="auto",
                position_before={
                    "ratio": ratio,
                    "shares_before": open_.shares,
                    "shares_after": 0 if after is None else after.shares,
                },
                created_at=svc.now(),
            )
        )
    orders = [dict(o) for o in lane.orders or []]
    for order in orders:
        if order["status"] != "working":
            continue
        shares = int(order["shares"] * ratio + 1e-9)
        if shares < 1:
            session_mod._close_order(order, "cancelled", when, reason=SPLIT_NO_SHARE)
            continue
        order["shares"] = shares
        for key in ("limit_price", "stop_price"):
            if order[key] is not None:
                order[key] = round(order[key] / ratio, 2)
    lane.orders, lane.updated_at = orders, svc.now()
    db.flush()


def _fills(
    db: Session,
    svc: Services,
    store: Any,
    work: list[ReplaySession],
    since: pd.Timestamp,
    target: pd.Timestamp,
) -> None:
    """Fill the working orders whose bars close in `(since, target]`, across however many data days that is. Each order
    is read from the moment it was placed, and a Day order only up to its expiry. The fills of all the lanes are then
    booked together, earliest first (ties by order id), so two orders that compete for one balance are settled in the
    order the market proved them."""
    found: list[tuple[orders_mod.Fill, int, int]] = []
    for lane in work:
        orders = [dict(o) for o in lane.orders or []]
        changed = False
        for order in orders:
            if order["status"] != "working":
                continue
            start = max(since, _ts(order["placed_at"]))
            until = target
            if order.get("tif") == "day" and order.get("expires_at"):
                until = min(target, _ts(order["expires_at"]))
            if until <= start:
                continue
            try:
                fill, fired = orders_mod.first_fill_across(
                    side=session_mod._side_of(order),
                    type_=order["type"],
                    limit=order["limit_price"],
                    trigger=order["stop_price"],
                    triggered_at=None if order["triggered_at"] is None else _ts(order["triggered_at"]),
                    minutes_of=lambda day, symbol=lane.symbol: svc.history.day_inputs(store, symbol, day).bars_1m,
                    since=start,
                    target=until,
                )
            except ReplayDayError:  # no trades on a day for this name: nothing there to fill against
                continue
            if fired is not None and order["triggered_at"] != fired.isoformat():
                order["triggered_at"], changed = fired.isoformat(), True
            if fill is not None:
                found.append((fill, lane.id, order["id"]))
        if changed:
            lane.orders = orders
    for fill, lane_id, order_id in sorted(found, key=lambda hit: (hit[0].at, hit[2], hit[1])):
        session_mod.apply_fill(db, svc, lane_id, order_id, fill)
    db.flush()


def _flag_stops(
    db: Session, svc: Services, store: Any, work: list[ReplaySession], t0: pd.Timestamp, t1: pd.Timestamp
) -> None:
    """Stamp `stop_hit_at` on every open trade whose stop line the one-minute bars closing in `(t0, t1]` crossed, at the
    bar it crossed on, even inside a Jump. It is information for the Portfolio and the journal, never a control: the
    clock does not stop for a stop and a stop never exits (ADR-0025 P4)."""
    books = session_mod.book(db, work[0].thread_id)
    for lane in work:
        open_ = books[lane.id][1]
        if open_ is None or not open_.stops or lane.stop_hit_at is not None:
            continue
        previous = max(t0, open_.stops[-1][0])  # a stop counts from the moment it was set
        hold = positions_mod.Hold(
            id=None,
            symbol=lane.symbol,
            side=open_.side,  # type: ignore[arg-type]
            shares=open_.shares,
            entry_day=lane.day,
            entry_at=open_.entry_at,
            entry_price=open_.entry_price,
            stop_at_entry=open_.stop_price,
            stop_price=open_.stops[-1][1],
            stop_hit_at=None,
        )
        for end_day in orders_mod.chunk_ends(previous, t1):
            end = trading_session("stock", end_day)
            assert end is not None
            try:
                frame = svc.history.day_inputs(store, lane.symbol, end_day).bars_1m
            except ReplayDayError:
                continue
            crossing = positions_mod.first_stop_crossing(
                [hold], {lane.symbol: frame}, previous, min(t1, end.extended_close)
            )
            if crossing is not None:
                lane.stop_hit_at, lane.updated_at = crossing.at.to_pydatetime(), svc.now()
                break


# -- control ----------------------------------------------------------------------------------------------------------


def _step_target(db: Session, thread: PracticeThread, clock: pd.Timestamp) -> pd.Timestamp:
    plan = plan_mod.active_plan(db, thread.owner_user_id, thread_id=thread.id)
    interval = plan.spec["setup"]["interval"] if plan is not None else "1m"
    return session_mod.next_bar_boundary(clock, INTERVAL_MINUTES[interval])


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
    """Play or pause the thread's clock, set its speed, step it one bar, or jump it to a time (`to`), then answer it.
    The clock is settled first, so a speed change or a pause never re-prices time that already passed. `to` and `step`
    are forward only (a `to` in the past is a 422 on `to`; `to` equal to the clock changes nothing) and no later than
    the `horizon` (422): no close, no open, no weekend and no stop of hers stops them or a run, and none of them
    closes a position. A request that is refused leaves the speed and the Play state alone."""
    thread = threads_mod.get_thread(db, user_id, thread_id, lock=True)
    if thread.clock_at is None:
        raise ReplayProblem(NO_CLOCK, path="clock", status=409)
    if thread.status == "closed":
        raise ReplayProblem(CLOSED, path="clock", status=409)
    if speed is not None and speed not in SPEEDS:
        raise ReplayProblem("Pick 1x, 2x, 5x or 10x", path="speed")
    if to is not None and step is not None:
        raise ReplayProblem("Send either to or step", path="to")
    if step is not None and step != "bar":
        raise ReplayProblem("Time steps by one bar only", path="step")
    settle(db, svc, thread)
    now = svc.wall()
    clock = _ts(thread.clock_at)
    limit = horizon(svc.now())
    # Resolved before anything is written, so a refused `to` (past, beyond the data, no offset) changes nothing.
    target = None
    if to is not None:
        if pd.Timestamp(to).tzinfo is None:
            raise ReplayProblem("Send the time with its UTC offset", path="to")
        target = _ts(to)
        if target < clock:  # `to == clock` is a no-op, not a rewind
            raise ReplayProblem(TIME_FORWARD_ONLY, path="to")
    elif step is not None:
        target = _step_target(db, thread, clock)
    if target is not None and target > limit:
        raise ReplayProblem(_horizon_text(limit), path="to" if to is not None else "step")
    if speed is not None:
        thread.clock_speed = speed
        if thread.clock_running:
            thread.clock_anchor_at = now
    if target is not None and target > clock:
        advance_thread(db, svc, thread, target)
    if running:
        if _ts(thread.clock_at) >= limit:  # nothing past the horizon to run into
            thread.clock_running, thread.clock_anchor_at, thread.clock_pause = False, None, HORIZON_PAUSE
        else:
            thread.clock_running, thread.clock_anchor_at, thread.clock_pause = True, now, None
    elif running is False:
        thread.clock_running, thread.clock_anchor_at = False, None
    thread.updated_at = now
    db.flush()
    return view(db, svc, thread)


def next_open(db: Session, user_id: int, thread_id: int, svc: Services) -> pd.Timestamp | None:
    """The first regular open after the thread's time, or None past the horizon (the client sends it as `to`)."""
    thread = threads_mod.get_thread(db, user_id, thread_id)
    if thread.clock_at is None:
        return None
    following = positions_mod.next_open(_ts(thread.clock_at))
    return following if following <= horizon(svc.now()) else None


__all__ = ("SPEEDS", "advance_thread", "control", "horizon", "next_open", "read", "settle", "view")
