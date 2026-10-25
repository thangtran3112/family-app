"""The market-data refresher (02m §b1 `data/refresher.py`, §b3): what the scheduler's jobs call to keep the stored
bars, the metric rows, the universe, and the screener's runs current. It is the only writer of `feed_health`.

Three passes, one per job that needs data:

- `intraday_pass` (every 15 minutes in session): 1-minute bars for the watchlist symbols and the screener
  survivors, metrics and the 15-minute bias label, then the intraday filters. Records `bars_delayed`.
- `premarket_pass` (08:30 ET): the universe, daily bars and metrics for its candidates, the liquidity floor,
  minutes for the survivors, then the premarket filters.
- `daily_pass` (after the close): daily bars for the watchlists and the floor survivors, metrics, the floor, then
  the daily filters. It does not rebuild the universe: that is the premarket pass's job.

Every provider call goes through `DataSources` (never a provider module). One symbol's failure is recorded and the
pass goes on; five failures in a row stop the pass, because the provider is down or has banned us and more
requests only make it worse. Bars are stored closed-only (`upsert_bars`), and every pass is safe to repeat.
A pass reports `down` when nothing could be fetched; the once-a-day jobs then fail without marking their clock, so
the scheduler retries them on its next tick (catch-up) instead of evaluating a whole day on stale data.

All stored bars are delayed SIP minutes (`delayed-15m`): nothing here is real time, and the freshness a reader shows
comes from `core.freshness` over the `last_ok_at` this module writes, never from a value computed here.
"""

import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import pandas as pd
from ai_trading_common.errors import NoData, ProviderError
from ai_trading_common.registry import DataSources
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.core import bias
from ai_trading.core.calendar import ET, annotate, previous_session
from ai_trading.core.calendar import session as trading_session
from ai_trading.core.evaluate import _resample
from ai_trading.data.backfill import backfill
from ai_trading.data.bars import read_bars, upsert_bars
from ai_trading.data.metrics import refresh_metrics
from ai_trading.data.universe import apply_floor, build_universe
from ai_trading.db.models import (
    Bar1m,
    FeedHealth,
    SymbolMetrics,
    UniverseDay,
    UniverseSymbol,
    Watchlist,
    WatchlistItem,
)
from ai_trading.screener.runner import run_filters

log = logging.getLogger(__name__)

BARS_FEED = "bars_delayed"
SCAN_FEED = "scan"
INTRADAY_FILTERS = frozenset({"bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h"})
DAILY_FILTERS = frozenset({"daily_close"})
PREMARKET_FILTERS = frozenset({"premarket_0830"})
MINUTE_HISTORY_DAYS = 16  # calendar days: ten prior sessions for the intraday RVOL baseline and the bias warm-up
DAILY_HISTORY_DAYS = 430  # calendar days: 252 sessions plus indicator warm-up
STOP_AFTER_FAILURES = 5


def scan_enabled(data_sources: DataSources) -> bool:
    """False for a `DataSources` without the `universe` kind (an old test double): the scan passes are skipped."""
    return getattr(data_sources, "universe", None) is not None


@dataclass
class PassReport:
    """What one pass did. `failed` maps a symbol (or a list name) to the error class that stopped it."""

    fetched: int = 0
    failed: dict[str, str] = field(default_factory=dict)
    stopped_early: bool = False

    @property
    def state(self) -> str:
        """`down` when nothing worked, `degraded` when some did, else `ok`."""
        if self.fetched == 0 and (self.failed or self.stopped_early):
            return "down"
        return "degraded" if self.failed or self.stopped_early else "ok"


def record_health(session: Session, feed: str, state: str, *, now: datetime, detail: str | None = None) -> None:
    """Upsert one feed's row. `last_ok_at` moves only for `ok` and `degraded`: a feed that is down keeps the
    time it last worked, which is what `core.freshness` and the staleness guard read. Caller commits."""
    values = {"feed": feed, "state": state, "detail": detail, "updated_at": now}
    if state != "down":
        values["last_ok_at"] = now
    stmt = pg_insert(FeedHealth).values(**values)
    changed = {key: value for key, value in values.items() if key != "feed"}
    session.execute(stmt.on_conflict_do_update(index_elements=["feed"], set_=changed))


# -- symbol sets --------------------------------------------------------------------------------------------


def watchlist_symbols(session: Session) -> list[str]:
    """Every stock symbol on any watchlist (futures wait for the IBKR slot)."""
    return sorted(
        session.execute(
            select(WatchlistItem.symbol)
            .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
            .where(WatchlistItem.asset_type == "stock")
            .distinct()
        ).scalars()
    )


def survivor_symbols(session: Session) -> list[str]:
    """Active universe symbols that passed the liquidity floor: the symbols the screener evaluates."""
    return sorted(
        session.execute(
            select(UniverseSymbol.symbol).where(UniverseSymbol.active.is_(True), UniverseSymbol.passed_floor.is_(True))
        ).scalars()
    )


