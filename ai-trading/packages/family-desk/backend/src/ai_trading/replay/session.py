"""The lane store and playhead (02o decisions 1 and 6, ADR-0025): open, feed, marks, orders, patch.

**A lane is a thread's book for one name** (`replay_sessions`, one active row per (thread, symbol) for the thread's
life). The thread owns the clock (`practice_threads.clock_at`, `replay/clock.py`); a lane's position is
`journal.assemble` over its marks, never cut at a day, and nothing the clock crosses (the close, a night, a weekend,
an open, a Jump) closes, ends or flattens it: it changes only by her trade, a resting order of hers filling, or a
split (`clock.advance_thread`).

**The no-lookahead guarantee lives here.** A lane carries `revealed_through`, a timestamp that only moves forward;
every read below is cut at it (or at the thread's time T for the live view of an open lane): bars whose period has
closed, prints with `time <= through`, signals whose bar close is at or before it. The would-fire list is stored on the
row and never serialized while the lane is active (only `fires_so_far`). A lane is lifted to the thread's time only
when she is on it (`advance(sync)`); wall time moves the thread's clock, never a lane's playhead. The playhead never
moves backward.

**Marks are practice records on a finished past**: the server stamps each at the playhead and prices it at the last
print at or before it, a stop note never exits, and nothing here touches a broker, an account or a live data path. A
market entry fills at that print; a working limit, stop or stop-limit entry (`orders.py`) fills when the thread's clock
crosses a bar that proves it, however many data days that takes (`clock.advance_thread`, `apply_fill`).

**A thread holds several open positions** (N names, one average-cost position each). A Buy or Sell mark is a fill
against the name's position: it adds to it, sells part of it, or flips it (ADR-0016; the walk is `journal.assemble`).
The one size rule is the cash check (`positions_mod.check_buying_power`), applied to the shares a fill OPENS against
the cash the open positions and the WORKING orders have not spent (`_reserved_cash`). Every position is marked by one
function (`positions_mod.mark_at`, ADR-0025 R8).
"""

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.contracts.practice_thread import DEFAULT_STARTING_BALANCE
from ai_trading.contracts.replay_session import ReplaySessionV1
from ai_trading.core.calendar import ET
from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import PracticeMark, PracticeThread, ReplaySession
from ai_trading.replay import frames
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import ledger as ledger_mod
from ai_trading.replay import orders as orders_mod
from ai_trading.replay import positions as positions_mod
from ai_trading.replay import signals as signals_mod
from ai_trading.replay.cache import BlobStore, DbBlobStore
from ai_trading.replay.data import DayInputs, History
from ai_trading.replay.model import (
    ENTRY_KINDS,
    EXIT_KINDS,
    INTERVAL_MINUTES,
    Fire,
    Mark,
    Plan,
    Span,
    add_span,
    spans_of,
    unseen,
)
from ai_trading.replay.tape import BIG_PRINT_USD, PACE_WINDOW_S, Prints, Tape, pace, select_rows, ticks

log = logging.getLogger(__name__)


def _threads() -> Any:
    """The threads module (the thread's balance and free cash), imported on first use: it imports this module."""
    from ai_trading.replay import threads

    return threads



def _clock() -> Any:
    """The clock module (it settles and advances the thread), imported on first use: it imports this module."""
    from ai_trading.replay import clock

    return clock


MINUTE = pd.Timedelta(minutes=1)
JUMP_TAPE_WINDOW = pd.Timedelta(minutes=30)  # a longer jump shows (and counts) only its last 30 minutes of prints
FEED_TAPE_WINDOW = pd.Timedelta(seconds=60)
FEED_PRINTS = 200
LOOKBACK_BARS_MAX = 6000  # the feed's warm-up bars (1-minute interval would otherwise carry about 9,600)
RATING_RANGE = (1, 5)
STAMP_SOURCE = "alpaca"
BEHIND_CLOCK = "This name is behind the thread clock · catch up before you {verb}"  # "Catch up" is the button's word
POSITION_CLOSED = "Position already closed"
THREAD_CLOSED = "Thread closed"
ORDER_EXPIRED = "Expired"
MAX_HELD_NAMES = 49  # a thread tracks at most this many names with a position or a working order (ADR-0025 P6)
HELD_CAP = f"A thread tracks at most {MAX_HELD_NAMES} names with a position or an order"
STALE_PRINT_S = 30  # a mark priced off a print older than this carries a warning
QUIET_PRINT_S = 60  # no eligible print for this long marks the tape quiet (a halt looks the same from here)
ATTENTION_S = 20  # a name left this many seconds of thread time (x speed) behind a running clock is still watched


class ReplayProblem(Exception):
    """A rejected request with a plain sentence: becomes `422 {"detail": {"problems": [...]}}` (or `status`)."""

    def __init__(self, message: str, path: str = "kind", status: int = 422) -> None:
        super().__init__(message)
        self.message, self.path, self.status = message, path, status


class SessionNotFound(Exception):
    pass


@dataclass
class Services:
    """The process-wide pieces a request needs. `store_factory` is the blob cache over a request's session."""

    history: History
    tape: Tape
    now: Callable[[], datetime] = lambda: datetime.now(UTC)
    # The wall clock the thread clock runs on (ADR-0018). In production it is `now`; a test or the E2E rig that pins
    # `now` (so a past day stays "finished", and `clock.horizon` stays put) leaves this one real, or moves it by hand.
    wall: Callable[[], datetime] = lambda: datetime.now(UTC)
    store_factory: Callable[[Session], BlobStore] = DbBlobStore
    sources: Any = None  # the `DataSources` behind `history` (the day list's earnings flag reads `earnings` from it)


@dataclass
class Ctx:
    """A lane row with everything computed from it, for one request. `inputs` are the bars of the lane's data day: the
    day of the thread's time T for an open lane (`positions_mod.data_day`), the row's own day for a legacy row."""

    row: ReplaySession
    svc: Services
    store: BlobStore
    inputs: DayInputs
    marks: list[Mark]
    fires: list[Fire]
    plan: Plan
    interval: str
    window_start: pd.Timestamp
    window_end: pd.Timestamp
    through: pd.Timestamp
    day_trades: list[journal_mod.Trade] = field(default_factory=list)  # the thread's other lanes, for the day rules
    db: Session | None = field(default=None, repr=False)  # the request's session
    thread: PracticeThread | None = field(default=None, repr=False)
    # The thread's time T capped at the end of this data day's tape (the night and the weekend add no bars); None for
    # a row that is not an open lane. A lane whose playhead trails it is "behind".
    day_clock: pd.Timestamp | None = None
    thread_time: pd.Timestamp | None = None  # the thread's one instant T, uncapped (None: not an open lane)
    away: list[Span] = field(default_factory=list)  # the spans she was on another name (02o-b2)
    filling: int | None = None  # the working order being filled right now: its cash reserve is released as it fills
    _cache: dict[str, Any] = field(default_factory=dict)

    @property
    def minutes(self) -> int:
        return INTERVAL_MINUTES[self.interval]

    @property
    def symbol(self) -> str:
        return self.row.symbol

    @property
    def feed(self) -> str:
        return self.row.tape_feed

    @property
    def behind_clock(self) -> bool:
        """This name's playhead is behind the thread's clock: it is revealed up to the playhead only, and it cannot be
        marked until a sync catches it up."""
        return self.day_clock is not None and self.through < self.day_clock


# -- small helpers -------------------------------------------------------------------------------------------


def _ts(value: datetime | pd.Timestamp) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


def market_open(day: date) -> pd.Timestamp:
    """The exchange's regular open (09:30 ET) of `day`: where a data day's chart begins."""
    found = trading_session("stock", day)
    assert found is not None
    return found.regular_open


def market_close(day: date, kind: str) -> pd.Timestamp:
    """The exchange's close for a session of `kind` ("regular" 16:00 ET, 13:00 on a half day; "extended" four hours
    after). The only time the replayed market stops on its own: a real day has no earlier end."""
    found = trading_session("stock", day)
    assert found is not None
    return found.regular_close if kind == "regular" else found.extended_close


def jsonable(value: Any) -> Any:
    """Journal dicts to plain JSON (timestamps as ISO strings) for the row's jsonb."""
    return json.loads(json.dumps(value, default=lambda o: o.isoformat() if hasattr(o, "isoformat") else float(o)))


