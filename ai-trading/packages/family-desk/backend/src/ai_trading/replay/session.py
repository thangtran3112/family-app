"""The replay session store and playhead (02o decisions 1 and 6): create, advance, feed, marks, end, patch.

**The no-lookahead guarantee lives here.** A session row carries `revealed_through`, a timestamp that only moves
forward; every read below is cut at it: bars whose period has closed, prints with `time <= revealed_through`,
signals whose bar close is at or before it. The would-fire list is stored on the row and never serialized while
the session is active (only `fires_so_far`). `advance` is the only writer of a session's `revealed_through`, under a
row lock, so two requests cannot reveal out of order. The day clock (`replay_day_lists.revealed_through`) is written by
`advance` and by `move_clock`, which a running thread clock settles lazily (`settle_locked`, ADR-0018): wall time moves
the clock, never a session's playhead, and a name is lifted to the clock only when she is on it. The playhead never
moves backward: "Replay again" is a new attempt.

**Marks are practice records on a finished past day**: the server stamps each at the playhead and prices it at the
last print at or before it, a stop note never exits, and nothing here touches a broker, an account or a live data path.
A market entry fills at that print; a working limit, stop or stop-limit entry (`orders.py`) fills only on a later
one-minute bar of the tape, from `advance`, at a price that bar proves.

**A swing session** (02p, `ctx.swing`) keeps the same playhead but its marks go through the thread's practice holds
(`holds.py`, `hold_rows.py`), its prices are regular-session only, `advance` pauses at a crossed stop, and the reads
carry a strip and a daily block (`swing_play.py`). Every swing branch below is guarded by `ctx.swing`; the day-trade
paths are unchanged.

**A day holds several open positions** (N names, one average-cost position each, no cap on how many names or fills). A
Buy or Sell mark is a fill against the name's position: it adds to it, sells part of it, or flips it (ADR-0016; the walk
is `journal.assemble`). The one size rule is the cash check (`positions_mod.check_buying_power`), applied to the shares
a fill OPENS against the cash the open positions and the WORKING orders have not spent (`_reserved_cash`). A resting
order the tape reached while she was on another name fills like any other: at the bar that proved it, never past the day
clock, booked when the name is next lifted to the clock (`advance`, `fill_away_orders`) or when the day ends (`end`),
never cancelled for having been out of sight. The positions share the day clock: `positions` prices each at the clock,
never at its own name's stale playhead (the name's own card is marked there too, `_marked`), `advance` pauses at the
first stop crossed on ANY open name, and ending the day flattens every one of them at the clock.
"""

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field, replace
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
from ai_trading.db.models import PracticeHold, PracticeMark, PracticeThread, ReplayDayList, ReplaySession
from ai_trading.replay import frames, hold_rows, swing_play
from ai_trading.replay import holds as holds_mod
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import ledger as ledger_mod
from ai_trading.replay import orders as orders_mod
from ai_trading.replay import positions as positions_mod
from ai_trading.replay import signals as signals_mod
from ai_trading.replay.cache import BlobStore, DbBlobStore
from ai_trading.replay.data import (
    DayInputs,
    History,
    check_day,
    check_window,
    window_bounds,
)
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

MINUTE = pd.Timedelta(minutes=1)
JUMP_TAPE_WINDOW = pd.Timedelta(minutes=30)  # a longer jump shows (and counts) only its last 30 minutes of prints
FEED_TAPE_WINDOW = pd.Timedelta(seconds=60)
FEED_PRINTS = 200
LOOKBACK_BARS_MAX = 6000  # the feed's warm-up bars (1-minute interval would otherwise carry about 9,600)
RATING_RANGE = (1, 5)
STAMP_SOURCE = "alpaca"
BEHIND_CLOCK = "This name is behind the day clock · catch up before you {verb}"  # "Catch up" is the button's word
STALE_PRINT_S = 30  # a mark priced off a print older than this carries a warning
QUIET_PRINT_S = 60  # no eligible print for this long marks the tape quiet (a halt looks the same from here)
ATTENTION_S = 20  # a name left this many seconds of thread time (x speed) behind a running clock is still being watched


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
    # `now` (so a past day stays "finished") leaves this one real, or moves it by hand, so time can pass.
    wall: Callable[[], datetime] = lambda: datetime.now(UTC)
    store_factory: Callable[[Session], BlobStore] = DbBlobStore
    sources: Any = None  # the `DataSources` behind `history` (the day list's earnings flag reads `earnings` from it)


@dataclass
class Ctx:
    """A session row with everything computed from it, for one request."""

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
    day_trades: list[journal_mod.Trade] = field(default_factory=list)  # the day list's other sessions, for day rules
    swing: bool = (
        False  # a session of a swing thread (02p): its holds carry overnight, so the day never auto-exits them
    )
    db: Session | None = field(default=None, repr=False)  # the request's session: a swing session reads its holds
    day_clock: pd.Timestamp | None = None  # the day list's shared clock; None for a standalone session
    # The thread's one instant T: the day list's clock after it was settled, NOT capped at this name's tape end. A
    # day-thread session only (None for a standalone or swing session).
    thread_time: pd.Timestamp | None = None
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
        """This name's playhead is behind the day's shared clock: it is revealed up to the playhead only, and it cannot
        be marked until an advance catches it up."""
        return self.day_clock is not None and self.through < self.day_clock


# -- small helpers -------------------------------------------------------------------------------------------


def _ts(value: datetime | pd.Timestamp) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


def market_open(day: date) -> pd.Timestamp:
    """The exchange's regular open (09:30 ET) of `day`: where a day begins for the thread clock, whatever time the plan
    starts practice at."""
    found = trading_session("stock", day)
    assert found is not None
    return found.regular_open


def market_close(day: date, kind: str) -> pd.Timestamp:
    """The exchange's close for a session of `kind` ("regular" 16:00 ET, 13:00 on a half day; "extended" four hours
    after). The only time the replayed market stops on its own: a real day has no earlier end."""
    found = trading_session("stock", day)
    assert found is not None
    return found.regular_close if kind == "regular" else found.extended_close


def window_end_of(row: ReplaySession, *, day_thread: bool) -> pd.Timestamp:
    """Where this session's tape ends. An ended session keeps the time it was ended at (its exits and journal were
    booked there). An open session of a day thread ends at the extended close of its day, derived here and never read
    from the stored column: every name of a day shares one tape end (the Summary's), whatever end the row was saved
    with (a row saved before the extended-tape rule stored 16:00 or her old focus mark). A swing or standalone session
    runs to the later of its stored end and the close of its own session kind, as it always did."""
    if row.status == "ended":
        return _ts(row.window_end)
    if day_thread:
        return market_close(row.day, "extended")
    return max(_ts(row.window_end), market_close(row.day, row.spec["session"]))


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


def day_books(db: Session, day_list_id: int) -> dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]]:
    """`{session id: (closed trades, open trade)}` for every session of the day list, in the order she opened them: the
    day's portfolio. One marks load per session."""
    ids = db.execute(
        select(ReplaySession.id).where(ReplaySession.day_list_id == day_list_id).order_by(ReplaySession.id)
    ).scalars()
    return {session_id: journal_mod.assemble(_marks_of(_load_marks(db, session_id))) for session_id in list(ids)}


@dataclass(frozen=True)
class Position:
    """An open practice position of the day (a name's average-cost aggregate), with its session and its price at the day
    clock."""

    row: ReplaySession
    trade: journal_mod.Trade
    price: float  # the last price AT THE DAY CLOCK, not at the name's own playhead


def open_positions(db: Session, day_list_id: int) -> list[tuple[ReplaySession, journal_mod.Trade]]:
    """`(session, open position)` of every session of the day list that holds one, in the order she opened the names. A
    name holds one average-cost position, however many fills built it."""
    by_id = {r.id: r for r in _sessions_of_day(db, day_list_id)}
    return [(by_id[sid], open_) for sid, (_, open_) in day_books(db, day_list_id).items() if open_ is not None]


