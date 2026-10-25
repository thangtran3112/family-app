"""Daily-list practice (02o-b v1): the plan, the day lists, the stars, the day's session, and ending the day.

Each practice day, her own filters build a candidate list for the past day she is about to replay
(`screen.build_list`: the live screener fed from the blob cache and cut at the time she would have looked). She stars
up to five names, practises one of them, and ends the day to see how every candidate moved from its list price.

- **Walk forward.** `practice_plans` is the saved setup plus a cursor. Days open in order, one list at a time; the
  next day opens only after the current one has ended. Dates are returned and hidden by a render rule.
- **One name a day in v1, on a shared day clock.** `replay_day_lists.revealed_through` is the day clock: `advance`
  moves it, a new session starts at it, and a name behind it cannot be marked. One session per day keeps
  cross-symbol hindsight out; switching names is 02o-b2.
- **Nothing past the cut before the day ends.** The list, the stars and Peek carry nothing after `data_through` or
  the day clock; the review (moves from the list price) is stored on `end_day` and served only once the day ended.
- **Prep** runs once at plan creation in the background (`run_prep`): bars for every day of the plan; a day's
  list reads the blob cache and fetches only what is missing.
"""

import logging
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.contracts.practice_block import PracticeBlockV1
from ai_trading.contracts.replay_session import ReplaySessionV1
from ai_trading.core.calendar import et
from ai_trading.core.calendar import session as trading_session
from ai_trading.data.universe import SEED_SYMBOLS, ensure_universe, split_plain
from ai_trading.db.models import (
    FilterStrategy,
    FilterStrategyVersion,
    PracticeMark,
    PracticePlan,
    PracticeThread,
    ReplayDayList,
    ReplaySession,
    SymbolMetrics,
    UniverseSymbol,
)
from ai_trading.replay import days as days_mod
from ai_trading.replay import prep as prep_mod
from ai_trading.replay import review as review_mod
from ai_trading.replay import screen
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.cache import BlobKey, BlobStore
from ai_trading.replay.data import ReplayDayError, check_day
from ai_trading.replay.model import ENTRY_KINDS
from ai_trading.replay.screen import ASOF_PART, EARLIEST_LIST_DAY, FilterInput, build_list, cut_frames
from ai_trading.replay.session import ReplayProblem, Services, SessionNotFound, jsonable
from ai_trading.screener.evaluator import SymbolBars, check_filter
from ai_trading.screener.runner import source_symbols

log = logging.getLogger(__name__)

MAX_UNIVERSE = 250
MAX_WATCH = 5
PREP_STALE = timedelta(minutes=5)  # a prep that has not reported for this long died with its process
EARNINGS_BUDGET_S = 8.0  # the earnings flag is a convenience: it never holds the list up
PEEK_DAILY_BARS = 120
DAY_SESSION_SHARES = 100  # a day session's default entry size; she sizes each entry herself (`PracticeMarkV1.shares`)
FEW_NAMES = 20
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


# -- the schedule --------------------------------------------------------------------------------------------


def plan_days(first_day: date, count: int) -> list[date]:
    """`count` trading sessions starting at `first_day` (itself a session)."""
    out, cursor = [], first_day
    while len(out) < count:
        if trading_session("stock", cursor) is not None:
            out.append(cursor)
        cursor += timedelta(days=1)
    return out


def check_range(first: date, sessions: int, now: datetime, *, path: str = "firstDay") -> list[date]:
    """The days of a plan or a swing thread, or the plain 422 that says why `first` and `sessions` cannot run."""
    if first < EARLIEST_LIST_DAY:
        raise ReplayProblem("Daily lists start on Jan 3, 2017 · pick a later day", path=path)
    if trading_session("stock", first) is None:
        raise ReplayProblem(f"No trading on {first:%a %Y-%m-%d} · pick a weekday", path=path)
    days = plan_days(first, sessions)
    try:
        check_day(days[-1], now)
    except ReplayDayError:
        raise ReplayProblem(
            f"{sessions} sessions from {first:%a %Y-%m-%d} run past the last finished day · pick an earlier start",
            path=path,
        ) from None
    return days