def _plan_of(spec: dict[str, Any]) -> Plan:
    plan = spec["plan"]
    return Plan(
        stop_required=plan["stopRequired"] == "yes",
        signal_only=plan["signalOnly"] == "yes",
        max_loss_usd=plan.get("maxLossUsd"),
        max_trades=plan.get("maxTrades"),
    )


def stamp(through: pd.Timestamp) -> dict[str, Any]:
    return {"as_of": through, "source": STAMP_SOURCE, "quality": "delayed-15m", "freshness": "replay"}


def _marks_of(rows: list[PracticeMark]) -> list[Mark]:
    return [
        Mark(
            id=r.id,
            seq=r.seq,
            kind=r.kind,  # type: ignore[arg-type]
            at=_ts(r.at),
            price=None if r.price is None else float(r.price),
            shares=r.shares,
            stop_price=None if r.stop_price is None else float(r.stop_price),
            note=r.note,
            trade_no=r.trade_no,
            source=r.source,  # type: ignore[arg-type]
            day_pnl_usd=None if r.day_pnl_usd is None else float(r.day_pnl_usd),
            ratio=float(r.position_before["ratio"]) if r.kind == "split" and r.position_before else None,
        )
        for r in rows
    ]


def mark_out(mark: Mark) -> dict[str, Any]:
    return {
        "id": mark.id,
        "seq": mark.seq,
        "kind": mark.kind,
        "at": mark.at,
        "price": mark.price,
        "shares": mark.shares,
        "stop_price": mark.stop_price,
        "note": mark.note,
        "trade_no": mark.trade_no,
        "source": mark.source,
    }


def _load_marks(db: Session, session_id: int) -> list[PracticeMark]:
    return list(
        db.execute(
            select(PracticeMark).where(PracticeMark.session_id == session_id).order_by(PracticeMark.seq)
        ).scalars()
    )


# -- loading -------------------------------------------------------------------------------------------------


def get_row(db: Session, user_id: int, session_id: int, *, lock: bool = False) -> ReplaySession:
    query = select(ReplaySession).where(ReplaySession.id == session_id)
    if lock:
        query = query.with_for_update()
    row = db.execute(query).scalar_one_or_none()
    if row is None or row.owner_user_id != user_id:  # never confirm existence to a non-owner
        raise SessionNotFound(session_id)
    return row


# -- the thread's lock and clock ------------------------------------------------------------------------------


def _lock_thread(db: Session, session_id: int) -> PracticeThread | None:
    """The lane's thread, locked, or None for a row with no thread (a legacy standalone one). Every writer of a lane
    takes this lock before the lane row, so two writers of one thread cannot deadlock (ADR-0025 R1)."""
    thread_id = db.execute(select(ReplaySession.thread_id).where(ReplaySession.id == session_id)).scalar_one_or_none()
    if thread_id is None:
        return None
    return db.execute(select(PracticeThread).where(PracticeThread.id == thread_id).with_for_update()).scalar_one()


def _lock_and_settle(db: Session, svc: Services, user_id: int, session_id: int) -> PracticeThread | None:
    """`_lock_thread`, then bring a running thread clock to now (ADR-0018). A stranger gets the 404 before any lock or
    write, so it cannot move another user's clock."""
    get_row(db, user_id, session_id)
    thread = _lock_thread(db, session_id)
    if thread is not None:
        _clock().settle(db, svc, thread)
    return thread


def settle_thread(db: Session, svc: Services, thread_id: int | None) -> None:
    """`clock.settle` for a read: a cheap look first, so a paused clock (the usual case) takes no lock and writes
    nothing; a running one is locked, brought to now and committed with the request."""
    if thread_id is None:
        return
    running = db.execute(
        select(PracticeThread.clock_running).where(PracticeThread.id == thread_id)
    ).scalar_one_or_none()
    if running:
        thread = db.execute(select(PracticeThread).where(PracticeThread.id == thread_id).with_for_update()).scalar_one()
        _clock().settle(db, svc, thread)
        db.flush()  # a caller that refreshes the thread next must find what the settle wrote


def _watching(ctx: Ctx, previous: pd.Timestamp, clock: pd.Timestamp, *, needs_running: bool = False) -> bool:
    """She is on this name, not returning to it: its playhead trails the thread's clock by no more than `ATTENTION_S`
    of thread time (the screen syncs every couple of seconds, so a name on screen is never further behind than that;
    one she left falls further behind with every second the clock runs). Such a lift is the same minutes she was
    already watching, so it adds no away span. `needs_running`: the lift is not a screen's own `sync` but a mark or
    order on a name behind the clock, whose catch-up rules stay as they were unless the clock is running."""
    thread = ctx.thread
    return (
        thread is not None
        and (thread.clock_running or not needs_running)
        and (clock - previous).total_seconds() <= ATTENTION_S * thread.clock_speed
    )


def _follow_clock(db: Session, ctx: Ctx) -> bool:
    """A name she is on that a running clock left a few seconds behind is lifted quietly before she marks or orders on
    it, so a click never fails with "behind the thread clock" because the clock ran between two syncs."""
    clock = ctx.day_clock
    if clock is None or not ctx.behind_clock or not _watching(ctx, ctx.through, clock, needs_running=True):
        return False
    ctx.row.revealed_through = ctx.day_clock.to_pydatetime()
    ctx.through = ctx.day_clock
    ctx.row.updated_at = ctx.svc.now()
    db.flush()
    return True


def _clock_state(ctx: Ctx) -> dict[str, Any] | None:
    """The thread clock as a lane's frame reports it: `{running, speed}` while it runs, else None (and left out of the
    JSON). A chart that follows the clock shows a hint when it is not running; it has no controls (ADR-0018)."""
    thread = ctx.thread
    if thread is None or ctx.thread_time is None:
        return None
    return {"running": True, "speed": thread.clock_speed} if thread.clock_running else None


def _market_of(ctx: Ctx, series: frames.PreparedSeries, data_through: pd.Timestamp) -> dict[str, Any] | None:
    """`market` of a lane frame (None for a row that is not an open lane): the phase at the thread's time T, the tape
    end of the data day, the close of this name's last bar and when the next regular session opens."""
    if ctx.thread_time is None:
        return None
    return frames.market_block(
        positions_mod.data_day(ctx.thread_time),
        ctx.thread_time,
        series.last_bar_close(data_through),
        positions_mod.next_open(ctx.thread_time),
    )


# -- the cash ---------------------------------------------------------------------------------------------------------


def buying_power(
    db: Session,
    thread: PracticeThread,
    skipped: tuple[int, int] | None = None,
    books: dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]] | None = None,
) -> float:
    """A thread's buying power: its balance less the entry notional of every open position and less the cash its
    working orders hold back. The one figure the cash check enforces (`_lane_free_cash`) and the Portfolio shows
    (`account`). `skipped`: `(lane id, order id)` of the order that is filling now (its reserve is released)."""
    books = book(db, thread.id) if books is None else books
    opens = {lane_id: open_ for lane_id, (_, open_) in books.items() if open_ is not None}
    held = sum(t.entry_price * t.shares for t in opens.values())
    reserved = _reserved_cash(
        lanes(db, thread.id, active=True),
        lambda s: (None, 0) if s.id not in opens else (opens[s.id].side, opens[s.id].shares),
        skipped,
    )
    return round(_threads().balance(db, thread) - held - reserved, 2)


def _lane_free_cash(db: Session, row: ReplaySession, skip: int | None = None) -> float:
    """A lane's buying power: its thread's. A row with no thread (a legacy standalone one) has an account of its own,
    the default starting balance of a thread plus its own closed trades, so the same cash rule is the only size rule on
    every path; nothing is booked from it."""
    skipped = None if skip is None else (row.id, skip)
    thread = None if row.thread_id is None else db.get(PracticeThread, row.thread_id)
    if thread is None:
        closed, open_ = journal_mod.assemble(_marks_of(_load_marks(db, row.id)))
        held = 0.0 if open_ is None else open_.entry_price * open_.shares
        realized = journal_mod.usd_sum([journal_mod.trade_pnl(t) for t in closed])
        reserved = _reserved_cash([row], lambda _: (None, 0) if open_ is None else (open_.side, open_.shares), skipped)
        return round(DEFAULT_STARTING_BALANCE + realized - held - reserved, 2)
    return buying_power(db, thread, skipped)


