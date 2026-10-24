"""Run every active filter on its cadence and store the result (02m §b1 `screener/runner.py`).

A run is keyed by `(filter version, run_on, session, evaluation point)`, so the same bar evaluated twice (a
retried job, a catch-up after a restart) writes nothing the second time. The data is read from the store only:
the scheduler's refresher put the bars there, and this module never calls a provider.
"""

import json
import logging
import time
from collections.abc import Collection, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.db.models import (
    Bar1d,
    Bar1m,
    FilterMatch,
    FilterRun,
    FilterStrategy,
    FilterStrategyVersion,
    SymbolMetrics,
    UniverseSymbol,
    Watchlist,
    WatchlistItem,
)
from ai_trading.screener.evaluator import DAILY_RUN_ON, Frames, ScanResult, SymbolBars, check_filter, scan

log = logging.getLogger(__name__)

DAILY_LOOKBACK_DAYS = 420  # calendar days: 252 sessions plus indicator warm-up
MINUTE_LOOKBACK_DAYS = 16  # calendar days: ten prior sessions for the intraday RVOL baseline
PREVIEW_BUDGET_SECONDS = 2.0
_OHLCV = ("open", "high", "low", "close", "volume")


class StoredBars(Mapping[str, SymbolBars]):
    """Bars for `symbols` read from the store. Daily bars load in one query; minutes load per symbol on first
    access, or all at once with `preload_minutes()` (a scheduled run reads them all anyway, a preview stops at
    its deadline and so only pays for the symbols it reaches)."""

    def __init__(self, session: Session, symbols: Iterable[str], *, now: datetime, minutes: bool) -> None:
        self._session = session
        self._symbols = sorted(set(symbols))
        self._now = pd.Timestamp(now)
        self._wants_minutes = minutes
        self._daily = self._load_daily()
        self._minutes: dict[str, pd.DataFrame | None] = {}

    def _load_daily(self) -> dict[str, pd.DataFrame]:
        if not self._symbols:
            return {}
        start = (self._now - pd.Timedelta(days=DAILY_LOOKBACK_DAYS)).date()
        rows = self._session.execute(
            select(Bar1d.symbol, Bar1d.day, Bar1d.open, Bar1d.high, Bar1d.low, Bar1d.close, Bar1d.volume)
            .where(Bar1d.symbol.in_(self._symbols), Bar1d.day >= start)
            .order_by(Bar1d.symbol, Bar1d.day)
        ).all()
        frame = pd.DataFrame(rows, columns=["symbol", "day", *_OHLCV])
        return {
            symbol: group.drop(columns="symbol").set_index("day")
            for symbol, group in frame.groupby("symbol", sort=False)
        }

    def _query_minutes(self, symbols: list[str]) -> dict[str, pd.DataFrame]:
        start = self._now - pd.Timedelta(days=MINUTE_LOOKBACK_DAYS)
        rows = self._session.execute(
            select(Bar1m.symbol, Bar1m.bar_start, Bar1m.open, Bar1m.high, Bar1m.low, Bar1m.close, Bar1m.volume)
            .where(
                Bar1m.symbol.in_(symbols),
                Bar1m.bar_start >= start.to_pydatetime(),
                Bar1m.bar_start <= (self._now - pd.Timedelta(minutes=1)).to_pydatetime(),
            )
            .order_by(Bar1m.symbol, Bar1m.bar_start)
        ).all()
        frame = pd.DataFrame(rows, columns=["symbol", "bar_start", *_OHLCV])
        frame["bar_start"] = pd.to_datetime(frame["bar_start"], utc=True)
        return {
            symbol: group.drop(columns="symbol").set_index("bar_start")
            for symbol, group in frame.groupby("symbol", sort=False)
        }

    def preload_minutes(self) -> None:
        if self._wants_minutes and self._symbols:
            found = self._query_minutes(self._symbols)
            self._minutes = {symbol: found.get(symbol) for symbol in self._symbols}

    def __getitem__(self, symbol: str) -> SymbolBars:
        if symbol not in self._symbols:
            raise KeyError(symbol)
        minutes = None
        if self._wants_minutes:
            if symbol not in self._minutes:
                self._minutes[symbol] = self._query_minutes([symbol]).get(symbol)
            minutes = self._minutes[symbol]
        return SymbolBars(self._daily.get(symbol, pd.DataFrame(columns=list(_OHLCV))), minutes)

    def __iter__(self) -> Iterator[str]:
        return iter(self._symbols)

    def __len__(self) -> int:
        return len(self._symbols)


