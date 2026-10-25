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

The lifecycle half (the swing board, `open_next`, `start_session`, `end_day`, the thread's end and its stats) is the
next step: it lives beside this module's setup half and reads the plan row and the frames written here.
"""

import logging
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.contracts.practice_thread import PracticeThreadCreateV1
from ai_trading.core.calendar import et, previous_session
from ai_trading.data.metrics import AVG_VOLUME_DAYS, metric_row
from ai_trading.data.universe import MIN_DAILY_BARS
from ai_trading.db.models import FilterStrategy, PracticePlan, PracticeThread, UniverseSymbol, Watchlist, WatchlistItem
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import prep as prep_mod
from ai_trading.replay import screen
from ai_trading.replay import signals as signals_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.cache import BlobKey, BlobStore, decode_daily, encode_daily
from ai_trading.replay.data import History
from ai_trading.replay.screen import ASOF_PART, FilterInput
from ai_trading.replay.session import ReplayProblem, Services
from ai_trading.screener.evaluator import DAILY_RUN_ON
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


__all__ = (
    "BENCHMARK",
    "DAILY_ONLY",
    "EXCLUDED_REASON",
    "MAX_UNIVERSE",
    "MIN_UNIVERSE",
    "PREVIEW_BUDGET_S",
    "SPLIT_PART",
    "SURVIVORSHIP_LABEL",
    "PreviewRequest",
    "PreviewResult",
    "create_thread",
    "day_ready",
    "filter_inputs",
    "has_history",
    "is_cached",
    "pool_prep",
    "preview",
    "run_prep",
    "split_frame",
    "survivorship_label",
    "universe_frames",
)