def positions(
    db: Session,
    svc: Services,
    day_list_id: int,
    clock: pd.Timestamp,
    books: dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]] | None = None,
) -> list[Position]:
    """Every open trade of the day priced at the shared day clock. A name behind the clock is priced at the clock too:
    the clock never runs past what the day has revealed, so this is not lookahead. A name with no price yet is carried
    at its entry (no P/L). The price is `frames.PreparedSeries.quote`, the one function every surface prices with."""
    rows = {r.id: r for r in _sessions_of_day(db, day_list_id)}
    out = []
    for session_id, (_, open_) in (books if books is not None else day_books(db, day_list_id)).items():
        if open_ is None:
            continue
        found = _price_of_row(db, svc, rows[session_id], clock)
        out.append(Position(rows[session_id], open_, open_.entry_price if found is None else found[0]))
    return out


def _sessions_of_day(db: Session, day_list_id: int) -> list[ReplaySession]:
    return list(
        db.execute(
            select(ReplaySession).where(ReplaySession.day_list_id == day_list_id).order_by(ReplaySession.id)
        ).scalars()
    )


def day_pnl(
    books: dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]],
    held: list[Position],
    as_of: Any,
) -> dict[str, Any]:
    """The day's live P/L: the closed trades of every name plus every open trade marked at the clock (cent-exact)."""
    realized = journal_mod.usd_sum([journal_mod.trade_pnl(t) for closed, _ in books.values() for t in closed])
    open_ = journal_mod.usd_sum([p.trade.unrealized(p.price) for p in held])
    return {
        "realized_usd": realized,
        "open_usd": open_,
        "total_usd": journal_mod.usd_sum([realized, open_]),
        "open_count": len(held),
        "as_of": as_of,
    }


def _day_trades(db: Session, row: ReplaySession) -> list[journal_mod.Trade]:
    """The closed trades of the other sessions of this session's day list: the max loss and the trade limit count
    every name practised that day (02o-b2)."""
    if row.day_list_id is None:
        return []
    others = db.execute(
        select(ReplaySession.id).where(ReplaySession.day_list_id == row.day_list_id, ReplaySession.id != row.id)
    ).scalars()
    trades: list[journal_mod.Trade] = []
    for session_id in list(others):
        closed, _ = journal_mod.assemble(_marks_of(_load_marks(db, session_id)))
        trades.extend(closed)
    return trades


def context(db: Session, svc: Services, row: ReplaySession) -> Ctx:
    store = svc.store_factory(db)
    inputs = svc.history.day_inputs(store, row.symbol, row.day)
    swing = _is_swing(db, row)
    day_list = db.get(ReplayDayList, row.day_list_id) if row.day_list_id is not None else None
    window_end = window_end_of(row, day_thread=row.thread_id is not None and not swing)
    return Ctx(
        row=row,
        svc=svc,
        store=store,
        inputs=inputs,
        marks=_marks_of(_load_marks(db, row.id)),
        fires=signals_mod.load_fires(row.signals),
        plan=_plan_of(row.spec),
        interval=row.spec["interval"],
        window_start=_ts(row.window_start),
        window_end=window_end,
        through=_ts(row.revealed_through),
        day_trades=[] if swing else _day_trades(db, row),  # a swing journal is scored weekly, not by day rules
        swing=swing,
        db=db,
        # The thread clock runs on past a name's tape (the night, the weekend): the name follows it only as far as it
        # has bars, so it is never "behind" a clock it cannot reach.
        day_clock=None
        if day_list is None or day_list.revealed_through is None
        else min(_ts(day_list.revealed_through), window_end),
        thread_time=None
        if day_list is None or day_list.revealed_through is None or swing
        else _ts(day_list.revealed_through),
        away=spans_of(row.away or []),
    )


def _is_day_thread(db: Session, row: ReplaySession) -> bool:
    """A session of a day thread (not a swing thread's, not a standalone replay)."""
    return row.thread_id is not None and not _is_swing(db, row)


def _is_swing(db: Session, row: ReplaySession) -> bool:
    if row.thread_id is None:
        return False
    # `db.get` answers from the identity map once the thread is loaded (a thread's mode never changes), so a list of
    # sessions that share a thread asks the database once.
    thread = db.get(PracticeThread, row.thread_id)
    return thread is not None and thread.mode == "swing"


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
    out = series.levels(through)
    if ctx.swing:  # the raw prior close is on the old share basis after a split
        out["prior_close"] = swing_play.prior_close(ctx, ctx.symbol) or ctx.inputs.prior_close
    return out


def _tape_lookup(svc: Services, store: BlobStore, symbol: str, feed: str) -> frames.LastPrint:
    """The name's last eligible print at or before a time, from the tape (a provider outage reads as no print)."""

    def last(through: pd.Timestamp) -> tuple[pd.Timestamp, float] | None:
        try:
            return svc.tape.last_print(store, symbol, through, feed)  # type: ignore[arg-type]
        except ProviderError as exc:
            log.warning("tape unavailable for the last price: %s", exc)
            return None

    return last


def _price_of_row(
    db: Session, svc: Services, row: ReplaySession, through: pd.Timestamp
) -> tuple[float, pd.Timestamp] | None:
    """`last_price` for a session row without building its context: the day thread's price at `through` (a swing
    session still prices from its holds)."""
    if _is_swing(db, row):
        return last_price(context(db, svc, row), through)
    store = svc.store_factory(db)
    inputs = svc.history.day_inputs(store, row.symbol, row.day)
    series = svc.history.series.get(inputs, INTERVAL_MINUTES[row.spec["interval"]])
    found = series.quote(through, _tape_lookup(svc, store, row.symbol, row.tape_feed))
    return None if found is None else (found.price, found.at)


def last_price(ctx: Ctx, through: pd.Timestamp) -> tuple[float, pd.Timestamp] | None:
    """The mark price at `through` (`frames.PreparedSeries.quote`): the last eligible print at or before it, else the
    last revealed 1-minute close, in whole cents (D-033) so what she sees is what the P/L runs on. A swing session
    prices from the regular session only (`swing_play.last_price`)."""
    if ctx.swing:
        return swing_play.last_price(ctx, through)
    found = _series(ctx).quote(through, _tape_lookup(ctx.svc, ctx.store, ctx.symbol, ctx.feed))
    return None if found is None else (found.price, found.at)


def _age_s(found: tuple[float, pd.Timestamp] | None, through: pd.Timestamp) -> int | None:
    """Seconds from the last eligible print to the playhead (never negative)."""
    return None if found is None else max(0, int((through - found[1]).total_seconds()))


def _marked(ctx: Ctx, found: tuple[float, pd.Timestamp] | None) -> float | None:
    """The price an open DAY trade is marked at: the name's last price at its playhead, except a name behind the day
    clock, which is marked where the clock is. That is the price End day books for it and the Portfolio shows
    (`positions`), so the number on the name's card is the number it exits at. The clock is the thread's revealed
    boundary, so this reads nothing the day has not shown; a swing hold is marked by `swing_play`."""
    if not ctx.swing and ctx.behind_clock:
        assert ctx.day_clock is not None
        found = last_price(ctx, ctx.day_clock) or found
    return None if found is None else found[0]


def _open_trade(ctx: Ctx, price: float | None) -> dict[str, Any] | None:
    if ctx.swing:  # the name's practice hold, not the marks of this one session
        return swing_play.open_trade(ctx, price)
    _, open_ = journal_mod.assemble(ctx.marks)
    return journal_mod.open_trade_out(open_, price)


def _journal(ctx: Ctx, price: float | None, *, final: bool) -> dict[str, Any]:
    if ctx.swing:
        return swing_play.journal(ctx)
    fires = ctx.fires if final else signals_mod.released(ctx.fires, ctx.through)
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
        final=final,
        day_trades=ctx.day_trades,
        away=ctx.away,
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
    journal = row.journal if ended and row.journal is not None else _journal(ctx, price, final=False)
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


def summary_out(db: Session, row: ReplaySession, marks: list[PracticeMark] | None = None) -> dict[str, Any]:
    """A hub row: realized trades and P/L only (cheap; no bars needed for active sessions). `marks` is the session's
    marks in `seq` order when the caller already has them (`list_sessions` loads a whole page at once)."""
    if row.status == "ended" and row.journal is not None:
        totals = row.journal["totals"]
        trades, pnl, adherence = totals["trades"], totals["pnl_usd"], row.journal["adherence"]["score_pct"]
    elif _is_swing(db, row):  # the holds that closed in it; its marks alone miss a carried hold's exit
        (trades, pnl), adherence = swing_play.summary_totals(db, row.id), None
    else:
        closed, _ = journal_mod.assemble(_marks_of(_load_marks(db, row.id) if marks is None else marks))
        trades = len(closed)
        pnl = journal_mod.usd_sum([journal_mod.trade_pnl(t) for t in closed]) if closed else None
        adherence = None
    return {
        "id": row.id,
        "day_list_id": row.day_list_id,
        "thread_id": row.thread_id,
        "symbol": row.symbol,
        "day": row.day,
        "attempt": row.attempt,
        "status": row.status,
        "revealed_through": row.revealed_through,
        "window_end": window_end_of(row, day_thread=_is_day_thread(db, row)),
        "trades": trades,
        "pnl_usd": pnl,
        "adherence_pct": adherence,
        "updated_at": row.updated_at,
    }


