"""Swing practice (02p), the setup half: the universe she picks, the swing thread that freezes it, and the data prep.

A swing thread is a 02r thread (`practice_threads.mode = 'swing'`) plus ONE `practice_plans` row that holds its calendar
(first day, 15 to 23 sessions), its frozen universe (R6: `{"source": "swing", "symbols": [{symbol, source}],
"basis_day", "frozen_at"}`) and its prep. The plan's `spec` is the `SwingSetupV1` dump plus `"mode": "swing"`.

- **The preview** (`preview`, 02p §c1-c2) builds the table she edits before she starts: her watchlists, her manual adds,
  then optional fills (a daily filter's matches, a dollar-volume rank), each symbol with a source tag and metrics as of
  the close before Day 1 (`basis_day`). Nothing is written but the blob cache. Data comes from the blob cache; what is
  missing is fetched in priority order while `PREVIEW_BUDGET_S` lasts and the rest is `pending` (the route hands those
  to `pool_prep` in the background). Watchlist and manual picks come first, so they are ready first.
- **The label** (`SURVIVORSHIP_LABEL`) says what the universe cannot be: the symbols the Desk tracks today.
- **Excluded**: a symbol whose as-of daily frame is missing on ANY day of the range (it did not trade, or had not
  listed) cannot be practised for the whole thread. It is listed with one neutral reason that names no date, so the
  list reveals nothing about what happened later.
- **The thread** (`create_thread`) validates the days, the universe's coverage of the whole range, and the arms, then
  writes the thread and the plan row. `run_prep` loads the bars (the universe's one-minute bars and dailies, SPY's
  dailies as the benchmark, a split-adjusted frame through the last day for the week review's returns).

- **The lifecycle** (02p §a2, the second half of this module): `open_next` restates the open holds for a split and
  builds the swing board of the prior close, `start_session` opens a name on the shared day clock, `end_day` (and Pass,
  the same call on a day with no session) marks the holds at the official close, credits the ones that exited and
  stores the day summary, and `close_thread` / the last day exit what is still open at a close. `state` is the
  thread's swing block. Lock order for every swing write: day list, session, thread, holds (so `advance`, marks and
  `end` cannot deadlock).
"""

import logging
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date
from decimal import Decimal
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.contracts.practice_thread import PracticeThreadCreateV1
from ai_trading.contracts.replay_session import ReplaySessionV1
from ai_trading.core.calendar import ET, et, previous_session
from ai_trading.core.calendar import session as trading_session
from ai_trading.data.metrics import AVG_VOLUME_DAYS, metric_row
from ai_trading.data.universe import MIN_DAILY_BARS
from ai_trading.db.models import (
    FilterStrategy,
    PracticeHold,
    PracticeLedger,
    PracticePlan,
    PracticeThread,
    PracticeWeek,
    ReplayDayList,
    UniverseSymbol,
    Watchlist,
    WatchlistItem,
)
from ai_trading.replay import days as days_mod
from ai_trading.replay import hold_rows, screen, swing_play
from ai_trading.replay import holds as holds_mod
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import prep as prep_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import signals as signals_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay import week as week_mod
from ai_trading.replay.cache import BlobKey, BlobStore, decode_daily, encode_daily
from ai_trading.replay.data import History
from ai_trading.replay.screen import ASOF_PART, FilterInput
from ai_trading.replay.session import ReplayProblem, Services, jsonable
from ai_trading.screener.evaluator import DAILY_RUN_ON, SymbolBars
from ai_trading.screener.runner import source_symbols

log = logging.getLogger(__name__)

SURVIVORSHIP_LABEL = (
    "Fixed universe · {size} symbols chosen today from the symbols the Desk tracks now. Stocks that were delisted or "
    "renamed since Day 1 cannot appear, so the list leans toward survivors. Your watchlists are today's lists: a name "
    "may be on them because of moves you already know about."
)
MIN_UNIVERSE = 10
MAX_UNIVERSE = 50
MAX_FILTERS = 3
PREVIEW_BUDGET_S = 8.0  # the most one preview call spends fetching; the rest of the pool is `pending` for the prep
EXCLUDED_REASON = "Not enough price history for this whole range"
DAILY_ONLY = "Use a daily filter for a swing thread"
BENCHMARK = "SPY"  # the week review's benchmark: loaded with the thread, never in the universe, never tradable
SPLIT_PART = "swingsplit"  # the blob part of a symbol's split-adjusted frame through the thread's last day
SOURCES = ("watchlist", "manual", "filter", "liquidity")
_SYMBOL_PATTERN = "^[A-Z][A-Z0-9.]{0,9}$"  # `SwingUniverseEntryV1.symbol`


def survivorship_label(size: int) -> str:
    return SURVIVORSHIP_LABEL.format(size=size)


# -- the frames ------------------------------------------------------------------------------------------------


def split_frame(history: History, store: BlobStore, symbol: str, first_day: date, last_day: date) -> pd.DataFrame:
    """The split-adjusted daily frame through the thread's LAST day, from the blob cache (fetched and stored once). The
    as-of frames of every day read it, and so does the week review (cut at a week's last close by the reader). An
    empty frame is stored too, so a symbol without data is asked about once."""
    key = BlobKey("bars1d", symbol, last_day, SPLIT_PART, "sip")
    payload = store.get(key)
    if payload is not None:
        return decode_daily(payload)
    frame = history.split_daily(symbol, first_day, last_day)
    stored, raw_bytes = encode_daily(frame)
    store.put(key, stored, len(frame), raw_bytes)
    return frame


def is_cached(store: BlobStore, symbol: str, days: list[date]) -> bool:
    """True when the symbol's as-of blob of every day and its split frame are stored (nothing would be fetched)."""
    have = store.keys("bars1d", symbol, days)
    wanted = [BlobKey("bars1d", symbol, day, ASOF_PART, "sip") for day in days]
    return all(key in have for key in wanted) and BlobKey("bars1d", symbol, days[-1], SPLIT_PART, "sip") in have


def universe_frames(
    history: History, store: BlobStore, symbol: str, days: list[date]
) -> dict[date, pd.DataFrame | None]:
    """The as-of frame of `symbol` on each of `days` (None when it did not trade that day), fetched once: two requests
    in all (the raw dailies and the split frame), however many days."""
    split = None if is_cached(store, symbol, days) else split_frame(history, store, symbol, days[0], days[-1])
    return screen.asof_frames(history, store, symbol, days, split=split)


def has_history(frames: dict[date, pd.DataFrame | None]) -> bool:
    """A symbol can be practised for the whole range only when it has an as-of frame, of at least `MIN_DAILY_BARS`
    sessions, on every day of it."""
    return all(frame is not None and len(frame) >= MIN_DAILY_BARS for frame in frames.values())


# -- the preview -----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class PreviewRequest:
    first_day: date
    sessions: int
    watchlist_ids: Sequence[int] = ()
    filter_ids: Sequence[int] = ()
    fill: str = "liquidity"  # "liquidity" | "none"
    add: Sequence[str] = ()
    remove: Sequence[str] = ()
    target: int = MAX_UNIVERSE


@dataclass
class PreviewResult:
    body: dict[str, Any]  # the response: `basis_day`, `state`, `prep`, `rows`, `excluded`, `counts`, `survivorship`
    pending: list[str]  # symbols still to fetch, in priority order: the route runs `pool_prep` on them


def _manual(add: Sequence[str]) -> list[str]:
    out = []
    for index, raw in enumerate(add):
        symbol = raw.strip().upper()
        if not re.fullmatch(_SYMBOL_PATTERN, symbol):
            raise ReplayProblem(f"{symbol or 'An empty entry'} is not a stock symbol", path=f"add.{index}")
        out.append(symbol)
    return out


