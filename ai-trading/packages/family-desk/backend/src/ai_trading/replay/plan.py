"""The freestyle thread's plan, its Screen and its lanes (02o-b, rewritten by ADR-0025).

A thread has ONE plan (`create_plan`: a start instant, her filters, the chart setup) and ONE Screen (a
`replay_day_lists` row with `thread_id` set, kept because its candidate/scan machinery is the Screen's). There is no day
to open, list, relist, end or review, and no block of days: the Screen is her filters evaluated at the thread's time T,
and she re-scans it whenever she wants a fresh look.

- **Screen.** `start_rescan` marks a job on the Screen row; the API runs `run_rescan` in the background: the filters run
  again at T, with the filter versions the Screen used and every input cut 15 minutes before T (the data day is the one
  of T). The job reports symbols read (`rescan_job`), the screen polls it, and when it finishes the scan REPLACES the
  Screen's names, columns, counts and data cut: one list, never a second beside it. A name she holds or starred that the
  scan no longer matches stays (`held_over`); a name the Screen did not hold is `new_since_list`. Each scan is also a
  row (`replay_day_scans`) labelled with T. A filter that reads bars that cannot have closed yet at T keeps its
  scan-time message (`screen.earliest_list_at`), so look-ahead stays impossible.
- **Lanes.** `open_lane` opens (or resumes) her book for a name: one `replay_sessions` row per (thread, symbol) for the
  thread's life, at T. A name needs no trade closed first; a position is never cut at a day.
- **Nothing past T.** The Screen, the stars and Peek carry nothing after `data_through` or T.
- **No prep job.** The universe is prepared lazily by the first re-scan (its progress job) and rolling `warm`.
"""

import logging
import secrets
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ai_trading.contracts.practice_setup import PracticeSetupV2
from ai_trading.contracts.replay_session import ReplaySessionV1
from ai_trading.core.calendar import ET
from ai_trading.core.calendar import session as trading_session
from ai_trading.data.universe import SEED_SYMBOLS, ensure_universe, split_plain
from ai_trading.db.models import (
    FilterStrategy,
    FilterStrategyVersion,
    PracticeMark,
    PracticePlan,
    PracticeThread,
    ReplayDayList,
    ReplayDayScan,
    ReplaySession,
    SymbolMetrics,
    UniverseSymbol,
)
from ai_trading.replay import days as days_mod
from ai_trading.replay import frames as frames_mod
from ai_trading.replay import positions as positions_mod
from ai_trading.replay import screen
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.data import ReplayDayError, check_day
from ai_trading.replay.model import ENTRY_KINDS, INTERVAL_MINUTES, add_span
from ai_trading.replay.screen import FilterInput, build_list, cut_frames
from ai_trading.replay.session import ReplayProblem, Services, SessionNotFound, jsonable
from ai_trading.screener.evaluator import SymbolBars, check_filter
from ai_trading.screener.runner import source_symbols

log = logging.getLogger(__name__)

MAX_UNIVERSE = 250
RESCAN_STALE = timedelta(minutes=2)  # a re-scan that has not reported for this long died with its process
RESCAN_TICK_S = 0.4  # a running re-scan writes its progress at most this often
RESCAN_DIED = "The re-scan stopped before it finished · run it again"
EARNINGS_BUDGET_S = 8.0  # the earnings flag is a convenience: it never holds the list up
PEEK_DAILY_BARS = 120
# A lane's entry size unless the thread sets one (D-042); each entry may still differ (`PracticeMarkV1.shares`).
DAY_SESSION_SHARES = 100
FEW_NAMES = 20
# Owner rule (2026-11-02): a thread has fewer than 50 stocks, so the Screen holds at most 49 names (and a thread
# tracks at most 49 names with a position or an order: `session.MAX_HELD_NAMES`). The contract's own `maxList` bound
# stays at 50 (a stored plan that says 50 must still load): this is enforced where a plan is created and where the
# Screen is re-scanned.
MAX_LIST = 49
UNIVERSE_LABEL = (
    "Practice universe · {size} symbols the Desk has scanned · the live screener that morning may have scanned others"
)


# -- the legacy block ----------------------------------------------------------------------------------------

LEGACY_SETUP_KEYS = ("plan", "shares")  # the risk plan and entry size left the block for the thread (02r, D-007)


def without_legacy_plan_fields(block: Any) -> Any:
    """A block with `setup.plan` and `setup.shares` taken out. An old client still sends them and a plan saved before
    0007 still stores them: both are ignored, never an error, and the block is served without them."""
    setup = block.get("setup") if isinstance(block, dict) else None
    if not isinstance(setup, dict):
        return block
    return {**block, "setup": {key: value for key, value in setup.items() if key not in LEGACY_SETUP_KEYS}}


def _weekday(day: date) -> str:
    return day.strftime("%a")


# -- the universe --------------------------------------------------------------------------------------------


def practice_universe(db: Session, user_id: int) -> tuple[list[str], bool]:
    """The Desk set frozen onto a plan: every plain ticker the Desk universe has held, active or not, plus the
    seeds and her watchlists, capped at `MAX_UNIVERSE` by dollar volume. Seeds and her watchlists are always kept.
    Returns `(symbols, capped)`. ponytail: ranked by the stored 20-day dollar volume of today, not as of the first
    day; the set is about 130 symbols, so the cap does not bind yet."""
    held = {
        symbol
        for symbol, reason in db.execute(select(UniverseSymbol.symbol, UniverseSymbol.floor_reason)).all()
        if (reason or {}).get("reason") != "non_plain_ticker"
    }
    kept_always = set(split_plain([*SEED_SYMBOLS, *days_mod.watchlist_symbols(db, user_id)])[0])
    everything = sorted(set(split_plain(held)[0]) | kept_always)
    if len(everything) <= MAX_UNIVERSE:
        return everything, False
    metrics = {row.symbol: row.metrics for row in db.execute(select(SymbolMetrics)).scalars()}

    def dollar_volume(symbol: str) -> float:
        row = metrics.get(symbol) or {}
        return float((row.get("avg_volume_20d") or 0) * (row.get("last") or 0))

    rest = sorted((s for s in everything if s not in kept_always), key=lambda s: (-dollar_volume(s), s))
    return sorted(kept_always | set(rest[: max(0, MAX_UNIVERSE - len(kept_always))])), True


