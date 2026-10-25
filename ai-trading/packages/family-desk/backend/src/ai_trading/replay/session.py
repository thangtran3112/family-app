"""The replay session store and playhead (02o decisions 1 and 6): create, advance, feed, marks, end, patch.

**The no-lookahead guarantee lives here.** A session row carries `revealed_through`, a timestamp that only moves
forward; every read below is cut at it: bars whose period has closed, prints with `time <= revealed_through`,
signals whose bar close is at or before it. The would-fire list is stored on the row and never serialized while
the session is active (only `fires_so_far`). `advance` is the only writer of `revealed_through`, under a row lock,
so two requests cannot reveal out of order. The playhead never moves backward: "Replay again" is a new attempt.

**Marks are journal annotations on a finished past day**, not orders: the server stamps each at the playhead and
prices it at the last print at or before it; she cannot pick a price, a stop note never exits, and nothing here
touches a broker, an account or a live data path.

**A swing session** (02p, `ctx.swing`) keeps the same playhead but its marks go through the thread's practice holds
(`holds.py`, `hold_rows.py`), its prices are regular-session only, `advance` pauses at a crossed stop, and the reads
carry a strip and a daily block (`swing_play.py`). Every swing branch below is guarded by `ctx.swing`; the day-trade
paths are unchanged.
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

from ai_trading.contracts.replay_session import ReplaySessionV1
from ai_trading.core.calendar import ET, annotate
from ai_trading.core.calendar import session as trading_session
from ai_trading.core.evaluate import _resample
from ai_trading.db.models import PracticeMark, PracticeThread, ReplayDayList, ReplaySession
from ai_trading.replay import hold_rows, swing_play
from ai_trading.replay import holds as holds_mod
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import ledger as ledger_mod
from ai_trading.replay import signals as signals_mod
from ai_trading.replay.cache import BlobStore, DbBlobStore
from ai_trading.replay.data import (
    DayInputs,
    History,
    ReplayDayError,
    check_day,
    check_window,
    window_bounds,
)
from ai_trading.replay.model import ENTRY_KINDS, EXIT_KINDS, INTERVAL_MINUTES, Fire, Mark, Plan
from ai_trading.replay.tape import BIG_PRINT_USD, PACE_WINDOW_S, Prints, Tape, pace, select_rows, ticks

log = logging.getLogger(__name__)

MINUTE = pd.Timedelta(minutes=1)
JUMP_TAPE_WINDOW = pd.Timedelta(minutes=30)  # a longer jump shows (and counts) only its last 30 minutes of prints
FEED_TAPE_WINDOW = pd.Timedelta(seconds=60)
FEED_PRINTS = 200
LOOKBACK_BARS_MAX = 6000  # the feed's warm-up bars (1-minute interval would otherwise carry about 9,600)
RATING_RANGE = (1, 5)
STAMP_SOURCE = "alpaca"
STALE_PRINT_S = 30  # a mark priced off a print older than this carries a warning
QUIET_PRINT_S = 60  # no eligible print for this long marks the tape quiet (a halt looks the same from here)


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


# -- small helpers -------------------------------------------------------------------------------------------


def _ts(value: datetime | pd.Timestamp) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


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
        window_end=_ts(row.window_end),
        through=_ts(row.revealed_through),
        day_trades=[] if swing else _day_trades(db, row),  # a swing journal is scored weekly, not by day rules
        swing=swing,
        db=db,
    )


def _is_swing(db: Session, row: ReplaySession) -> bool:
    if row.thread_id is None:
        return False
    return (
        db.execute(select(PracticeThread.mode).where(PracticeThread.id == row.thread_id)).scalar_one_or_none()
        == "swing"
    )


# -- views over the revealed history --------------------------------------------------------------------------


def _day_minutes(ctx: Ctx, through: pd.Timestamp) -> pd.DataFrame:
    """Closed 1-minute bars of the replay day (extended hours) at `through`, nothing later."""
    found = trading_session("stock", ctx.row.day)
    assert found is not None
    bars = ctx.inputs.bars_1m
    return bars[(bars.index >= found.extended_open) & (bars.index + MINUTE <= through)]


def _display(ctx: Ctx, minutes: pd.DataFrame, as_of: pd.Timestamp, width: int) -> pd.DataFrame:
    """Display-interval bars completed by `as_of`, with the engine's own aggregation (`day`, `phase` columns)."""
    if minutes.empty:
        return minutes.assign(day=None, phase=None)
    return _resample(annotate(minutes, "stock"), "stock", width, as_of)


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