def _check_buying_power(
    db: Session,
    row: ReplaySession,
    shares: int,
    price: float,
    *,
    closing: journal_mod.Trade | None = None,
    take: int = 0,
    skip: int | None = None,
) -> None:
    """The cash rule for the `shares` a fill opens or adds. A flip (`closing`, `take` shares of it closed first) closes
    the whole position before it opens the other way, so that notional comes back to the cash along with the closed
    shares' P/L. `skip`: the working order of this lane that is filling now (its reserve is released)."""
    free = _lane_free_cash(db, row, skip)
    if closing is not None and take:
        gain = journal_mod.pnl_usd(closing.sign, closing.entry_price, price, take)
        free = round(free + closing.entry_price * closing.shares + gain, 2)
    try:
        positions_mod.check_buying_power(shares=shares, price=price, free_cash_usd=free)
    except positions_mod.HoldProblem as exc:
        raise ReplayProblem(exc.message, path=exc.path, status=exc.status) from None


# -- the thread's book -----------------------------------------------------------------------------------------


def lanes(db: Session, thread_id: int, *, active: bool = False) -> list[ReplaySession]:
    """The thread's lanes in the order she opened them. `active`: the open ones only (an ended row is legacy history
    from before the freestyle thread: its marks are final and it holds no position)."""
    query = select(ReplaySession).where(ReplaySession.thread_id == thread_id)
    if active:
        query = query.where(ReplaySession.status == "active")
    return list(db.execute(query.order_by(ReplaySession.id)).scalars())


def book(db: Session, thread_id: int) -> dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]]:
    """`{lane id: (closed trades, open trade)}` for every lane of the thread: the whole book, however many days old.
    One marks query for the thread."""
    rows = lanes(db, thread_id)
    by_lane: dict[int, list[PracticeMark]] = {row.id: [] for row in rows}
    for mark in db.execute(
        select(PracticeMark)
        .where(PracticeMark.session_id.in_(list(by_lane)))
        .order_by(PracticeMark.session_id, PracticeMark.seq)
    ).scalars():
        by_lane[mark.session_id].append(mark)
    return {lane_id: journal_mod.assemble(_marks_of(marks)) for lane_id, marks in by_lane.items()}


@dataclass(frozen=True)
class Position:
    """An open practice position of the thread (a name's average-cost aggregate), with its lane and its mark at the
    thread's time."""

    row: ReplaySession
    trade: journal_mod.Trade
    price: float  # `positions_mod.mark_at`: the price AT THE THREAD'S TIME, never carried at cost unless there is none
    price_at: pd.Timestamp | None  # when that price printed; None: the name has no price at all (carried at cost)


def open_positions(db: Session, thread_id: int) -> list[tuple[ReplaySession, journal_mod.Trade]]:
    """`(lane, open position)` of every lane that holds one, in the order she opened the names."""
    by_id = {r.id: r for r in lanes(db, thread_id)}
    return [(by_id[lane_id], open_) for lane_id, (_, open_) in book(db, thread_id).items() if open_ is not None]


def lane_mark(db: Session, svc: Services, row: ReplaySession, at: pd.Timestamp) -> positions_mod.MarkPrice | None:
    """The lane's name priced at thread time `at` (`positions_mod.mark_at`), on the lane's own feed and interval."""
    return positions_mod.mark_at(
        svc,
        svc.store_factory(db),
        row.symbol,
        at,
        feed=row.tape_feed,
        minutes=INTERVAL_MINUTES[row.spec["interval"]],
    )


def positions(
    db: Session,
    svc: Services,
    thread_id: int,
    clock: pd.Timestamp,
    books: dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]] | None = None,
) -> list[Position]:
    """Every open trade of the thread priced at the thread's time. A name with no price at all is carried at its entry
    (no P/L); every other is marked by `mark_at`, the one function every surface prices with."""
    rows = {r.id: r for r in lanes(db, thread_id)}
    out = []
    for lane_id, (_, open_) in (books if books is not None else book(db, thread_id)).items():
        if open_ is None:
            continue
        found = lane_mark(db, svc, rows[lane_id], clock)
        out.append(
            Position(
                rows[lane_id],
                open_,
                open_.entry_price if found is None else found.price,
                None if found is None else found.at,
            )
        )
    return out


def thread_pnl(
    books: dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]], held: list[Position], as_of: Any
) -> dict[str, Any]:
    """The thread's live P/L: the closed trades of every lane plus every open trade marked at the thread's time
    (cent-exact)."""
    realized = journal_mod.usd_sum([journal_mod.trade_pnl(t) for closed, _ in books.values() for t in closed])
    open_ = journal_mod.usd_sum([p.trade.unrealized(p.price) for p in held])
    return {
        "realized_usd": realized,
        "open_usd": open_,
        "total_usd": journal_mod.usd_sum([realized, open_]),
        "open_count": len(held),
        "as_of": as_of,
    }


def _date_pnl(
    books: dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]], held: list[Position], at: pd.Timestamp
) -> float:
    """The ET date's P/L at `at`, the basis of the max-loss rule: what exited on that date plus the positions opened on
    it, marked at `at`. The date is a key, never an end (ADR-0025); a position carried in from an earlier date is not
    part of "today's" loss. ponytail: an add to a carried position still counts as carried."""
    day = at.tz_convert(ET).date()
    realized = [
        journal_mod.trade_pnl(t)
        for closed, _ in books.values()
        for t in closed
        if t.exit_at is not None and t.exit_at.tz_convert(ET).date() == day
    ]
    open_ = [p.trade.unrealized(p.price) for p in held if p.trade.entry_at.tz_convert(ET).date() == day]
    return journal_mod.usd_sum([*realized, *open_])


def account(
    db: Session,
    svc: Services,
    thread: PracticeThread,
    clock: pd.Timestamp,
    books: dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]] | None = None,
    held: list[Position] | None = None,
) -> dict[str, Any]:
    """The simulated account at the thread's time: the ledger's balance (realized, to the cent), what every open
    position is worth over its cost at that time, and the two together. One function of (ledger, each lane's open
    trade, `mark_at`): the header, the Portfolio and the Screen all read it (ADR-0025 R8)."""
    books = book(db, thread.id) if books is None else books
    held = positions(db, svc, thread.id, clock, books) if held is None else held
    pnl = thread_pnl(books, held, clock)
    cash = _threads().balance(db, thread)
    equity = journal_mod.usd_sum([cash, pnl["open_usd"]])
    return {
        "balance": cash,
        "open_pnl_usd": pnl["open_usd"],
        "equity_usd": equity,
        "buying_power_usd": buying_power(db, thread, books=books),
        "since_start_usd": journal_mod.usd_sum([equity, -float(thread.starting_balance)]),
        "positions": pnl["open_count"],
        "as_of": clock,
    }


def held_names(db: Session, thread_id: int) -> int:
    """How many names the thread tracks with a position or a working order (ADR-0025 P6): flat lanes are history."""
    books = book(db, thread_id)
    holding = {lane_id for lane_id, (_, open_) in books.items() if open_ is not None}
    holding |= {
        r.id for r in lanes(db, thread_id, active=True) if any(o["status"] == "working" for o in r.orders or [])
    }
    return len(holding)


def _check_held_cap(db: Session, row: ReplaySession) -> None:
    """A flat lane with no working order that is about to take its first position or order: the 50th name is a 409."""
    if row.thread_id is None or any(o["status"] == "working" for o in row.orders or []):
        return
    if journal_mod.assemble(_marks_of(_load_marks(db, row.id)))[1] is not None:
        return
    if held_names(db, row.thread_id) >= MAX_HELD_NAMES:
        raise ReplayProblem(HELD_CAP, path="symbol", status=409)


def _lane_trades(db: Session, row: ReplaySession) -> list[journal_mod.Trade]:
    """The closed trades of the thread's other lanes: the max loss and the trade limit count every name practised on a
    date (02o-b2)."""
    if row.thread_id is None:
        return []
    trades: list[journal_mod.Trade] = []
    for other in lanes(db, row.thread_id):
        if other.id != row.id:
            trades.extend(journal_mod.assemble(_marks_of(_load_marks(db, other.id)))[0])
    return trades