def _watchlist_symbols(db: Session, user_id: int, ids: Sequence[int]) -> list[str]:
    """Her lists' stocks, list by list in the order asked, each list in its manage-mode order."""
    out: list[str] = []
    for index, list_id in enumerate(ids):
        found = db.execute(select(Watchlist.id).where(Watchlist.id == list_id, Watchlist.user_id == user_id)).first()
        if found is None:
            raise ReplayProblem("Watchlist not found", path=f"watchlist_ids.{index}")
        out += db.execute(
            select(WatchlistItem.symbol)
            .where(WatchlistItem.watchlist_id == list_id, WatchlistItem.asset_type == "stock")
            .order_by(WatchlistItem.position, WatchlistItem.symbol)
        ).scalars()
    return out


def _daily_filters(
    db: Session, user_id: int, ids: Sequence[int], path: str
) -> list[tuple[FilterStrategy, dict[str, Any], int]]:
    """Her filters with their current spec and version id. A filter that cannot run is the plain 422 of
    `plan._resolve_filters` (at `path.N`); one that runs on bars of the day itself is `DAILY_ONLY`."""
    out = []
    for index, filter_id in enumerate(ids):
        try:
            [(row, spec, version_id)] = plan_mod._resolve_filters(db, user_id, [{"id": filter_id}])
        except ReplayProblem as problem:
            raise ReplayProblem(problem.message, path=f"{path}.{index}", status=problem.status) from None
        if spec["watch"]["runOn"] not in DAILY_RUN_ON:
            raise ReplayProblem(DAILY_ONLY, path=f"{path}.{index}")
        out.append((row, spec, version_id))
    return out


def filter_inputs(
    db: Session, user_id: int, resolved: list[tuple[FilterStrategy, dict[str, Any], int]], universe: list[str]
) -> list[FilterInput]:
    """Her daily filters as `build_list` scans them: a `market` filter scans `universe`, a watchlist filter its list."""
    out = []
    for row, spec, version_id in resolved:
        if "market" in spec["watch"]["universe"]:
            symbols = universe
            if spec.get("assetTypes"):
                kinds = dict(db.execute(select(UniverseSymbol.symbol, UniverseSymbol.asset_type)).all())
                symbols = [s for s in universe if kinds.get(s, "stock") in spec["assetTypes"]]
        else:
            symbols = source_symbols(db, spec, user_id)
        out.append(FilterInput(id=row.id, version_id=version_id, name=row.name, spec=spec, symbols=symbols))
    return out


def _check_request(req: PreviewRequest) -> None:
    if not 15 <= req.sessions <= 23:
        raise ReplayProblem("A swing thread runs 15 to 23 sessions", path="sessions")
    if not MIN_UNIVERSE <= req.target <= MAX_UNIVERSE:
        raise ReplayProblem(f"The target size is {MIN_UNIVERSE} to {MAX_UNIVERSE} symbols", path="target")
    if len(req.filter_ids) > MAX_FILTERS:
        raise ReplayProblem(f"Pick at most {MAX_FILTERS} filters", path="filter_ids")
    if req.fill not in ("liquidity", "none"):
        raise ReplayProblem("Fill by liquidity or not at all", path="fill")


def _dollar_volume(frame: pd.DataFrame) -> float:
    return float((frame["close"] * frame["volume"]).iloc[-AVG_VOLUME_DAYS:].mean())


def _row(symbol: str, source: str, frame: pd.DataFrame, matched: list[str]) -> dict[str, Any]:
    """The table row: every figure is read from the as-of frame, which ends at the close before Day 1."""
    close = frame["close"]
    return {
        "symbol": symbol,
        "source": source,
        "prior_close": round(float(close.iloc[-1]), 4),
        "chg_20d_pct": round((float(close.iloc[-1]) / float(close.iloc[-21]) - 1) * 100, 2)
        if len(close) > 20
        else None,
        "avg_dollar_volume_20d": round(_dollar_volume(frame)),
        "atr_pct_14": metric_row(frame)["atr_pct_14"],
        "matched": matched,
        "warnings": [],
    }


def preview(db: Session, user_id: int, req: PreviewRequest, svc: Services) -> PreviewResult:
    """The universe table of 02p §c1 for this request. Raises `ReplayProblem` for a request that cannot run (the days,
    a list or filter that is not hers, an intraday filter). Everything is as of `basis_day`, the session before the
    first day: the frames end there and the later days are only asked whether they exist (see `EXCLUDED_REASON`)."""
    _check_request(req)
    days = plan_mod.check_range(req.first_day, req.sessions, svc.now(), path="first_day")
    basis_day = previous_session("stock", req.first_day)
    removed = {symbol.strip().upper() for symbol in req.remove}
    watchlist = _watchlist_symbols(db, user_id, list(dict.fromkeys(req.watchlist_ids)))
    manual = _manual(req.add)
    resolved = _daily_filters(db, user_id, req.filter_ids, "filter_ids")
    liquidity = req.fill == "liquidity"
    pool = plan_mod.practice_universe(db, user_id)[0] if (liquidity or resolved) else []
    scans = filter_inputs(db, user_id, resolved, pool)

    # Fetch in priority order: her own picks, then the pool, then whatever else a filter scans.
    scanned = (symbol for item in scans for symbol in item.symbols)
    needed = [s for s in dict.fromkeys([*watchlist, *manual, *pool, *scanned]) if s not in removed]
    store = svc.store_factory(db)
    cached: set[str] = set()
    pending: list[str] = []
    started = time.monotonic()
    for symbol in needed:
        if is_cached(store, symbol, days):
            cached.add(symbol)
        elif time.monotonic() - started >= PREVIEW_BUDGET_S:
            pending.append(symbol)
        else:
            try:
                universe_frames(svc.history, store, symbol, days)
                cached.add(symbol)
            except ProviderError as exc:
                # ponytail: a symbol the provider keeps refusing stays pending (never "excluded" for an outage), so
                # the form keeps saying "preparing"; a retry limit or an error list is the upgrade if that bites.
                log.warning("swing preview: %s unavailable: %s", symbol, exc)
                pending.append(symbol)

    basis = {s: screen.asof_frames(svc.history, store, s, [days[0]])[days[0]] for s in needed if s in cached}
    matched: dict[str, list[str]] = {}
    ordered_matches: list[str] = []
    if scans:
        built = screen.build_list(
            filters=scans,
            daily_of=basis.get,
            minutes_of=lambda _symbol: None,
            day=req.first_day,
            list_at=et(req.first_day, screen.LIST_AT_MIN),
            max_list=len(needed) + 1,
        )
        matched = {c["symbol"]: c["filters"] for c in built.candidates}
        ordered_matches = [c["symbol"] for c in built.candidates]
    ranked = sorted(
        (s for s in pool if (frame := basis.get(s)) is not None and screen.passes_floor(frame)),
        key=lambda s: (-_dollar_volume(basis[s]), s),
    )
    sequence = [
        *((s, "watchlist") for s in watchlist),
        *((s, "manual") for s in manual),
        *((s, "filter") for s in ordered_matches),
        *(((s, "liquidity") for s in ranked) if liquidity else ()),
    ]

    rows: list[dict[str, Any]] = []
    excluded: list[dict[str, str]] = []
    seen: set[str] = set()
    for symbol, source in sequence:
        if len(rows) >= req.target:
            break
        if symbol in seen:
            continue
        seen.add(symbol)
        if symbol not in cached:
            continue  # pending, or removed (never fetched): a pending symbol takes its place once its data is in
        if not has_history(universe_frames(svc.history, store, symbol, days)):
            excluded.append({"symbol": symbol, "reason": EXCLUDED_REASON})
            continue
        row = _row(symbol, source, basis[symbol], matched.get(symbol, []))
        if source in ("watchlist", "manual") and not screen.passes_floor(basis[symbol]):
            row["warnings"].append("below floor")  # her own picks may be below it; a fill never is
        rows.append(row)

    counts = {source: sum(1 for r in rows if r["source"] == source) for source in SOURCES}
    return PreviewResult(
        body={
            "basis_day": basis_day.isoformat(),
            "state": "preparing" if pending else "ready",
            "prep": {"done": len(cached), "total": len(needed)},
            "rows": rows,
            "excluded": excluded,
            "counts": {**counts, "total": len(rows)},
            "survivorship": survivorship_label(len(rows)),
        },
        pending=pending,
    )