def _weekday(day: date) -> str:
    return day.strftime("%a")


def _is_swing(plan: PracticePlan) -> bool:
    return plan.spec.get("mode") == "swing"


def _swing() -> Any:
    """The swing module, imported on first use: it imports this module."""
    from ai_trading.replay import swing

    return swing


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
    """The active plan of thread `thread_id`, else of her DAY thread (a plan saved before 0007 has no thread and counts
    as a day plan). A swing thread has its own plan beside it, so every daily-list caller keeps the day meaning."""
    query = select(PracticePlan).where(PracticePlan.owner_user_id == user_id, PracticePlan.status == "active")
    if thread_id is not None:
        query = query.where(PracticePlan.thread_id == thread_id)
    else:
        day_threads = select(PracticeThread.id).where(PracticeThread.mode == "day")
        query = query.where(or_(PracticePlan.thread_id.is_(None), PracticePlan.thread_id.in_(day_threads)))
    return db.execute(query.with_for_update() if lock else query).scalar_one_or_none()


def clock12(hhmm: str) -> str:
    """ "10:00" as "10:00 AM"."""
    hours, minutes = (int(part) for part in hhmm.split(":"))
    return f"{hours % 12 or 12}:{minutes:02d} {'AM' if hours < 12 else 'PM'}"


def _early_list_message(name: str, spec: dict[str, Any], need: str) -> str:
    if spec["watch"]["runOn"] == "premarket_0830":
        return f"Premarket filters need a list time of {clock12(need)} or later"
    return f"{name} needs a list time of {clock12(need)} or later · before then none of its bars of the day has closed"


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


def create_plan(
    db: Session, user_id: int, spec: PracticeBlockV1, svc: Services, thread: PracticeThread
) -> PracticePlan:
    """Validate and save a plan, archive the one it replaces, freeze the universe, and mark prep as running (the
    caller starts `run_prep`). Server rules that need a lookup: the day range, her filters, the premarket list time.
    The plan binds to `thread`, which carries the risk plan (D-007): the block's own plan fields are never read."""
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    first = date.fromisoformat(dumped["firstDay"])
    check_range(first, dumped["sessions"], svc.now())
    resolved = _resolve_filters(db, user_id, dumped["screen"]["filters"])
    for row, spec, _ in resolved:
        need = screen.earliest_list_at(spec)
        if dumped["screen"]["listAt"] < need:
            raise ReplayProblem(_early_list_message(row.name, spec, need), path="screen.listAt")

    now = svc.now()
    old = active_plan(db, user_id, thread_id=thread.id, lock=True)
    if old is not None:
        old.status, old.updated_at = "archived", now  # its lists stay readable; one plan is live per thread
        db.flush()
    _ensure_desk_universe(db, svc, now)
    symbols, capped = practice_universe(db, user_id)
    row = PracticePlan(
        owner_user_id=user_id,
        schema_version=1,
        spec=dumped,
        first_day=first,
        universe={"source": "desk", "symbols": symbols, "capped": capped, "frozen_at": now.isoformat()},
        prep={"state": "running", "done": 0, "total": len(symbols), "failed": {}, "updated_at": now.isoformat()},
        day_cursor=None,
        days_opened=0,
        status="active",
        created_at=now,
        updated_at=now,
        thread_id=thread.id,
    )
    db.add(row)
    db.flush()
    return row


def _quiet(_message: str) -> None:
    return None


