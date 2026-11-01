"""Swing practice (02p) inside a session: what `session.py` calls when `ctx.swing` is true.

A swing session reads one name on the day's shared clock, but its holds belong to the THREAD and carry overnight. This
module holds the reads and the small writes the session needs and keeps them out of the day-trade paths:

- **The price basis** (a4): regular session only. Tape off -> the close of the last CLOSED regular one-minute bar (first
  one at 09:31); tape on -> the last eligible print at or after 09:30:00. A premarket print never prices a swing mark.
  Once the clock reaches the regular close, every price is the day's OFFICIAL close (the daily bar's), the same price
  `swing.end_day` marks the holds at, so a hold reads the same at the 16:00 playhead and after End day (D-064).
- **The stop pause** (b5): `stop_pause` finds the first one-minute bar that crossed an open hold's stop and hands
  `advance` the time to clamp to. A stop never exits.
- **The strip and the daily block** (d2, a3 rule 4): rows for the holds and the focus names at the DAY CLOCK, and the
  rebased daily frame through D-1 with a forming D candle built from revealed one-minute bars. D's own stored daily bar
  is never read.
- **The views**: the symbol's hold as the open-trade card, `hold_out` (wrapping `swing.hold_view`), and the session's
  journal, which lists the holds that exited in it (adherence is scored weekly, 02p e).

Everything here is cut at a timestamp the caller passes (the session's playhead or the day clock), never later. It
cannot import `session` (which imports this module) or, at module level, `swing` (which imports `session`).
"""

import logging
import math
from datetime import date
from typing import TYPE_CHECKING, Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from sqlalchemy import select

from ai_trading.core.calendar import ET
from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import (
    PracticeHold,
    PracticeMark,
    PracticePlan,
    PracticeThread,
    ReplayDayList,
    ReplaySession,
)
from ai_trading.replay import hold_rows, screen
from ai_trading.replay import holds as holds_mod
from ai_trading.replay import journal as journal_mod

if TYPE_CHECKING:
    from ai_trading.replay.session import Ctx

log = logging.getLogger(__name__)

MINUTE = pd.Timedelta(minutes=1)
DAILY_BARS = 120  # the daily block's chart history (the rebased frame through D-1)
FIRST_PRINT_WINDOW = pd.Timedelta(minutes=5)  # the opening print is looked for in the first five minutes
SCORED_WEEKLY = "Scored weekly"
NOT_OPEN = "Market not open yet · step to the first bar"


def _swing() -> Any:
    """The swing module, imported on first use: it imports `session`, which imports this module."""
    from ai_trading.replay import swing

    return swing


# -- the day's rows ------------------------------------------------------------------------------------------------


def day_list(ctx: "Ctx") -> ReplayDayList:
    if "day_list" not in ctx._cache:
        found = ctx.db.get(ReplayDayList, ctx.row.day_list_id)
        assert found is not None
        ctx._cache["day_list"] = found
    return ctx._cache["day_list"]


def plan_days(ctx: "Ctx") -> list[date]:
    if "days" not in ctx._cache:
        plan = ctx.db.get(PracticePlan, day_list(ctx).plan_id)
        assert plan is not None
        ctx._cache["days"] = _swing()._days(plan)
    return ctx._cache["days"]


def day_clock(ctx: "Ctx") -> pd.Timestamp:
    """The shared day clock, never behind this session's own playhead."""
    stamped = day_list(ctx).revealed_through
    return ctx.through if stamped is None else max(ctx.through, pd.Timestamp(stamped).tz_convert("UTC"))


def lock_thread(db: Any, thread_id: int) -> PracticeThread:
    """The thread row, locked: the third step of the lock order (day list, session, THREAD, holds)."""
    return db.execute(select(PracticeThread).where(PracticeThread.id == thread_id).with_for_update()).scalar_one()


# -- one-minute bars of the day ------------------------------------------------------------------------------------


def _regular(frame: pd.DataFrame, day: date) -> pd.DataFrame:
    found = trading_session("stock", day)
    assert found is not None
    return frame[(frame.index >= found.regular_open) & (frame.index < found.regular_close)]