def source_symbols(session: Session, spec: Mapping[str, Any], owner_id: int) -> list[str]:
    """The symbols a filter scans: `market` is the active universe (narrowed by `assetTypes`), `watchlist` the
    owner's list by name, `symbols` the listed ones."""
    universe = spec["watch"]["universe"]
    if "symbols" in universe:
        return sorted({s for s in universe["symbols"] if not s.startswith("/")})
    if "watchlist" in universe:
        return sorted(
            session.execute(
                select(WatchlistItem.symbol)
                .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
                .where(
                    Watchlist.user_id == owner_id,
                    Watchlist.name == universe["watchlist"],
                    WatchlistItem.asset_type == "stock",
                )
            ).scalars()
        )
    query = select(UniverseSymbol.symbol).where(UniverseSymbol.active.is_(True))
    if spec.get("assetTypes"):
        query = query.where(UniverseSymbol.asset_type.in_(spec["assetTypes"]))
    return sorted(session.execute(query).scalars())


def _quality(run_on: str) -> str:
    return "eod" if run_on in DAILY_RUN_ON else "delayed-15m"


@dataclass
class RunReport:
    """What one `run_filters` call did: runs written, runs skipped because the bar was already evaluated, and
    filters that could not run, by id with the reason."""

    written: int = 0
    already_run: int = 0
    skipped: dict[int, str] = field(default_factory=dict)


def active_filters(
    session: Session, run_on: Collection[str] | None
) -> list[tuple[FilterStrategy, FilterStrategyVersion]]:
    rows = session.execute(
        select(FilterStrategy, FilterStrategyVersion)
        .join(FilterStrategyVersion, FilterStrategyVersion.id == FilterStrategy.current_version_id)
        .where(FilterStrategy.archived_at.is_(None))
        .order_by(FilterStrategy.id)
    ).all()
    return [(f, v) for f, v in rows if run_on is None or v.spec["watch"]["runOn"] in run_on]


def run_filters(
    session: Session,
    *,
    now: datetime,
    run_on: Collection[str] | None = None,
    version_ids: Collection[int] | None = None,
    budget: float | None = None,
) -> RunReport:
    """Evaluate every active, non-archived filter whose `runOn` is in `run_on` (all when None) as of `now`.
    `version_ids` narrows the pass to those filter versions (a filter the user just saved). With a `budget`
    in seconds, a scan that runs over it is dropped, not stored half done. Caller commits.

    Seeds are per-user copies, so two users hold the same spec: it is scanned once and the result written for
    each version. A filter whose spec no longer passes `check_filter`, or that scans no symbol with data, is
    reported in `skipped` and writes nothing."""
    report = RunReport()
    as_of = pd.Timestamp(now)
    scans: dict[str, ScanResult] = {}
    frames: dict[str, Frames] = {}
    loaded: dict[tuple[tuple[str, ...], bool], StoredBars] = {}

    def frames_for(symbol: str, bars: SymbolBars) -> Frames:
        if symbol not in frames:
            frames[symbol] = Frames(bars, as_of)
        return frames[symbol]

    started = time.monotonic()
    for filter_row, version in active_filters(session, run_on):
        if version_ids is not None and version.id not in version_ids:
            continue
        spec = version.spec
        problems = check_filter(spec)
        if problems:
            report.skipped[filter_row.id] = problems[0]
            continue
        symbols = tuple(source_symbols(session, spec, filter_row.owner_user_id))
        intraday = spec["watch"]["runOn"] not in DAILY_RUN_ON
        key = json.dumps([spec, symbols], sort_keys=True)
        if key not in scans:
            bars_key = (symbols, intraday)
            if bars_key not in loaded:
                loaded[bars_key] = StoredBars(session, symbols, now=now, minutes=intraday)
                loaded[bars_key].preload_minutes()
            deadline = None if budget is None else started + budget
            scans[key] = scan(spec, loaded[bars_key], as_of, frames_for=frames_for, deadline=deadline)
        result = scans[key]
        if result.truncated:
            report.skipped[filter_row.id] = "the scan ran over its time budget"
            continue
        if result.evaluation_point is None:
            report.skipped[filter_row.id] = "no symbol has the bars this filter needs"
            continue
        if _store(session, version, result, now=now):
            report.written += 1
        else:
            report.already_run += 1
    return report