def pool_prep(db: Session, svc: Services, user_id: int, req: PreviewRequest, symbols: Sequence[str]) -> dict[str, str]:
    """Fetch the as-of frames of the `pending` symbols for the whole range, committing after each (the blob cache is the
    cursor, so a restart resumes and a repeated call fetches nothing). A symbol that fails is recorded, never fatal.
    The route runs this as a background task with its own session. Returns `{symbol: error name}` for the failures."""
    days = plan_mod.plan_days(req.first_day, req.sessions)
    store = svc.store_factory(db)
    failed: dict[str, str] = {}
    for symbol in symbols:
        try:
            universe_frames(svc.history, store, symbol, days)
            db.commit()
        except Exception as exc:  # noqa: BLE001 -- one symbol must not stop a 130-symbol prep
            db.rollback()
            failed[symbol] = type(exc).__name__
            log.warning("swing pool prep for user %s: %s failed: %s", user_id, symbol, type(exc).__name__)
    return failed


# -- the thread ------------------------------------------------------------------------------------------------


def _check_arms(db: Session, user_id: int, swing: dict[str, Any]) -> None:
    """Her armed strategies must run in a replay (`signals.resolve`, the rules a session applies) and a filter must be a
    daily one: the swing board reads the prior close, so an intraday filter has nothing to match."""
    if not swing["armed"]:
        return
    try:
        armed = signals_mod.resolve(db, user_id, swing["armed"], swing["universe"][0]["symbol"])
    except signals_mod.ArmProblem as exc:
        raise ReplayProblem(exc.message, path=f"swing.armed.{exc.index}.id") from None
    for index, item in enumerate(armed):
        if item.source == "filter" and item.spec["watch"]["runOn"] not in DAILY_RUN_ON:
            raise ReplayProblem(DAILY_ONLY, path=f"swing.armed.{index}.id")


def create_thread(
    db: Session, user_id: int, spec: PracticeThreadCreateV1, svc: Services
) -> tuple[PracticeThread, PracticePlan]:
    """Validate and write a swing thread: the days, one active swing thread per owner, the plan against the balance,
    the arms, and every universe symbol's data for the whole range (fetched now when it is not cached). Then the
    thread row and its ONE plan row, with the universe frozen in order and prep marked running (the caller starts
    `run_prep`)."""
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    if dumped["mode"] != "swing":
        raise ReplayProblem("This is not a swing thread", path="mode")
    swing = dumped["swing"]
    now = svc.now()
    first = date.fromisoformat(swing["firstDay"])
    days = plan_mod.check_range(first, swing["sessions"], now, path="swing.firstDay")
    threads_mod.check_new_thread(db, user_id, dumped)
    _check_arms(db, user_id, swing)
    store = svc.store_factory(db)
    for index, entry in enumerate(swing["universe"]):
        if not has_history(universe_frames(svc.history, store, entry["symbol"], days)):
            raise ReplayProblem(
                f"{entry['symbol']} has not enough price history for this whole range",
                path=f"swing.universe.{index}.symbol",
            )

    thread = threads_mod.add_thread(db, user_id, dumped, now)
    row = PracticePlan(
        owner_user_id=user_id,
        schema_version=1,
        spec={**swing, "mode": "swing"},
        first_day=first,
        universe={
            "source": "swing",
            "symbols": swing["universe"],
            "basis_day": previous_session("stock", first).isoformat(),
            "frozen_at": now.isoformat(),
        },
        prep={
            "state": "running",
            "done": 0,
            "total": len(swing["universe"]) + 1,  # the universe plus the benchmark
            "failed": {},
            "updated_at": now.isoformat(),
        },
        day_cursor=None,
        days_opened=0,
        status="active",
        created_at=now,
        updated_at=now,
        thread_id=thread.id,
    )
    db.add(row)
    db.flush()
    return thread, row


# -- thread prep -----------------------------------------------------------------------------------------------


def _quiet(_message: str) -> None:
    return None


def run_prep(db: Session, svc: Services, plan_id: int) -> dict[str, Any]:
    """The swing counterpart of `plan.run_prep`: for each universe symbol the one-minute bars of the days and their ten
    lookback sessions plus the raw dailies, then the as-of frames (with the split frame through the last day); for SPY
    the daily frames only. Progress commits after each symbol, a restart resumes through the write-once blob cache,
    and a symbol that fails is recorded, never fatal."""
    plan = db.get(PracticePlan, plan_id)
    if plan is None:
        log.warning("swing prep: plan %s is not visible", plan_id)
        return {}
    days = plan_mod.plan_days(plan.first_day, plan.spec["sessions"])
    store = svc.store_factory(db)
    universe = [entry["symbol"] for entry in plan.universe["symbols"]]
    symbols = [*universe, BENCHMARK]
    failed: dict[str, str] = {}
    for done, symbol in enumerate(symbols, start=1):
        try:
            report = (
                prep_mod.preload_bars(svc.history, store, [symbol], days, now=svc.now(), say=_quiet)
                if symbol != BENCHMARK
                else None
            )
            if report is not None and report.failed:
                failed[symbol] = report.failed[symbol]
            else:
                universe_frames(svc.history, store, symbol, days)
        except Exception as exc:  # noqa: BLE001 -- one symbol must not stop a 50-symbol prep
            db.rollback()
            failed[symbol] = type(exc).__name__
        plan = db.get(PracticePlan, plan_id)
        assert plan is not None
        plan.prep = {
            "state": "running" if done < len(symbols) else "done",
            "done": done,
            "total": len(symbols),
            "failed": failed,
            "updated_at": svc.now().isoformat(),
        }
        db.commit()
    return plan.prep


def day_ready(plan: PracticePlan, store: BlobStore, day: date) -> bool:
    """True when prep is over, or the as-of frame of `day` is stored for the whole universe and SPY (prep fetches the
    rest): the swing counterpart of `plan._day_ready`."""
    if plan.prep.get("state") == "done":
        return True
    wanted = [entry["symbol"] for entry in plan.universe["symbols"]] + [BENCHMARK]
    return all(
        BlobKey("bars1d", symbol, day, ASOF_PART, "sip") in store.keys("bars1d", symbol, [day]) for symbol in wanted
    )


# -- the lifecycle (02p §a2) -----------------------------------------------------------------------------------

EARNINGS_SESSIONS = 10  # the board's earnings chip looks this many sessions ahead of the day
BOARD_ROWS = MAX_UNIVERSE
PEEK_DAILY_BARS = plan_mod.PEEK_DAILY_BARS
DIVIDEND_NOTE = "Dividends are not credited in practice"
ONE_MINUTE_NOTE = "Swing prices are one-minute closes · turn the tape on for exact prints"
BOARD_COLUMNS = [
    {"key": "source", "label": "Source", "format": "text"},
    {"key": "prior_close", "label": "Prior close", "format": "price"},
    {"key": "chg_1d_pct", "label": "1d %", "format": "pct_signed"},
    {"key": "chg_5d_pct", "label": "5d %", "format": "pct_signed"},
    {"key": "chg_20d_pct", "label": "20d %", "format": "pct_signed"},
    {"key": "atr_pct_14", "label": "ATR %", "format": "pct"},
    {"key": "rsi_14", "label": "RSI", "format": "number"},
    {"key": "rvol_10d", "label": "RVOL", "format": "ratio"},
    {"key": "pct_from_20d_high", "label": "vs 20d high %", "format": "pct_signed"},
    {"key": "vs_50d_avg_pct", "label": "vs 50d avg %", "format": "pct_signed"},
    {"key": "avg_dollar_volume_20d", "label": "$ volume 20d", "format": "compact"},
    {"key": "matches", "label": "Matches", "format": "text"},
]