def candidate_symbols(session: Session) -> list[str]:
    return sorted(session.execute(select(UniverseSymbol.symbol).where(UniverseSymbol.active.is_(True))).scalars())


# -- fetching -----------------------------------------------------------------------------------------------


def _fetch_each(symbols: Iterable[str], fetch) -> PassReport:
    """Call `fetch(symbol)` for each symbol, isolating `ProviderError`s and stopping after a run of them."""
    report = PassReport()
    streak = 0
    for symbol in symbols:
        try:
            fetch(symbol)
        except NoData:
            streak = 0  # the provider answered: it has nothing for this symbol
            continue
        except ProviderError as exc:
            report.failed[symbol] = type(exc).__name__
            streak += 1
            if streak >= STOP_AFTER_FAILURES:
                report.stopped_early = True
                break
            continue
        streak = 0
        report.fetched += 1
    return report


def _ensure_minute_history(session: Session, sources: DataSources, symbol: str, now: datetime) -> None:
    """The first time a symbol is scanned, fill its previous sessions' minutes (one request for the gap)."""
    earliest = session.execute(select(func.min(Bar1m.bar_start)).where(Bar1m.symbol == symbol)).scalar_one()
    stamp = pd.Timestamp(now)
    if earliest is not None and pd.Timestamp(earliest) <= stamp - pd.Timedelta(days=MINUTE_HISTORY_DAYS - 4):
        return
    today = stamp.tz_convert(ET).date()
    backfill(
        session,
        symbol,
        "1m",
        "stock",
        today - timedelta(days=MINUTE_HISTORY_DAYS),
        previous_session("stock", today),
        bars_source=sources.bars,
        now=stamp,
    )


def refresh_minutes(session: Session, sources: DataSources, symbols: Iterable[str], *, now: datetime) -> PassReport:
    """Store the newest closed 1-minute bars of each symbol (today's session, from its last stored bar)."""
    stamp = pd.Timestamp(now)
    today = trading_session("stock", stamp.tz_convert(ET).date())

    def fetch(symbol: str) -> None:
        _ensure_minute_history(session, sources, symbol, now)
        if today is None or stamp < today.extended_open:
            return
        last = session.execute(
            select(func.max(Bar1m.bar_start)).where(Bar1m.symbol == symbol, Bar1m.bar_start >= today.extended_open)
        ).scalar_one()
        start = today.extended_open if last is None else pd.Timestamp(last)
        bars = sources.bars.bars(symbol, "1m", start, today.extended_close, now=stamp)
        upsert_bars(session, symbol, "1m", bars.frame, bars.source, "stock", now=stamp)

    return _fetch_each(symbols, fetch)


def refresh_daily(session: Session, sources: DataSources, symbols: Iterable[str], *, now: datetime) -> PassReport:
    """Fill each symbol's missing daily bars over the last `DAILY_HISTORY_DAYS` (a new symbol: all of it)."""
    stamp = pd.Timestamp(now)
    today = stamp.tz_convert(ET).date()

    def fetch(symbol: str) -> None:
        backfill(
            session,
            symbol,
            "1d",
            "stock",
            today - timedelta(days=DAILY_HISTORY_DAYS),
            today,
            bars_source=sources.bars,
            now=stamp,
        )

    return _fetch_each(symbols, fetch)


# -- bias ---------------------------------------------------------------------------------------------------


def fifteen_minute_bias(session: Session, symbol: str, now: pd.Timestamp) -> str | None:
    """The summary label of the 15-minute technical bias over the stored regular-session minutes, or None while
    fewer than `bias.MIN_BARS` 15-minute bars exist."""
    minutes = read_bars(session, symbol, "1m", now - pd.Timedelta(days=MINUTE_HISTORY_DAYS), now, "stock", as_of=now)
    if minutes.empty:
        return None
    regular = annotate(minutes, "stock")
    regular = regular[regular["phase"] == "regular"]
    if regular.empty:
        return None
    frame = _resample(regular, "stock", 15, now)[["open", "high", "low", "close", "volume"]]
    result = bias.bias(frame)
    return None if result == "warming up" else result.summary_label


def refresh_bias(session: Session, symbols: Iterable[str], *, now: datetime) -> int:
    """Write `bias_15m` beside each symbol's metrics (the watchlist table reads it). A symbol with no metrics
    row yet is skipped. Returns the rows updated.

    `refresh_metrics` writes with a Core upsert, so an instance an earlier job still holds in this session (the
    scheduler runs several jobs on one) is stale: reload it, or the stale numbers overwrite the fresh row."""
    stamp = pd.Timestamp(now)
    updated = 0
    for symbol in symbols:
        row = session.get(SymbolMetrics, symbol, populate_existing=True)
        if row is None:
            continue
        row.metrics = {**row.metrics, "bias_15m": fifteen_minute_bias(session, symbol, stamp)}
        updated += 1
    return updated