def _closed(frame: pd.DataFrame | None, through: pd.Timestamp) -> pd.DataFrame:
    """Bars whose minute has closed by `through`; an empty frame for a name without bars."""
    if frame is None:
        return pd.DataFrame({c: [] for c in ("open", "high", "low", "close", "volume")}, index=pd.DatetimeIndex([]))
    return frame[frame.index + MINUTE <= through]


def day_minutes(ctx: "Ctx", symbol: str) -> pd.DataFrame | None:
    """The regular-session one-minute bars of the session's day for `symbol` (None: the provider has none), read once
    per request. The session's own name comes from its inputs; any other name from the blob cache.
    ponytail: one blob decode per strip name per request; an LRU on `History` is the upgrade."""
    cache = ctx._cache.setdefault("swing_minutes", {})
    if symbol not in cache:
        frame: pd.DataFrame | None = ctx.inputs.bars_1m if symbol == ctx.symbol else None
        if symbol != ctx.symbol:
            try:
                frame = ctx.svc.history.minute_bars(ctx.store, symbol, [ctx.row.day]).get(ctx.row.day)
            except ProviderError as exc:
                log.warning("swing: minute bars unavailable for %s: %s", symbol, exc)
        cache[symbol] = None if frame is None or frame.empty else _regular(frame, ctx.row.day)
    return cache[symbol]


def official_close(history: Any, store: Any, symbol: str, day: date) -> float | None:
    """The official close of `day`: the raw daily bar's close on `day`'s own share basis, in whole cents (D-033), or
    None when the name did not trade. It is the day's value of an open hold: `swing.end_day` marks the hold at it, and
    the live day reads it once the clock has reached the close, so the two never disagree (D-064)."""
    try:
        raw = history.daily_bars(store, symbol, day)
    except ProviderError as exc:
        log.warning("swing: daily bars unavailable for %s: %s", symbol, exc)
        return None
    return journal_mod.fill_price(float(raw.loc[day, "close"])) if day in raw.index else None


def _close_if_over(ctx: "Ctx", symbol: str, through: pd.Timestamp) -> tuple[float, pd.Timestamp] | None:
    """`(official close, the regular close)` when `through` has reached the regular close, else None. The day's own
    daily bar is the day's outcome, so it is read only once the clock is at the close, where it is revealed."""
    found = trading_session("stock", ctx.row.day)
    assert found is not None
    if through < found.regular_close:
        return None
    cache = ctx._cache.setdefault("swing_official", {})
    if symbol not in cache:
        cache[symbol] = official_close(ctx.svc.history, ctx.store, symbol, ctx.row.day)
    return None if cache[symbol] is None else (cache[symbol], found.regular_close)


def last_price(ctx: "Ctx", through: pd.Timestamp) -> tuple[float, pd.Timestamp] | None:
    """The swing mark price at `through` and when it printed, or None before the first regular price. With the tape
    on, the last eligible print at or after 09:30:00 (a premarket print never counts; a tape outage or a quiet tape
    falls back to the one-minute close, as the day paths do); with it off, the last closed regular one-minute bar.
    At or after the regular close it is the official close (D-064). Whole cents, as the day paths price (D-033)."""
    if (over := _close_if_over(ctx, ctx.symbol, through)) is not None:
        return over
    found = trading_session("stock", ctx.row.day)
    assert found is not None
    if ctx.feed != "off":
        try:
            printed = ctx.svc.tape.last_print(ctx.store, ctx.symbol, through, ctx.feed)  # type: ignore[arg-type]
        except ProviderError as exc:
            log.warning("tape unavailable for the last price: %s", exc)
            printed = None
        if printed is not None and printed[0] >= found.regular_open:
            return journal_mod.fill_price(printed[1]), printed[0]
    closed = _closed(day_minutes(ctx, ctx.symbol), through)
    if closed.empty:
        return None
    return journal_mod.fill_price(float(closed["close"].iloc[-1])), closed.index[-1] + MINUTE