def _money(value: float | Decimal) -> float:
    return round(float(value), 2)


def _thread_plan(db: Session, thread_id: int, *, lock: bool = False) -> PracticePlan:
    """The thread's ONE plan row, active or archived (the last day archives it while the thread reads finished)."""
    query = select(PracticePlan).where(PracticePlan.thread_id == thread_id).order_by(PracticePlan.id.desc()).limit(1)
    return db.execute(query.with_for_update() if lock else query).scalar_one()


def plan_snapshot(thread: PracticeThread, plan: PracticePlan) -> dict[str, Any]:
    """The plan fields the weekly review scores, as they stand now (the thread plan's names, R1, and the swing spec's).
    A day list keeps them in its `screen` when it opens, so a week is scored under the plan its days started with. A
    limit that is not set is absent."""
    fields = {
        "stopNoteOnEntry": thread.stop_note_on_entry,
        "tradeOnlyOnSignal": thread.trade_only_on_signal,
        "maxLossUsd": thread.max_loss_usd,
        "maxTrades": thread.max_trades,
        "riskPerHoldUsd": plan.spec.get("riskPerHoldUsd"),
        "maxOpenHolds": plan.spec["maxOpenHolds"],
    }
    return {key: value for key, value in fields.items() if value is not None}


def _days(plan: PracticePlan) -> list[date]:
    return plan_mod.plan_days(plan.first_day, plan.spec["sessions"])


def balance(db: Session, thread: PracticeThread) -> float:
    """The thread's balance: the starting balance plus its ledger (never unrealized P/L, 02p b3)."""
    total = db.execute(
        select(func.coalesce(func.sum(PracticeLedger.pnl_usd), 0)).where(PracticeLedger.thread_id == thread.id)
    ).scalar_one()
    return _money(thread.starting_balance + Decimal(total))


def _value_price(hold: holds_mod.Hold) -> float:
    """The price an open hold is valued at outside the live day: its last official close, else (a hold entered on a day
    that has not ended) where it was bought, so nothing later than the last ended close is ever read."""
    return hold.last_close if hold.last_close is not None else hold.entry_price


def _minutes_of(history: History, store: BlobStore, symbol: str, day: date) -> pd.DataFrame | None:
    try:
        frame = history.minute_bars(store, symbol, [day]).get(day)
    except ProviderError as exc:
        log.warning("swing: minute bars unavailable for %s: %s", symbol, exc)
        return None
    return None if frame is None or frame.empty else frame


def _first_regular_close(frame: pd.DataFrame | None, day: date) -> float | None:
    """The first regular-session price of `day`: the 09:30 one-minute bar's close, in whole cents like every fill and
    every mark (D-033, D-064: the gap runs from a whole-cent close to a whole-cent price). ponytail: with the tape on,
    the exact opening print can differ from this by a cent or two; the gap figure stays one-minute exact until a swing
    thread asks for prints (the tape is fetched around the playhead only)."""
    if frame is None:
        return None
    found = trading_session("stock", day)
    assert found is not None
    regular = frame[(frame.index >= found.regular_open) & (frame.index < found.regular_close)]
    return journal_mod.fill_price(float(regular["close"].iloc[0])) if len(regular) else None


# -- the board (d1) ------------------------------------------------------------------------------------------------


def earnings_chips(sources: Any, symbols: Sequence[str], day: date, now: Any) -> dict[str, dict[str, Any]]:
    """`{symbol: {"in_sessions": n, "timing": "before open" | "after close"}}` for the symbols with an explicit report
    date AND an explicit timing within the next `EARNINGS_SESSIONS` sessions (0 is `day` itself). The calendar is
    published weeks ahead, so this is known on the morning; a gap-derived guess is never shown (02p a3 rule 9). Budgeted
    like `plan.earnings_flags`: a provider failure or a slow chain leaves a symbol without a chip."""
    if sources is None:
        return {}
    ahead = {d: n for n, d in enumerate(plan_mod.plan_days(day, EARNINGS_SESSIONS + 1))}
    out: dict[str, dict[str, Any]] = {}
    started = time.monotonic()
    for symbol in symbols:
        if time.monotonic() - started > plan_mod.EARNINGS_BUDGET_S:
            break
        try:
            events = days_mod.earnings_events(sources, symbol, now)
        except Exception as exc:  # noqa: BLE001 -- never fail a board over a calendar lookup
            log.warning("earnings lookup failed for %s: %s", symbol, type(exc).__name__)
            continue
        found = [
            (ahead[report], "before open" if timing.lower().startswith("pre") else "after close")
            for report, timing in events
            if report in ahead and (timing or "").lower().startswith(("pre", "post"))
        ]
        if found:
            n, timing = min(found)
            out[symbol] = {"in_sessions": n, "timing": timing}
    return out


def _board_row(
    entry: dict[str, str], frame: pd.DataFrame | None, matches: list[str], chip: dict[str, Any] | None
) -> dict[str, Any]:
    """One board row, every figure read from the as-of frame (through the prior close). An empty frame (the provider
    failed for the symbol) keeps the row with empty figures."""
    row: dict[str, Any] = {
        "symbol": entry["symbol"],
        "source": entry["source"],
        "prior_close": None,
        "chg_1d_pct": None,
        "chg_5d_pct": None,
        "chg_20d_pct": None,
        "atr_pct_14": None,
        "rsi_14": None,
        "rvol_10d": None,  # the daily RVOL of `metric_row` (10 sessions); 02p says 20, the shared metric keeps 10
        "pct_from_20d_high": None,
        "vs_50d_avg_pct": None,
        "avg_dollar_volume_20d": None,
        "matches": matches,
        "earnings": chip,
    }
    if frame is None or len(frame) < MIN_DAILY_BARS:
        return row
    close, metrics = frame["close"], metric_row(frame)
    last = float(close.iloc[-1])

    def change(sessions: int) -> float | None:
        return round((last / float(close.iloc[-1 - sessions]) - 1) * 100, 2) if len(close) > sessions else None

    row.update(
        prior_close=round(last, 4),
        chg_1d_pct=change(1),
        chg_5d_pct=change(5),
        chg_20d_pct=change(20),
        atr_pct_14=metrics["atr_pct_14"],
        rsi_14=metrics["rsi_14"],
        rvol_10d=metrics["rvol_10d"],
        pct_from_20d_high=round((last / float(frame["high"].iloc[-20:].max()) - 1) * 100, 2),
        vs_50d_avg_pct=round((last / float(close.iloc[-50:].mean()) - 1) * 100, 2) if len(close) >= 50 else None,
        avg_dollar_volume_20d=round(_dollar_volume(frame)),
    )
    return row