# -- the plan ------------------------------------------------------------------------------------------------


def active_plan(db: Session, user_id: int, *, thread_id: int | None = None, lock: bool = False) -> PracticePlan | None:
    """The active plan of thread `thread_id`, else of her most recently started DAY thread (a plan saved before 0007
    has no thread and counts as a day plan). A swing thread has its own plan beside it, so every daily-list caller keeps
    the day meaning. With several day threads, name the thread."""
    if thread_id is None:
        thread = threads_mod.active_thread(db, user_id)
        thread_id = None if thread is None else thread.id
    query = select(PracticePlan).where(PracticePlan.owner_user_id == user_id, PracticePlan.status == "active")
    if thread_id is not None:
        query = query.where(PracticePlan.thread_id == thread_id)
    else:
        query = query.where(PracticePlan.thread_id.is_(None))  # no day thread: only a plan saved before 0007 is left
    query = query.order_by(PracticePlan.id.desc()).limit(1)
    return db.execute(query.with_for_update() if lock else query).scalar_one_or_none()


def clock12(hhmm: str) -> str:
    """ "10:00" as "10:00 AM"."""
    hours, minutes = (int(part) for part in hhmm.split(":"))
    return f"{hours % 12 or 12}:{minutes:02d} {'AM' if hours < 12 else 'PM'}"


def _resolve_filters(
    db: Session, user_id: int, refs: list[dict[str, int]]
) -> list[tuple[FilterStrategy, dict[str, Any], int]]:
    """Her filters with their current spec and version id, or a plain 422 naming the one that cannot run."""
    out = []
    for index, ref in enumerate(refs):
        path = f"screen.filters.{index}.id"
        row = db.execute(
            select(FilterStrategy).where(FilterStrategy.id == ref["id"], FilterStrategy.owner_user_id == user_id)
        ).scalar_one_or_none()
        if row is None or row.archived_at is not None or row.current_version_id is None:
            raise ReplayProblem("Filter not found", path=path)
        version = db.get(FilterStrategyVersion, row.current_version_id)
        assert version is not None
        problems = check_filter(version.spec)
        if problems:
            raise ReplayProblem(f"{row.name}: {problems[0]}", path=path)
        out.append((row, version.spec, version.id))
    return out


def _ensure_desk_universe(db: Session, svc: Services, now: datetime) -> None:
    """A plan freezes the Desk universe, so a fresh install builds it now instead of waiting for the first weekday
    premarket pass. Best effort: a provider outage or a source without the universe kind leaves the seeds, and
    the plan still saves (the savepoint keeps a failed build out of the plan's transaction)."""
    if svc.sources is None:
        return
    try:
        with db.begin_nested():
            build = ensure_universe(db, svc.sources, now=now)
    except Exception:  # noqa: BLE001 -- see the docstring
        log.exception("universe build for a new plan failed")
        return
    if build is not None and build.failed:
        log.warning("universe build for a new plan: provider lists failed: %s", sorted(build.failed))


# -- plan out ------------------------------------------------------------------------------------------------


# -- opening a day -------------------------------------------------------------------------------------------


def _filter_inputs(
    db: Session, plan: PracticePlan, universe: list[str] | None = None, pinned: dict[int, int] | None = None
) -> list[FilterInput]:
    """Her filters as they stand now (or at the `pinned` versions, filter id to version id: the ones a list used), with
    the symbols each scans (`universe` for `market`: the day's recorded Desk set when there is one, else the plan's)."""
    universe = list(plan.universe["symbols"]) if universe is None else universe
    out = []
    for ref in plan.spec["screen"]["filters"]:
        row = db.get(FilterStrategy, ref["id"])
        if row is None or row.current_version_id is None:
            raise ReplayProblem("A filter of this plan was deleted · start a new plan", path="screen.filters")
        version = db.get(FilterStrategyVersion, (pinned or {}).get(row.id, row.current_version_id))
        assert version is not None
        spec = version.spec
        watch = spec["watch"]["universe"]
        if "market" in watch:
            symbols = universe
            if spec.get("assetTypes"):
                kinds = dict(db.execute(select(UniverseSymbol.symbol, UniverseSymbol.asset_type)).all())
                symbols = [s for s in universe if kinds.get(s, "stock") in spec["assetTypes"]]
        else:
            symbols = source_symbols(db, spec, plan.owner_user_id)
        out.append(FilterInput(id=row.id, version_id=version.id, name=row.name, spec=spec, symbols=symbols))
    return out


def earnings_states(sources: Any, symbols: list[str], day: date, now: datetime) -> dict[str, str]:
    """`reported` or `none` for each symbol whose report history was read (explicit report times only), within a small
    time budget. A symbol the check did not reach (no provider history, a provider failure, the budget spent) is left
    out: unknown, never `none`."""
    if sources is None:
        return {}
    states: dict[str, str] = {}
    started = time.monotonic()
    for symbol in symbols:
        if time.monotonic() - started > EARNINGS_BUDGET_S:
            break
        try:
            events = days_mod.earnings_events(sources, symbol, now)
            if events:
                states[symbol] = "reported" if screen.reported_before_open(events, day) else "none"
        except Exception as exc:  # noqa: BLE001 -- never fail a list over a calendar lookup
            log.warning("earnings lookup failed for %s: %s", symbol, type(exc).__name__)
            continue
    return states


def _universe_note(
    built_size: int, filters: list[FilterInput], capped: bool, member: dict[str, Any] | None = None
) -> dict[str, str]:
    """The universe line and its footnote. A day with a recorded morning says so (and what it left out); a day before
    the recording began says it scans today's Desk set (`universe_days.membership`)."""
    recorded = member is not None and member["source"] == "universe_days"
    notes = [member["note"] if recorded else UNIVERSE_LABEL.format(size=built_size)]
    if member is not None and not recorded:
        notes.append(member["note"])
    for item in filters:
        scope = item.spec["watch"]["universe"]
        if "watchlist" in scope:
            notes.append(f"{item.name} scans your {scope['watchlist']} list as it is today")
    if capped and not recorded:
        notes.append(f"capped at {MAX_UNIVERSE} by dollar volume")
    return {"label": notes[0], "footnote": " · ".join(notes)}