# -- the passes ---------------------------------------------------------------------------------------------


def _scan_symbols(session: Session) -> list[str]:
    return sorted(set(watchlist_symbols(session)) | set(survivor_symbols(session)))


def _recompute(session: Session, symbols: Iterable[str], *, now: datetime) -> list[str]:
    """Metrics for `symbols`, then the 15-minute bias beside the metrics of the watchlist ones (every metrics
    write replaces the row, so the bias is rewritten each time). Returns the symbols whose metrics were stored."""
    stored = refresh_metrics(session, symbols, now=pd.Timestamp(now))
    refresh_bias(session, [s for s in watchlist_symbols(session) if s in stored], now=now)
    return stored


def record_universe_day(session: Session, *, now: datetime) -> None:
    """Snapshot the symbols this morning's pass scans, so a later practice day can name its universe exactly
    (02o-b v1: write-only, no reader yet). One row per ET day, replaced by a re-run the same day. It runs in a
    savepoint and swallows any failure: a snapshot must never fail the live pass."""
    try:
        with session.begin_nested():
            day = pd.Timestamp(now).tz_convert(ET).date()
            stmt = pg_insert(UniverseDay).values(day=day, symbols=survivor_symbols(session), created_at=now)
            session.execute(stmt.on_conflict_do_update(index_elements=["day"], set_={"symbols": stmt.excluded.symbols}))
    except Exception as exc:  # noqa: BLE001 -- see the docstring
        log.warning("universe_days snapshot skipped (%s)", type(exc).__name__)


def _refresh_universe(session: Session, sources: DataSources, *, now: datetime) -> PassReport:
    """Rebuild the universe, store the daily bars and metrics of its candidates, apply the floor."""
    build = build_universe(session, sources, now=now)
    candidates = candidate_symbols(session)
    daily = refresh_daily(session, sources, candidates, now=now)
    _recompute(session, candidates, now=now)
    apply_floor(session, now=now)
    record_universe_day(session, now=now)
    # `build.failed` values carry provider messages: keep the error class only, like every other failure here.
    failed = {name: message.split(":", 1)[0] for name, message in build.failed.items()}
    return PassReport(fetched=daily.fetched, failed={**failed, **daily.failed}, stopped_early=daily.stopped_early)


def intraday_pass(session: Session, sources: DataSources, *, now: datetime) -> PassReport:
    """The 15-minute pass. Caller commits.

    With no floor survivor stored, the premarket pass missed its day or failed: rebuild the universe first, so
    the next 15-minute slot catches up instead of waiting for tomorrow."""
    scanning = scan_enabled(sources)
    if scanning and not survivor_symbols(session):
        _refresh_universe(session, sources, now=now)
    symbols = _scan_symbols(session) if scanning else watchlist_symbols(session)
    report = refresh_minutes(session, sources, symbols, now=now)
    record_health(session, BARS_FEED, report.state, now=now, detail=_detail(report))
    if report.fetched:
        _recompute(session, symbols, now=now)
        if scanning:
            run_filters(session, now=now, run_on=INTRADAY_FILTERS)
            record_health(session, SCAN_FEED, report.state, now=now, detail=_detail(report))
    return report


def premarket_pass(session: Session, sources: DataSources, *, now: datetime) -> PassReport:
    """08:30 ET: the universe and its daily numbers, minutes for the survivors, then the premarket filters."""
    report = _refresh_universe(session, sources, now=now)
    symbols = _scan_symbols(session)
    minutes = refresh_minutes(session, sources, symbols, now=now)
    record_health(session, BARS_FEED, minutes.state, now=now, detail=_detail(minutes))
    _recompute(session, symbols, now=now)
    run_filters(session, now=now, run_on=PREMARKET_FILTERS)
    report.fetched += minutes.fetched
    report.failed.update(minutes.failed)
    report.stopped_early = report.stopped_early or minutes.stopped_early
    record_health(session, SCAN_FEED, report.state, now=now, detail=_detail(report))
    return report


def daily_pass(session: Session, sources: DataSources, *, now: datetime) -> PassReport:
    """After the close: daily bars for the watchlists and the survivors, metrics, the floor, the daily filters."""
    symbols = _scan_symbols(session)
    report = refresh_daily(session, sources, symbols, now=now)
    _recompute(session, symbols, now=now)
    apply_floor(session, now=now)
    run_filters(session, now=now, run_on=DAILY_FILTERS)
    record_health(session, SCAN_FEED, report.state, now=now, detail=_detail(report))
    return report


def _detail(report: PassReport) -> str | None:
    """A short, secret-free note for `feed_health.detail`: how many symbols failed and the error classes."""
    if not report.failed and not report.stopped_early:
        return None
    kinds = ", ".join(sorted(set(report.failed.values())))
    note = f"{len(report.failed)} failed ({kinds})" if report.failed else "stopped early"
    return note + ("; stopped early" if report.stopped_early and report.failed else "")