def _sort_board(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Matches count (most first), then source order (watchlist, manual, filter, liquidity), then dollar volume."""
    return sorted(
        rows,
        key=lambda r: (
            -len(r["matches"]),
            week_mod.SOURCE_ORDER.index(r["source"]),
            -(r["avg_dollar_volume_20d"] or 0),
            r["symbol"],
        ),
    )


def _armed_filters(db: Session, user_id: int, plan: PracticePlan) -> list[tuple[FilterStrategy, dict[str, Any], int]]:
    """Her armed daily filters as they stand today. One that was deleted, archived, or edited into an intraday one
    since the thread began matches nothing (the thread keeps going)."""
    out = []
    for ref in plan.spec["armed"]:
        if ref["source"] != "filter":
            continue
        try:
            [(row, spec, version_id)] = plan_mod._resolve_filters(db, user_id, [{"id": ref["id"]}])
        except ReplayProblem:
            continue
        if spec["watch"]["runOn"] in DAILY_RUN_ON:
            out.append((row, spec, version_id))
    return out


def _restate_splits(
    history: History, store: BlobStore, rows: list[PracticeHold], days: list[date], day: date, now: Any
) -> None:
    """02p b4: a split that takes effect on `day` restates each open hold before the open. `k` is the ratio of the
    raw-to-split-adjusted close of the prior session over the same ratio of `day`'s own bar: only that ratio of `day` is
    read (a corporate action is known before the open, a3 rule 10). A hold restated to 0 shares (a reverse split that
    rounds down) closes FLAT instead: the row cannot store 0 shares, and "cash in lieu is not modeled" says it earns
    nothing, so it keeps its shares and prices, exits at its entry price on `day`'s open (P/L 0, `exit_source auto`) and
    its `splits` entry records `shares_after: 0`. (Its unrealized gain up to the prior close is not carried over.)"""
    prior = previous_session("stock", day)
    found = trading_session("stock", day)
    assert found is not None
    for row in rows:
        raw = history.daily_bars(store, row.symbol, day)
        adjusted = split_frame(history, store, row.symbol, days[0], days[-1])
        if not all(d in frame.index for frame in (raw, adjusted) for d in (prior, day)):
            continue
        closes = [float(raw.loc[prior, "close"]), float(adjusted.loc[prior, "close"])]
        closes += [float(raw.loc[day, "close"]), float(adjusted.loc[day, "close"])]
        if not all(close > 0 for close in closes):
            continue  # a missing or zero close is bad data, not a split
        k = holds_mod.split_factor(*closes)
        if k == 1.0:
            continue
        hold = hold_rows.to_hold(row)
        restated = holds_mod.restate(hold, k, day)
        if restated.shares == 0:
            restated = holds_mod.exit_hold(
                replace(hold, splits=restated.splits),
                day=day,
                at=found.regular_open,
                price=hold.entry_price,
                source="auto",
            )
        hold_rows.apply(row, restated)
        row.updated_at = now


def open_next(db: Session, user_id: int, svc: Services, thread_id: int) -> plan_mod.Opened:
    """The thread's current day while it is not over; else the next day, built now: the open holds are restated for a
    split that takes effect on it (b4), the swing board is built from daily bars cut at the prior close (d1), the week
    row opens with its first day, and the day list is stored (R6). The cursor works as `plan.open_next`: data not ready
    -> no list (the prep may be stale, the caller restarts it), every day done -> no list. 409 on a closed thread.

    Everything the board reads ends at the prior session's close; the earnings chip reads the calendar, never a bar.
    ponytail: the daily RVOL is `metric_row`'s 10-session one (02p names 20)."""
    thread = threads_mod.get_thread(db, user_id, thread_id, lock=True)
    if thread.mode != "swing":
        raise ReplayProblem("This is not a swing thread", path="threadId")
    if thread.status == "closed":
        raise ReplayProblem(threads_mod.CLOSED_THREAD, path="threadId", status=409)
    plan = _thread_plan(db, thread.id, lock=True)
    days = _days(plan)
    latest = plan_mod._latest(db, plan.id)
    if latest is not None and latest.status != "ended":
        return plan_mod.Opened(plan, latest)
    index = 0 if latest is None else days.index(latest.day) + 1
    if index >= len(days):
        return plan_mod.Opened(plan, None)
    day = days[index]
    store = svc.store_factory(db)
    now = svc.now()
    if not day_ready(plan, store, day):
        stale = plan_mod._prep_stale(plan, now)
        if stale:
            plan.prep = {**plan.prep, "updated_at": now.isoformat()}
        return plan_mod.Opened(plan, None, restart_prep=stale)

    _restate_splits(svc.history, store, hold_rows.open_holds(db, thread.id, lock=True), days, day, now)

    universe = plan.universe["symbols"]
    symbols = [entry["symbol"] for entry in universe]
    prior = previous_session("stock", day)
    through = pd.Timestamp(
        trading_session("stock", prior).regular_close
    )  # the prior regular close: nothing later is read
    load = screen.asof_loader(svc.history, store, day)
    frames: dict[str, pd.DataFrame | None] = {}
    for symbol in symbols:
        frame = load(symbol)
        cut = None if frame is None else screen.cut_frames(SymbolBars(frame), through).daily
        frames[symbol] = None if cut is None or cut.empty else cut
    filters = filter_inputs(db, user_id, _armed_filters(db, user_id, plan), symbols)
    matches: dict[str, list[str]] = {}
    if filters:
        built = screen.build_list(
            filters=filters,
            daily_of=frames.get,
            minutes_of=lambda _symbol: None,
            day=day,
            list_at=et(day, screen.LIST_AT_MIN),
            max_list=BOARD_ROWS,
        )
        matches = {c["symbol"]: c["filters"] for c in built.candidates}
    chips = earnings_chips(svc.sources, symbols, day, now)
    rows = _sort_board(
        [
            _board_row(entry, frames[entry["symbol"]], matches.get(entry["symbol"], []), chips.get(entry["symbol"]))
            for entry in universe
        ]
    )

    span = week_mod.span_for(days, day)
    if day == span.days[0] and db.get(PracticeWeek, (thread.id, span.week_no)) is None:
        db.add(
            PracticeWeek(
                thread_id=thread.id,
                owner_user_id=user_id,
                week_no=span.week_no,
                first_day=span.days[0],
                last_day=span.days[-1],
                status="open",
                review=None,
                notes=None,
                rating=None,
                created_at=now,
                closed_at=None,
            )
        )
    mix = {source: n for source in SOURCES if (n := sum(1 for entry in universe if entry["source"] == source))}
    row = ReplayDayList(
        plan_id=plan.id,
        owner_user_id=user_id,
        day=day,
        day_no=index + 1,
        screen={
            "filters": [{"id": f.id, "version_id": f.version_id, "name": f.name} for f in filters],
            "listAt": screen.LIST_AT_MIN,
            "maxList": BOARD_ROWS,
            "plan": plan_snapshot(thread, plan),
        },
        list_at=through.to_pydatetime(),
        data_through=through.to_pydatetime(),
        universe={
            "source": "swing",
            "size": len(universe),
            "mix": mix,
            "label": survivorship_label(len(universe)),
            "footnote": DIVIDEND_NOTE if plan.spec["tape"] == "on" else f"{DIVIDEND_NOTE} · {ONE_MINUTE_NOTE}",
        },
        columns=BOARD_COLUMNS,
        candidates=jsonable(rows),
        watch=[],
        revealed_through=None,
        status="listed",
        journal=None,
        review=None,
        notes=None,
        rating=None,
        created_at=now,
        updated_at=now,
        ended_at=None,
    )
    db.add(row)
    plan.day_cursor, plan.days_opened, plan.updated_at = day, plan.days_opened + 1, now
    try:
        db.flush()
    except IntegrityError:  # a concurrent open of the same day: use that list
        db.rollback()
        plan = _thread_plan(db, thread_id)
        return plan_mod.Opened(plan, plan_mod._latest(db, plan.id))
    return plan_mod.Opened(plan, row)


# -- the day's sessions ----------------------------------------------------------------------------------------


def _session_spec(plan: PracticePlan, day: date, symbol: str, thread: PracticeThread) -> ReplaySessionV1:
    """A swing session is built by the server: the regular session 09:30 to the day's real close (13:00 on a half day,
    which `session.create` would refuse a later end for), the plan's interval, 100 shares as the default entry size, the
    thread's risk plan as it stands now (snapshotted by the session)."""
    found = trading_session("stock", day)
    assert found is not None
    return ReplaySessionV1.model_validate(
        {
            "schemaVersion": 1,
            "symbol": symbol,
            "day": day.isoformat(),
            "window": {"from": "09:30", "to": found.regular_close.tz_convert(ET).strftime("%H:%M")},
            "session": "regular",
            "interval": plan.spec["interval"],
            "shares": plan_mod.DAY_SESSION_SHARES,
            "armed": plan.spec["armed"],
            "plan": threads_mod.session_plan(thread),
            "hideDate": plan.spec["hideDates"],
        }
    )


def start_session(db: Session, user_id: int, day_list_id: int, symbol: str, svc: Services):
    """A session on a focus name or an open hold, on the day's shared clock. A second, third... name is allowed (the
    02o-b v1 one-name rule is for day threads). Tape off fixes the session's feed to `off` (no prints are fetched)."""
    row = plan_mod.get_day_list(db, user_id, day_list_id, lock=True)
    if row.status == "ended":
        raise ReplayProblem("The day is over · open the next day from the practice page", path="symbol", status=409)
    plan = db.get(PracticePlan, row.plan_id)
    assert plan is not None
    thread = db.get(PracticeThread, plan.thread_id)
    assert thread is not None
    if thread.status == "closed":
        raise ReplayProblem(threads_mod.CLOSED_THREAD, path="threadId", status=409)
    focus = {w["symbol"] for w in row.watch}
    if symbol not in focus | {h.symbol for h in hold_rows.open_holds(db, thread.id)}:
        raise ReplayProblem(f"{symbol} is not a focus name or a practice hold", path="symbol")
    created = session_mod.create(
        db,
        user_id,
        _session_spec(plan, row.day, symbol, thread),
        svc,
        day_list=row,
        thread_id=thread.id,
        tape_feed="off" if plan.spec["tape"] == "off" else None,
    )
    if row.status == "listed":
        row.status = "practicing"
    row.updated_at = svc.now()
    if row.revealed_through is None or plan_mod._utc(created.revealed_through) > plan_mod._utc(row.revealed_through):
        row.revealed_through = created.revealed_through
    elif created.status == "active" and plan_mod._utc(created.revealed_through) < plan_mod._utc(row.revealed_through):
        # A name opened earlier fell behind the shared day clock while she played another one. Returning to it lifts it
        # to the clock (what lies between is already revealed on the strip and cannot be marked), exactly as an
        # `advance` would; every advance scanned all holds' stops, so nothing is skipped by the lift.
        created.revealed_through = row.revealed_through
        created.updated_at = svc.now()
    db.flush()
    return created


# -- ending a day (and Pass) -----------------------------------------------------------------------------------------


def _freeze_week(db: Session, svc: Services | None, thread: PracticeThread, week_no: int, now: Any) -> None:
    """Close the week row with its review (`swing_weeks.freeze`, which imports this module, so it is imported here)."""
    from ai_trading.replay import swing_weeks

    swing_weeks.freeze(db, svc, thread, _thread_plan(db, thread.id), week_no, now)


def _max_open(rows: list[PracticeHold], day: date) -> int:
    """The most holds open at once on `day`: those carried in, plus entries, minus exits, in time order (an exit first
    on a tie)."""
    running = sum(1 for r in rows if r.entry_day < day and (r.status == "open" or r.exit_day >= day))
    events = [(r.entry_at, 1) for r in rows if r.entry_day == day]
    events += [(r.exit_at, -1) for r in rows if r.status == "closed" and r.exit_day == day]
    best = running
    for _, step in sorted(events, key=lambda event: (event[0], event[1])):
        running += step
        best = max(best, running)
    return best


def _day_summary(
    db: Session,
    row: ReplayDayList,
    thread: PracticeThread,
    days: list[date],
    *,
    sessions: int,
    all_rows: list[PracticeHold],
    carried: list[PracticeHold],
    start_close: dict[int, float],
    minutes: dict[str, pd.DataFrame],
    stop_hits: list[dict[str, str]],
) -> dict[str, Any]:
    """The day's one strip of tiles (02p b6), from the holds as they stand after the close: the realized P/L of the
    holds that exited today (credited to the ledger), the overnight gap of the carried ones, and the rest of the equity
    change as intraday. `holds` lists the open holds marked at the close and the ones that exited today."""
    day = row.day
    exits = [r for r in all_rows if r.status == "closed" and r.exit_day == day]
    still_open = [r for r in all_rows if r.status == "open"]
    gaps: dict[int, float] = {}
    for r in carried:
        splits_to_zero = any(s["day"] == day.isoformat() and s["shares_after"] == 0 for s in r.splits)
        first = _first_regular_close(minutes.get(r.symbol), day)
        if first is not None and not splits_to_zero:
            gaps[r.id] = holds_mod.gap_usd(hold_rows.to_hold(r), first, start_close[r.id])
    unrealized_end = sum(holds_mod.pnl(h, _value_price(h)) for h in map(hold_rows.to_hold, still_open))
    attribution = holds_mod.day_attribution(
        realized_credit=sum(holds_mod.closed_pnl(hold_rows.to_hold(r)) for r in exits),
        unrealized_start=sum(holds_mod.pnl(hold_rows.to_hold(r), start_close[r.id]) for r in carried),
        unrealized_end=unrealized_end,
        gap=sum(gaps.values()),
    )
    cash = balance(db, thread)
    chips = {c["symbol"]: c.get("earnings") for c in row.candidates}
    found = trading_session("stock", day)
    assert found is not None
    return {
        "passed": "yes" if not sessions else "no",
        **attribution,
        "balance_usd": cash,
        "equity_usd": _money(cash + unrealized_end),
        "free_cash_usd": holds_mod.free_cash(cash, 0.0, [hold_rows.to_hold(r) for r in still_open]),
        "holds": [
            hold_view(r, days, as_of=day, chip=chips.get(r.symbol), price_basis="last", gap=gaps.get(r.id))
            for r in all_rows
            if r.status == "open" or r.exit_day == day
        ],
        "stop_hits": sorted(stop_hits, key=lambda hit: (hit["at"], hit["symbol"])),
        "late_stars": [w["symbol"] for w in row.watch if plan_mod._utc(w["starred_clock"]) > found.regular_open],
        "entries": sum(1 for r in all_rows if r.entry_day == day),
        "exits": len(exits),
        "max_open_seen": _max_open(all_rows, day),
    }


def end_day(db: Session, user_id: int, day_list_id: int, svc: Services) -> ReplayDayList:
    """End the day, or Pass it (the same call on a day with no session). Idempotent. No hold is ever exited by this
    (the last day excepted): every session of the day ends without an auto exit; each open hold's stop is scanned over
    the minutes she did not watch (from the day clock, or from 09:30 on a passed day) and a first crossing is recorded
    as `watched: "no"`; every open hold is marked at the official close; the holds that exited today are credited to the
    ledger (R9); the day summary is stored (b6). The last day of an ISO week freezes its week row, and the last day of
    the thread exits what is still open at the close and archives the plan (b7).

    Lock order: this day list (the caller), the sessions, the thread, the holds."""
    row = plan_mod.get_day_list(db, user_id, day_list_id, lock=True)
    if row.status == "ended":
        return row
    plan = db.get(PracticePlan, row.plan_id)
    assert plan is not None
    sessions = plan_mod._sessions_of(db, row.id)
    for s in sessions:
        if s.status == "active":
            session_mod.end(db, user_id, s.id, svc, via_day=True)
            db.refresh(s)
    thread = threads_mod.get_thread(db, user_id, plan.thread_id, lock=True)
    all_rows = hold_rows.load(db, thread.id, lock=True)
    day, days = row.day, _days(plan)
    found = trading_session("stock", day)
    assert found is not None
    store, now = svc.store_factory(db), svc.now()

    carried = [r for r in all_rows if r.entry_day < day and (r.status == "open" or r.exit_day == day)]
    start_close = {r.id: _value_price(hold_rows.to_hold(r)) for r in carried}  # the prior close, before today marks it
    open_rows = [r for r in all_rows if r.status == "open"]
    minutes = {
        symbol: frame
        for symbol in {r.symbol for r in [*carried, *open_rows]}
        if (frame := _minutes_of(svc.history, store, symbol, day)) is not None
    }

    # Stops crossed while she was away: from the day clock (09:30 when the day never started) to the close.
    clock = max(plan_mod._utc(row.revealed_through), found.regular_open) if row.revealed_through else found.regular_open
    stop_hits = []
    for r in all_rows:  # flagged during play today: she watched it
        hit = hold_rows.to_hold(r).stop_hit_at
        if hit is not None and hit.tz_convert(ET).date() == day:
            stop_hits.append({"symbol": r.symbol, "at": hit.tz_convert(ET).strftime("%H:%M"), "watched": "yes"})
    for r in open_rows:
        hold = hold_rows.to_hold(r)
        crossing = holds_mod.first_stop_crossing([hold], minutes, clock, found.regular_close)
        if crossing is not None:
            hold_rows.apply(r, replace(hold, stop_hit_at=crossing.at))
            stop_hits.append({"symbol": r.symbol, "at": crossing.at.tz_convert(ET).strftime("%H:%M"), "watched": "no"})

    for r in open_rows:
        close = swing_play.official_close(svc.history, store, r.symbol, day)
        if close is not None:
            hold_rows.apply(r, holds_mod.mark_close(hold_rows.to_hold(r), close, day))
    last_day = day == days[-1]
    if last_day:  # b7: what is still open exits at the last close, with no session or mark
        for r in open_rows:
            hold = hold_rows.to_hold(r)
            exited = holds_mod.exit_hold(hold, day=day, at=found.regular_close, price=_value_price(hold), source="auto")
            hold_rows.apply(r, exited)
    for r in all_rows:
        if r.status == "closed" and r.exit_day == day:
            hold_rows.credit(db, r, now)

    summary = _day_summary(
        db,
        row,
        thread,
        days,
        sessions=len(sessions),
        all_rows=all_rows,
        carried=carried,
        start_close=start_close,
        minutes=minutes,
        stop_hits=stop_hits,
    )
    row.journal = jsonable(summary)
    row.status, row.revealed_through, row.ended_at, row.updated_at = (
        "ended",
        found.regular_close.to_pydatetime(),
        now,
        now,
    )
    db.flush()  # the week review reads this day's summary
    if week_mod.is_last_day_of_week(days, day):
        _freeze_week(db, svc, thread, week_mod.span_for(days, day).week_no, now)
    if last_day:
        plan.status, plan.updated_at = "archived", now
    db.flush()
    return row


def close_thread(db: Session, thread: PracticeThread, now: Any, svc: Services | None = None) -> None:
    """02r's early close for a swing thread (`threads.close_thread` has checked that no day is open): every open hold
    exits at its last official close (the last ended day's, b7), is credited, and the open week is frozen as the
    partial week it was (with its review when `svc` is given; else `swing_weeks.week_out` builds it on read). The
    caller archives the plan and stamps the thread."""
    for r in hold_rows.open_holds(db, thread.id, lock=True):
        hold = hold_rows.to_hold(r)
        day = hold.last_close_day or hold.entry_day
        found = trading_session("stock", day)
        assert found is not None
        hold_rows.apply(
            r, holds_mod.exit_hold(hold, day=day, at=found.regular_close, price=_value_price(hold), source="auto")
        )
        hold_rows.credit(db, r, now)
    week = db.execute(
        select(PracticeWeek).where(PracticeWeek.thread_id == thread.id, PracticeWeek.status == "open")
    ).scalar_one_or_none()
    if week is not None:
        last_ended = db.execute(
            select(func.max(ReplayDayList.day))
            .join(PracticePlan, PracticePlan.id == ReplayDayList.plan_id)
            .where(PracticePlan.thread_id == thread.id, ReplayDayList.status == "ended")
        ).scalar_one()
        if last_ended is not None and last_ended < week.last_day:
            week.last_day = last_ended  # the week the thread actually played
        _freeze_week(db, svc, thread, week.week_no, now)


# -- reading ---------------------------------------------------------------------------------------------------


def _split_note(split: dict[str, Any], last_close: float | None) -> str:
    k = split["ratio"]
    ratio = f"{k:g}-for-1" if k >= 1 else f"1-for-{1 / k:g}"
    if split["shares_after"] == 0:
        return (
            f"Split {ratio} before today's open · {split['shares_before']:,} shares round down to 0 · "
            "cash in lieu is not modeled, so the hold closed flat"
        )
    note = f"Split {ratio} before today's open · {split['shares_before']:,} shares are now {split['shares_after']:,}"
    return note if last_close is None else f"{note} at {last_close:,.2f}"


def hold_view(
    row: PracticeHold,
    days: list[date],
    *,
    as_of: date,
    chip: dict[str, Any] | None = None,
    price_basis: str | None = None,
    gap: float | None = None,
    split_day: date | None = None,
) -> dict[str, Any]:
    """A hold as the screens read it (the `HoldOut` keys of the wire shapes): an open one valued at its last close, a
    closed one at its exit. `as_of` is the session the days held run through; `split_day` names the day whose split, if
    any, becomes the note. Day numbers and weekdays only, no dates (R4)."""
    hold = hold_rows.to_hold(row)
    number = {d: n for n, d in enumerate(days, start=1)}
    closed = hold.status == "closed"
    price = hold.exit_price if closed else _value_price(hold)
    assert price is not None
    split = next((s for s in hold.splits if split_day is not None and s["day"] == split_day.isoformat()), None)
    return {
        "id": row.id,
        "symbol": hold.symbol,
        "side": hold.side,
        "shares": hold.shares,
        "entry_day_no": number[hold.entry_day],
        "entry_weekday": hold.entry_day.strftime("%a"),
        "entry_price": hold.entry_price,
        "days_held": number[hold.exit_day if closed else as_of] - number[hold.entry_day] + 1,
        "stop_at_entry": hold.stop_at_entry,
        "stop_price": hold.stop_price,
        "stop_hit": "yes" if hold.stop_hit_at is not None else "no",
        "status": hold.status,
        "exit_day_no": number[hold.exit_day] if hold.exit_day is not None else None,
        "exit_price": hold.exit_price,
        "exit_source": hold.exit_source,
        "last_close": hold.last_close,
        "price_basis": None if closed or hold.last_close is None else price_basis,
        "unrealized_usd": None if closed else holds_mod.pnl(hold, price),
        "pnl_usd": holds_mod.closed_pnl(hold) if closed else None,
        "r": holds_mod.r_multiple(hold, price),
        "gap_usd": gap,
        "earnings": chip,
        "split_note": None if split is None else _split_note(split, hold.last_close),
    }


def live_numbers(db: Session, thread: PracticeThread, day: date | None) -> tuple[float, float]:
    """`(free cash, equity)` of the thread while `day` is under way (None: between days). Free cash is the entry
    rule's (`swing_play.free_cash`): a hold she exited today counts as realized, though the ledger credits it when the
    day ends. Equity values every hold that was open at the last ended close at that close, an exit of today's
    included (a3 rule 6: the thread's stats move when a day ends), so an exit moves cash and not equity until then."""
    rows = hold_rows.load(db, thread.id)
    valued = [hold_rows.to_hold(r) for r in rows if r.status == "open" or r.exit_day == day]
    equity = _money(balance(db, thread) + sum(holds_mod.pnl(h, _value_price(h)) for h in valued))
    return swing_play.free_cash(db, thread, rows, day), equity


def state(db: Session, thread: PracticeThread) -> dict[str, Any]:
    """The `swing` block of `GET thread` (02p f2), from stored rows only: the day under way (else the next to open),
    the sessions and weeks, the open holds with free cash and equity (holds valued at their last official close, never
    a later one) and the equity series read from the ended days' stored summaries, which stops at the last ended day."""
    plan = _thread_plan(db, thread.id)
    days = _days(plan)
    ended = threads_mod._ended_days(db, thread.id)
    under_way = threads_mod.open_day(db, thread.id)
    day_no = under_way.day_no if under_way is not None else min(len(ended) + 1, len(days))
    free_cash, equity = live_numbers(db, thread, None if under_way is None else under_way.day)
    if thread.status == "closed" or len(ended) >= len(days):
        upcoming = "finished"
    elif under_way is None and ended and week_mod.is_last_day_of_week(days, ended[-1].day):
        upcoming = "week_review"
    else:
        upcoming = "day"
    return {
        "day_no": day_no,
        "days": len(days),
        "days_ended": len(ended),
        "week_no": week_mod.span_for(days, days[day_no - 1]).week_no,
        "weeks": len(week_mod.week_spans(days)),
        "holds_open": len(hold_rows.open_holds(db, thread.id)),
        "free_cash_usd": free_cash,
        "equity_usd": equity,
        "equity_series": [
            {
                "day_no": d.day_no,
                "weekday": d.day.strftime("%a"),
                "balance_usd": d.journal["balance_usd"],
                "equity_usd": d.journal["equity_usd"],
            }
            for d in ended
            if d.journal
        ],
        "next": upcoming,
    }


def plan_out(db: Session, plan: PracticePlan) -> dict[str, Any]:
    """The open-next response's plan: the day cursor and prep. No dates (R4): numbers and weekdays only."""
    days = _days(plan)
    latest = plan_mod._latest(db, plan.id)
    finished = latest is not None and latest.status == "ended" and latest.day == days[-1]
    if latest is None:
        upcoming: date | None = days[0]
    elif latest.status != "ended":
        upcoming = latest.day
    else:
        upcoming = None if finished else days[days.index(latest.day) + 1]
    prep = plan.prep
    return {
        "id": plan.id,
        "thread_id": plan.thread_id,
        "mode": "swing",
        "sessions": plan.spec["sessions"],
        "days_opened": plan.days_opened,
        "current": None if latest is None else {"id": latest.id, "day_no": latest.day_no, "status": latest.status},
        "next_day_no": None if upcoming is None else days.index(upcoming) + 1,
        "next_weekday": None if upcoming is None else upcoming.strftime("%a"),
        "finished": finished,
        "prep": {
            "state": prep["state"],
            "done": prep["done"],
            "total": prep["total"],
            "failed": len(prep.get("failed", {})),
        },
    }


def _peek(db: Session, svc: Services, row: ReplayDayList, symbol: str) -> dict[str, Any]:
    """Peek on the board: the rebased daily frame cut at the prior close (never a minute of the day) and its levels."""
    if symbol not in {c["symbol"] for c in row.candidates}:
        raise ReplayProblem(f"{symbol} is not on today's board", path="peek")
    frame = screen.asof_loader(svc.history, svc.store_factory(db), row.day)(symbol)
    cut = None if frame is None else screen.cut_frames(SymbolBars(frame), pd.Timestamp(row.data_through)).daily
    if cut is None or cut.empty:
        return {"symbol": symbol, "daily": [], "levels": {}}
    last = cut.iloc[-1]
    return {
        "symbol": symbol,
        "daily": [
            {
                "t": index,
                "o": float(bar["open"]),
                "h": float(bar["high"]),
                "l": float(bar["low"]),
                "c": float(bar["close"]),
                "v": float(bar["volume"]),
            }
            for index, bar in cut.tail(PEEK_DAILY_BARS).iterrows()
        ],
        "levels": {
            "prior_high": float(last["high"]),
            "prior_low": float(last["low"]),
            "prior_close": float(last["close"]),
        },
    }


def day_list_out(db: Session, user_id: int, day_list_id: int, svc: Services, peek: str | None = None) -> dict[str, Any]:
    """The swing board screen's data (d1). A day under way (or listed) reads the holds LIVE, valued at their last close,
    which is the prior close until the day ends; an ended day serves its stored summary, which carries the holds as they
    were at that close. Only the stored `day` carries a date (the web hides it, R4)."""
    row = plan_mod.get_day_list(db, user_id, day_list_id)
    plan = db.get(PracticePlan, row.plan_id)
    assert plan is not None
    thread = db.get(PracticeThread, plan.thread_id)
    assert thread is not None
    days = _days(plan)
    ended = row.status == "ended"
    span = week_mod.span_for(days, row.day)
    prior = days[days.index(row.day) - 1] if row.day != days[0] else row.day
    if ended:
        summary = row.journal or {}
        holds_block, free_cash = summary.get("holds", []), summary.get("free_cash_usd")
    else:
        chips = {c["symbol"]: c.get("earnings") for c in row.candidates}
        live = [r for r in hold_rows.load(db, thread.id) if r.status == "open" or r.exit_day == row.day]
        holds_block = [
            hold_view(
                r,
                days,
                as_of=row.day if r.entry_day == row.day else prior,
                chip=chips.get(r.symbol),
                price_basis="prior_close",
                split_day=row.day,
            )
            for r in live
        ]
        free_cash = live_numbers(db, thread, row.day)[0]
    sessions = plan_mod._sessions_of(db, row.id)
    return {
        "kind": "swing",
        "id": row.id,
        "plan": plan_out(db, plan),
        "thread": threads_mod.brief(db, thread.id, row.id),
        "day": row.day,
        "weekday": row.day.strftime("%a"),
        "day_no": row.day_no,
        "of": len(days),
        "week_no": span.week_no,
        "week_label": span.label,
        "status": row.status,
        "clock": row.revealed_through,
        "watch": row.watch,
        "columns": row.columns,
        "candidates": row.candidates,
        "holds": holds_block,
        "free_cash_usd": free_cash,
        "sessions": [plan_mod._session_brief(s, row, set()) for s in sessions],  # no one-open-trade rule in swing
        "universe": row.universe,
        "label": row.universe["label"],
        "peek": None if peek is None else _peek(db, svc, row, peek),
        "journal": row.journal if ended else None,
        "notes": row.notes,
        "rating": row.rating,
        "created_at": row.created_at,
        "ended_at": row.ended_at,
        "stamp": {
            "as_of": row.revealed_through if row.revealed_through is not None else row.data_through,
            "source": "alpaca",
            "quality": "delayed-15m",
            "freshness": "replay",
        },
    }


__all__ = (
    "BENCHMARK",
    "BOARD_COLUMNS",
    "DAILY_ONLY",
    "EXCLUDED_REASON",
    "MAX_UNIVERSE",
    "MIN_UNIVERSE",
    "PREVIEW_BUDGET_S",
    "SPLIT_PART",
    "SURVIVORSHIP_LABEL",
    "PreviewRequest",
    "PreviewResult",
    "balance",
    "close_thread",
    "create_thread",
    "day_list_out",
    "day_ready",
    "earnings_chips",
    "end_day",
    "filter_inputs",
    "has_history",
    "hold_view",
    "is_cached",
    "open_next",
    "plan_out",
    "plan_snapshot",
    "pool_prep",
    "preview",
    "run_prep",
    "split_frame",
    "start_session",
    "state",
    "survivorship_label",
    "universe_frames",
)