def run_prep(db: Session, svc: Services, plan_id: int) -> dict[str, Any]:
    """Fetch the plan's bars once, symbol by symbol, committing progress after each (the block row is the cursor,
    so a restart resumes through the write-once blob cache). Raw daily and 1-minute bars come from the landed
    `prep.preload_bars`; the as-of daily frames are built beside them. A symbol that fails is recorded, never fatal."""
    plan = db.get(PracticePlan, plan_id)
    if plan is None:
        log.warning("daily-list prep: plan %s is not visible", plan_id)
        return {}
    if _is_swing(plan):  # a swing thread's plan: its universe is fixed and it loads SPY too
        return _swing().run_prep(db, svc, plan_id)
    days = plan_days(plan.first_day, plan.spec["sessions"])
    store = svc.store_factory(db)
    symbols = list(plan.universe["symbols"])
    failed: dict[str, str] = {}
    for done, symbol in enumerate(symbols, start=1):
        try:
            report = prep_mod.preload_bars(
                svc.history, store, [symbol], days, now=svc.now(), say=_quiet, lookback=screen.LIST_LOOKBACK_SESSIONS
            )
            if report.failed:
                failed[symbol] = report.failed[symbol]
            else:
                screen.asof_frames(svc.history, store, symbol, days)
        except Exception as exc:  # noqa: BLE001 -- one symbol must not stop a 130-symbol prep
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
    if not symbols:
        plan.prep = {**plan.prep, "state": "done"}
        db.commit()
    return plan.prep


def _prep_stale(plan: PracticePlan, now: datetime) -> bool:
    if plan.prep.get("state") != "running":
        return False
    return pd.Timestamp(now) - pd.Timestamp(plan.prep["updated_at"]) > PREP_STALE


def _day_ready(plan: PracticePlan, store: BlobStore, day: date) -> bool:
    """True when the as-of frames of `day` exist for the whole universe, or prep is over (it fetches the rest)."""
    if plan.prep.get("state") == "done":
        return True
    wanted = BlobKey("bars1d", "", day, ASOF_PART, "sip")
    for symbol in plan.universe["symbols"]:
        if wanted._replace(symbol=symbol) not in store.keys("bars1d", symbol, [day]):
            return False
    return True


# -- plan out ------------------------------------------------------------------------------------------------


def _latest(db: Session, plan_id: int) -> ReplayDayList | None:
    return db.execute(
        select(ReplayDayList).where(ReplayDayList.plan_id == plan_id).order_by(ReplayDayList.day.desc()).limit(1)
    ).scalar_one_or_none()


def plan_out(db: Session, plan: PracticePlan) -> dict[str, Any]:
    if _is_swing(plan):
        return _swing().plan_out(db, plan)
    spec = without_legacy_plan_fields(plan.spec)
    days = plan_days(plan.first_day, spec["sessions"])
    latest = _latest(db, plan.id)
    finished = latest is not None and latest.status == "ended" and latest.day == days[-1]
    if latest is None:
        upcoming: date | None = days[0]
    elif latest.status != "ended":
        upcoming = latest.day
    else:
        upcoming = None if finished else days[days.index(latest.day) + 1]
    names = {
        row.id: row.name
        for row in db.execute(
            select(FilterStrategy).where(FilterStrategy.id.in_([f["id"] for f in spec["screen"]["filters"]]))
        ).scalars()
    }
    prep = plan.prep
    return {
        "id": plan.id,
        "thread_id": plan.thread_id,
        "sessions": spec["sessions"],
        "days_opened": plan.days_opened,
        "spec": spec,
        "filters": [{"id": f["id"], "name": names.get(f["id"], "Removed filter")} for f in spec["screen"]["filters"]],
        "current": None if latest is None else {"id": latest.id, "day_no": latest.day_no, "status": latest.status},
        "next_day": upcoming,
        "next_weekday": None if upcoming is None else _weekday(upcoming),
        "next_day_no": None if upcoming is None else days.index(upcoming) + 1,
        "finished": finished,
        "prep": {
            "state": prep["state"],
            "done": prep["done"],
            "total": prep["total"],
            "failed": len(prep.get("failed", {})),
        },
    }


# -- opening a day -------------------------------------------------------------------------------------------


@dataclass
class Opened:
    plan: PracticePlan
    day_list: ReplayDayList | None  # None while the data is still being prepared, or when every day is done
    restart_prep: bool = False  # the prep died with its process: the caller starts it again


def _filter_inputs(db: Session, plan: PracticePlan) -> list[FilterInput]:
    """Her filters as they stand now, with the symbols each scans (the frozen Desk set for `market`)."""
    universe = list(plan.universe["symbols"])
    out = []
    for ref in plan.spec["screen"]["filters"]:
        row = db.get(FilterStrategy, ref["id"])
        if row is None or row.current_version_id is None:
            raise ReplayProblem("A filter of this plan was deleted · start a new plan", path="screen.filters")
        version = db.get(FilterStrategyVersion, row.current_version_id)
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