def _forming(ctx: Ctx, minutes: pd.DataFrame, through: pd.Timestamp, width: int) -> dict[str, Any] | None:
    """The display bar now forming, built from closed minutes of the same phase bin (None on a bin boundary)."""
    if minutes.empty:
        return None
    last = minutes.index[-1]
    ann = annotate(minutes.iloc[-1:], "stock")
    if ann.empty:
        return None
    found = trading_session("stock", ctx.row.day)
    assert found is not None
    phase = ann["phase"].iloc[0]
    start_of = {"pre": found.extended_open, "regular": found.regular_open, "post": found.regular_close}[phase]
    end_of = {"pre": found.regular_open, "regular": found.regular_close, "post": found.extended_close}[phase]
    width_td = pd.Timedelta(minutes=width)
    bin_start = start_of + ((last - start_of) // width_td) * width_td
    bin_end = min(bin_start + width_td, end_of)
    if bin_end <= through:
        return None
    part = minutes[(minutes.index >= bin_start) & (minutes.index + MINUTE <= through)]
    if part.empty:
        return None
    return {
        "t": bin_start,
        "o": float(part["open"].iloc[0]),
        "h": float(part["high"].max()),
        "l": float(part["low"].min()),
        "c": float(part["close"].iloc[-1]),
        "v": float(part["volume"].sum()),
    }


def _levels(ctx: Ctx, minutes: pd.DataFrame, through: pd.Timestamp) -> dict[str, Any]:
    found = trading_session("stock", ctx.row.day)
    assert found is not None
    regular = minutes[(minutes.index >= found.regular_open) & (minutes.index < found.regular_close)]
    out: dict[str, Any] = {"prior_close": ctx.inputs.prior_close}
    if ctx.swing:  # the raw prior close is on the old share basis after a split
        out["prior_close"] = swing_play.prior_close(ctx, ctx.symbol) or ctx.inputs.prior_close
    if len(regular):
        out["session_high"] = float(regular["high"].max())
        out["session_low"] = float(regular["low"].min())
    if through >= found.regular_open + pd.Timedelta(minutes=15):
        opening = regular[regular.index < found.regular_open + pd.Timedelta(minutes=15)]
        if len(opening):
            out["opening_range_high"] = float(opening["high"].max())
            out["opening_range_low"] = float(opening["low"].min())
    return out


def last_price(ctx: Ctx, through: pd.Timestamp) -> tuple[float, pd.Timestamp] | None:
    """The mark price: the last eligible print at or before `through`, else the last revealed 1-minute close. A swing
    session prices from the regular session only (`swing_play.last_price`)."""
    if ctx.swing:
        return swing_play.last_price(ctx, through)
    try:
        found = ctx.svc.tape.last_print(ctx.store, ctx.symbol, through, ctx.feed)  # type: ignore[arg-type]
    except ProviderError as exc:
        log.warning("tape unavailable for the last price: %s", exc)
        found = None
    if found is not None:
        return found[1], found[0]
    closed = _day_minutes(ctx, through)
    if closed.empty:
        return None
    return float(closed["close"].iloc[-1]), closed.index[-1] + MINUTE


def _age_s(found: tuple[float, pd.Timestamp] | None, through: pd.Timestamp) -> int | None:
    """Seconds from the last eligible print to the playhead (never negative)."""
    return None if found is None else max(0, int((through - found[1]).total_seconds()))


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
    )