# -- reading and changing a day list ---------------------------------------------------------------------------


def get_day_list(db: Session, user_id: int, day_list_id: int, *, lock: bool = False) -> ReplayDayList:
    query = select(ReplayDayList).where(ReplayDayList.id == day_list_id)
    row = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if row is None or row.owner_user_id != user_id:  # never confirm existence to a non-owner
        raise SessionNotFound(day_list_id)
    return row


def _peek(db: Session, svc: Services, row: ReplayDayList, symbol: str) -> dict[str, Any]:
    """Pre-open chart data for one candidate, cut at `data_through`: the same rebased daily frame the list was
    screened on (never the raw one), the day's minutes through the cut, and the levels a trader reads at the open."""
    candidate = next((c for c in row.candidates if c["symbol"] == symbol), None)
    if candidate is None:
        raise ReplayProblem(f"{symbol} is not on today's list", path="peek")
    store = svc.store_factory(db)
    through = pd.Timestamp(row.data_through)
    daily = screen.asof_loader(svc.history, store, row.day)(symbol)
    minutes = screen.minutes_loader(svc.history, store, row.day)(symbol)
    # D-145: a name with nothing to draw answers "no data", never a 500.
    no_data = {"symbol": symbol, "data_through": through, "daily": [], "minutes": [], "levels": {}}
    if daily is None:
        return no_data
    cut = cut_frames(SymbolBars(daily, minutes), through)
    if cut.daily.empty:
        return no_data
    found = trading_session("stock", row.day)
    assert found is not None
    # No minute bars through the cut: the empty frame keeps a time index (a RangeIndex cannot compare to a Timestamp).
    today = (
        cut.minutes[(cut.minutes.index >= found.extended_open)]
        if cut.minutes is not None
        else pd.DataFrame(columns=["open", "high", "low", "close", "volume"], index=pd.DatetimeIndex([], tz="UTC"))
    )
    last = cut.daily.iloc[-1]
    levels: dict[str, float | None] = {
        "prior_high": float(last["high"]),
        "prior_low": float(last["low"]),
        "prior_close": float(last["close"]),
        "premarket_high": None,
        "premarket_low": None,
    }
    premarket = today[today.index < found.regular_open]
    if len(premarket):
        levels["premarket_high"], levels["premarket_low"] = (
            float(premarket["high"].max()),
            float(premarket["low"].min()),
        )

    def bar(index: Any, r: pd.Series) -> dict[str, Any]:
        return {
            "t": index,
            "o": float(r["open"]),
            "h": float(r["high"]),
            "l": float(r["low"]),
            "c": float(r["close"]),
            "v": float(r["volume"]),
        }

    return {
        "symbol": symbol,
        "data_through": through,
        "list_price": candidate["list_price"],
        "daily": [bar(d, r) for d, r in cut.daily.tail(PEEK_DAILY_BARS).iterrows()],
        "minutes": [bar(i, r) for i, r in today.iterrows()],
        "levels": levels,
    }


def _join(names: list[str], word: str = "and") -> str:
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} {word} {names[-1]}"


def watch_check(db: Session, row: ReplayDayList, sessions: list[ReplaySession]) -> dict[str, Any]:
    """The "traded only names on your watch" data (02o-b2): the starred names, the names she entered a trade on, and
    the entered names that were not starred. Data only: no plan field scores it, the screen renders it."""
    starred = [w["symbol"] for w in row.watch]
    entered = set(
        db.execute(
            select(PracticeMark.session_id).where(
                PracticeMark.session_id.in_([s.id for s in sessions]), PracticeMark.kind.in_(ENTRY_KINDS)
            )
        ).scalars()
    )
    traded = list(dict.fromkeys(s.symbol for s in sessions if s.id in entered))
    off = [symbol for symbol in traded if symbol not in starred]
    if not traded:
        verdict, label = "no_trades", "No trades yet · nothing to check against your watch"
    elif off:
        verdict, label = "off_watch", f"Traded {_join(off)}, not on your watch"
    else:
        verdict, label = "on_watch", "Traded only names on your watch"
    return {"starred": starred, "traded": traded, "off_watch": off, "verdict": verdict, "label": label}


# -- re-scan at the playhead ---------------------------------------------------------------------------------------


def _latest_scan(db: Session, day_list_id: int) -> ReplayDayScan | None:
    return db.execute(
        select(ReplayDayScan)
        .where(ReplayDayScan.day_list_id == day_list_id)
        .order_by(ReplayDayScan.seq.desc())
        .limit(1)
    ).scalar_one_or_none()


def _rescan_stale(job: dict[str, Any], now: datetime) -> bool:
    """A running job that has not reported for `RESCAN_STALE` died with its process (a restart, a crash)."""
    return job["state"] == "running" and pd.Timestamp(now) - pd.Timestamp(job["updated_at"]) > RESCAN_STALE


class _Superseded(Exception):
    """The job on the row carries another run token: a newer scan took this one over."""


class _Progress:
    """Writes a running re-scan's progress onto its job, at most every `RESCAN_TICK_S`, each write its own commit so the
    screen's poll sees it. A write that finds another token on the row raises `_Superseded`."""

    def __init__(self, db: Session, svc: Services, day_list_id: int, job: dict[str, Any], total: int) -> None:
        self.db, self.svc, self.day_list_id, self.job = db, svc, day_list_id, job
        self.total, self.done, self.written = total, 0, 0.0
        self.write(force=True)

    def write(self, *, force: bool = False) -> None:
        if not force and time.monotonic() - self.written < RESCAN_TICK_S:
            return
        self.written = time.monotonic()
        self.job = {**self.job, "done": self.done, "total": self.total, "updated_at": self.svc.now().isoformat()}
        moved = self.db.execute(
            update(ReplayDayList)
            .where(ReplayDayList.id == self.day_list_id, ReplayDayList.rescan_job["run"].as_string() == self.job["run"])
            .values(rescan_job=self.job)
        )
        self.db.commit()
        if moved.rowcount == 0:  # type: ignore[attr-defined]
            raise _Superseded

    def counting(self, load: Callable[[str], pd.DataFrame | None]) -> Callable[[str], pd.DataFrame | None]:
        """`load` that counts the symbol it was asked for: the list's first pass reads every symbol's daily bars."""

        def counted(symbol: str) -> pd.DataFrame | None:
            frame = load(symbol)
            self.done += 1
            self.write(force=self.done >= self.total)
            return frame

        return counted

    def beating(self, load: Callable[[str], pd.DataFrame | None]) -> Callable[[str], pd.DataFrame | None]:
        """`load` that only reports it is alive: the filters read minute bars after the count is complete."""

        def beat(symbol: str) -> pd.DataFrame | None:
            frame = load(symbol)
            self.write()
            return frame

        return beat