def first_price(ctx: "Ctx", through: pd.Timestamp) -> float | None:
    """The first regular-session price of the day revealed by `through`: the opening print with the tape on (looked for
    in the first five minutes), else the 09:30 bar's close; whole cents, as every fill is (D-033). ponytail: a tape that
    has no print in those five minutes reads the bar close; the day summary's gap is always the bar close
    (`swing._first_regular_close`), so it can differ from this price by under a cent a share."""
    found = trading_session("stock", ctx.row.day)
    assert found is not None
    if ctx.feed != "off":
        try:
            window = ctx.svc.tape.prints(
                ctx.store,
                ctx.symbol,
                found.regular_open - pd.Timedelta(nanoseconds=1),
                min(through, found.regular_open + FIRST_PRINT_WINDOW),
                ctx.feed,  # type: ignore[arg-type]
            )
        except ProviderError as exc:
            log.warning("tape unavailable for the first price: %s", exc)
            window = None
        if window is not None and len(window):
            return journal_mod.fill_price(float(window.p[0]))
    closed = _closed(day_minutes(ctx, ctx.symbol), through)
    return None if closed.empty else journal_mod.fill_price(float(closed["close"].iloc[0]))


def last_close_at(ctx: "Ctx", symbol: str, clock: pd.Timestamp) -> float | None:
    """`symbol`'s last revealed regular-session one-minute close at `clock` (strip rows), in whole cents (D-033); the
    official close once the clock has reached the close (D-064)."""
    if (over := _close_if_over(ctx, symbol, clock)) is not None:
        return over[0]
    closed = _closed(day_minutes(ctx, symbol), clock)
    return None if closed.empty else journal_mod.fill_price(float(closed["close"].iloc[-1]))


# -- the daily frame (rebased, through D-1) ------------------------------------------------------------------------


def asof(ctx: "Ctx", symbol: str) -> pd.DataFrame | None:
    """The rebased daily frame through the session before the day, on the day's share basis (None: no data)."""
    cache = ctx._cache.setdefault("swing_asof", {})
    if symbol not in cache:
        cache[symbol] = screen.asof_loader(ctx.svc.history, ctx.store, ctx.row.day)(symbol)
    return cache[symbol]


def prior_close(ctx: "Ctx", symbol: str) -> float | None:
    """The prior session's official close restated to the day's share basis (the raw one is on the old basis after a
    split)."""
    frame = asof(ctx, symbol)
    return None if frame is None or frame.empty else float(frame["close"].iloc[-1])


def forming_daily(ctx: "Ctx", through: pd.Timestamp) -> dict[str, Any] | None:
    """The day's candle so far, from revealed regular one-minute bars of the session's name (None before the first)."""
    closed = _closed(day_minutes(ctx, ctx.symbol), through)
    if closed.empty:
        return None
    return {
        "t": ctx.row.day,
        "o": float(closed["open"].iloc[0]),
        "h": float(closed["high"].max()),
        "l": float(closed["low"].min()),
        "c": float(closed["close"].iloc[-1]),
        "v": float(closed["volume"].sum()),
    }


def _open_hold(ctx: "Ctx", *, lock: bool = False) -> PracticeHold | None:
    return next((r for r in hold_rows.open_holds(ctx.db, ctx.row.thread_id, lock=lock) if r.symbol == ctx.symbol), None)


def daily_block(ctx: "Ctx", through: pd.Timestamp) -> dict[str, Any]:
    """`feed.daily` (a3 rule 4): the rebased frame through D-1 (its last 120 bars), the forming candle, and this name's
    open hold for the entry marker and the stop line. The day's own stored daily bar is never served."""
    frame = asof(ctx, ctx.symbol)
    bars = (
        []
        if frame is None
        else [
            {
                "t": index,
                "o": float(bar["open"]),
                "h": float(bar["high"]),
                "l": float(bar["low"]),
                "c": float(bar["close"]),
                "v": float(bar["volume"]),
            }
            for index, bar in frame.tail(DAILY_BARS).iterrows()
        ]
    )
    row = _open_hold(ctx)
    return {
        "bars": bars,
        "forming": forming_daily(ctx, through),
        "holds": []
        if row is None
        else [
            {
                "entry_t": row.entry_day,
                "side": row.side,
                "entry_price": float(row.entry_price),
                "stop_price": None if row.stop_price is None else float(row.stop_price),
            }
        ],
    }


# -- the stop pause ------------------------------------------------------------------------------------------------