def context(db: Session, svc: Services, row: ReplaySession) -> Ctx:
    """The lane's inputs for a request. An open lane of a thread reads the bars of the data day of the thread's time T
    (`positions_mod.data_day`) and follows T as far as that day's tape goes; an ended legacy row keeps its own day."""
    thread = db.get(PracticeThread, row.thread_id) if row.thread_id is not None else None
    live = thread is not None and thread.clock_at is not None and row.status == "active"
    clock = _ts(thread.clock_at) if live and thread is not None and thread.clock_at is not None else None
    day = positions_mod.data_day(clock) if clock is not None else row.day
    store = svc.store_factory(db)
    inputs = svc.history.day_inputs(store, row.symbol, day)
    if clock is not None:
        window_start, window_end = market_open(day), market_close(day, "extended")
    elif row.status == "ended" or row.thread_id is not None:
        window_start, window_end = _ts(row.window_start), _ts(row.window_end)
    else:  # a standalone row from before the freestyle thread: it runs to the later of its end and its session's close
        window_start = _ts(row.window_start)
        window_end = max(_ts(row.window_end), market_close(row.day, row.spec["session"]))
    return Ctx(
        row=row,
        svc=svc,
        store=store,
        inputs=inputs,
        marks=_marks_of(_load_marks(db, row.id)),
        fires=signals_mod.load_fires(row.signals),
        plan=_plan_of(row.spec),
        interval=row.spec["interval"],
        window_start=window_start,
        window_end=window_end,
        through=_ts(row.revealed_through),
        day_trades=_lane_trades(db, row),
        db=db,
        thread=thread,
        # The thread's clock runs on past a name's tape (the night, the weekend): the name follows it only as far as it
        # has bars, so it is never "behind" a clock it cannot reach.
        day_clock=None if clock is None else min(clock, window_end),
        thread_time=clock,
        away=spans_of(row.away or []),
    )


# -- views over the revealed history --------------------------------------------------------------------------


def _series(ctx: Ctx, width: int | None = None) -> frames.PreparedSeries:
    """The name's prepared series at `width` minutes (the session's own interval by default): one per (symbol, day,
    interval) in the process, so a request slices it and never re-resamples."""
    return ctx.svc.history.series.get(ctx.inputs, ctx.minutes if width is None else width)


def _bar_rows(frame: pd.DataFrame) -> list[dict[str, Any]]:
    return [
        {
            "t": index,
            "o": float(row["open"]),
            "h": float(row["high"]),
            "l": float(row["low"]),
            "c": float(row["close"]),
            "v": float(row["volume"]),
            "ext": row["phase"] != "regular",
        }
        for index, row in frame.iterrows()
    ]


def _levels_of(ctx: Ctx, series: frames.PreparedSeries, through: pd.Timestamp) -> dict[str, Any]:
    return series.levels(through)


def _tape_lookup(svc: Services, store: BlobStore, symbol: str, feed: str) -> frames.LastPrint:
    """The name's last eligible print at or before a time, from the tape (a provider outage reads as no print)."""

    def last(through: pd.Timestamp) -> tuple[pd.Timestamp, float] | None:
        try:
            return svc.tape.last_print(store, symbol, through, feed)  # type: ignore[arg-type]
        except ProviderError as exc:
            log.warning("tape unavailable for the last price: %s", exc)
            return None

    return last


def last_price(ctx: Ctx, through: pd.Timestamp) -> tuple[float, pd.Timestamp] | None:
    """The price at `through` on the lane's data day (`frames.PreparedSeries.quote`): the last eligible print at or
    before it, else the last revealed 1-minute close, in whole cents (D-033) so what she sees is what the P/L runs on.
    A position is marked across days by `positions_mod.mark_at`, which falls back to the previous session."""
    found = _series(ctx).quote(through, _tape_lookup(ctx.svc, ctx.store, ctx.symbol, ctx.feed))
    return None if found is None else (found.price, found.at)


def _age_s(found: tuple[float, pd.Timestamp] | None, through: pd.Timestamp) -> int | None:
    """Seconds from the last eligible print to the playhead (never negative)."""
    return None if found is None else max(0, int((through - found[1]).total_seconds()))


def _marked(ctx: Ctx, found: tuple[float, pd.Timestamp] | None) -> float | None:
    """The price an open trade is marked at: the name's last price at its playhead, except a name behind the thread's
    clock, which is marked where the clock is (`positions_mod.mark_at`: the previous session's last print before the
    day's first bar). That is the price the Portfolio shows, so the number on the name's card is the number the
    thread's account runs on. The clock is the thread's revealed boundary, so this reads nothing it has not shown."""
    if ctx.thread_time is not None and ctx.behind_clock:
        assert ctx.thread is not None
        mark = lane_mark(ctx.db, ctx.svc, ctx.row, ctx.thread_time)  # type: ignore[arg-type]
        found = found if mark is None else (mark.price, mark.at)
    return None if found is None else found[0]


def _open_trade(ctx: Ctx, price: float | None) -> dict[str, Any] | None:
    _, open_ = journal_mod.assemble(ctx.marks)
    return journal_mod.open_trade_out(open_, price)


def _journal(ctx: Ctx, price: float | None) -> dict[str, Any]:
    """The lane's journal, read live and never final (ADR-0025): the trades of its whole life, the day rules counted on
    the ET date of its playhead."""
    fires = signals_mod.released(ctx.fires, ctx.through)
    return journal_mod.compute_journal(
        ctx.marks,
        bars=ctx.inputs.bars_1m,
        fires=fires,
        plan=ctx.plan,
        display_minutes=ctx.minutes,
        window_start=ctx.window_start,
        window_end=ctx.window_end,
        as_of=ctx.through,
        last_price=price,
        final=False,
        day_trades=ctx.day_trades,
        away=ctx.away,
        day=ctx.through.tz_convert(ET).date(),
    )


# -- session out ---------------------------------------------------------------------------------------------


def session_out(ctx: Ctx) -> dict[str, Any]:
    row = ctx.row
    ended = row.status == "ended"
    price = None if ended else _marked(ctx, last_price(ctx, ctx.through))
    released = signals_mod.released(ctx.fires, ctx.through)
    counts: dict[tuple[str, int], int] = {}
    for fire in released:
        counts[(fire.source, fire.id)] = counts.get((fire.source, fire.id), 0) + 1
    journal = row.journal if ended and row.journal is not None else _journal(ctx, price)
    return {
        "id": row.id,
        "day_list_id": row.day_list_id,
        "thread_id": row.thread_id,
        "attempt": row.attempt,
        "status": row.status,
        "spec": ReplaySessionV1.model_validate(row.spec),
        "window_start": ctx.window_start,
        "window_end": ctx.window_end,
        "revealed_through": ctx.through,
        "day_clock": ctx.day_clock,
        "behind_clock": not ended and ctx.behind_clock,
        "tape_feed": row.tape_feed,
        "armed": [{**ref, "fires_so_far": counts.get((ref["source"], ref["id"]), 0)} for ref in row.armed],
        "marks": [mark_out(m) for m in ctx.marks],
        "open_trade": None if ended else _open_trade(ctx, price),
        "orders": list(row.orders or []),
        "journal": journal,
        "notes": row.notes,
        "rating": row.rating,
        "created_at": row.created_at,
        "ended_at": row.ended_at,
        "stamp": stamp(ctx.through),
    }


# -- create --------------------------------------------------------------------------------------------------