def list_sessions(db: Session, user_id: int, *, status: str | None, limit: int) -> list[dict[str, Any]]:
    query = select(ReplaySession).where(ReplaySession.owner_user_id == user_id)
    if status:
        query = query.where(ReplaySession.status == status)
    rows = list(
        db.execute(query.order_by(ReplaySession.updated_at.desc(), ReplaySession.id.desc()).limit(limit)).scalars()
    )
    # One query each for the page's threads and marks instead of two per row (was an N+1 over up to 100 rows). The
    # threads land in the identity map, where `summary_out`'s `_is_swing` finds them; a row whose journal is already
    # written needs neither its marks nor, usually, its thread.
    thread_ids = {row.thread_id for row in rows if row.thread_id is not None}
    if thread_ids:
        db.execute(select(PracticeThread).where(PracticeThread.id.in_(thread_ids))).scalars().all()
    marks: dict[int, list[PracticeMark]] = {}
    need_marks = [row.id for row in rows if not (row.status == "ended" and row.journal is not None)]
    if need_marks:
        for mark in db.execute(
            select(PracticeMark).where(PracticeMark.session_id.in_(need_marks)).order_by(PracticeMark.seq)
        ).scalars():
            marks.setdefault(mark.session_id, []).append(mark)
    return [summary_out(db, row, marks.get(row.id, [])) for row in rows]


# -- create --------------------------------------------------------------------------------------------------