# -- session out ---------------------------------------------------------------------------------------------


def session_out(ctx: Ctx) -> dict[str, Any]:
    row = ctx.row
    ended = row.status == "ended"
    price = None if ended else (last_price(ctx, ctx.through) or (None, None))[0]
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
        "tape_feed": row.tape_feed,
        "armed": [{**ref, "fires_so_far": counts.get((ref["source"], ref["id"]), 0)} for ref in row.armed],
        "marks": [mark_out(m) for m in ctx.marks],
        "open_trade": None if ended else _open_trade(ctx, price),
        "journal": journal,
        "notes": row.notes,
        "rating": row.rating,
        "created_at": row.created_at,
        "ended_at": row.ended_at,
        "stamp": stamp(ctx.through),
    }


def summary_out(db: Session, row: ReplaySession) -> dict[str, Any]:
    """A hub row: realized trades and P/L only (cheap; no bars needed for active sessions)."""
    if row.status == "ended" and row.journal is not None:
        totals = row.journal["totals"]
        trades, pnl, adherence = totals["trades"], totals["pnl_usd"], row.journal["adherence"]["score_pct"]
    elif _is_swing(db, row):  # the holds that closed in it; its marks alone miss a carried hold's exit
        (trades, pnl), adherence = swing_play.summary_totals(db, row.id), None
    else:
        closed, _ = journal_mod.assemble(_marks_of(_load_marks(db, row.id)))
        trades = len(closed)
        pnl = round(sum(t.sign * (t.exit_price - t.entry_price) * t.shares for t in closed), 2) if closed else None  # type: ignore[operator]
        adherence = None
    return {
        "id": row.id,
        "day_list_id": row.day_list_id,
        "thread_id": row.thread_id,
        "symbol": row.symbol,
        "day": row.day,
        "attempt": row.attempt,
        "status": row.status,
        "hide_date": row.spec["hideDate"],
        "revealed_through": row.revealed_through,
        "window_end": row.window_end,
        "trades": trades,
        "pnl_usd": pnl,
        "adherence_pct": adherence,
        "updated_at": row.updated_at,
    }


def list_sessions(db: Session, user_id: int, *, status: str | None, limit: int) -> list[dict[str, Any]]:
    query = select(ReplaySession).where(ReplaySession.owner_user_id == user_id)
    if status:
        query = query.where(ReplaySession.status == status)
    rows = db.execute(query.order_by(ReplaySession.updated_at.desc(), ReplaySession.id.desc()).limit(limit)).scalars()
    return [summary_out(db, row) for row in rows]


# -- create --------------------------------------------------------------------------------------------------