def open_lane(
    db: Session,
    user_id: int,
    spec: ReplaySessionV1,
    svc: Services,
    thread: PracticeThread,
    *,
    day_list_id: int | None = None,
    tape_feed: str | None = None,
) -> ReplaySession:
    """The thread's lane for a name: its open one (resume), else a new one at the thread's time T (ADR-0025). One active
    row per (thread, symbol) for the life of the thread, so a position is never cut at a day: the lane's marks are the
    whole book of the name. `spec.day` and its window are labels of the data day it opened on and are never read as
    bounds. A name with no trades on that data day is a `ReplayDayError`. `day_list_id`: the thread's Screen."""
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    symbol = dumped["symbol"]
    existing = db.execute(
        select(ReplaySession).where(
            ReplaySession.thread_id == thread.id, ReplaySession.symbol == symbol, ReplaySession.status == "active"
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    if thread.clock_at is None:
        raise ReplayProblem("Start the thread's plan first · it has no clock yet", path="clock", status=409)
    clock = _ts(thread.clock_at)
    day = positions_mod.data_day(clock)
    now = svc.now()
    start, end = market_open(day), market_close(day, "extended")
    store = svc.store_factory(db)
    inputs = svc.history.day_inputs(store, symbol, day)  # raises ReplayDayError("No trades for ...")
    try:
        armed = signals_mod.resolve(db, user_id, dumped["armed"], symbol)
    except signals_mod.ArmProblem as exc:
        raise ReplayProblem(exc.message, path=f"armed.{exc.index}.id") from None
    # ponytail: the would-fire list is evaluated for the data day the lane opens on; a lane that lives on keeps that
    # list (the signals of its later days are not scored). Evaluate per data day when signal scoring matters there.
    fires = signals_mod.evaluate_window(
        armed, symbol, day, bars_1m=inputs.bars_1m, daily=inputs.daily, window_start=start, window_end=end
    )
    feed = tape_feed
    if feed is None:
        try:
            feed = svc.tape.probe_feed(store, symbol, start)
        except ProviderError as exc:  # a tape outage must not block the chart; prints retry on advance
            log.warning("tape probe failed for %s %s: %s", symbol, day, exc)
            feed = "sip"
    attempt = (
        db.execute(
            select(func.coalesce(func.max(ReplaySession.attempt), 0)).where(
                ReplaySession.owner_user_id == user_id, ReplaySession.symbol == symbol, ReplaySession.day == day
            )
        ).scalar_one()
        + 1
    )
    # Opened mid-way: the lane starts at the thread's time, so a would-fire signal that fired before it never reached
    # her on this name. The signal list keeps it (the chart shows it as history); the journal does not score it.
    joined = min(clock, end)
    row = ReplaySession(
        owner_user_id=user_id,
        symbol=symbol,
        day=day,
        attempt=attempt,
        schema_version=1,
        spec=dumped,
        armed=[a.ref() for a in armed],
        signals=signals_mod.dump_fires(fires),
        window_start=start.to_pydatetime(),
        window_end=end.to_pydatetime(),
        revealed_through=joined.to_pydatetime(),
        away=add_span([], start, joined),
        tape_feed=feed,
        status="active",
        journal=None,
        notes=None,
        rating=None,
        created_at=now,
        updated_at=now,
        ended_at=None,
        day_list_id=day_list_id,
        thread_id=thread.id,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:  # a concurrent open of the same lane: that one
        db.rollback()
        found = db.execute(
            select(ReplaySession).where(
                ReplaySession.thread_id == thread.id, ReplaySession.symbol == symbol, ReplaySession.status == "active"
            )
        ).scalar_one()
        return found
    return row


# -- advance and feed ----------------------------------------------------------------------------------------


def next_bar_boundary(after: pd.Timestamp, minutes: int) -> pd.Timestamp:
    """The next display-bar close strictly after `after`: wall-clock multiples of the interval (04:00 and 09:30
    are multiples of 15 minutes, so every phase bin lines up with them)."""
    local = after.tz_convert(ET)
    since_midnight = local.hour * 60 + local.minute + local.second / 60 + local.microsecond / 6e7
    nxt = (int(since_midnight // minutes) + 1) * minutes
    midnight = local.normalize()
    return (midnight + pd.Timedelta(minutes=nxt)).tz_convert("UTC")


def _prints_block(
    ctx: Ctx,
    after: pd.Timestamp,
    through: pd.Timestamp,
    *,
    min_size: int,
    min_notional: int,
    max_prints: int,
    pace_too: bool,
) -> dict[str, Any]:
    if ctx.feed == "off":  # a lane with the tape off fetches no prints at all
        return {
            "feed": ctx.feed,
            "rows": [],
            "count": 0,
            "volume": 0,
            "shown": 0,
            "big_print_usd": BIG_PRINT_USD,
            "pace": None,
        }
    tape = ctx.svc.tape
    after = max(after, through - JUMP_TAPE_WINDOW)
    try:
        window = tape.prints(ctx.store, ctx.symbol, after, through, ctx.feed)  # type: ignore[arg-type]
        previous = tape.last_print(ctx.store, ctx.symbol, after, ctx.feed) if len(window) else None  # type: ignore[arg-type]
        pace_block = None
        if pace_too:
            recent = tape.prints(
                ctx.store, ctx.symbol, through - pd.Timedelta(seconds=PACE_WINDOW_S), through, ctx.feed
            )  # type: ignore[arg-type]
            pace_block = pace(recent, seconds=PACE_WINDOW_S, avg_shares_per_s=ctx.inputs.avg_shares_per_s)
    except ProviderError as exc:  # the tape is a convenience: a provider outage degrades to "no prints", not a 5xx
        log.warning("tape unavailable for %s: %s", ctx.symbol, exc)
        window, previous, pace_block = Prints.empty(), None, None
    tick = ticks(window.p, None if previous is None else previous[1])
    rows, _ = select_rows(window, tick, min_size=min_size, min_notional=min_notional, max_prints=max_prints)
    return {
        "feed": ctx.feed,
        "rows": [(t, p, s, k) for t, p, s, k in rows],
        "count": len(window),
        "volume": window.volume,
        "shown": len(rows),
        "big_print_usd": BIG_PRINT_USD,
        "pace": pace_block,
    }


def _frame(
    ctx: Ctx,
    *,
    bars: list[dict[str, Any]],
    through: pd.Timestamp,
    width: int,
    interval: str,
    prints: dict[str, Any],
    signals: list[Fire],
) -> dict[str, Any]:
    series = _series(ctx, width)
    price = last_price(ctx, through)
    # A day-thread session's forming candle closes at the price the header shows, so the candle, the header and the
    # indicators read one number; a legacy row keeps its candle as the minutes built it.
    quote = None if price is None or ctx.thread_time is None else frames.Quote(price[0], price[1])
    forming = series.forming(through, quote)
    live = ctx.thread_time is not None and ctx.row.status != "ended"  # an open day-thread session follows the thread
    data_through = min(ctx.thread_time, series.tape_end) if live and ctx.thread_time is not None else through
    return {
        "revealed_through": through,
        "thread_time": ctx.thread_time,
        "data_through": data_through,
        "market": _market_of(ctx, series, data_through),
        "day_clock": ctx.day_clock,
        "behind_clock": ctx.day_clock is not None and ctx.through < ctx.day_clock,
        "at_end": through >= ctx.window_end,
        "bars": bars,
        "forming": forming,
        "indicators": series.indicators(pd.DatetimeIndex([b["t"] for b in bars]), forming, through, interval),
        "prints": prints,
        "signals": [
            {
                "source": f.source,
                "id": f.id,
                "name": f.name,
                "bias": f.bias,
                "bar_time": f.bar_time,
                "bar_close": f.bar_close,
                "close": f.close,
                "evidence": f.evidence,
                "seen": not unseen(ctx.away, f.bar_close),
            }
            for f in signals
        ],
        "levels": _levels_of(ctx, series, through),
        "last": None if price is None else {"price": price[0], "at": price[1], "age_s": _age_s(price, through)},
        "quiet_s": (
            age if ctx.feed != "off" and (age := _age_s(price, through)) is not None and age >= QUIET_PRINT_S else None
        ),
        "open_trade": _open_trade(ctx, _marked(ctx, price)),
        "orders": list(ctx.row.orders or []),
        "thread_clock": _clock_state(ctx),
        "stamp": stamp(through),
    }


def advance(
    db: Session,
    user_id: int,
    session_id: int,
    svc: Services,
    *,
    to: datetime | None,
    step: str | None,
    interval: str | None,
    min_size: int,
    min_notional: int,
    max_prints: int,
    sync: bool = False,
    since: datetime | None = None,
) -> dict[str, Any]:
    """Follow the thread's clock and answer the frame. This is the only thing a lane's `advance` does now (ADR-0025
    R2): `to` and `step` are 422, because a name must not move the thread's time (the thread's clock does, forward
    only). A lane behind the clock is lifted to it, and the span it was away is recorded unless she was on the name
    (`_watching`). Resting orders are not touched here: the thread's clock fills them as it crosses them."""
    if to is not None or step is not None or not sync:
        raise ReplayProblem(
            "Time moves at the thread · set it from the thread's clock", path="to" if to is not None else "step"
        )
    if since is not None and pd.Timestamp(since).tzinfo is None:
        raise ReplayProblem("`since` is a time with its UTC offset, sent with sync", path="since")
    _lock_and_settle(db, svc, user_id, session_id)  # the thread row first, then the lane row
    row = get_row(db, user_id, session_id, lock=True)
    ctx = context(db, svc, row)
    width = INTERVAL_MINUTES[interval or ctx.interval]
    previous = ctx.through
    clock = ctx.day_clock
    if row.status == "ended":
        target = ctx.window_end
    elif clock is None:
        target = previous
    else:
        # A name behind the thread's clock catches up to it: what lies between is revealed on the chart but was never
        # in front of her, and the journal does not score a signal that fired inside it (02o-b2).
        if previous < clock and not _watching(ctx, previous, clock):
            row.away = add_span(list(row.away or []), previous, clock)
            ctx.away = spans_of(row.away)
        target = max(previous, clock)
    target = min(max(target, previous), ctx.window_end)  # forward only; clamped to the data day's tape end
    if target > previous:
        row.revealed_through = target.to_pydatetime()
        row.updated_at = svc.now()
        db.flush()
        ctx.through = target

    # The answer starts where the caller's view ends, not only where the lane's one playhead was: a second window on
    # this name has a playhead the first one already moved (D-198). Never before the window, never past it.
    shown_from = previous if since is None else min(previous, max(_ts(since), ctx.window_start))
    new_bars = _series(ctx, width).bars_between(shown_from, target)
    prints = _prints_block(
        ctx, shown_from, target, min_size=min_size, min_notional=min_notional, max_prints=max_prints, pace_too=True
    )
    fresh = [f for f in ctx.fires if shown_from < f.bar_close <= target]
    frame = _frame(
        ctx,
        bars=_bar_rows(new_bars),
        through=target,
        width=width,
        interval=interval or ctx.interval,
        prints=prints,
        signals=fresh,
    )
    frame["paused"] = None  # the clock never stops for a stop (a crossed stop is a flag); the response leaves None out
    frame["fills"] = None  # a resting order fills when the thread's clock crosses it, not on a sync
    return frame


def feed(
    db: Session,
    user_id: int,
    session_id: int,
    svc: Services,
    *,
    interval: str | None,
    min_size: int = 0,
    min_notional: int = 0,
) -> dict[str, Any]:
    """Everything revealed so far at `interval`: the lookback for warm-up, the revealed window, the last minute of
    prints, the released signals (all of them once a legacy session has ended). Never past `revealed_through`, except
    that an open lane is read at the thread's time T (cut at its data day's tape end): see the comment below."""
    row = get_row(db, user_id, session_id)
    settle_thread(db, svc, row.thread_id)
    ctx = context(db, svc, row)
    name = interval or ctx.interval
    width = INTERVAL_MINUTES[name]
    if row.status == "ended":
        through = ctx.through = ctx.window_end
    elif ctx.thread_time is not None:
        # An open day-thread session reads at the thread's time T (cut at its tape end), never at its own stored
        # playhead: a name nobody synced shows the same bars, price and levels as the Summary's clock. The playhead
        # stays where it is (a GET writes nothing) and so does `behind_clock`, the write gate: marks and orders still
        # wait for an advance to lift the name. What lies between the playhead and T is shown but was never in front of
        # her, so a signal inside it reads as unseen, exactly as the lift will record it.
        through = max(ctx.through, min(ctx.thread_time, ctx.window_end))
        if ctx.through < through:
            ctx.away = [*ctx.away, (ctx.through, through)]
    else:
        through = ctx.through
    display = _series(ctx, width).bars(through)
    display = display.tail(LOOKBACK_BARS_MAX + len(display[display.index >= ctx.window_start]))
    prints = _prints_block(
        ctx,
        through - FEED_TAPE_WINDOW,
        through,
        min_size=min_size,
        min_notional=min_notional,
        max_prints=FEED_PRINTS,
        pace_too=True,
    )
    shown = ctx.fires if row.status == "ended" else signals_mod.released(ctx.fires, through)
    frame = _frame(
        ctx, bars=_bar_rows(display), through=through, width=width, interval=name, prints=prints, signals=shown
    )
    return {**frame, "interval": name, "window_start": ctx.window_start}


# -- marks ---------------------------------------------------------------------------------------------------


def place_mark(db: Session, user_id: int, session_id: int, svc: Services, body: dict[str, Any]) -> dict[str, Any]:
    """Stamp a practice mark at the playhead. State rules answer 422 with `path: "kind"` or `"stopPrice"`. An entry
    needs no stop: the thread's "stop on every entry" plan is scored, never a reason to refuse. A Buy or Sell is a fill
    against the name's position (adds, sells part, or flips); only the shares it opens must fit the cash."""
    _lock_and_settle(db, svc, user_id, session_id)  # the thread row first, then the lane row: one lock order
    row = get_row(db, user_id, session_id, lock=True)
    if row.status != "active":
        raise ReplayProblem("This session is over · its thread no longer takes marks", path="kind")
    ctx = context(db, svc, row)
    if ctx.behind_clock and not _follow_clock(db, ctx):
        # Revealed but not markable: the thread's clock is ahead of this name's playhead, so a mark here would be
        # stamped at a time the thread has already passed. A catch-up (the screen's "Catch up") moves the name to the
        # clock first. A note is refused too: it would be stamped before the clock the thread is already past.
        raise ReplayProblem(BEHIND_CLOCK.format(verb="mark"), path="kind")
    return _place(db, ctx, body, svc)


def _place(
    db: Session, ctx: Ctx, body: dict[str, Any], svc: Services, *, fill: orders_mod.Fill | None = None
) -> dict[str, Any]:
    """The mark itself, for a locked, current session. `fill` is a working order the tape just proved: the entry is
    stamped at the fill's time and price instead of at the playhead's last print."""
    row = ctx.row
    kind = body["kind"]
    closed, open_ = journal_mod.assemble(ctx.marks)
    price = None
    warning = None
    at = ctx.through if fill is None else fill.at
    if fill is not None:
        price = fill.price
    elif kind != "note":
        found = last_price(ctx, ctx.through)
        if found is None:
            raise ReplayProblem("No price yet · advance the replay first", path="kind")
        price = found[0]
        age = _age_s(found, ctx.through)
        if age is not None and age >= STALE_PRINT_S:
            warning = f"Priced off a print {age} s old · the tape has been quiet"

    stop_price = body.get("stopPrice")
    shares = None
    trade_no = None
    take = rest = 0
    if kind in ENTRY_KINDS:
        # A fill against the name's position: it closes shares first, then opens (or adds to) a position with the rest.
        side = "long" if kind == "long_entry" else "short"
        shares = body.get("shares") or row.spec["shares"]
        take, rest = journal_mod.fill_split(
            None if open_ is None else open_.side, 0 if open_ is None else open_.shares, side, shares
        )
        if open_ is None:
            trade_no = max((t.no for t in closed), default=0) + 1
        else:
            trade_no = open_.no + (1 if take and rest else 0)  # a flip is a new position
        remaining = None if open_ is None else (open_.side if take < open_.shares else None)
        stays = side if rest else remaining  # the side of the position the fill leaves behind, if any
        if stop_price is not None and stays is not None:
            _check_stop_side(stays == "long", stop_price, price)
        if rest:
            if open_ is None and fill is None:
                _check_held_cap(db, row)
            _check_buying_power(db, row, rest, price, closing=open_ if take else None, take=take, skip=ctx.filling)
    elif kind in EXIT_KINDS:
        wanted = "long" if kind == "long_exit" else "short"
        if open_ is None or open_.side != wanted:
            raise ReplayProblem("No open practice trade to exit", path="kind")
        trade_no = open_.no
    elif kind == "stop":
        if open_ is None:
            raise ReplayProblem("Open a practice trade before setting a stop", path="kind")
        _check_stop_side(open_.side == "long", stop_price, price)
        trade_no = open_.no

    day_pnl_usd = None
    if rest and row.thread_id is not None:
        # The max-loss rule's basis: the ET date's P/L when she entered (what exited that date plus the positions
        # opened on it, every one marked at the entry's time).
        books = book(db, row.thread_id)
        day_pnl_usd = _date_pnl(books, positions(db, svc, row.thread_id, at, books), at)
    mark = PracticeMark(
        session_id=row.id,
        seq=(ctx.marks[-1].seq if ctx.marks else 0) + 1,
        kind=kind,
        at=at.to_pydatetime(),
        price=price,
        shares=shares,
        stop_price=stop_price,
        note=body.get("note"),
        trade_no=trade_no,
        source="her",
        day_pnl_usd=day_pnl_usd,
        created_at=svc.now(),
    )
    db.add(mark)
    row.updated_at = svc.now()
    if kind != "note":  # a new entry, stop note or exit clears the stop pause flag
        row.stop_hit_at = None
    db.flush()
    ctx.marks = _marks_of(_load_marks(db, row.id))
    if take or kind in EXIT_KINDS:  # the mark realized a trade: the ledger books it (and the balance moves)
        closed, _ = journal_mod.assemble(ctx.marks)
        ledger_mod.book(db, row, closed, svc.now())
    placed = next(m for m in ctx.marks if m.seq == mark.seq)
    if fill is not None:  # a resting order's fill: the booking is all the caller needs, not a journal
        return {"mark": mark_out(placed)}
    return {
        "mark": mark_out(placed),
        "open_trade": _open_trade(ctx, price if price is not None else _price_or_none(ctx)),
        "journal": _journal(ctx, price if price is not None else _price_or_none(ctx)),
        "warning": warning,
    }


# -- working orders -------------------------------------------------------------------------------------------
# A limit, stop or stop-limit entry that is not marketable waits in `replay_sessions.orders` and fills when the thread's
# clock crosses a bar that proves it (`clock.advance_thread`, which may cross several days in one move;
# replay/orders.py has the rules). A market entry is `place_mark`. A fill is a Buy or Sell against the name's position
# whatever it is when the order fills (it can add, sell part, or flip); only the cash can cancel it, with the reason.
# An order is GTC (default) or Day (cancelled "Expired" at the extended close of its session); a closing order is
# reduce-only (`min(order, position)` at the fill, cancelled "Position already closed" when the position is gone).


def _side_of(order: dict[str, Any]) -> str:
    return "long" if order["side"] == "buy" else "short"


def _entry_kind_of(order: dict[str, Any]) -> str:
    return "long_entry" if order["side"] == "buy" else "short_entry"


def _close_order(
    order: dict[str, Any],
    status: str,
    at: pd.Timestamp,
    *,
    reason: str | None = None,
    price: float | None = None,
    mark_id: int | None = None,
) -> None:
    order.update(status=status, closed_at=at.isoformat(), reason=reason, fill_price=price, mark_id=mark_id)


def place_order(db: Session, user_id: int, session_id: int, svc: Services, body: dict[str, Any]) -> dict[str, Any]:
    """Place a limit, stop or stop-limit order at the playhead, GTC (default) or Day (`timeInForce`). A limit that
    already accepts the last price is marketable and fills at once at that price; anything else waits for the thread's
    clock to cross it. An order against an open position that is on the other side and no larger than it is
    reduce-only (derived, no toggle). State rules answer 422 with a path (`limitPrice`, `stopPrice`, `shares`, `kind`).
    Affordability is checked now and again at the fill."""
    _lock_and_settle(db, svc, user_id, session_id)
    row = get_row(db, user_id, session_id, lock=True)
    if row.status != "active":
        raise ReplayProblem("This session is over · its thread no longer takes orders", path="kind")
    ctx = context(db, svc, row)
    if ctx.behind_clock and not _follow_clock(db, ctx):
        raise ReplayProblem(BEHIND_CLOCK.format(verb="order"), path="kind")
    side = "long" if body["side"] == "buy" else "short"
    shares = body.get("shares") or row.spec["shares"]
    found = last_price(ctx, ctx.through)
    if found is None:
        raise ReplayProblem("No price yet · advance the replay first", path="kind")
    try:
        limit, trigger = orders_mod.check_new(
            side=side,
            type_=body["orderType"],
            limit=body.get("limitPrice"),
            trigger=body.get("stopPrice"),
            last=found[0],
        )
    except orders_mod.OrderProblem as exc:
        raise ReplayProblem(exc.message, path=exc.path) from None
    entry = "long_entry" if side == "long" else "short_entry"
    tif = body.get("timeInForce", "gtc")
    open_ = journal_mod.assemble(ctx.marks)[1]
    record = {
        "id": 1 + max((o["id"] for o in row.orders or []), default=0),
        "side": body["side"],
        "type": body["orderType"],
        "shares": shares,
        "limit_price": limit,
        "stop_price": trigger,
        "tif": tif,
        "expires_at": orders_mod.day_expiry(ctx.through).isoformat() if tif == "day" else None,
        "reduce_only": open_ is not None and open_.side != side and shares <= open_.shares,
        "status": "working",
        "placed_at": ctx.through.isoformat(),
        "triggered_at": None,
        "closed_at": None,
        "fill_price": None,
        "mark_id": None,
        "reason": None,
    }
    if orders_mod.marketable(side, body["orderType"], limit, found[0]):
        out = _place(db, ctx, {"kind": entry, "shares": shares}, svc)
        _close_order(record, "filled", ctx.through, price=out["mark"]["price"], mark_id=out["mark"]["id"])
    else:
        _check_held_cap(db, row)
        _check_can_work(db, ctx, side, shares, limit if limit is not None else trigger)
        out = {
            "mark": None,
            "open_trade": _open_trade(ctx, found[0]),
            "journal": _journal(ctx, found[0]),
            "warning": None,
        }
    row.orders = [*(row.orders or []), record]
    row.updated_at = svc.now()
    db.flush()
    return {**out, "order": record, "orders": list(row.orders)}


def _check_can_work(db: Session, ctx: Ctx, side: str, shares: int, reference: float | None) -> None:
    """The rule a working order must pass now: the shares it would open, at its own price (a stop is priced at its
    trigger), fit the free cash as the position stands. The same rule runs again when it fills."""
    assert reference is not None
    open_ = journal_mod.assemble(ctx.marks)[1]
    take, rest = journal_mod.fill_split(
        None if open_ is None else open_.side, 0 if open_ is None else open_.shares, side, shares
    )
    if rest:
        _check_buying_power(db, ctx.row, rest, reference, closing=open_ if take else None, take=take)


def cancel_order(db: Session, user_id: int, session_id: int, order_id: int, svc: Services) -> dict[str, Any]:
    """Cancel a working order. 404 for an unknown order, 409 for one that is no longer working."""
    get_row(db, user_id, session_id)  # 404 before any lock for a stranger
    thread = _lock_thread(db, session_id)
    row = get_row(db, user_id, session_id, lock=True)
    orders = [dict(o) for o in row.orders or []]
    target = next((o for o in orders if o["id"] == order_id), None)
    if target is None:
        raise SessionNotFound(order_id)
    if target["status"] != "working":
        raise ReplayProblem("That order is no longer working", path="kind", status=409)
    at = _ts(thread.clock_at) if thread is not None and thread.clock_at is not None else _ts(row.revealed_through)
    _close_order(target, "cancelled", at)
    row.orders, row.updated_at = orders, svc.now()
    db.flush()
    return {"order": target, "orders": orders}


def apply_fill(db: Session, svc: Services, lane_id: int, order_id: int, fill: orders_mod.Fill) -> Mark | None:
    """Book a working order the thread's clock proved (`clock.advance_thread`): an ordinary Buy or Sell mark stamped at
    the fill's bar close and priced at the fill, in the lane's one book, at the account's cash as it is NOW (two fills
    of one move compete for one balance: the earlier wins, the later is cancelled with the cash reason). A reduce-only
    order fills `min(order, position)` and is cancelled "Position already closed" when the position is gone. The caller
    holds the thread lock; this takes the lane's. None when the order was cancelled instead of filled."""
    row = db.execute(select(ReplaySession).where(ReplaySession.id == lane_id).with_for_update()).scalar_one()
    orders = [dict(o) for o in row.orders or []]
    order = next((o for o in orders if o["id"] == order_id and o["status"] == "working"), None)
    if order is None:
        return None
    ctx = context(db, svc, row)
    open_ = journal_mod.assemble(ctx.marks)[1]
    shares = order["shares"]
    if order.get("reduce_only"):
        shares = orders_mod.reduce_shares(
            shares, _side_of(order), None if open_ is None else open_.side, 0 if open_ is None else open_.shares
        )
        if shares == 0:
            _close_order(order, "cancelled", fill.at, reason=POSITION_CLOSED)
            row.orders, row.updated_at = orders, svc.now()
            db.flush()
            return None
    ctx.filling = order_id  # its cash reserve is released as it fills; the other working orders still hold cash back
    try:
        with db.begin_nested():
            out = _place(db, ctx, {"kind": _entry_kind_of(order), "shares": shares}, svc, fill=fill)
    except ReplayProblem as exc:
        _close_order(order, "cancelled", fill.at, reason=exc.message)
        row.orders, row.updated_at = orders, svc.now()
        db.flush()
        return None
    finally:
        ctx.filling = None
    _close_order(order, "filled", fill.at, price=fill.price, mark_id=out["mark"]["id"])
    row.orders, row.updated_at = orders, svc.now()
    db.flush()
    return next(m for m in ctx.marks if m.id == out["mark"]["id"])


def expire_orders(row: ReplaySession, until: pd.Timestamp, now: datetime) -> None:
    """Cancel the lane's working Day orders whose session ended at or before `until`: "Expired", stamped at the
    session's extended close. The market's rule, not a practice rule: a GTC order never expires, and a Day order a
    fill reached first is already filled."""
    orders = [dict(o) for o in row.orders or []]
    changed = False
    for order in orders:
        if order["status"] == "working" and order.get("tif") == "day" and _ts(order["expires_at"]) <= until:
            _close_order(order, "cancelled", _ts(order["expires_at"]), reason=ORDER_EXPIRED)
            changed = True
    if changed:
        row.orders, row.updated_at = orders, now


def cancel_working(db: Session, thread_id: int, at: pd.Timestamp, reason: str, now: datetime) -> int:
    """Cancel every working order of every lane of the thread, stamped at `at` (closing a thread). Returns how many."""
    count = 0
    for row in lanes(db, thread_id, active=True):
        orders = [dict(o) for o in row.orders or []]
        for order in orders:
            if order["status"] == "working":
                _close_order(order, "cancelled", at, reason=reason)
                count += 1
        if count:
            row.orders, row.updated_at = orders, now
    db.flush()
    return count


def _order_price(order: dict[str, Any]) -> float:
    """What a working order is priced at for the cash rule: its limit, else its trigger."""
    return order["limit_price"] if order["limit_price"] is not None else order["stop_price"]


def _reserved_cash(
    sessions: list[ReplaySession],
    held_of: Callable[[ReplaySession], tuple[str | None, int]],
    skip: tuple[int, int] | None = None,
) -> float:
    """The cash the WORKING orders of `sessions` hold back, like a broker's buying power: each reserves the entry
    notional of the shares it would open or add to against its name's position as it stands now (`held_of`: side and
    shares; the shares it would close need no cash), at its own price. `skip` is `(session id, order id)` of the order
    being filled: it is turning into the position, not a reserve. A second affordable order that the first one leaves
    no cash for is refused when it is placed, not cancelled when it fills."""
    total = 0.0
    for session in sessions:
        side, shares = held_of(session)
        for order in session.orders or []:
            if order["status"] != "working" or (session.id, order["id"]) == skip:
                continue
            _, rest = journal_mod.fill_split(side, shares, _side_of(order), order["shares"])
            total += rest * _order_price(order)
    return total


def _price_or_none(ctx: Ctx) -> float | None:
    found = last_price(ctx, ctx.through)
    return None if found is None else found[0]


def _check_stop_side(is_long: bool, stop_price: float, price: float | None) -> None:
    if price is None:
        return
    if is_long and stop_price >= price:
        raise ReplayProblem("A long stop goes below the last price", path="stopPrice")
    if not is_long and stop_price <= price:
        raise ReplayProblem("A short stop goes above the last price", path="stopPrice")


def undo_mark(db: Session, user_id: int, session_id: int, mark_id: int, svc: Services) -> dict[str, Any]:
    """Remove the last mark, only while the playhead has not moved since it was placed (else 409)."""
    get_row(db, user_id, session_id)  # 404 before any lock for a stranger
    thread = _lock_thread(db, session_id)  # the lock order: thread, lane
    row = get_row(db, user_id, session_id, lock=True)
    ctx = context(db, svc, row)
    target = next((m for m in ctx.marks if m.id == mark_id), None)
    if target is None:
        raise SessionNotFound(mark_id)
    if any(o.get("mark_id") == mark_id for o in row.orders or []):
        raise ReplayProblem("A filled order can't be undone · exit the trade instead", path="kind", status=409)
    if row.status != "active" or target.seq != ctx.marks[-1].seq or target.source != "her" or target.at != ctx.through:
        raise ReplayProblem("Only the last mark can be undone, before the replay moves on", path="kind", status=409)
    # The shared day clock is the playhead too: another name's advance past this mark seals it (no peeking at the open
    # position's P/L on the Portfolio, then undoing the entry).
    clock = None if thread is None or thread.clock_at is None else _ts(thread.clock_at)
    if clock is not None and clock > target.at:
        raise ReplayProblem("Only the last mark can be undone, before the replay moves on", path="kind", status=409)
    free_before = _lane_free_cash(db, row)
    db.delete(db.get(PracticeMark, mark_id))
    row.updated_at = svc.now()
    row.stop_hit_at = None
    db.flush()
    # Undoing an exit or a sale puts its shares back among the open ones (and its ledger row goes), so they pass the
    # cash rule again as the other names stand: another name may have spent the cash since (the shared day clock lets
    # a second name mark at the same moment). 409, and the request's transaction rolls the delete back.
    free_after = _lane_free_cash(db, row)
    if free_after < 0 and free_after < free_before:
        raise ReplayProblem(
            "Can't undo that · it would leave you without enough practice cash", path="kind", status=409
        )
    ctx.marks = [m for m in ctx.marks if m.id != mark_id]
    price = _price_or_none(ctx)
    return {
        "removed_mark_id": mark_id,
        "open_trade": _open_trade(ctx, price),
        "journal": _journal(ctx, price),
    }


# -- the Portfolio ---------------------------------------------------------------------------------------------


def portfolio(db: Session, svc: Services, thread: PracticeThread) -> dict[str, Any]:
    """The thread's Portfolio at its time T (`GET /threads/{id}/portfolio`): every open position across the lanes at its
    `mark_at` price, the working orders, and the account. One read of the book, one price function (ADR-0025 R8): what
    a position was worth a month ago or a Jump ago is not stored anywhere, it is this read at the new T."""
    from ai_trading.replay import threads as threads_mod

    base = {"thread_id": thread.id, "label": threads_mod.SIMULATED_LABEL}
    if thread.clock_at is None:
        return {**base, "as_of": None, "positions": [], "orders": [], "account": None}
    clock = _ts(thread.clock_at)
    books = book(db, thread.id)
    held = positions(db, svc, thread.id, clock, books)
    rows = [
        {
            "session_id": p.row.id,
            "symbol": p.row.symbol,
            "side": p.trade.side,
            "shares": p.trade.shares,
            "avg_cost": p.trade.entry_price,
            "price": p.price,
            "price_at": p.price_at,
            "price_age_s": None if p.price_at is None else max(0, int((clock - p.price_at).total_seconds())),
            "unrealized_usd": p.trade.unrealized(p.price),
            "stop_price": p.trade.stops[-1][1] if p.trade.stops else None,
            "stop_hit_at": p.row.stop_hit_at,
            "entry_at": p.trade.entry_at,
            "held_for_s": max(0, int((clock - p.trade.entry_at).total_seconds())),
        }
        for p in held
    ]
    working = [
        {"session_id": lane.id, "symbol": lane.symbol, **order}
        for lane in lanes(db, thread.id, active=True)
        for order in lane.orders or []
        if order["status"] == "working"
    ]
    return {
        **base,
        "as_of": clock,
        "positions": rows,
        "orders": working,
        "account": account(db, svc, thread, clock, books, held),
    }


# -- end and patch -------------------------------------------------------------------------------------------


def patch(
    db: Session,
    user_id: int,
    session_id: int,
    svc: Services,
    *,
    notes: str | None,
    rating: int | None,
    fields: set[str],
) -> dict[str, Any]:
    row = get_row(db, user_id, session_id, lock=True)
    if "notes" in fields:
        row.notes = notes
    if "rating" in fields:
        row.rating = rating
    row.updated_at = svc.now()
    db.flush()
    return session_out(context(db, svc, row))