def _finish_job(db: Session, day_list_id: int, run: str, state: str, message: str | None) -> None:
    """Close the job this worker owns (committed here: the worker may be about to give up). Another token: untouched."""
    row = db.execute(
        select(ReplayDayList).where(ReplayDayList.id == day_list_id).with_for_update()
    ).scalar_one_or_none()
    if row is None or row.rescan_job is None or row.rescan_job["run"] != run:
        db.rollback()
        return
    row.rescan_job = {**row.rescan_job, "state": state, "message": message}
    db.commit()


def run_rescan(db: Session, svc: Services, day_list_id: int, run: str) -> ReplayDayScan | None:
    """The background half of a re-scan (see `start_rescan`): run the day's filters at the day clock the job was started
    at, as the Desk would have shown them then (the filter versions the list used, the list's universe, every input cut
    `LIST_DATA_LAG` before the clock), report progress while it reads, then REPOPULATE the day list and keep the scan as
    a row labelled with that clock. Never raises: a failure closes the job as `failed`, so the screen says so and
    offers the scan again."""
    try:
        return _run_rescan(db, svc, day_list_id, run)
    except _Superseded:
        db.rollback()
        return None
    except Exception:  # noqa: BLE001 -- the job says "failed"; the log says why
        log.exception("re-scan %s of day list %s failed", run, day_list_id)
        db.rollback()
        _finish_job(db, day_list_id, run, "failed", "Couldn't finish the re-scan · try again")
        return None


def _run_rescan(db: Session, svc: Services, day_list_id: int, run: str) -> ReplayDayScan | None:
    row = db.get(ReplayDayList, day_list_id)
    if row is None or row.rescan_job is None or row.rescan_job["run"] != run:
        return None
    plan = db.get(PracticePlan, row.plan_id)
    assert plan is not None
    clock = pd.Timestamp(row.rescan_job["as_of"])
    store = svc.store_factory(db)
    filters = _filter_inputs(
        db,
        plan,
        row.universe.get("symbols") or list(plan.universe["symbols"]),
        {item["id"]: item["version_id"] for item in row.screen["filters"]},
    )
    progress = _Progress(db, svc, row.id, row.rescan_job, len({s for item in filters for s in item.symbols}))
    day, max_list, prior = row.day, min(row.screen["maxList"], MAX_LIST), {c["symbol"]: c for c in row.candidates}
    built = build_list(
        filters=filters,
        daily_of=progress.counting(screen.asof_loader(svc.history, store, day)),
        minutes_of=progress.beating(screen.minutes_loader(svc.history, store, day)),
        day=day,
        list_at=clock,
        max_list=max_list,
    )
    fresh = [c["symbol"] for c in built.candidates if c["symbol"] not in prior]
    states = earnings_states(svc.sources, fresh, day, svc.now())
    for candidate in built.candidates:
        seen = prior.get(candidate["symbol"])
        candidate["new_since_list"] = seen is None
        candidate["held_over"] = False
        # a name already on the list keeps what the list held (a list stored before the state existed has the flag only)
        candidate["earnings_state"] = (
            states.get(candidate["symbol"])
            if seen is None
            else seen.get("earnings_state") or ("reported" if seen.get("reported_before_open") else None)
        )

    # From here the Screen changes: under its lock, on what the thread holds now (a star or a lane opened while the scan
    # read counts), and only if this scan still owns the job and the thread is still open.
    db.commit()  # keeps the bars the read cached, and expires `row` so the locked read below is fresh
    row = db.execute(select(ReplayDayList).where(ReplayDayList.id == day_list_id).with_for_update()).scalar_one()
    if row.rescan_job is None or row.rescan_job["run"] != run:
        raise _Superseded
    thread = db.get(PracticeThread, row.thread_id)
    if thread is None or thread.status == "closed":
        _finish_job(db, day_list_id, run, "failed", "The thread closed before the re-scan finished")
        return None
    now = svc.now()
    matched = {c["symbol"] for c in built.candidates}
    holding = {s.symbol for s in session_mod.lanes(db, thread.id)} | {w["symbol"] for w in row.watch}
    held = [
        {**c, "new_since_list": False, "held_over": True}
        for c in row.candidates
        if c["symbol"] in holding and c["symbol"] not in matched
    ]
    built.candidates = _fit_list(built.candidates, holding, len(held))
    last = _latest_scan(db, row.id)
    universe = jsonable(
        {
            **row.universe,
            **built.universe,
            "matches_total": built.matches_total,
            "shown": len(built.candidates),
            "prev_basis": built.prev_basis,
            "filters": built.filters,
        }
    )
    scan = ReplayDayScan(
        day_list_id=row.id,
        seq=1 if last is None else last.seq + 1,
        as_of=clock.to_pydatetime(),
        data_through=built.data_through.to_pydatetime(),
        universe=universe,
        columns=built.columns,
        candidates=jsonable(built.candidates),
        created_at=now,
    )
    db.add(scan)
    row.candidates = jsonable(
        [*built.candidates, *({**c, "rank": len(built.candidates) + i} for i, c in enumerate(held, 1))]
    )
    row.columns, row.universe, row.data_through = built.columns, universe, built.data_through.to_pydatetime()
    row.rescan_job = {
        **row.rescan_job,
        "state": "done",
        "done": progress.total,
        "total": progress.total,
        "message": None,
        "updated_at": now.isoformat(),
    }
    row.updated_at = now
    db.commit()
    return scan