def stop_pause(ctx: "Ctx", previous: pd.Timestamp, target: pd.Timestamp) -> tuple[dict[str, Any] | None, pd.Timestamp]:
    """Scan every open hold of the thread (not just this name) over the one-minute bars closing in `(previous, target]`
    and return `(paused, target)`: with a crossing, `target` is clamped to the bar's close, `stop_hit_at` is set on
    the crossing hold and on every other hold crossed in the same minute, and `paused` is the wire shape; without one,
    `(None, target)`. `previous` is the later of the playhead and the day clock: minutes already revealed were scanned
    by the advance that revealed them, and a hold entered later has no business with them."""
    if previous >= target:
        return None, target
    db = ctx.db
    lock_thread(db, ctx.row.thread_id)
    rows = hold_rows.open_holds(db, ctx.row.thread_id, lock=True)
    live = [r for r in rows if r.stop_price is not None and r.stop_hit_at is None]
    minutes = {r.symbol: frame for r in live if (frame := day_minutes(ctx, r.symbol)) is not None}
    crossing = holds_mod.first_stop_crossing([hold_rows.to_hold(r) for r in live], minutes, previous, target)
    if crossing is None:
        return None, target
    for row in live:
        if row.symbol == crossing.symbol or row.symbol in crossing.also:
            row.stop_hit_at, row.updated_at = crossing.at.to_pydatetime(), ctx.svc.now()
    db.flush()
    paused = {
        "symbol": crossing.symbol,
        "stop_price": crossing.stop_price,
        "at": crossing.at,
        "price": journal_mod.fill_price(crossing.price),  # the price an Exit books: whole cents (D-033)
        "kind": crossing.kind,
        "also": list(crossing.also),
    }
    return paused, crossing.at


# -- the strip -----------------------------------------------------------------------------------------------------


def _value(hold: holds_mod.Hold, last: float | None) -> float:
    """What a hold is worth per share now: the revealed price, else its prior close (else where it was bought)."""
    if last is not None:
        return last
    return hold.last_close if hold.last_close is not None else hold.entry_price


def _chg_pct(last: float | None, prior: float | None) -> float | None:
    return None if last is None or not prior else round((last / prior - 1) * 100, 2)


def strip(ctx: "Ctx", clock: pd.Timestamp) -> list[dict[str, Any]]:
    """The day strip (d2) at the DAY CLOCK: every open hold of the thread, then every focus name that is not one (at
    most 5 + 5 rows). `last` is the name's own last closed regular one-minute close at `clock`; `chg_pct` is against the
    restated prior close (a hold's `last_close`, else the as-of frame's), never the raw one."""
    rows = hold_rows.open_holds(ctx.db, ctx.row.thread_id)
    held = {r.symbol for r in rows}
    out: list[dict[str, Any]] = []
    for row in rows:
        hold = hold_rows.to_hold(row)
        last = last_close_at(ctx, row.symbol, clock)
        prior = hold.last_close if hold.last_close is not None else prior_close(ctx, row.symbol)
        value = _value(hold, last)
        room = None
        if hold.stop_price is not None:  # positive while the price is on the safe side of the stop
            room = round(hold.sign * (value - hold.stop_price) / value * 100, 2) if value else None
        out.append(
            {
                "symbol": row.symbol,
                "source": "hold",
                "last": last,
                "chg_pct": _chg_pct(last, prior),
                "hold": {
                    "side": hold.side,
                    "shares": hold.shares,
                    "unrealized_usd": holds_mod.pnl(hold, value),
                    "stop_price": hold.stop_price,
                    "stop_distance_pct": room,
                    "stopped": "yes" if hold.stop_hit_at is not None else "no",
                },
            }
        )
    for entry in day_list(ctx).watch:
        symbol = entry["symbol"]
        if symbol in held:
            continue
        last = last_close_at(ctx, symbol, clock)
        out.append(
            {
                "symbol": symbol,
                "source": "focus",
                "last": last,
                "chg_pct": _chg_pct(last, prior_close(ctx, symbol)),
                "hold": None,
            }
        )
    return out


# -- the hold as the screens read it -------------------------------------------------------------------------------


def balance(db: Any, thread: PracticeThread) -> float:
    """The thread's balance: the starting balance plus its ledger (never unrealized P/L)."""
    return _swing().balance(db, thread)