def create(
    db: Session,
    user_id: int,
    spec: ReplaySessionV1,
    svc: Services,
    day_list: ReplayDayList | None = None,
    thread_id: int | None = None,
    tape_feed: str | None = None,
    extended_tape: bool = False,
) -> ReplaySession:
    """A new active session at the window start (idempotent per active symbol and day), or the existing one.

    With a `day_list` the session belongs to that day: it starts at the day clock when the clock is past the window
    start (the shared clock never goes backward), and a standalone session on the same symbol and day is a 409.
    `tape_feed` fixes the session's feed without asking the provider (`"off"`: a swing thread with the tape off, 02p
    decision 4; the default probes SIP, then IEX)."""
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    symbol, day = dumped["symbol"], date.fromisoformat(dumped["day"])
    now = svc.now()
    check_day(day, now)
    # Her `window.to` is a focus mark kept in the spec; the session itself runs to the exchange close.
    start, _focus = window_bounds(day, dumped["window"]["from"], dumped["window"]["to"])
    if day_list is not None and day_list.revealed_through:
        # The thread clock does not wait for her window: a name opened before the plan's "Start at" starts at the clock.
        # It never lifts the clock to the window start (a hidden jump of time that only she may make).
        start = min(start, _ts(day_list.revealed_through))
    asked_end = market_close(day, dumped["session"])
    check_window(day, asked_end, now)
    end = market_close(day, "extended") if extended_tape else asked_end

    existing = _active_for(db, user_id, symbol, day, day_list)
    if existing is not None:
        return existing

    store = svc.store_factory(db)
    inputs = svc.history.day_inputs(store, symbol, day)  # raises ReplayDayError("No trades for ...")
    try:
        armed = signals_mod.resolve(db, user_id, dumped["armed"], symbol)
    except signals_mod.ArmProblem as exc:
        raise ReplayProblem(exc.message, path=f"armed.{exc.index}.id") from None
    fires = signals_mod.evaluate_window(
        armed,
        symbol,
        day,
        bars_1m=inputs.bars_1m,
        daily=inputs.daily,
        window_start=start,
        window_end=end,
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
    # Joined mid-day: the session opens at the shared clock, so a would-fire signal that fired before it never
    # reached her on this name. The signal list keeps it (the chart shows it as history); the journal does not score it.
    joined = (
        min(max(start, _ts(day_list.revealed_through)), end)
        if day_list is not None and day_list.revealed_through
        else start
    )
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
        day_list_id=day_list.id if day_list is not None else None,
        thread_id=thread_id if day_list is not None else None,  # only a day-list session books into a thread
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:  # a concurrent create of the same active session: that one, if it is this day list's own
        db.rollback()
        found = _active_for(db, user_id, symbol, day, day_list)  # another list's winner is the same 409, never adopted
        assert found is not None
        return found
    return row


def _active_for(
    db: Session, user_id: int, symbol: str, day: date, day_list: ReplayDayList | None
) -> ReplaySession | None:
    """The user's active session on a name and day, or None. There is one per name and day whichever day list holds it
    (the partial unique index), so a hit that is not `day_list`'s own is a 409 that says where it is open. The day list
    shows the same rows as `held_elsewhere`, so a name it offers never meets this refusal."""
    existing = db.execute(
        select(ReplaySession).where(
            ReplaySession.owner_user_id == user_id,
            ReplaySession.symbol == symbol,
            ReplaySession.day == day,
            ReplaySession.status == "active",
        )
    ).scalar_one_or_none()
    if existing is None:
        return None
    if day_list is not None and existing.day_list_id != day_list.id:
        thread = db.get(PracticeThread, existing.thread_id) if existing.thread_id is not None else None
        where = f"in {thread.name}" if thread is not None else "as a standalone session"
        raise ReplayProblem(
            f"You already have an open {symbol} practice session for this day {where} · end it first",
            path="symbol",
            status=409,
        )
    if day_list is None and existing.day_list_id is not None:
        raise ReplayProblem("This day is part of your daily list · open it from the list", path="symbol", status=409)
    return existing


def held_elsewhere(db: Session, user_id: int, day: date, day_list_id: int) -> list[dict[str, Any]]:
    """The user's active sessions on `day` that belong to another day list or to none: the names `_active_for` refuses
    to open in this one (one active session per name and day, across every thread and swing day). The day list read
    reports them so a name is never shown as "not opened" while the open refuses it; each names where to end it."""
    rows = db.execute(
        select(
            ReplaySession.id,
            ReplaySession.symbol,
            ReplaySession.day_list_id,
            ReplaySession.thread_id,
            PracticeThread.name,
        )
        .outerjoin(PracticeThread, PracticeThread.id == ReplaySession.thread_id)
        .where(
            ReplaySession.owner_user_id == user_id,
            ReplaySession.day == day,
            ReplaySession.status == "active",
            ReplaySession.day_list_id.is_distinct_from(day_list_id),
        )
        .order_by(ReplaySession.id)
    )
    return [
        {"session_id": sid, "symbol": symbol, "day_list_id": dlid, "thread_id": tid, "thread_name": tname}
        for sid, symbol, dlid, tid, tname in rows
    ]


# -- advance and feed ----------------------------------------------------------------------------------------


def _lock_day_list(db: Session, session_id: int) -> ReplayDayList | None:
    """The session's day list, locked, or None for a standalone session. Every writer of a day-list session takes
    this lock before the session row, so two advances of one day cannot deadlock."""
    day_list_id = db.execute(
        select(ReplaySession.day_list_id).where(ReplaySession.id == session_id)
    ).scalar_one_or_none()
    if day_list_id is None:
        return None
    return db.execute(select(ReplayDayList).where(ReplayDayList.id == day_list_id).with_for_update()).scalar_one()


def _lock_and_settle(db: Session, svc: Services, user_id: int, session_id: int) -> ReplayDayList | None:
    """`_lock_day_list`, then bring a running thread clock to now (ADR-0018). None for a standalone session. A stranger
    gets the 404 before any lock or write, so it cannot move another user's clock."""
    get_row(db, user_id, session_id)
    day_list = _lock_day_list(db, session_id)
    if day_list is not None:
        settle_locked(db, svc, day_list)
    return day_list


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
    if ctx.feed == "off":  # a swing thread with the tape off fetches no prints at all
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


def _clock_state(ctx: Ctx) -> dict[str, Any] | None:
    """The thread clock as a day session's frame reports it: `{running, speed}` while it runs, else None (and left out
    of the JSON). A chart that follows the clock shows a hint when it is not running; it has no controls (ADR-0018)."""
    if ctx.db is None or ctx.row.day_list_id is None or ctx.swing:
        return None
    day_list = ctx.db.get(ReplayDayList, ctx.row.day_list_id)
    return {"running": True, "speed": day_list.clock_speed} if day_list is not None and day_list.clock_running else None


def _next_start(ctx: Ctx) -> pd.Timestamp | None:  # None only without a day list (a standalone session)
    """When the thread's next trading day opens (the day hands over there): the exchange's open, also after the plan's
    last day (that day ends there)."""
    if "next_start" not in ctx._cache:
        from ai_trading.replay import plan as plan_mod  # plan imports this module: the lookup lives there

        day_list = ctx.db.get(ReplayDayList, ctx.row.day_list_id) if ctx.db is not None else None
        ctx._cache["next_start"] = None if day_list is None else plan_mod.next_day_start(ctx.db, day_list)
    return ctx._cache["next_start"]


def _market_of(ctx: Ctx, series: frames.PreparedSeries, data_through: pd.Timestamp) -> dict[str, Any] | None:
    """`market` of a day-thread frame (None for a standalone or swing session): the phase at the thread's time T, the
    tape end, the close of this name's last bar and when the next day's data starts."""
    if ctx.thread_time is None:
        return None
    return frames.market_block(ctx.row.day, ctx.thread_time, series.last_bar_close(data_through), _next_start(ctx))


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
    # indicators read one number; a swing or standalone session keeps its candle as the minutes built it.
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


def _flag_stops(db: Session, ctx: Ctx, previous: pd.Timestamp, target: pd.Timestamp) -> None:
    """Mark `stop_hit_at` on every open trade of the day list (not just this name) whose stop the one-minute bars
    closing in `(previous, target]` crossed, each at the bar it crossed on. It is information for the Portfolio and the
    journal, never a control: the clock does not stop for a stop and a stop never exits. `previous` is the later of
    the playhead and the day clock: minutes already revealed were scanned by the advance that revealed them.
    ponytail: one bars load per open trade."""
    if previous >= target:
        return
    live = [
        (row, trade) for row, trade in open_positions(db, ctx.row.day_list_id) if trade.stops and not row.stop_hit_at
    ]
    if not live:
        return
    minutes = {
        row.symbol: ctx.inputs.bars_1m
        if row.id == ctx.row.id
        else ctx.svc.history.day_inputs(ctx.store, row.symbol, row.day).bars_1m
        for row, _ in live
    }
    while live:
        crossing = positions_mod.first_stop_crossing(
            [
                positions_mod.Hold(
                    id=None,
                    symbol=row.symbol,
                    side=trade.side,  # type: ignore[arg-type]
                    shares=trade.shares,
                    entry_day=row.day,
                    entry_at=trade.entry_at,
                    entry_price=trade.entry_price,
                    stop_at_entry=trade.stop_price,
                    stop_price=trade.stops[-1][1],
                    stop_hit_at=None,
                )
                for row, trade in live
            ],
            minutes,
            previous,
            target,
        )
        if crossing is None:
            break
        hit = {crossing.symbol, *crossing.also}
        for row, _ in live:
            if row.symbol in hit:
                row.stop_hit_at, row.updated_at = crossing.at.to_pydatetime(), ctx.svc.now()
        live = [(row, trade) for row, trade in live if row.symbol not in hit]
        previous = crossing.at
    db.flush()


def move_clock(db: Session, svc: Services, day_list: ReplayDayList, target: pd.Timestamp) -> pd.Timestamp:
    """Move the thread's clock forward to `target` (the caller holds the day-list lock). The clock is real time shifted:
    it has no end of its own. It runs on through the close, after-hours, overnight and the weekend; the day list hands
    over to the next day only when the clock reaches that day's start (`clock.roll`), and nothing here stops it. A
    crossed stop is flagged on its position (`_flag_stops`) and the clock goes on. No session's playhead moves here: a
    name is lifted to the clock when she is on it (`advance`), never written while she is not."""
    if day_list.revealed_through is None or day_list.status == "ended":
        return _ts(day_list.revealed_through) if day_list.revealed_through is not None else _ts(svc.now())
    previous = _ts(day_list.revealed_through)
    target = max(_ts(target), previous)
    sessions = _sessions_of_day(db, day_list.id)
    if sessions and target > previous:
        ctx = context(db, svc, sessions[0])
        _flag_stops(db, ctx, previous, min(target, ctx.window_end))  # bars exist up to the name's tape end
    target = target.floor("us")  # a settled clock is a float of seconds: drop the nanoseconds Postgres cannot hold
    day_list.revealed_through, day_list.updated_at = target.to_pydatetime(), svc.now()
    db.flush()
    return target


def settle_locked(db: Session, svc: Services, day_list: ReplayDayList) -> None:
    """Bring a running thread clock to now (ADR-0018): `clock + speed x (now - anchor)`, through `move_clock`, then a
    fresh anchor. Called with the day-list lock held, by every request that reads or acts on the clock, so the clock is
    a function of wall time and survives a closed screen, a logout and a restart. A paused clock, an ended day, or a
    request that arrives with the anchor in the future (clock skew) changes nothing."""
    if (
        not day_list.clock_running
        or day_list.status == "ended"
        or day_list.revealed_through is None
        or day_list.clock_anchor_at is None
    ):
        return
    now = svc.wall()
    elapsed = (_ts(now) - _ts(day_list.clock_anchor_at)).total_seconds()
    if elapsed <= 0:
        return
    day_list.clock_anchor_at = now
    move_clock(db, svc, day_list, _ts(day_list.revealed_through) + pd.Timedelta(seconds=elapsed * day_list.clock_speed))


def settle_day(db: Session, svc: Services, day_list_id: int | None) -> None:
    """`settle_locked` for a read: a cheap look first, so a paused clock (the usual case) takes no lock and writes
    nothing; a running one is locked, brought to now and committed with the request."""
    if day_list_id is None:
        return
    running = db.execute(
        select(ReplayDayList.clock_running).where(ReplayDayList.id == day_list_id)
    ).scalar_one_or_none()
    if running:
        row = db.execute(select(ReplayDayList).where(ReplayDayList.id == day_list_id).with_for_update()).scalar_one()
        settle_locked(db, svc, row)


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
    if [to is not None, step is not None, sync].count(True) != 1:
        raise ReplayProblem("Send exactly one of to, step and sync", path="to")
    if since is not None and (not sync or pd.Timestamp(since).tzinfo is None):
        raise ReplayProblem("`since` is a time with its UTC offset, sent with sync", path="since")
    day_list = _lock_and_settle(db, svc, user_id, session_id)  # the day list row first, then the session row
    if day_list is None and sync:
        raise ReplayProblem("Only a session of a practice day follows the thread clock", path="sync")
    row = get_row(db, user_id, session_id, lock=True)
    ctx = context(db, svc, row)
    width = INTERVAL_MINUTES[interval or ctx.interval]
    previous = ctx.through
    # A step is a step of the day's one clock, not of this name's playhead: from a name behind the shared clock it goes
    # one bar (or one signal) past the clock, so the thread's time moves the same whichever name is on screen.
    base = previous if ctx.day_clock is None or row.status == "ended" else max(previous, ctx.day_clock)
    if row.status == "ended":
        target = ctx.window_end
    elif sync:  # the screen follows the thread's clock: wherever it is now, never past it
        target = base
    elif to is not None:
        if pd.Timestamp(to).tzinfo is None:
            raise ReplayProblem("Send the time with its UTC offset", path="to")
        target = _ts(to)
    elif step == "bar":
        target = next_bar_boundary(base, width)
    else:
        upcoming = signals_mod.next_after(ctx.fires, base)
        if upcoming is None:
            raise ReplayProblem("No more signals in this session", path="step")
        target = upcoming.bar_close
    target = min(max(target, previous), ctx.window_end)  # forward only; clamped to the window end
    scan_from, paused = previous, None
    if day_list is not None and row.status != "ended":
        clock = ctx.day_clock
        if clock is not None:
            # A name behind the shared day clock catches up to it: what lies between is revealed on the chart but was
            # never in front of her, and the journal does not score a signal that fired inside it (02o-b2). A resting
            # order the tape reached inside it still fills: the fill pass below reads `(previous, target]`.
            if previous < clock and not (sync and _watching(ctx, day_list, previous, clock)):
                row.away = add_span(list(row.away or []), previous, clock)
                ctx.away = spans_of(row.away)
            target = min(max(target, clock), ctx.window_end)
            scan_from = max(previous, clock)
        if ctx.swing:  # play stops at the first crossed stop (02p b5): never earlier, never later
            paused, target = swing_play.stop_pause(ctx, scan_from, target)
        else:  # a day's clock never stops for a stop: every open name's crossing is flagged, the time goes on
            _flag_stops(db, ctx, scan_from, target)
        if clock is None or target > clock:
            day_list.revealed_through = target.to_pydatetime()
            ctx.day_clock = target
            if ctx.thread_time is not None:
                ctx.thread_time = target

    fills: list[Mark] = []
    if target > previous:
        row.revealed_through = target.to_pydatetime()
        row.updated_at = svc.now()
        db.flush()
        ctx.through = target
        if row.status != "ended":
            fills = _fill_working_orders(db, ctx, previous, target)

    # The answer starts where the caller's view ends, not only where the session's one playhead was: a second window on
    # this name has a playhead the first one already moved (D-198). Never before the session's window, never past it.
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
    frame["paused"] = paused  # a swing day only (play stops at its first crossed stop); the response leaves None out
    frame["fills"] = [mark_out(m) for m in fills] or None  # working orders the tape filled inside this advance
    if ctx.swing:
        frame |= {"strip": swing_play.strip(ctx, target), "daily_forming": swing_play.forming_daily(ctx, target)}
    return frame


def _watching(
    ctx: Ctx, day_list: ReplayDayList, previous: pd.Timestamp, clock: pd.Timestamp, *, needs_running: bool = False
) -> bool:
    """She is on this name, not returning to it: its playhead trails the day clock by no more than `ATTENTION_S` of
    thread time (the screen syncs every couple of seconds, so a name on screen is never further behind than that; one
    she left falls further behind with every second the clock runs). Such a lift is the same minutes she was already
    watching, so it adds no away span (the fill pass over `(previous, clock]` runs either way).
    `needs_running`: the lift is not a screen's own `sync` but a mark or order on a name behind the clock, an old path
    whose catch-up rules stay as they were unless the clock is running."""
    return (
        not ctx.swing
        and (day_list.clock_running or not needs_running)
        and (clock - previous).total_seconds() <= ATTENTION_S * day_list.clock_speed
    )


def _follow_clock(db: Session, ctx: Ctx) -> bool:
    """A name she is on that a running clock left a few seconds behind is lifted quietly before she marks or orders on
    it, so a click never fails with "behind the day clock" because the clock ran between two syncs. True when lifted."""
    day_list = db.get(ReplayDayList, ctx.row.day_list_id) if ctx.row.day_list_id is not None else None
    if (
        day_list is None
        or ctx.day_clock is None
        or not ctx.behind_clock
        or not _watching(ctx, day_list, ctx.through, ctx.day_clock, needs_running=True)
    ):
        return False
    previous = ctx.through
    ctx.row.revealed_through = ctx.day_clock.to_pydatetime()
    ctx.through = ctx.day_clock
    ctx.row.updated_at = ctx.svc.now()
    db.flush()
    _fill_working_orders(db, ctx, previous, ctx.through)
    return True


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
    prints, the released signals (all of them once the session has ended). Never past `revealed_through`, except that an
    open day-thread session is read at the thread's time T (cut at its tape end): see the comment below."""
    row = get_row(db, user_id, session_id)
    settle_day(db, svc, row.day_list_id)
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
    out = {**frame, "interval": name, "window_start": ctx.window_start}
    if ctx.swing:  # the strip reads the shared day clock; the daily block never reads the day's own daily bar
        clock = swing_play.day_clock(ctx)
        out |= {"strip": swing_play.strip(ctx, clock), "daily": swing_play.daily_block(ctx, through)}
    return out


# -- marks ---------------------------------------------------------------------------------------------------


def place_mark(db: Session, user_id: int, session_id: int, svc: Services, body: dict[str, Any]) -> dict[str, Any]:
    """Stamp a practice mark at the playhead. State rules answer 422 with `path: "kind"` or `"stopPrice"`. An entry
    needs no stop: the thread's "stop on every entry" plan is scored, never a reason to refuse. A Buy or Sell is a fill
    against the name's position (adds, sells part, or flips); only the shares it opens must fit the cash."""
    _lock_and_settle(db, svc, user_id, session_id)  # the day list row first, then the session row: one lock order
    row = get_row(db, user_id, session_id, lock=True)
    if row.status != "active":
        raise ReplayProblem("This session is over · start a new attempt", path="kind")
    ctx = context(db, svc, row)
    if ctx.behind_clock and not _follow_clock(db, ctx):
        # Revealed but not markable: the shared day clock is ahead of this name's playhead, so a mark here would be
        # stamped at a time the day has already passed. A catch-up (the screen's "Catch up") moves the name to the
        # clock first. A note is refused too: it would be stamped before the clock the day is already past.
        raise ReplayProblem(BEHIND_CLOCK.format(verb="mark"), path="kind")
    return _place(db, ctx, body, svc)


def _place(
    db: Session, ctx: Ctx, body: dict[str, Any], svc: Services, *, fill: orders_mod.Fill | None = None
) -> dict[str, Any]:
    """The mark itself, for a locked, current session. `fill` is a working order the tape just proved: the entry is
    stamped at the fill's time and price instead of at the playhead's last print."""
    if ctx.swing:
        return _place_swing_mark(db, ctx, body, svc, fill=fill)
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
            _check_day_buying_power(db, row, rest, price, closing=open_ if take else None, take=take, skip=ctx.filling)
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
    if rest and row.day_list_id is not None:
        # The max-loss rule's basis: the day's P/L when she entered (realized plus every open trade at the clock).
        books = day_books(db, row.day_list_id)
        day_pnl_usd = day_pnl(books, positions(db, svc, row.day_list_id, ctx.through, books), ctx.through)["total_usd"]
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
    return {
        "mark": mark_out(placed),
        "open_trade": _open_trade(ctx, price if price is not None else _price_or_none(ctx)),
        "journal": _journal(ctx, price if price is not None else _price_or_none(ctx), final=False),
        "warning": warning,
    }


# -- working orders -------------------------------------------------------------------------------------------
# A limit, stop or stop-limit entry that is not marketable waits in `replay_sessions.orders` and fills from `advance`
# (replay/orders.py has the rules). A market entry is `place_mark`. A fill is a Buy or Sell against the name's position
# whatever it is when the order fills (it can add, sell part, or flip); only the cash can cancel it, with the reason.


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


def _tape_fill(
    ctx: Ctx, order: dict[str, Any], since: pd.Timestamp, target: pd.Timestamp
) -> tuple[orders_mod.Fill | None, pd.Timestamp | None]:
    """`orders_mod.first_fill` for a stored order over the one-minute bars that close in `(since, target]`."""
    return orders_mod.first_fill(
        side=_side_of(order),
        type_=order["type"],
        limit=order["limit_price"],
        trigger=order["stop_price"],
        triggered_at=None if order["triggered_at"] is None else _ts(order["triggered_at"]),
        bars_1m=ctx.inputs.bars_1m,
        since=since,
        target=target,
    )


def fill_away_orders(
    db: Session, svc: Services, row: ReplaySession, previous: pd.Timestamp, clock: pd.Timestamp
) -> list[Mark]:
    """Lift a resumed name's playhead from `previous` to the day clock and fill its working orders over `(previous,
    clock]`. The thread's clock runs with nobody on this name, so a limit or stop the tape reached there fills like a
    watched one (ADR-0019): stamped at the bar that proved it, in time order, against the cash the account has now.
    Nothing past `clock` is read. (An `advance` needs no call here: its own fill pass reads the same span.)"""
    if not any(o["status"] == "working" for o in row.orders or []):
        return []
    ctx = context(db, svc, row)
    row.revealed_through, row.updated_at = clock.to_pydatetime(), svc.now()
    ctx.through = clock
    db.flush()
    return _fill_working_orders(db, ctx, previous, clock)


def _fill_working_orders(db: Session, ctx: Ctx, previous: pd.Timestamp, target: pd.Timestamp) -> list[Mark]:
    """Fill the session's working orders from the one-minute bars that closed in `(previous, target]` (an order is
    read only from the moment it was placed). Each fill is an ordinary Buy or Sell mark stamped at its bar's close, in
    time order. An order whose opening shares the account cannot afford is cancelled with that reason. The caller has
    moved the playhead to `target`, so nothing here reaches past what is revealed."""
    row = ctx.row
    if not any(o["status"] == "working" for o in row.orders or []):
        return []
    orders = [dict(o) for o in row.orders]
    hits: list[tuple[orders_mod.Fill, dict[str, Any]]] = []
    for order in orders:
        if order["status"] != "working":
            continue
        fill, fired = _tape_fill(ctx, order, max(previous, _ts(order["placed_at"])), target)
        if fired is not None:
            order["triggered_at"] = fired.isoformat()
        if fill is not None:
            hits.append((fill, order))
    placed: list[Mark] = []
    for fill, order in sorted(hits, key=lambda hit: (hit[0].at, hit[1]["id"])):
        ctx.filling = order["id"]  # its reserve is released as it fills; the other working orders still hold cash back
        try:
            with db.begin_nested():
                out = _place(db, ctx, {"kind": _entry_kind_of(order), "shares": order["shares"]}, ctx.svc, fill=fill)
        except ReplayProblem as exc:
            _close_order(order, "cancelled", fill.at, reason=exc.message)
            row.orders = [dict(o) for o in orders]  # a settled order no longer reserves cash for the next fill
            continue
        finally:
            ctx.filling = None
        mark = next(m for m in ctx.marks if m.id == out["mark"]["id"])
        _close_order(order, "filled", fill.at, price=fill.price, mark_id=mark.id)
        row.orders = [dict(o) for o in orders]
        placed.append(mark)
    row.orders = orders
    row.updated_at = ctx.svc.now()
    db.flush()
    return placed


def place_order(db: Session, user_id: int, session_id: int, svc: Services, body: dict[str, Any]) -> dict[str, Any]:
    """Place a limit, stop or stop-limit entry at the playhead. A limit that already accepts the last price is
    marketable and fills at once at that price; anything else waits for the tape. State rules answer 422 with a path
    (`limitPrice`, `stopPrice`, `shares`, `kind`). Affordability is checked now and again at the fill."""
    _lock_and_settle(db, svc, user_id, session_id)
    row = get_row(db, user_id, session_id, lock=True)
    if row.status != "active":
        raise ReplayProblem("This session is over · start a new attempt", path="kind")
    ctx = context(db, svc, row)
    if ctx.behind_clock and not _follow_clock(db, ctx):
        raise ReplayProblem(BEHIND_CLOCK.format(verb="order"), path="kind")
    side = "long" if body["side"] == "buy" else "short"
    shares = body.get("shares") or row.spec["shares"]
    found = last_price(ctx, ctx.through)
    if found is None:
        raise ReplayProblem(
            swing_play.NOT_OPEN if ctx.swing else "No price yet · advance the replay first", path="kind"
        )
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
    record = {
        "id": 1 + max((o["id"] for o in row.orders or []), default=0),
        "side": body["side"],
        "type": body["orderType"],
        "shares": shares,
        "limit_price": limit,
        "stop_price": trigger,
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
        _check_can_work(db, ctx, side, shares, limit if limit is not None else trigger)
        out = {
            "mark": None,
            "open_trade": _open_trade(ctx, found[0]),
            "journal": _journal(ctx, found[0], final=False),
            "warning": None,
        }
    row.orders = [*(row.orders or []), record]
    row.updated_at = svc.now()
    db.flush()
    return {**out, "order": record, "orders": list(row.orders)}


def _check_can_work(db: Session, ctx: Ctx, side: str, shares: int, reference: float | None) -> None:
    """The rule a working order must pass now: the shares it would open, at its own price (a stop is priced at its
    trigger), fit the free cash as the position stands. The same rule runs again when it fills."""
    row = ctx.row
    assert reference is not None
    if ctx.swing:
        thread = swing_play.lock_thread(db, row.thread_id)
        rows = hold_rows.load(db, thread.id, lock=True)
        mine = next((r for r in rows if r.symbol == row.symbol and r.status == "open"), None)
        take, rest = journal_mod.fill_split(
            None if mine is None else mine.side, 0 if mine is None else mine.shares, side, shares
        )
        if rest:
            try:
                positions_mod.check_buying_power(
                    shares=rest,
                    price=reference,
                    free_cash_usd=_swing_free_cash(db, row, thread, rows, mine, take, reference),
                )
            except positions_mod.HoldProblem as exc:
                raise ReplayProblem(exc.message, path=exc.path, status=exc.status) from None
        return
    open_ = journal_mod.assemble(ctx.marks)[1]
    take, rest = journal_mod.fill_split(
        None if open_ is None else open_.side, 0 if open_ is None else open_.shares, side, shares
    )
    if rest:
        _check_day_buying_power(db, row, rest, reference, closing=open_ if take else None, take=take)


def cancel_order(db: Session, user_id: int, session_id: int, order_id: int, svc: Services) -> dict[str, Any]:
    """Cancel a working order. 404 for an unknown order, 409 for one that is no longer working."""
    get_row(db, user_id, session_id)  # 404 before any lock for a stranger
    _lock_day_list(db, session_id)
    row = get_row(db, user_id, session_id, lock=True)
    orders = [dict(o) for o in row.orders or []]
    target = next((o for o in orders if o["id"] == order_id), None)
    if target is None:
        raise SessionNotFound(order_id)
    if target["status"] != "working":
        raise ReplayProblem("That order is no longer working", path="kind", status=409)
    _close_order(target, "cancelled", _ts(row.revealed_through))
    row.orders, row.updated_at = orders, svc.now()
    db.flush()
    return {"order": target, "orders": orders}


def _expire_orders(row: ReplaySession, at: pd.Timestamp) -> None:
    """A day order lives for the day: when the session ends, what still waits is cancelled."""
    if any(o["status"] == "working" for o in row.orders or []):
        orders = [dict(o) for o in row.orders]
        for order in orders:
            if order["status"] == "working":
                _close_order(order, "cancelled", at, reason="The day ended")
        row.orders = orders


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


def _day_free_cash(db: Session, row: ReplaySession, skip: int | None = None) -> float:
    """A day session's buying power: its account's balance (the starting balance plus every booked trade; a day trade is
    booked when it exits) less the entry notional of the open positions, this name's included (what she already holds
    in it is cash spent), less the cash its working orders hold back (`_reserved_cash`; `skip` is the order of this
    session that is filling now). Like the swing rule, a short's notional counts as a long's.

    A thread session's account is the thread's. A standalone session (no thread) has an account of its own, the default
    starting balance of a thread plus the session's own closed trades, so the same cash rule is the only size rule on
    every path; nothing is booked from it and each attempt starts from the same balance."""
    skipped = None if skip is None else (row.id, skip)
    thread = None if row.thread_id is None or row.day_list_id is None else db.get(PracticeThread, row.thread_id)
    if thread is None:
        closed, open_ = journal_mod.assemble(_marks_of(_load_marks(db, row.id)))
        held = 0.0 if open_ is None else open_.entry_price * open_.shares
        realized = journal_mod.usd_sum([journal_mod.trade_pnl(t) for t in closed])
        reserved = _reserved_cash([row], lambda _: (None, 0) if open_ is None else (open_.side, open_.shares), skipped)
        return round(DEFAULT_STARTING_BALANCE + realized - held - reserved, 2)
    return day_buying_power(db, thread, row.day_list_id, skipped)


def day_buying_power(
    db: Session,
    thread: PracticeThread,
    day_list_id: int,
    skipped: tuple[int, int] | None = None,
    books: dict[int, tuple[list[journal_mod.Trade], journal_mod.Trade | None]] | None = None,
) -> float:
    """A day thread's buying power on one of its days: the thread's balance less the entry notional of the day's open
    positions and less the cash its working orders hold back. The one figure the cash check enforces (`_day_free_cash`)
    and the Summary shows (`clock._account`, which passes the `books` it already read)."""
    books = day_books(db, day_list_id) if books is None else books
    opens = {sid: open_ for sid, (_, open_) in books.items() if open_ is not None}
    held = sum(t.entry_price * t.shares for t in opens.values())
    reserved = _reserved_cash(
        _sessions_of_day(db, day_list_id),
        lambda s: (None, 0) if s.id not in opens else (opens[s.id].side, opens[s.id].shares),
        skipped,
    )
    return round(_threads().balance(db, thread) - held - reserved, 2)


def _check_day_buying_power(
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
    shares' P/L. `skip`: the working order of this session that is filling now (its reserve is released)."""
    free = _day_free_cash(db, row, skip)
    if closing is not None and take:
        gain = journal_mod.pnl_usd(closing.sign, closing.entry_price, price, take)
        free = round(free + closing.entry_price * closing.shares + gain, 2)
    try:
        positions_mod.check_buying_power(shares=shares, price=price, free_cash_usd=free)
    except positions_mod.HoldProblem as exc:
        raise ReplayProblem(exc.message, path=exc.path, status=exc.status) from None


def _swing_free_cash(
    db: Session,
    row: ReplaySession,
    thread: PracticeThread,
    rows: list[PracticeHold],
    mine: PracticeHold | None,
    take: int,
    price: float,
    skip: int | None = None,
) -> float:
    """A swing fill's free cash for the shares it opens: the thread's free cash with this name's hold still open, less
    the cash the day's working orders hold back (`_reserved_cash`; `skip` is the order of this session filling now),
    plus, when the fill flips the hold (`take` shares close the whole hold first), the hold's notional and the closed
    P/L."""
    free = _threads().free_cash(db, thread, rows, row.day)

    def held_of(session: ReplaySession) -> tuple[str | None, int]:
        hold = next((r for r in rows if r.symbol == session.symbol and r.status == "open"), None)
        return (None, 0) if hold is None else (hold.side, hold.shares)

    free = round(
        free
        - _reserved_cash(
            [row] if row.day_list_id is None else _sessions_of_day(db, row.day_list_id),
            held_of,
            None if skip is None else (row.id, skip),
        ),
        2,
    )
    if mine is not None and take:
        gain = journal_mod.pnl_usd(1 if mine.side == "long" else -1, float(mine.entry_price), price, take)
        free = round(free + float(mine.entry_price) * mine.shares + gain, 2)
    return free


def _place_swing_mark(
    db: Session, ctx: Ctx, body: dict[str, Any], svc: Services, *, fill: orders_mod.Fill | None = None
) -> dict[str, Any]:
    """`place_mark` for a swing session (02p b2): the mark stays a per-session annotation, the practice HOLD is the
    record. The name's open hold is its average-cost position (ADR-0016): a Buy or Sell adds to it
    (`hold_rows.scale_in`), sells part of it (`split_off`: the slice closes at the hold's cost, the rest stays open), or
    closes it and opens the other way (a flip); Close position closes the whole hold at the revealed price. A stop
    moves the position's line (and clears the pause flag). No ledger row is written here: the day's end credits the
    holds that exited on it (R9). Lock order: the day list and the session (the caller), then the thread, then its
    holds."""
    row, kind, now = ctx.row, body["kind"], svc.now()
    price = warning = None
    at = ctx.through if fill is None else fill.at
    if fill is not None:
        price = fill.price
    elif kind != "note":
        found = last_price(ctx, ctx.through)
        if found is None:
            raise ReplayProblem(swing_play.NOT_OPEN, path="kind")
        price = found[0]
        age = _age_s(found, ctx.through)
        if ctx.feed != "off" and age is not None and age >= STALE_PRINT_S:  # a one-minute close is not a print
            warning = f"Priced off a print {age} s old · the tape has been quiet"
    thread = swing_play.lock_thread(db, row.thread_id)
    rows = hold_rows.load(db, thread.id, lock=True)
    mine = next((r for r in rows if r.symbol == row.symbol and r.status == "open"), None)
    stop_price = body.get("stopPrice")
    shares = None
    position_before = closed_row = target = None
    take = rest = 0
    try:
        if kind in ENTRY_KINDS:
            side = "long" if kind == "long_entry" else "short"
            shares = body.get("shares") or row.spec["shares"]
            take, rest = journal_mod.fill_split(
                None if mine is None else mine.side, 0 if mine is None else mine.shares, side, shares
            )
            if rest:
                positions_mod.check_buying_power(
                    shares=rest,
                    price=price,
                    free_cash_usd=_swing_free_cash(db, row, thread, rows, mine, take, price, ctx.filling),
                )
            stays = side if rest else (mine.side if mine is not None and take < mine.shares else None)
            if stop_price is not None and stays is not None:
                holds_mod.check_stop(stays, stop_price, price)
        elif kind in EXIT_KINDS:
            if mine is None or mine.side != ("long" if kind == "long_exit" else "short"):
                raise positions_mod.HoldProblem("No open practice hold to exit")
            take = mine.shares
        elif kind == "stop":
            if mine is None:
                raise positions_mod.HoldProblem("Open a practice hold before setting a stop")
            holds_mod.check_stop(mine.side, stop_price, price)
        mark = PracticeMark(
            session_id=row.id,
            seq=(ctx.marks[-1].seq if ctx.marks else 0) + 1,
            kind=kind,
            at=at.to_pydatetime(),
            price=price,
            shares=shares,
            stop_price=stop_price,
            note=body.get("note"),
            trade_no=None,
            source="her",
            created_at=now,
        )
        db.add(mark)
        row.updated_at = now
        db.flush()
        if take:  # the shares a fill (or Close position) closes: the whole hold, or a slice of it
            if take == mine.shares:
                hold_rows.apply(
                    mine, holds_mod.exit_hold(hold_rows.to_hold(mine), day=row.day, at=at, price=price, source="her")
                )
                mine.exit_session_id, mine.exit_mark_id = row.id, mark.id
                closed_row, mine = mine, None
                db.flush()  # the name has no open hold now: a flip may open the next
            else:
                closed_row = hold_rows.split_off(
                    db, mine, shares=take, day=row.day, at=at, price=price, session_id=row.id, mark_id=mark.id, now=now
                )
        if rest:
            if mine is None:
                mine = hold_rows.add_entry(
                    db,
                    thread,
                    symbol=row.symbol,
                    side="long" if kind == "long_entry" else "short",
                    shares=rest,
                    day=row.day,
                    at=at,
                    price=price,
                    stop=stop_price,
                    session_id=row.id,
                    mark_id=mark.id,
                    now=now,
                )
            else:
                position_before = hold_rows.scale_in(mine, shares=rest, price=price, stop=stop_price, now=now)
        elif kind == "stop":
            hold_rows.apply(mine, holds_mod.set_stop(hold_rows.to_hold(mine), stop_price))
        elif kind in ENTRY_KINDS and stop_price is not None and mine is not None:  # a sale that left the hold open
            # Taken after the slice came off: the undo restores this, then puts the slice back.
            position_before = hold_rows.snapshot(mine)
            hold_rows.apply(mine, holds_mod.set_stop(hold_rows.to_hold(mine), stop_price))
        target = mine if mine is not None else (closed_row if take else None)
        if target is not None and kind != "note":
            mark.trade_no, mark.position_before = target.id, position_before
            if mine is not None:
                mine.updated_at = now
        db.flush()
    except positions_mod.HoldProblem as exc:
        raise ReplayProblem(exc.message, path=exc.path, status=exc.status) from None
    ctx.marks = _marks_of(_load_marks(db, row.id))
    shown = price if price is not None else _price_or_none(ctx)
    return {
        "mark": mark_out(next(m for m in ctx.marks if m.seq == mark.seq)),
        "open_trade": _open_trade(ctx, shown),
        "journal": _journal(ctx, shown, final=False),
        "warning": warning,
        "hold": None if target is None else swing_play.hold_out(ctx, target, shown),
    }


def _check_reopen(
    db: Session, thread: PracticeThread, rows: list[PracticeHold], reopened: PracticeHold, day: date
) -> None:
    """Undoing an exit puts its shares back among the open ones (as a hold of their own, or as shares of the name's open
    hold), so they have to pass the cash rule again against the thread's other holds: another name may have spent the
    cash since the exit (the shared day clock lets a second name mark at the same moment). 409, nothing is written."""
    others = [r for r in rows if r is not reopened]
    try:
        positions_mod.check_buying_power(
            shares=reopened.shares,
            price=float(reopened.entry_price),
            free_cash_usd=_threads().free_cash(db, thread, others, day),
        )
    except positions_mod.HoldProblem:
        raise ReplayProblem(
            "Can't undo that exit · it would leave you without enough practice cash", path="kind", status=409
        ) from None


def _undo_swing_mark(db: Session, ctx: Ctx, target: Mark) -> dict[str, Any]:
    """`undo_mark` for a swing session (02p b2): undo the last mark's two halves in reverse. What it OPENED goes first:
    a hold it created is deleted, a scale-in is restored from the hold the mark recorded (`position_before`). What it
    CLOSED comes back second: a hold it closed whole is reopened, a slice it closed (a partial exit) rejoins the open
    hold, and either must still fit the cash rule (nothing was credited yet). Undoing a stop puts the previous stop
    back and recomputes whether that stop was already crossed."""
    row, now = ctx.row, ctx.svc.now()
    thread = swing_play.lock_thread(db, row.thread_id)
    rows = hold_rows.load(db, thread.id, lock=True)
    mine = next((r for r in rows if r.symbol == row.symbol and r.status == "open"), None)
    try:
        if target.kind in ENTRY_KINDS or target.kind in EXIT_KINDS:
            if (entered := next((r for r in rows if r.entry_mark_id == target.id), None)) is not None:
                hold_rows.delete(db, entered)  # a hold this mark opened
                rows, mine = [r for r in rows if r is not entered], None
            elif (before := db.get(PracticeMark, target.id).position_before) is not None and mine is not None:
                hold_rows.restore(mine, before, now)  # a scale-in
            if (
                closed := next((r for r in rows if r.exit_mark_id == target.id and r.status == "closed"), None)
            ) is not None:
                _check_reopen(db, thread, rows, closed, row.day)
                if mine is not None and closed.part_exit:
                    hold_rows.merge_back(db, mine, closed, now)  # a slice of a partial exit
                else:
                    hold_rows.reopen(db, closed)
                    mine = closed
        elif target.kind == "stop" and mine is not None:
            stop, set_at = swing_play.previous_stop(db, mine, target.id)
            restored = replace(hold_rows.to_hold(mine), stop_price=stop, stop_hit_at=None)
            if stop is not None:  # play may already have paused on the old stop: it must not pause on it twice
                restored = replace(restored, stop_hit_at=swing_play.crossing_since(ctx, restored, set_at))
            hold_rows.apply(mine, restored)
    except positions_mod.HoldProblem as exc:
        raise ReplayProblem(exc.message, path=exc.path, status=exc.status) from None
    if mine is not None:
        mine.updated_at = row.updated_at = now
    db.delete(db.get(PracticeMark, target.id))
    row.updated_at = now
    db.flush()
    ctx.marks = [m for m in ctx.marks if m.id != target.id]
    price = _price_or_none(ctx)
    return {
        "removed_mark_id": target.id,
        "open_trade": _open_trade(ctx, price),
        "journal": _journal(ctx, price, final=False),
        "hold": None if mine is None else swing_play.hold_out(ctx, mine, price),
    }


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
    day_list = _lock_day_list(db, session_id)  # the lock order: day list, session (, thread)
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
    clock = None if day_list is None or day_list.revealed_through is None else _ts(day_list.revealed_through)
    if clock is not None and clock > target.at:
        raise ReplayProblem("Only the last mark can be undone, before the replay moves on", path="kind", status=409)
    if ctx.swing:
        return _undo_swing_mark(db, ctx, target)
    free_before = _day_free_cash(db, row)
    db.delete(db.get(PracticeMark, mark_id))
    row.updated_at = svc.now()
    row.stop_hit_at = None
    db.flush()
    # Undoing an exit or a sale puts its shares back among the open ones (and its ledger row goes), so they pass the
    # cash rule again as the other names stand: another name may have spent the cash since (the shared day clock lets
    # a second name mark at the same moment). 409, and the request's transaction rolls the delete back.
    free_after = _day_free_cash(db, row)
    if free_after < 0 and free_after < free_before:
        raise ReplayProblem(
            "Can't undo that · it would leave you without enough practice cash", path="kind", status=409
        )
    ctx.marks = [m for m in ctx.marks if m.id != mark_id]
    price = _price_or_none(ctx)
    return {
        "removed_mark_id": mark_id,
        "open_trade": _open_trade(ctx, price),
        "journal": _journal(ctx, price, final=False),
    }


# -- end and patch -------------------------------------------------------------------------------------------


def end(db: Session, user_id: int, session_id: int, svc: Services, *, via_day: bool = False) -> dict[str, Any]:
    """Auto-exit an open trade at the price at the DAY CLOCK (the window end for a standalone session), reveal the whole
    window, store the final journal. Idempotent. Every open trade of the day is flattened this way, each at the same
    clock, so an early End day books the price she sees, not the close.

    A day-list session ends only with its day (`via_day`): unsealing one name's window would show the market's
    direction to every other name practised that day."""
    row = get_row(db, user_id, session_id, lock=True)
    ctx = context(db, svc, row)
    if row.status == "ended":
        return session_out(ctx)
    if row.day_list_id is not None and not via_day:
        raise ReplayProblem("End the day to score this session", path="kind", status=409)
    if row.day_list_id is not None and not ctx.swing and ctx.day_clock is not None:
        # A resting order the tape reached while she was on another name (the thread's clock runs without her) fills at
        # its bar before the day ends, never past the day clock; only what the clock never reached is cancelled below.
        clock = min(ctx.day_clock, ctx.window_end)
        if ctx.through < clock:
            previous, ctx.through = ctx.through, clock
            row.revealed_through = clock.to_pydatetime()
            _fill_working_orders(db, ctx, previous, clock)
    ctx.through = ctx.window_end
    # An ended session keeps the end it revealed to (a session saved before the close rule had her old mark stored).
    row.revealed_through = row.window_end = ctx.window_end.to_pydatetime()
    _expire_orders(row, ctx.window_end)
    # A swing day never auto-exits (a hold rides overnight) and books nothing here: the day's end credits the holds
    # that exited on it (02p b3), and a swing session may have no tape to price an exit from.
    exit_at = ctx.window_end if ctx.day_clock is None else min(ctx.day_clock, ctx.window_end)
    found = None if ctx.swing else last_price(ctx, exit_at)
    _, open_ = journal_mod.assemble(ctx.marks)
    if open_ is not None and not ctx.swing:
        # No price at the clock (a provider outage with no revealed bar) must not leave the trade unbooked: the day's
        # P/L would silently lose it. It exits flat at its entry, the way `positions` carries a name with no price.
        exit_price = open_.entry_price if found is None else found[0]
        db.add(
            PracticeMark(
                session_id=row.id,
                seq=(ctx.marks[-1].seq if ctx.marks else 0) + 1,
                kind="long_exit" if open_.side == "long" else "short_exit",
                at=exit_at.to_pydatetime(),
                price=exit_price,
                trade_no=open_.no,
                source="auto",
                created_at=svc.now(),
            )
        )
        db.flush()
        ctx.marks = _marks_of(_load_marks(db, row.id))
    if not ctx.swing:
        ledger_mod.book(db, row, journal_mod.assemble(ctx.marks)[0], svc.now())
    price = None if found is None else found[0]
    row.journal = jsonable(_journal(ctx, price, final=True))
    row.stop_hit_at = None
    row.status = "ended"
    row.ended_at = row.updated_at = svc.now()
    db.flush()
    return session_out(ctx)


def refresh_journal(db: Session, user_id: int, session_id: int, svc: Services) -> None:
    """Rescore an ended session's final journal. Ending a day ends its sessions one after another, so a session ended
    first scored the day rules (max loss, trade limit) before its siblings' last exits existed; the day does this
    once they have all ended."""
    row = get_row(db, user_id, session_id, lock=True)
    if row.status != "ended":
        return
    ctx = context(db, svc, row)
    if ctx.swing:  # the holds that closed in it are final once it has ended; the adherence is scored weekly
        return
    ctx.through = ctx.window_end
    row.journal = jsonable(_journal(ctx, None, final=True))
    db.flush()


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