def _fit_list(candidates: list[dict[str, Any]], holding: set[str], held: int) -> list[dict[str, Any]]:
    """The re-scan's matches with room left for the names she holds that it no longer matches: a day list never exceeds
    `MAX_LIST` names, so the lowest-ranked matches she does not hold make way, and the rest are numbered again."""
    extra = len(candidates) + held - MAX_LIST
    if extra <= 0:
        return candidates
    kept = []
    for candidate in reversed(candidates):
        if extra > 0 and candidate["symbol"] not in holding:
            extra -= 1
            continue
        kept.append(candidate)
    kept.reverse()
    return [{**candidate, "rank": rank} for rank, candidate in enumerate(kept, start=1)]


def _scan_out(scan: ReplayDayScan) -> dict[str, Any]:
    """Which scan the list now shows: its number, the clock it ran at, the time its data stops, and what it added."""
    return {
        "seq": scan.seq,
        "as_of": scan.as_of,
        "data_through": scan.data_through,
        "new_count": sum(1 for c in scan.candidates if c["new_since_list"]),
        "created_at": scan.created_at,
    }


def _job_out(job: dict[str, Any] | None, now: datetime) -> dict[str, Any] | None:
    """The re-scan's progress for the screen's poll. A running job that stopped reporting reads as failed."""
    if job is None:
        return None
    died = _rescan_stale(job, now)
    return {
        "state": "failed" if died else job["state"],
        "as_of": job["as_of"],
        "done": job["done"],
        "total": job["total"],
        "message": RESCAN_DIED if died else job["message"],
    }


# -- the day's session ------------------------------------------------------------------------------------------


# -- ending the day ---------------------------------------------------------------------------------------------


# -- the hub ----------------------------------------------------------------------------------------------------


# -- the plan ---------------------------------------------------------------------------------------------------


def _horizon(svc: Services) -> pd.Timestamp:
    from ai_trading.replay import clock as clock_mod  # clock imports this module

    return clock_mod.horizon(svc.now())


def _check_start(start: pd.Timestamp, svc: Services) -> date:
    """The ET trading day of `start`, when the thread may begin there (ADR-0025 R4): a finished trading session on or
    after 2016-01-04, the instant inside that day's extended hours, and not past the horizon."""
    first = start.tz_convert(ET).date()
    try:
        check_day(first, svc.now())
    except ReplayDayError as exc:  # a closed day is refused under the start date, where she pressed Start (D-230)
        raise ReplayProblem(exc.message, path="startAt") from exc
    found = trading_session("stock", first)
    assert found is not None
    if not found.extended_open <= start < found.extended_close:
        raise ReplayProblem("Start between 4:00 AM and 8:00 PM ET on a trading day", path="startAt")
    if start > (limit := _horizon(svc)):
        raise ReplayProblem(
            f"There is no data past {limit.tz_convert(ET):%a %Y-%m-%d %H:%M} ET yet · start earlier", path="startAt"
        )
    return first