def free_cash(db: Any, thread: PracticeThread, rows: list[PracticeHold], day: date | None) -> float:
    """Free cash on `day` (b2): the ledger balance, plus today's realized P/L of the holds that exited today (credited
    to the ledger only when the day ends), minus the entry notional of every open hold. `day` None: between days,
    nothing is waiting to be credited."""
    realized = sum(
        holds_mod.closed_pnl(hold_rows.to_hold(r)) for r in rows if r.status == "closed" and r.exit_day == day
    )
    held = [hold_rows.to_hold(r) for r in rows if r.status == "open"]
    return holds_mod.free_cash(balance(db, thread), realized, held)


def _gap(ctx: "Ctx", row: PracticeHold) -> float | None:
    """A carried hold's overnight gap so far: the first regular price of the day against its restated prior close,
    signed for its side. None for a hold entered today, or until the first price is revealed."""
    hold = hold_rows.to_hold(row)
    if hold.entry_day >= ctx.row.day or hold.last_close is None:
        return None
    first = first_price(ctx, ctx.through)
    return None if first is None else holds_mod.gap_usd(hold, first, hold.last_close)


def open_trade(ctx: "Ctx", price: float | None) -> dict[str, Any] | None:
    """The name's open hold as the 02o open-trade card (`trade_no` is the hold id), at `price` (the revealed price), or
    at its prior close until one is revealed. Adds the days held, the gap and which of the two prices it shows."""
    row = _open_hold(ctx)
    if row is None:
        return None
    hold = hold_rows.to_hold(row)
    value = _value(hold, price)
    days = plan_days(ctx)
    r = holds_mod.r_multiple(hold, value)
    return {
        "trade_no": row.id,
        "side": hold.side,
        "shares": hold.shares,
        "entry_price": hold.entry_price,
        "stop_price": hold.stop_price,
        "last_price": value,
        "unrealized_usd": holds_mod.pnl(hold, value),
        "r": r,
        "opened_day_no": days.index(hold.entry_day) + 1,
        "days_held": days.index(ctx.row.day) - days.index(hold.entry_day) + 1,
        "gap_usd": _gap(ctx, row),
        "price_basis": "last" if price is not None else "prior_close",
    }


def hold_out(ctx: "Ctx", row: PracticeHold, price: float | None) -> dict[str, Any]:
    """The `HoldOut` wire shape of one of the session's name's holds. `swing.hold_view` values an open hold at its last
    official close; during the day it is valued at the revealed `price`, labelled "last" (else "prior_close")."""
    day = ctx.row.day
    chip = next((c.get("earnings") for c in day_list(ctx).candidates if c["symbol"] == row.symbol), None)
    view = _swing().hold_view(
        row,
        plan_days(ctx),
        as_of=day,
        chip=chip,
        price_basis="last" if price is not None else "prior_close",
        gap=_gap(ctx, row),
        split_day=day,
    )
    if row.status == "open":
        hold = hold_rows.to_hold(row)
        value = _value(hold, price)
        view["unrealized_usd"], view["r"] = holds_mod.pnl(hold, value), holds_mod.r_multiple(hold, value)
        view["price_basis"] = "last" if price is not None else "prior_close"
    return view