def earnings_flags(sources: Any, symbols: list[str], day: date, now: datetime) -> set[str]:
    """Symbols that reported before the open of `day` (explicit report times only), within a small time budget.
    A provider failure or a slow chain leaves a symbol unflagged: the flag is a positive claim only."""
    if sources is None:
        return set()
    flagged: set[str] = set()
    started = time.monotonic()
    for symbol in symbols:
        if time.monotonic() - started > EARNINGS_BUDGET_S:
            break
        try:
            events = days_mod.earnings_events(sources, symbol, now)
        except Exception as exc:  # noqa: BLE001 -- never fail a list over a calendar lookup
            log.warning("earnings lookup failed for %s: %s", symbol, type(exc).__name__)
            continue
        if events and screen.reported_before_open(events, day):
            flagged.add(symbol)
    return flagged


def _universe_note(built_size: int, filters: list[FilterInput], capped: bool) -> dict[str, str]:
    notes = [UNIVERSE_LABEL.format(size=built_size)]
    for item in filters:
        scope = item.spec["watch"]["universe"]
        if "watchlist" in scope:
            notes.append(f"{item.name} scans your {scope['watchlist']} list as it is today")
    if capped:
        notes.append(f"capped at {MAX_UNIVERSE} by dollar volume")
    return {"label": notes[0], "footnote": " · ".join(notes)}