def _store(session: Session, version: FilterStrategyVersion, result: ScanResult, *, now: datetime) -> bool:
    """Insert the run and its matches; False when this evaluation point was already stored."""
    spec = version.spec
    stmt = (
        pg_insert(FilterRun)
        .values(
            filter_strategy_version_id=version.id,
            run_on=spec["watch"]["runOn"],
            session=spec["watch"]["session"],
            evaluation_point=result.evaluation_point.to_pydatetime(),
            scanned=result.scanned,
            no_data=result.no_data,
            matches_total=result.matches_total,
            source="alpaca",
            quality=_quality(spec["watch"]["runOn"]),
            created_at=now,
        )
        .on_conflict_do_nothing(constraint="uq_filter_runs_version_run_on_session_evaluation_point")
        .returning(FilterRun.id)
    )
    run_id = session.execute(stmt).scalar_one_or_none()
    if run_id is None:
        return False
    metrics = {
        row.symbol: row.metrics
        for row in session.execute(
            select(SymbolMetrics).where(SymbolMetrics.symbol.in_([m.symbol for m in result.matches]))
        ).scalars()
    }
    for rank, match in enumerate(result.matches, start=1):
        session.add(
            FilterMatch(
                run_id=run_id,
                symbol=match.symbol,
                rank=rank,
                # NOT NULL in the table; a filter without a rank, or a match whose rank series is unknown, stores 0.
                rank_value=match.rank_value if match.rank_value is not None else 0.0,
                matched_since=match.matched_since.to_pydatetime(),
                operands=match.operands,
                columns=metrics.get(match.symbol, {}),
            )
        )
    return True


def preview_spec(
    session: Session, spec: Mapping[str, Any], owner_id: int, *, now: datetime, budget: float | None = None
) -> ScanResult:
    """Scan an unsaved, already-validated spec over the stored universe within `budget` seconds. The result
    is `truncated` when the budget ran out, so its totals are partial and the caller says so."""
    started = time.monotonic()
    budget = PREVIEW_BUDGET_SECONDS if budget is None else budget
    symbols = source_symbols(session, spec, owner_id)
    bars = StoredBars(session, symbols, now=now, minutes=spec["watch"]["runOn"] not in DAILY_RUN_ON)
    return scan(dict(spec), bars, pd.Timestamp(now), deadline=started + budget)


def newest_run(session: Session, version_id: int) -> FilterRun | None:
    return session.execute(
        select(FilterRun)
        .where(FilterRun.filter_strategy_version_id == version_id)
        .order_by(FilterRun.evaluation_point.desc(), FilterRun.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def run_matches(session: Session, run_id: int) -> list[FilterMatch]:
    return list(
        session.execute(select(FilterMatch).where(FilterMatch.run_id == run_id).order_by(FilterMatch.rank)).scalars()
    )


__all__ = (
    "PREVIEW_BUDGET_SECONDS",
    "RunReport",
    "StoredBars",
    "active_filters",
    "newest_run",
    "preview_spec",
    "run_filters",
    "run_matches",
    "source_symbols",
)