def previous_stop(db: Any, row: PracticeHold, removed_mark_id: int) -> tuple[float | None, pd.Timestamp]:
    """The stop in force before the stop mark `removed_mark_id` and when it was set: the latest earlier stop mark of
    this hold (its time), taken to the hold's share basis (a split since divides it), else the stop it entered with
    (the entry's time)."""
    earlier = db.execute(
        select(PracticeMark)
        .join(ReplaySession, ReplaySession.id == PracticeMark.session_id)
        .where(
            ReplaySession.thread_id == row.thread_id,
            PracticeMark.kind == "stop",
            PracticeMark.trade_no == row.id,
            PracticeMark.id != removed_mark_id,
        )
        .order_by(PracticeMark.at.desc(), PracticeMark.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    if earlier is None:
        return (None if row.stop_at_entry is None else float(row.stop_at_entry)), pd.Timestamp(row.entry_at).tz_convert(
            "UTC"
        )
    price = float(earlier.stop_price)
    set_at = pd.Timestamp(earlier.at).tz_convert("UTC")
    for split in row.splits or ():
        if date.fromisoformat(split["day"]) > set_at.tz_convert(ET).date():
            price = round(price / split["ratio"], 6)
    return price, set_at


def crossing_since(ctx: "Ctx", hold: holds_mod.Hold, since: pd.Timestamp) -> pd.Timestamp | None:
    """When `hold`'s stop in force was first crossed in the regular one-minute bars closing in `(since, day clock]`, or
    None. An undone stop note puts an older stop back, and whether play had already paused on it is not stored, so it is
    read again from the bars of every day from `since` to today (an earlier day's raw bars are taken to the hold's share
    basis: each split after that day divides them). Nothing later than the day clock is read."""
    today = ctx.row.day
    earlier = [d for d in plan_days(ctx) if since.tz_convert(ET).date() <= d < today]
    frames = []
    if earlier:
        try:
            raw = ctx.svc.history.minute_bars(ctx.store, hold.symbol, earlier)
        except ProviderError as exc:
            log.warning("swing: minute bars unavailable for %s: %s", hold.symbol, exc)
            raw = {}
        for day, frame in raw.items():
            ratio = math.prod(split["ratio"] for split in hold.splits if date.fromisoformat(split["day"]) > day)
            frames.append(_regular(frame, day) / ratio)
    if (now := day_minutes(ctx, hold.symbol)) is not None:
        frames.append(now)
    if not frames:
        return None
    found = holds_mod.first_stop_crossing([hold], {hold.symbol: pd.concat(frames)}, since, day_clock(ctx))
    return None if found is None else found.at


# -- the journal ---------------------------------------------------------------------------------------------------


def _trade(row: PracticeHold) -> journal_mod.Trade:
    return journal_mod.Trade(
        no=row.id,
        side=row.side,
        entry_at=pd.Timestamp(row.entry_at),
        entry_price=float(row.entry_price),
        shares=row.shares,
        stop_price=None if row.stop_at_entry is None else float(row.stop_at_entry),
        exit_at=pd.Timestamp(row.exit_at),
        exit_price=float(row.exit_price),
        exit_source=row.exit_source,
        exit_mark_id=row.exit_mark_id,
    )


def exited_in(db: Any, session_id: int) -> list[PracticeHold]:
    """The holds that closed in this session, in exit order (her exit marks; an auto exit has no session)."""
    return list(
        db.execute(
            select(PracticeHold)
            .where(PracticeHold.exit_session_id == session_id, PracticeHold.status == "closed")
            .order_by(PracticeHold.exit_at, PracticeHold.id)
        ).scalars()
    )


def journal(ctx: "Ctx") -> dict[str, Any]:
    """A valid `JournalOut` for a swing session (02p f2): the totals and the trades are the holds that CLOSED in this
    session (a hold carried in and exited here counts; one still open does not), the adherence is scored weekly, and
    there is no signals-versus-trades table or P/L series."""
    trades = [_trade(r) for r in exited_in(ctx.db, ctx.row.id)]
    return {
        "totals": journal_mod._totals(trades),
        "trades": [
            {
                "no": t.no,
                "side": t.side,
                "entry_at": t.entry_at,
                "entry_price": t.entry_price,
                "exit_at": t.exit_at,
                "exit_price": t.exit_price,
                "shares": t.shares,
                "pnl_usd": journal_mod.trade_pnl(t),
                "r": None if (r := t.r_of(t.exit_price)) is None else round(r, 2),  # type: ignore[arg-type]
                "stop_price": t.stop_price,
                "on_signal": False,
                "exit_source": t.exit_source,
            }
            for t in trades
        ],
        "adherence": {"score_pct": None, "hint": SCORED_WEEKLY, "checks": []},
        "signals_vs_trades": [],
        "pnl_series": [],
    }


def summary_totals(db: Any, session_id: int) -> tuple[int, float | None]:
    """`(trades, pnl)` of a hub row for an active swing session: the holds closed in it."""
    trades = [_trade(r) for r in exited_in(db, session_id)]
    return len(trades), round(sum(journal_mod.trade_pnl(t) for t in trades), 2) if trades else None


__all__ = (
    "NOT_OPEN",
    "SCORED_WEEKLY",
    "asof",
    "crossing_since",
    "daily_block",
    "day_clock",
    "first_price",
    "forming_daily",
    "free_cash",
    "hold_out",
    "journal",
    "last_price",
    "lock_thread",
    "open_trade",
    "prior_close",
    "stop_pause",
    "strip",
    "summary_totals",
)