def open_next(db: Session, user_id: int, svc: Services, thread_id: int | None = None) -> Opened:
    """The current day list while it is not over; else the next day's list, built now. While the plan's data is not
    ready the result carries no list and the plan's prep progress says why. Every day done: no list. A swing thread
    (`thread_id`) continues its own calendar (`swing.open_next`)."""
    if thread_id is not None and threads_mod.get_thread(db, user_id, thread_id).mode == "swing":
        return _swing().open_next(db, user_id, svc, thread_id)
    plan = active_plan(db, user_id, lock=True)
    if plan is None:
        raise ReplayProblem("Start a daily practice plan first", path="plan", status=409)
    days = plan_days(plan.first_day, plan.spec["sessions"])
    latest = _latest(db, plan.id)
    if latest is not None and latest.status != "ended":
        return Opened(plan, latest)
    index = 0 if latest is None else days.index(latest.day) + 1
    if index >= len(days):
        return Opened(plan, None)
    day = days[index]
    store = svc.store_factory(db)
    now = svc.now()
    if not _day_ready(plan, store, day):
        stale = _prep_stale(plan, now)
        if stale:
            plan.prep = {**plan.prep, "updated_at": now.isoformat()}
        return Opened(plan, None, restart_prep=stale)

    spec = plan.spec
    list_at = et(day, spec["screen"]["listAt"])
    filters = _filter_inputs(db, plan)
    built = build_list(
        filters=filters,
        daily_of=screen.asof_loader(svc.history, store, day),
        minutes_of=screen.minutes_loader(svc.history, store, day),
        day=day,
        list_at=list_at,
        max_list=spec["screen"]["maxList"],
    )
    flagged = earnings_flags(svc.sources, [c["symbol"] for c in built.candidates], day, now)
    for candidate in built.candidates:
        candidate["reported_before_open"] = candidate["symbol"] in flagged
    note = _universe_note(len(plan.universe["symbols"]), filters, bool(plan.universe.get("capped")))
    row = ReplayDayList(
        plan_id=plan.id,
        owner_user_id=user_id,
        day=day,
        day_no=index + 1,
        screen={
            "filters": [{"id": f.id, "version_id": f.version_id, "name": f.name} for f in filters],
            "listAt": spec["screen"]["listAt"],
            "maxList": spec["screen"]["maxList"],
        },
        list_at=list_at.to_pydatetime(),
        data_through=built.data_through.to_pydatetime(),
        universe=jsonable(
            {
                "source": "desk",
                **built.universe,
                "matches_total": built.matches_total,
                "shown": len(built.candidates),
                "prev_basis": built.prev_basis,
                "filters": built.filters,
                **note,
            }
        ),
        columns=built.columns,
        candidates=jsonable(built.candidates),
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
        plan = active_plan(db, user_id)
        assert plan is not None
        return Opened(plan, _latest(db, plan.id))
    return Opened(plan, row)


# -- reading and changing a day list ---------------------------------------------------------------------------


def get_day_list(db: Session, user_id: int, day_list_id: int, *, lock: bool = False) -> ReplayDayList:
    query = select(ReplayDayList).where(ReplayDayList.id == day_list_id)
    row = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if row is None or row.owner_user_id != user_id:  # never confirm existence to a non-owner
        raise SessionNotFound(day_list_id)
    return row


def _sessions_of(db: Session, day_list_id: int) -> list[ReplaySession]:
    return list(
        db.execute(
            select(ReplaySession).where(ReplaySession.day_list_id == day_list_id).order_by(ReplaySession.id)
        ).scalars()
    )


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
    if daily is None:
        return {"symbol": symbol, "data_through": through, "daily": [], "minutes": [], "levels": {}}
    cut = cut_frames(SymbolBars(daily, minutes), through)
    found = trading_session("stock", row.day)
    assert found is not None
    today = (
        cut.minutes[(cut.minutes.index >= found.extended_open)]
        if cut.minutes is not None
        else pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
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


def _join(names: list[str]) -> str:
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def _few_names_reason(db: Session, row: ReplayDayList) -> str:
    """Why a list is short, from what the list stored: no symbol could be scanned, a filter that could only read
    the previous session at this list time (a plan saved before the server refused that), no bars to read, or
    thresholds nothing met. Said once, with the one thing she can change."""
    universe, count = row.universe, len(row.candidates)
    list_at, filters = row.screen["listAt"], row.screen["filters"]
    if universe["scanned"] == 0:
        return (
            f"No symbol could be scanned · {universe['no_data']} had no price data and {universe['below_floor']} fell "
            "below the $5 and 500,000-share floor"
        )
    early: list[tuple[str, str]] = []
    for item in filters:
        version = db.get(FilterStrategyVersion, item["version_id"])
        if version is not None and list_at < (need := screen.earliest_list_at(version.spec)):
            early.append((item["name"], need))
    if early:
        verb = "reads" if len(early) == 1 else "read"
        return (
            f"{_join([name for name, _ in early])} {verb} bars of the day itself, and none had closed by "
            f"{clock12(list_at)} · only the previous session was visible. Start a new plan with a list time of "
            f"{clock12(max(need for _, need in early))} or later"
        )
    if all(item["scanned"] == 0 for item in universe["filters"]):
        return (
            f"No bars to read at {clock12(list_at)} for any of the {universe['scanned']} symbols that passed the "
            "floor · the data for this day may be missing"
        )
    names = _join([item["name"] for item in filters])
    met = f"Only {count}" if count else "None"
    return (
        f"{met} of the {universe['scanned']} scanned symbols met {names}"
        " · loosen a filter in the Screener to widen the next days' lists"
    )


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


def day_list_out(
    db: Session, user_id: int, day_list_id: int, svc: Services, *, peek: str | None = None
) -> dict[str, Any]:
    row = get_day_list(db, user_id, day_list_id)
    plan = db.get(PracticePlan, row.plan_id)
    assert plan is not None
    if _is_swing(plan):
        return _swing().day_list_out(db, user_id, day_list_id, svc, peek=peek)
    ended = row.status == "ended"
    sessions = _sessions_of(db, row.id)
    universe = row.universe
    warnings = [_few_names_reason(db, row)] if len(row.candidates) < FEW_NAMES else []
    return {
        "id": row.id,
        "plan": plan_out(db, plan),
        "day": row.day,
        "weekday": _weekday(row.day),
        "day_no": row.day_no,
        "of": plan.spec["sessions"],
        "status": row.status,
        "list_at": row.list_at,
        "data_through": row.data_through,
        "screen": {
            "filters": row.screen["filters"],
            "list_at": row.screen["listAt"],
            "max_list": row.screen["maxList"],
        },
        "universe": universe,
        "columns": row.columns,
        "candidates": row.candidates,
        "watch": row.watch,
        "clock": row.revealed_through,
        "sessions": [{"id": s.id, "symbol": s.symbol, "status": s.status} for s in sessions],
        "watch_check": watch_check(db, row, sessions),
        "thread": threads_mod.brief(db, plan.thread_id, row.id),
        "warnings": warnings,
        "peek": None if peek is None else _peek(db, svc, row, peek),
        "journal": row.journal if ended else None,
        "review": row.review if ended else None,
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


def patch_day_list(
    db: Session,
    user_id: int,
    day_list_id: int,
    svc: Services,
    *,
    watch: list[str] | None,
    notes: str | None,
    rating: int | None,
    fields: set[str],
) -> ReplayDayList:
    """Stars, notes and the self-rating. A star is stamped with the day clock when it is placed (the list time
    before the day starts); stars close with the day."""
    row = get_day_list(db, user_id, day_list_id, lock=True)
    if "watch" in fields:
        if row.status == "ended":
            raise ReplayProblem("The day is over · stars are closed", path="watch", status=409)
        symbols = list(dict.fromkeys(watch or []))
        on_list = {c["symbol"] for c in row.candidates}
        for index, symbol in enumerate(symbols):
            if symbol not in on_list:
                raise ReplayProblem(f"{symbol} is not on today's list", path=f"watch.{index}")
        if len(symbols) > MAX_WATCH:
            raise ReplayProblem(f"Star at most {MAX_WATCH} names", path="watch")
        kept = {w["symbol"]: w["starred_clock"] for w in row.watch}
        clock = (row.revealed_through or row.list_at).isoformat()
        row.watch = [{"symbol": s, "starred_clock": kept.get(s, clock)} for s in symbols]
    if "notes" in fields:
        row.notes = notes
    if "rating" in fields:
        row.rating = rating
    row.updated_at = svc.now()
    db.flush()
    return row


# -- the day's session ------------------------------------------------------------------------------------------


def _session_spec(plan: PracticePlan, day: date, symbol: str, thread: PracticeThread) -> ReplaySessionV1:
    """The day's session from the plan's setup (window, interval, armed names) and the thread's risk plan. The plan is
    snapshotted here: editing the thread later never rescores a session already started. A plan saved before 0007
    still carries `setup.plan` and `setup.shares`; they are never read."""
    setup = plan.spec["setup"]
    return ReplaySessionV1.model_validate(
        {
            "schemaVersion": 1,
            "symbol": symbol,
            "day": day.isoformat(),
            "window": setup["window"],
            "session": setup["session"],
            "interval": setup["interval"],
            "shares": DAY_SESSION_SHARES,
            "armed": setup["armed"],
            "plan": threads_mod.session_plan(thread),
            "hideDate": plan.spec["hideDates"],
        }
    )


def start_session(db: Session, user_id: int, day_list_id: int, symbol: str, svc: Services) -> ReplaySession:
    """The day's practice session on a name from the list, built from the plan's setup. v1 practises one name a
    day: a second name is a 409 until the day ends (switching on the shared clock is 02o-b2)."""
    row = get_day_list(db, user_id, day_list_id, lock=True)
    plan = db.get(PracticePlan, row.plan_id)
    assert plan is not None
    if _is_swing(plan):
        return _swing().start_session(db, user_id, day_list_id, symbol, svc)
    if row.status == "ended":
        raise ReplayProblem("The day is over · open the next day from the practice page", path="symbol", status=409)
    if symbol not in {c["symbol"] for c in row.candidates}:
        raise ReplayProblem(f"{symbol} is not on today's list", path="symbol")
    existing = _sessions_of(db, row.id)
    other = next((s for s in existing if s.symbol != symbol), None)
    if other is not None:
        raise ReplayProblem(
            f"Your day is on {other.symbol} · end the day to score it, then pick the next name",
            path="symbol",
            status=409,
        )
    thread = db.get(PracticeThread, plan.thread_id) if plan.thread_id is not None else None
    if thread is None:
        raise ReplayProblem(threads_mod.NO_THREAD, path="threadId", status=409)
    if thread.status == "closed":
        raise ReplayProblem(threads_mod.CLOSED_THREAD, path="threadId", status=409)
    created = session_mod.create(
        db, user_id, _session_spec(plan, row.day, symbol, thread), svc, day_list=row, thread_id=thread.id
    )
    if row.status == "listed":
        row.status = "practicing"
    row.updated_at = svc.now()
    if row.revealed_through is None or _utc(created.revealed_through) > _utc(row.revealed_through):
        row.revealed_through = created.revealed_through
    db.flush()
    return created


def _utc(value: datetime) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


# -- ending the day ---------------------------------------------------------------------------------------------


def _day_journal(sessions: list[ReplaySession]) -> dict[str, Any]:
    rows = []
    for s in sessions:
        journal = s.journal or {}
        totals = journal.get("totals", {})
        rows.append(
            {
                "id": s.id,
                "symbol": s.symbol,
                "trades": totals.get("trades", 0),
                "pnl_usd": totals.get("pnl_usd", 0.0),
                "adherence_pct": (journal.get("adherence") or {}).get("score_pct"),
            }
        )
    return {
        "sessions": rows,
        "trades": sum(r["trades"] for r in rows),
        "pnl_usd": round(sum(r["pnl_usd"] for r in rows), 2),
    }


def end_day(db: Session, user_id: int, day_list_id: int, svc: Services) -> ReplayDayList:
    """Ends the day's session (an open practice trade exits at the last price), unseals the window, and stores the
    list review. Idempotent."""
    row = get_day_list(db, user_id, day_list_id, lock=True)
    if row.status == "ended":
        return row
    plan = db.get(PracticePlan, row.plan_id)
    assert plan is not None
    if _is_swing(plan):
        return _swing().end_day(db, user_id, day_list_id, svc)
    sessions = _sessions_of(db, row.id)
    for s in sessions:
        if s.status == "active":
            session_mod.end(db, user_id, s.id, svc, via_day=True)
            db.refresh(s)
    if len(sessions) > 1:  # the day rules count every name: rescore now that each one's last exit exists
        for s in sessions:
            session_mod.refresh_journal(db, user_id, s.id, svc)
            db.refresh(s)
    window_end = _utc(sessions[0].window_end) if sessions else et(row.day, plan.spec["setup"]["window"]["to"])
    store = svc.store_factory(db)
    minutes: dict[str, pd.DataFrame | None] = {}
    for candidate in row.candidates:
        try:
            minutes[candidate["symbol"]] = svc.history.minute_bars(store, candidate["symbol"], [row.day]).get(row.day)
        except ProviderError as exc:
            log.warning("review minutes unavailable for %s: %s", candidate["symbol"], exc)
            minutes[candidate["symbol"]] = None
    picks = {w["symbol"]: "starred" for w in row.watch}
    picks.update({s.symbol: "traded" for s in sessions})
    now = svc.now()
    row.review = jsonable(review_mod.compute_review(row.candidates, minutes, row.day, window_end, picks))
    row.journal = jsonable(_day_journal(sessions))
    row.status, row.revealed_through, row.ended_at, row.updated_at = "ended", window_end.to_pydatetime(), now, now
    db.flush()
    return row


# -- the hub ----------------------------------------------------------------------------------------------------


def hub(db: Session, user_id: int) -> dict[str, Any]:
    plan = active_plan(db, user_id)
    thread = threads_mod.active_thread(db, user_id)
    return {
        "plan": None if plan is None else plan_out(db, plan),
        "thread": None if thread is None else threads_mod.summary(db, thread),
    }


__all__ = (
    "Opened",
    "active_plan",
    "check_range",
    "create_plan",
    "day_list_out",
    "earnings_flags",
    "end_day",
    "hub",
    "open_next",
    "patch_day_list",
    "plan_days",
    "plan_out",
    "practice_universe",
    "run_prep",
    "start_session",
)