def create(
    db: Session,
    user_id: int,
    spec: ReplaySessionV1,
    svc: Services,
    day_list: ReplayDayList | None = None,
    thread_id: int | None = None,
    tape_feed: str | None = None,
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
    start, end = window_bounds(day, dumped["window"]["from"], dumped["window"]["to"])
    found = trading_session("stock", day)
    assert found is not None
    limit = found.regular_close if dumped["session"] == "regular" else found.extended_close
    if end > limit:
        raise ReplayDayError("The window runs past the close", path="window")
    check_window(day, end, now)

    existing = db.execute(
        select(ReplaySession).where(
            ReplaySession.owner_user_id == user_id,
            ReplaySession.symbol == symbol,
            ReplaySession.day == day,
            ReplaySession.status == "active",
        )
    ).scalar_one_or_none()
    if existing is not None:
        if day_list is not None and existing.day_list_id != day_list.id:
            raise ReplayProblem(
                f"You already have an open {symbol} practice session for this day · end it first",
                path="symbol",
                status=409,
            )
        if day_list is None and existing.day_list_id is not None:
            raise ReplayProblem(
                "This day is part of your daily list · open it from the list", path="symbol", status=409
            )
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
        revealed_through=(
            min(max(start, _ts(day_list.revealed_through)), end)
            if day_list is not None and day_list.revealed_through
            else start
        ).to_pydatetime(),
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
    except IntegrityError:  # a concurrent create of the same active session: return that one
        db.rollback()
        return db.execute(
            select(ReplaySession).where(
                ReplaySession.owner_user_id == user_id,
                ReplaySession.symbol == symbol,
                ReplaySession.day == day,
                ReplaySession.status == "active",
            )
        ).scalar_one()
    return row


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


def _next_bar_boundary(ctx: Ctx, after: pd.Timestamp, minutes: int) -> pd.Timestamp:
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


def _frame(
    ctx: Ctx,
    *,
    bars: list[dict[str, Any]],
    through: pd.Timestamp,
    width: int,
    prints: dict[str, Any],
    signals: list[Fire],
) -> dict[str, Any]:
    minutes = _day_minutes(ctx, through)
    price = last_price(ctx, through)
    return {
        "revealed_through": through,
        "at_end": through >= ctx.window_end,
        "bars": bars,
        "forming": _forming(ctx, minutes, through, width),
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
            }
            for f in signals
        ],
        "levels": _levels(ctx, minutes, through),
        "last": None if price is None else {"price": price[0], "at": price[1], "age_s": _age_s(price, through)},
        "quiet_s": (
            age if ctx.feed != "off" and (age := _age_s(price, through)) is not None and age >= QUIET_PRINT_S else None
        ),
        "open_trade": _open_trade(ctx, None if price is None else price[0]),
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
) -> dict[str, Any]:
    if (to is None) == (step is None):
        raise ReplayProblem("Send exactly one of to and step", path="to")
    day_list = _lock_day_list(db, session_id)  # the day list row first, then the session row: one lock order
    row = get_row(db, user_id, session_id, lock=True)
    ctx = context(db, svc, row)
    width = INTERVAL_MINUTES[interval or ctx.interval]
    previous = ctx.through
    if row.status == "ended":
        target = ctx.window_end
    elif to is not None:
        if pd.Timestamp(to).tzinfo is None:
            raise ReplayProblem("Send the time with its UTC offset", path="to")
        target = _ts(to)
    elif step == "bar":
        target = _next_bar_boundary(ctx, previous, width)
    else:
        upcoming = signals_mod.next_after(ctx.fires, previous)
        if upcoming is None:
            raise ReplayProblem("No more signals in this session", path="step")
        target = upcoming.bar_close
    target = min(max(target, previous), ctx.window_end)  # forward only; clamped to the window end
    scan_from, paused = previous, None
    if day_list is not None and row.status != "ended":
        if day_list.revealed_through is not None:
            # A session behind the shared day clock catches up to it: what lies between is revealed, not markable.
            target = min(max(target, _ts(day_list.revealed_through)), ctx.window_end)
            scan_from = max(previous, _ts(day_list.revealed_through))
        if ctx.swing:  # play stops at the first crossed stop (02p b5): never earlier, never later
            paused, target = swing_play.stop_pause(ctx, scan_from, target)
        if day_list.revealed_through is None or target > _ts(day_list.revealed_through):
            day_list.revealed_through = target.to_pydatetime()

    if target > previous:
        row.revealed_through = target.to_pydatetime()
        row.updated_at = svc.now()
        db.flush()
        ctx.through = target

    minutes = _day_minutes(ctx, target)
    if width == 1:
        now_bars = _display(ctx, minutes, target, 1)
        old = set(_day_minutes(ctx, previous).index)
    else:
        now_bars = _display(ctx, minutes, target, width)
        old = set(_display(ctx, _day_minutes(ctx, previous), previous, width).index)
    new_bars = now_bars[[t not in old for t in now_bars.index]] if len(now_bars) else now_bars
    prints = _prints_block(
        ctx, previous, target, min_size=min_size, min_notional=min_notional, max_prints=max_prints, pace_too=True
    )
    fresh = [f for f in ctx.fires if previous < f.bar_close <= target]
    frame = _frame(ctx, bars=_bar_rows(new_bars), through=target, width=width, prints=prints, signals=fresh)
    if ctx.swing:
        frame |= {
            "paused": paused,
            "strip": swing_play.strip(ctx, target),
            "daily_forming": swing_play.forming_daily(ctx, target),
        }
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
    prints, the released signals (all of them once the session has ended). Never past `revealed_through`."""
    row = get_row(db, user_id, session_id)
    ctx = context(db, svc, row)
    name = interval or ctx.interval
    width = INTERVAL_MINUTES[name]
    through = ctx.window_end if row.status == "ended" else ctx.through
    ctx.through = through
    bars_1m = ctx.inputs.bars_1m
    closed = bars_1m[bars_1m.index + MINUTE <= through]
    display = _display(ctx, closed, through, width)
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
    frame = _frame(ctx, bars=_bar_rows(display), through=through, width=width, prints=prints, signals=shown)
    out = {**frame, "interval": name, "window_start": ctx.window_start}
    if ctx.swing:  # the strip reads the shared day clock; the daily block never reads the day's own daily bar
        clock = swing_play.day_clock(ctx)
        out |= {"strip": swing_play.strip(ctx, clock), "daily": swing_play.daily_block(ctx, through)}
    return out


# -- marks ---------------------------------------------------------------------------------------------------


def place_mark(db: Session, user_id: int, session_id: int, svc: Services, body: dict[str, Any]) -> dict[str, Any]:
    """Stamp a practice mark at the playhead. State rules answer 422 with `path: "kind"` or `"stopPrice"`."""
    day_list = _lock_day_list(db, session_id)
    row = get_row(db, user_id, session_id, lock=True)
    if row.status != "active":
        raise ReplayProblem("This session is over · start a new attempt", path="kind")
    ctx = context(db, svc, row)
    if day_list is not None and day_list.revealed_through is not None and ctx.through < _ts(day_list.revealed_through):
        # Revealed but not markable: the shared day clock is ahead of this name's playhead, so a mark here would be
        # stamped at a time the day has already passed. `advance` catches the name up first.
        raise ReplayProblem("This name is behind the day clock · advance to catch up before you mark", path="kind")
    if ctx.swing:
        return _place_swing_mark(db, ctx, body, svc)
    kind = body["kind"]
    closed, open_ = journal_mod.assemble(ctx.marks)
    price = None
    warning = None
    if kind != "note":
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
    if kind in ENTRY_KINDS:
        if open_ is not None:
            raise ReplayProblem("Close the open practice trade first", path="kind")
        shares = body.get("shares") or row.spec["shares"]
        trade_no = len(closed) + 1
        if stop_price is not None:
            _check_stop_side(kind == "long_entry", stop_price, price)
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

    mark = PracticeMark(
        session_id=row.id,
        seq=(ctx.marks[-1].seq if ctx.marks else 0) + 1,
        kind=kind,
        at=ctx.through.to_pydatetime(),
        price=price,
        shares=shares,
        stop_price=stop_price,
        note=body.get("note"),
        trade_no=trade_no,
        source="her",
        created_at=svc.now(),
    )
    db.add(mark)
    row.updated_at = svc.now()
    db.flush()
    ctx.marks = _marks_of(_load_marks(db, row.id))
    if kind in EXIT_KINDS:
        closed, _ = journal_mod.assemble(ctx.marks)
        ledger_mod.book(db, row, closed, svc.now())
    placed = next(m for m in ctx.marks if m.seq == mark.seq)
    return {
        "mark": mark_out(placed),
        "open_trade": _open_trade(ctx, price if price is not None else _price_or_none(ctx)),
        "journal": _journal(ctx, price if price is not None else _price_or_none(ctx), final=False),
        "warning": warning,
    }


def _place_swing_mark(db: Session, ctx: Ctx, body: dict[str, Any], svc: Services) -> dict[str, Any]:
    """`place_mark` for a swing session (02p b2): the mark stays a per-session annotation, the practice HOLD is the
    record. An entry creates the hold, a stop moves its line (and clears the pause flag), an exit closes the whole hold
    at the revealed price. No ledger row is written here: the day's end credits the holds that exited on it (R9).
    Lock order: the day list and the session (the caller), then the thread, then its holds."""
    row, kind, now = ctx.row, body["kind"], svc.now()
    price = warning = None
    if kind != "note":
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
    try:
        if kind in ENTRY_KINDS:
            shares = body.get("shares") or row.spec["shares"]
            holds_mod.check_entry(
                open_holds=[hold_rows.to_hold(r) for r in rows if r.status == "open"],
                symbol=row.symbol,
                shares=shares,
                price=price,
                free_cash_usd=swing_play.free_cash(db, thread, rows, row.day),
            )
            if stop_price is not None:
                holds_mod.check_stop("long" if kind == "long_entry" else "short", stop_price, price)
        elif kind in EXIT_KINDS:
            if mine is None or mine.side != ("long" if kind == "long_exit" else "short"):
                raise holds_mod.HoldProblem("No open practice hold to exit")
        elif kind == "stop":
            if mine is None:
                raise holds_mod.HoldProblem("Open a practice hold before setting a stop")
            holds_mod.check_stop(mine.side, stop_price, price)
        mark = PracticeMark(
            session_id=row.id,
            seq=(ctx.marks[-1].seq if ctx.marks else 0) + 1,
            kind=kind,
            at=ctx.through.to_pydatetime(),
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
        if kind in ENTRY_KINDS:
            mine = hold_rows.add_entry(
                db,
                thread,
                symbol=row.symbol,
                side="long" if kind == "long_entry" else "short",
                shares=shares,
                day=row.day,
                at=ctx.through,
                price=price,
                stop=stop_price,
                session_id=row.id,
                mark_id=mark.id,
                now=now,
            )
        elif kind in EXIT_KINDS:
            hold_rows.apply(
                mine,
                holds_mod.exit_hold(hold_rows.to_hold(mine), day=row.day, at=ctx.through, price=price, source="her"),
            )
            mine.exit_session_id, mine.exit_mark_id = row.id, mark.id
        elif kind == "stop":
            hold_rows.apply(mine, holds_mod.set_stop(hold_rows.to_hold(mine), stop_price))
        if mine is not None and kind != "note":
            mark.trade_no, mine.updated_at = mine.id, now
        db.flush()
    except holds_mod.HoldProblem as exc:
        raise ReplayProblem(exc.message, path=exc.path, status=exc.status) from None
    ctx.marks = _marks_of(_load_marks(db, row.id))
    shown = price if price is not None else _price_or_none(ctx)
    return {
        "mark": mark_out(next(m for m in ctx.marks if m.seq == mark.seq)),
        "open_trade": _open_trade(ctx, shown),
        "journal": _journal(ctx, shown, final=False),
        "warning": warning,
        "hold": None if mine is None else swing_play.hold_out(ctx, mine, shown),
    }


def _undo_swing_mark(db: Session, ctx: Ctx, target: Mark) -> dict[str, Any]:
    """`undo_mark` for a swing session (02p b2): undoing an entry deletes its hold, undoing an exit reopens it (nothing
    was credited yet), undoing a stop puts the previous stop back and clears the pause flag."""
    row = ctx.row
    thread = swing_play.lock_thread(db, row.thread_id)
    rows = hold_rows.load(db, thread.id, lock=True)
    mine = next((r for r in rows if r.symbol == row.symbol and r.status == "open"), None)
    try:
        if target.kind in ENTRY_KINDS:
            if (entered := next((r for r in rows if r.entry_mark_id == target.id), None)) is not None:
                hold_rows.delete(db, entered)
            mine = None
        elif target.kind in EXIT_KINDS:
            if (mine := next((r for r in rows if r.exit_mark_id == target.id), None)) is not None:
                hold_rows.reopen(db, mine)
        elif target.kind == "stop" and mine is not None:
            restored = replace(
                hold_rows.to_hold(mine), stop_price=swing_play.previous_stop(db, mine, target.id), stop_hit_at=None
            )
            hold_rows.apply(mine, restored)
    except holds_mod.HoldProblem as exc:
        raise ReplayProblem(exc.message, path=exc.path, status=exc.status) from None
    if mine is not None:
        mine.updated_at = row.updated_at = ctx.svc.now()
    db.delete(db.get(PracticeMark, target.id))
    row.updated_at = ctx.svc.now()
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
    swing = _is_swing(db, get_row(db, user_id, session_id))
    day_list = _lock_day_list(db, session_id) if swing else None  # the swing lock order: day list, session, thread
    row = get_row(db, user_id, session_id, lock=True)
    ctx = context(db, svc, row)
    target = next((m for m in ctx.marks if m.id == mark_id), None)
    if target is None:
        raise SessionNotFound(mark_id)
    if row.status != "active" or target.seq != ctx.marks[-1].seq or target.source != "her" or target.at != ctx.through:
        raise ReplayProblem("Only the last mark can be undone, before the replay moves on", path="kind", status=409)
    if ctx.swing:
        # The shared day clock is the playhead too: another name's advance past this mark seals it (no peeking, then
        # undoing the entry).
        clock = None if day_list is None or day_list.revealed_through is None else _ts(day_list.revealed_through)
        if clock is not None and clock > target.at:
            raise ReplayProblem("Only the last mark can be undone, before the replay moves on", path="kind", status=409)
        return _undo_swing_mark(db, ctx, target)
    db.delete(db.get(PracticeMark, mark_id))
    row.updated_at = svc.now()
    db.flush()
    ctx.marks = [m for m in ctx.marks if m.id != mark_id]
    price = _price_or_none(ctx)
    return {
        "removed_mark_id": mark_id,
        "open_trade": _open_trade(ctx, price),
        "journal": _journal(ctx, price, final=False),
    }


# -- end and patch -------------------------------------------------------------------------------------------


def end(db: Session, user_id: int, session_id: int, svc: Services, *, via_day: bool = False) -> dict[str, Any]:
    """Auto-exit an open trade at the last price, reveal the whole window, store the final journal. Idempotent.

    A day-list session ends only with its day (`via_day`): unsealing one name's window would show the market's
    direction to every other name practised that day."""
    row = get_row(db, user_id, session_id, lock=True)
    ctx = context(db, svc, row)
    if row.status == "ended":
        return session_out(ctx)
    if row.day_list_id is not None and not via_day:
        raise ReplayProblem("End the day to score this session", path="kind", status=409)
    ctx.through = ctx.window_end
    row.revealed_through = ctx.window_end.to_pydatetime()
    # A swing day never auto-exits (a hold rides overnight) and books nothing here: the day's end credits the holds
    # that exited on it (02p b3), and a swing session may have no tape to price an exit from.
    found = None if ctx.swing else last_price(ctx, ctx.window_end)
    _, open_ = journal_mod.assemble(ctx.marks)
    if open_ is not None and found is not None:
        db.add(
            PracticeMark(
                session_id=row.id,
                seq=(ctx.marks[-1].seq if ctx.marks else 0) + 1,
                kind="long_exit" if open_.side == "long" else "short_exit",
                at=ctx.window_end.to_pydatetime(),
                price=found[0],
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