def create_plan(
    db: Session, user_id: int, spec: PracticeSetupV2, svc: Services, thread: PracticeThread
) -> PracticePlan:
    """Validate and save the thread's plan from a `PracticeSetupV2`, archive the one it replaces, freeze the universe,
    and give the thread its clock and Screen. Server rules that need a lookup: `startAt` (a finished trading session,
    inside its hours, not past the horizon), her filters, the Screen's cap. The first plan sets the thread's start and
    puts its clock there, paused; a plan that replaces another never moves time. The plan binds to `thread`, which
    carries the risk plan (D-007)."""
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    start = _utc(datetime.fromisoformat(dumped["startAt"]))
    first = _check_start(start, svc) if thread.clock_at is None else start.tz_convert(ET).date()
    if dumped["screen"]["maxList"] > MAX_LIST:
        raise ReplayProblem(f"The Screen holds at most {MAX_LIST} names", path="screen.maxList")
    _resolve_filters(db, user_id, dumped["screen"]["filters"])
    now = svc.now()
    old = active_plan(db, user_id, thread_id=thread.id, lock=True)
    if old is not None:
        old.status, old.updated_at = "archived", now  # its Screen is re-pointed below; one plan is live per thread
        db.flush()
    _ensure_desk_universe(db, svc, now)
    symbols, capped = practice_universe(db, user_id)
    row = PracticePlan(
        owner_user_id=user_id,
        schema_version=2,
        spec=dumped,
        first_day=first,
        universe={"source": "desk", "symbols": symbols, "capped": capped, "frozen_at": now.isoformat()},
        prep={
            "state": "done",
            "done": len(symbols),
            "total": len(symbols),
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
    if thread.clock_at is None:
        thread.start_at = thread.clock_at = start.to_pydatetime()
        thread.clock_running, thread.clock_anchor_at, thread.clock_pause = False, None, None
        thread.updated_at = now
    ensure_screen(db, row, thread, svc)
    return row


def plan_out(db: Session, plan: PracticePlan) -> dict[str, Any]:
    spec = without_legacy_plan_fields(plan.spec)
    names = {
        row.id: row.name
        for row in db.execute(
            select(FilterStrategy).where(FilterStrategy.id.in_([f["id"] for f in spec["screen"]["filters"]]))
        ).scalars()
    }
    return {
        "id": plan.id,
        "thread_id": plan.thread_id,
        "spec": spec,
        "filters": [{"id": f["id"], "name": names.get(f["id"], "Removed filter")} for f in spec["screen"]["filters"]],
    }


# -- the Screen -------------------------------------------------------------------------------------------------


def ensure_screen(db: Session, plan: PracticePlan, thread: PracticeThread, svc: Services) -> ReplayDayList:
    """The thread's Screen row, created empty on its first plan and re-pointed (and emptied) by a replacing plan: one
    row per thread. Its names come from the first re-scan, which is a background job with progress, so creating a thread
    never waits on the universe's bars. The row's `day` is the data day of T, moved by every re-scan."""
    assert thread.clock_at is not None
    clock = _utc(thread.clock_at)
    filters = _filter_inputs(db, plan)
    now = svc.now()
    note = _universe_note(len(plan.universe["symbols"]), filters, bool(plan.universe.get("capped")))
    screen_json = {
        "filters": [{"id": f.id, "version_id": f.version_id, "name": f.name} for f in filters],
        "maxList": min(plan.spec["screen"]["maxList"], MAX_LIST),
    }
    universe = {
        "source": "desk",
        "size": len(plan.universe["symbols"]),
        "symbols": list(plan.universe["symbols"]),
        "scanned": 0,
        "no_data": 0,
        "below_floor": 0,
        "matches_total": 0,
        "shown": 0,
        "prev_basis": False,
        "filters": [],
        **note,
    }
    row = db.execute(
        select(ReplayDayList).where(ReplayDayList.thread_id == thread.id).with_for_update()
    ).scalar_one_or_none()
    if row is None:
        row = ReplayDayList(
            plan_id=plan.id,
            owner_user_id=plan.owner_user_id,
            thread_id=thread.id,
            day=positions_mod.data_day(clock),
            day_no=1,
            screen=screen_json,
            list_at=clock.to_pydatetime(),
            data_through=clock.to_pydatetime(),
            universe=universe,
            columns=[],
            candidates=[],
            watch=[],
            status="practicing",
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    else:
        row.plan_id, row.screen, row.universe = plan.id, screen_json, universe
        row.columns, row.candidates, row.watch, row.rescan_job = [], [], [], None
        row.updated_at = now
    db.flush()
    return row


def screen_row(db: Session, user_id: int, thread_id: int, svc: Services, *, lock: bool = False) -> ReplayDayList:
    """The thread's Screen (404 for a thread that is not hers). A thread whose plan exists but whose Screen does not
    (a thread from before the freestyle model that had no open day) gets one now; a thread with no plan is a 409."""
    thread = threads_mod.get_thread(db, user_id, thread_id)
    query = select(ReplayDayList).where(ReplayDayList.thread_id == thread.id)
    row = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if row is not None:
        return row
    plan = active_plan(db, user_id, thread_id=thread.id)
    if plan is None or thread.clock_at is None:
        raise ReplayProblem("Start the thread's plan first · it holds the Screen's filters", path="plan", status=409)
    return ensure_screen(db, plan, thread, svc)


def _few_names_reason(db: Session, row: ReplayDayList, scan: ReplayDayScan) -> str:
    """Why the Screen is short, from what the scan stored: no symbol could be scanned, no bars to read, or thresholds
    nothing met. Said once, with the one thing she can change."""
    universe = row.universe
    at = _utc(scan.as_of).tz_convert(ET).strftime("%H:%M")
    if universe["scanned"] == 0:
        return (
            f"No symbol could be scanned · {universe['no_data']} had no price data and {universe['below_floor']} fell "
            "below the $5 and 500,000-share floor"
        )
    if all(item["scanned"] == 0 for item in universe["filters"]):
        return (
            f"No bars to read at {clock12(at)} for any of the {universe['scanned']} symbols that passed the "
            "floor · the data for this time may be missing"
        )
    names = _join([item["name"] for item in row.screen["filters"]], "or")  # a name that passes either is listed (D-061)
    count = universe["shown"]
    met = f"Only {count}" if count else "None"
    return (
        f"{met} of the {universe['scanned']} scanned symbols met {names}"
        " · loosen a filter in the Screener to widen the Screen"
    )


def _screen_warnings(db: Session, row: ReplayDayList, scan: ReplayDayScan | None) -> list[str]:
    """What the Screen says about its scan: the filters still waiting for a bar of the day, and why it is short."""
    if scan is None:
        return []
    out = []
    waiting = [(item["name"], item["reads_from"]) for item in row.universe.get("filters", []) if item.get("reads_from")]
    if waiting:
        names = _join([name for name, _ in waiting])
        at = clock12(_utc(scan.as_of).tz_convert(ET).strftime("%H:%M"))
        out.append(
            f"{names} lists no names until {clock12(max(need for _, need in waiting))} ET · at {at} ET its first bar "
            "of the day cannot be read yet"
        )
    if len(row.candidates) < FEW_NAMES:
        out.append(_few_names_reason(db, row, scan))
    return out


def _live_candidates(
    svc: Services,
    db: Session,
    row: ReplayDayList,
    clock: pd.Timestamp,
    interval: str,
    tape: dict[str, str],
) -> list[dict[str, Any]]:
    """The Screen's names, each with a `live` block: the name as of T. The stored `candidates` stay the scan's snapshot;
    this only adds what the clock has shown since. Every name is read from its prepared series (`frames`, the one decode
    the chart shares) and priced by `PreparedSeries.quote`: with its tape for a name in `tape` (`{symbol: feed}`, the
    names she holds, so a held name reads the same print as her chart and her account), else off the last closed
    minute. A name whose bars are unavailable gets `live: None`, never a stand-in."""
    store = svc.store_factory(db)
    day = positions_mod.data_day(clock)
    daily_of = screen.asof_loader(svc.history, store, day)
    out = []
    for candidate in row.candidates:
        symbol = candidate["symbol"]
        try:
            series = svc.history.series.get(svc.history.day_inputs(store, symbol, day), INTERVAL_MINUTES[interval])
        except (ReplayDayError, ProviderError) as exc:
            log.warning("live read: %s has no bars for %s: %s", symbol, day, exc)
            out.append({**candidate, "live": None})
            continue
        if "asof" not in series.memo:
            series.memo["asof"] = daily_of(symbol)
        daily = series.memo["asof"]
        prints = session_mod._tape_lookup(svc, store, symbol, tape[symbol]) if symbol in tape else None
        quote = series.quote(clock, prints)
        live = (
            None
            if daily is None
            else screen.live_quote(daily, series.minutes_through(clock), day, clock, quote, series.memo)
        )
        out.append({**candidate, "live": jsonable(live)})
    return out


def warm(db: Session, svc: Services, day_list_id: int, interval: str | None = None) -> int:
    """Prepare every name of the Screen (and every lane) at the chart interval (the plan's, or `interval`: the one she
    switched to) on the data day of T, so the first read is a slice of memory (`frames.warm`). Returns how many names
    were prepared."""
    row = db.get(ReplayDayList, day_list_id)
    plan = None if row is None else db.get(PracticePlan, row.plan_id)
    thread = None if row is None or row.thread_id is None else db.get(PracticeThread, row.thread_id)
    if row is None or plan is None or thread is None or thread.clock_at is None or thread.status == "closed":
        return 0
    clock = _utc(thread.clock_at)
    day = positions_mod.data_day(clock)
    store = svc.store_factory(db)
    width = INTERVAL_MINUTES[interval or plan.spec["setup"]["interval"]]
    held = [r.symbol for r in session_mod.lanes(db, thread.id, active=True)]
    symbols = list(dict.fromkeys([c["symbol"] for c in row.candidates] + held))
    done = frames_mod.warm(svc.history, store, symbols, day, width, screen.asof_loader(svc.history, store, day))
    _live_candidates(svc, db, row, clock, plan.spec["setup"]["interval"], {})  # prime the live block: a hit next read
    return done


def _lane_brief(
    lane: ReplaySession,
    clock: pd.Timestamp,
    book: tuple[list[Any], Any] | None,
    last: float | None,
) -> dict[str, Any]:
    """A name in the thread's book: its status, how far it is revealed, whether it is behind the thread's clock (its
    next sync catches it up), whether it holds an open position (one average-cost position per name), and its P/L: the
    closed trades booked so far and the open position marked at `last` (the price at T) with when its stop line was
    crossed."""
    from ai_trading.replay import journal as journal_mod

    day_clock = min(clock, session_mod.market_close(positions_mod.data_day(clock), "extended"))
    closed, open_ = book if book is not None else ([], None)
    position = journal_mod.open_trade_out(open_, last)
    if position is not None and lane.stop_hit_at is not None:
        position["stop_hit_at"] = lane.stop_hit_at
    return {
        "id": lane.id,
        "symbol": lane.symbol,
        "status": lane.status,
        "revealed_through": lane.revealed_through,
        "behind_clock": lane.status == "active" and _utc(lane.revealed_through) < day_clock,
        "has_open_trade": open_ is not None,
        "trades": len(closed),
        "realized_usd": journal_mod.usd_sum([journal_mod.trade_pnl(t) for t in closed]),
        "position": position,
    }


def screen_out(
    db: Session, user_id: int, thread_id: int, svc: Services, *, peek: str | None = None, live: bool = False
) -> dict[str, Any]:
    """The thread's Screen at T (`GET /threads/{id}/screen`): the latest scan of her filters, her stars, the names she
    holds (with their P/L at T), and with `peek` the pre-open chart data of one candidate. With `live` each candidate
    also carries `live`: the name priced at T. Nothing here is later than `data_through` or T."""
    thread = threads_mod.get_thread(db, user_id, thread_id)
    session_mod.settle_thread(db, svc, thread.id)  # a running clock has moved since it was last read (ADR-0018)
    db.refresh(thread)
    row = screen_row(db, user_id, thread.id, svc)
    plan = db.get(PracticePlan, row.plan_id)
    assert plan is not None and thread.clock_at is not None
    clock = _utc(thread.clock_at)
    day = positions_mod.data_day(clock)
    books = session_mod.book(db, thread.id)
    held = {p.row.id: p for p in session_mod.positions(db, svc, thread.id, clock, books)}
    lanes = session_mod.lanes(db, thread.id, active=True)
    held_tape = {p.row.symbol: p.row.tape_feed for p in held.values()}
    scan = _latest_scan(db, row.id)
    return {
        "id": row.id,
        "thread_id": thread.id,
        "plan": plan_out(db, plan),
        "day": day,
        "weekday": _weekday(day),
        "as_of": clock,
        "data_through": row.data_through,
        "screen": {"filters": row.screen["filters"], "max_list": row.screen["maxList"]},
        "universe": row.universe,
        "columns": row.columns,
        "candidates": _live_candidates(svc, db, row, clock, plan.spec["setup"]["interval"], held_tape)
        if live and thread.status == "active"
        else row.candidates,
        "watch": row.watch,
        "clock": clock,
        "market": frames_mod.market_block(day, clock, None, positions_mod.next_open(clock)),
        "lanes": [
            _lane_brief(lane, clock, books.get(lane.id), held[lane.id].price if lane.id in held else None)
            for lane in lanes
        ],
        "watch_check": watch_check(db, row, lanes),
        "thread": threads_mod.brief(db, thread.id),
        "warnings": _screen_warnings(db, row, scan),
        "rescan": None if scan is None else _scan_out(scan),
        "rescan_job": _job_out(row.rescan_job, svc.now()),
        "peek": None if peek is None else _peek(db, svc, row, peek),
        "notes": row.notes,
        "rating": row.rating,
        "created_at": row.created_at,
        "stamp": {"as_of": clock, "source": "alpaca", "quality": "delayed-15m", "freshness": "replay"},
    }


def patch_screen(
    db: Session,
    user_id: int,
    thread_id: int,
    svc: Services,
    *,
    watch: list[str] | None,
    notes: str | None,
    rating: int | None,
    fields: set[str],
) -> ReplayDayList:
    """Stars, notes and the self-rating. A star is stamped with T when it is placed; a closed thread's are frozen."""
    thread = threads_mod.get_thread(db, user_id, thread_id)
    session_mod.settle_thread(db, svc, thread.id)
    db.refresh(thread)
    row = screen_row(db, user_id, thread.id, svc, lock=True)
    if "watch" in fields:
        if thread.status == "closed":
            raise ReplayProblem("This thread is closed · stars are frozen", path="watch", status=409)
        symbols = list(dict.fromkeys(watch or []))
        on_list = {c["symbol"] for c in row.candidates}
        for index, symbol in enumerate(symbols):
            if symbol not in on_list:
                raise ReplayProblem(f"{symbol} is not on the Screen", path=f"watch.{index}")
        kept = {w["symbol"]: w["starred_clock"] for w in row.watch}
        clock = _utc(thread.clock_at).isoformat() if thread.clock_at is not None else row.list_at.isoformat()
        row.watch = [{"symbol": s, "starred_clock": kept.get(s, clock)} for s in symbols]
    if "notes" in fields:
        row.notes = notes
    if "rating" in fields:
        row.rating = rating
    row.updated_at = svc.now()
    db.flush()
    return row


def start_rescan(db: Session, user_id: int, thread_id: int, svc: Services) -> tuple[int, str | None]:
    """Mark a re-scan at T as running on the thread's Screen and return `(screen id, run token)`; the caller starts
    `run_rescan` with it on its own session once this one has committed. The token is None when there is nothing to
    start: a scan already in flight is joined, never doubled (a job that stopped reporting is taken over, and the old
    worker finds its token gone), and a Screen that already holds a scan at this T is current. The scan runs on the
    data day of T. A 409 on a closed thread, and a 409 when every filter reads bars of the day that cannot have closed
    yet at T (`screen.reads_from`); a filter that waits is skipped by the scan, so the look-ahead stays impossible."""
    thread = threads_mod.get_thread(db, user_id, thread_id)
    session_mod.settle_thread(db, svc, thread.id)
    db.refresh(thread)
    row = screen_row(db, user_id, thread.id, svc, lock=True)
    if thread.status == "closed":
        raise ReplayProblem("This thread is closed · scans are closed", path="rescan", status=409)
    assert thread.clock_at is not None
    clock = _utc(thread.clock_at)
    day = positions_mod.data_day(clock)
    # A filter with no bar of the day to read yet lists nothing until it has one; the other filters still scan. Only a
    # Screen whose every filter waits is refused: there is nothing to scan at T (the look-ahead stays impossible).
    waiting: list[tuple[str, str]] = []
    for item in row.screen["filters"]:
        version = db.get(FilterStrategyVersion, item["version_id"])
        need = screen.reads_from(version.spec, day, clock) if version is not None else None
        if need is not None:
            waiting.append((item["name"], need))
    if waiting and len(waiting) == len(row.screen["filters"]):
        names = _join([name for name, _ in waiting])
        latest = clock12(max(need for _, need in waiting))
        now = clock12(clock.tz_convert(ET).strftime("%H:%M"))
        raise ReplayProblem(
            f"{names} waits until {latest} ET · no filter has a bar to read at {now} ET",
            path="rescan",
            status=409,
        )
    now = svc.now()
    job = row.rescan_job
    if job is not None and job["state"] == "running" and not _rescan_stale(job, now):
        return row.id, None
    last = _latest_scan(db, row.id)
    if last is not None and _utc(last.as_of) == clock:
        return row.id, None
    run = secrets.token_hex(8)
    row.day = day
    row.rescan_job = {
        "run": run,
        "state": "running",
        "as_of": clock.isoformat(),
        "done": 0,
        "total": 0,
        "message": None,
        "started_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }
    row.updated_at = now
    db.flush()
    return row.id, run


# -- lanes ------------------------------------------------------------------------------------------------------


def _session_spec(plan: PracticePlan, day: date, symbol: str, thread: PracticeThread) -> ReplaySessionV1:
    """The lane's spec from the plan's setup (interval, session, armed names) and the thread's risk plan. The plan is
    snapshotted here: editing the thread later never rescores a lane already opened. `day` and the window are labels
    of the data day the lane opens on (a lane runs for the thread's life; neither is ever read as a bound)."""
    setup = plan.spec["setup"]
    return ReplaySessionV1.model_validate(
        {
            "schemaVersion": 1,
            "symbol": symbol,
            "day": day.isoformat(),
            "window": setup.get("window", {"from": "09:30", "to": "16:00"}),
            "session": setup["session"],
            "interval": setup["interval"],
            "shares": thread.shares or DAY_SESSION_SHARES,
            "armed": setup["armed"],
            "plan": threads_mod.session_plan(thread),
            "hideDate": "no",
        }
    )


def open_lane(db: Session, user_id: int, thread_id: int, symbol: str, svc: Services) -> ReplaySession:
    """The thread's lane on a name (`POST /threads/{id}/lanes`): her open one (resume), else a new one at T. Any name of
    the Screen or of the thread's frozen universe opens, and a position open on another name never blocks it. A lane
    resumed behind the clock is lifted to it, the span she was away is recorded, and she can mark at once."""
    thread = threads_mod.get_thread(db, user_id, thread_id, lock=True)
    if thread.status == "closed":
        raise ReplayProblem(threads_mod.CLOSED_THREAD, path="threadId", status=409)
    session_mod._clock().settle(db, svc, thread)  # a name opened now starts at T as it is now, not as it was last read
    plan = active_plan(db, user_id, thread_id=thread.id)
    if plan is None or thread.clock_at is None:
        raise ReplayProblem(
            "Start the thread's plan first · it holds the setup a lane opens with", path="plan", status=409
        )
    screen_ = screen_row(db, user_id, thread.id, svc)
    existing = db.execute(
        select(ReplaySession.id).where(
            ReplaySession.thread_id == thread.id, ReplaySession.symbol == symbol, ReplaySession.status == "active"
        )
    ).first()
    if existing is None and symbol not in {c["symbol"] for c in screen_.candidates} | set(plan.universe["symbols"]):
        raise ReplayProblem(f"{symbol} is not on the Screen or in this thread's universe", path="symbol")
    clock = _utc(thread.clock_at)
    created = session_mod.open_lane(
        db,
        user_id,
        _session_spec(plan, positions_mod.data_day(clock), symbol, thread),
        svc,
        thread,
        day_list_id=screen_.id,
    )
    lift = min(clock, session_mod.market_close(positions_mod.data_day(clock), "extended"))
    if created.status == "active" and _utc(created.revealed_through) < lift:
        # Returning to a name that fell behind the clock lifts it, as a sync does: what lies between is revealed but was
        # never in front of her (an away span).
        created.away = add_span(list(created.away or []), _utc(created.revealed_through), lift)
        created.revealed_through, created.updated_at = lift.to_pydatetime(), svc.now()
    db.flush()
    return created


def _utc(value: datetime) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


__all__ = (
    "active_plan",
    "create_plan",
    "earnings_states",
    "ensure_screen",
    "open_lane",
    "patch_screen",
    "plan_out",
    "practice_universe",
    "run_rescan",
    "screen_out",
    "screen_row",
    "start_rescan",
    "warm",
)
