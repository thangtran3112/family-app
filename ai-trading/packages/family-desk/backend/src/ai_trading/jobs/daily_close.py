"""`daily_close`: appends every watchlist symbol's closed daily bar, then evaluates `daily_close`
strategies (Lane L3). With a `DataSources` that has the universe kind it also refreshes the screener's daily
numbers and runs the `daily_close` filters (`data.refresher.daily_pass`, 02m §b3). Only the day's bars and the
daily evaluation -- IV and consensus-snapshot collection are Phase 5's job, which actually consumes them
(PROTO-BRIEF §5/§9, following the brief's explicit L5 table over 02c's own older one-liner, per the brief's
§9 ruling)."""

from datetime import datetime, time

from ai_trading_common.registry import DataSources
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import tick
from ai_trading.core.calendar import ET, session
from ai_trading.data import refresher
from ai_trading.data.backfill import backfill
from ai_trading.db.models import WatchlistItem
from ai_trading.jobs import JobResult
from ai_trading.jobs.clock import JobClock

NAME = "daily_close"
_SCHEDULED_ET = time(16, 30)


def due_now(now: datetime) -> bool:
    """True from a fixed 16:30 ET onward, on any XNYS trading day -- half days included.

    Integration fix (PROTO-BRIEF.md integration rulings): this is a fixed wall-clock slot, not
    the stock session's own regular close. A half day's own regular close is 13:00 ET, well
    before this slot, so by 16:30 ET its bars are already closed and available to store/evaluate
    (`test_due_now_daily_close_fires_at_the_half_days_1300_et_close`, 02c Review Focus 4) --
    `daily_close` still runs once per day, just always at the same time, matching
    `watchdog.JOB_SCHEDULE`'s own 16:30 entry exactly (no longer two separate values that happen
    not to conflict).
    """
    et_now = now.astimezone(ET)
    if session("stock", et_now.date()) is None:
        return False
    return et_now.time() >= _SCHEDULED_ET


def run(session_: Session, data_sources: DataSources, clock: JobClock, *, now: datetime) -> JobResult:
    """Backfills today's session for every distinct watchlist symbol (`start=end=today`), then
    evaluates `daily_close` strategies. Never touches `iv_daily`/`consensus_snapshots` (§1
    non-goals).

    Stocks only (02a §5/D-c): `data_sources.bars` has no futures source at all until 2b ships the
    IBKR client -- there is no Alpaca futures endpoint to call -- so a future symbol is skipped
    here rather than attempted and failed; `evaluate()` still runs for it against whatever daily
    bars happen to exist (none, today), producing zero candidates rather than an error.
    """
    if refresher.scan_enabled(data_sources):
        report = refresher.daily_pass(session_, data_sources, now=now)  # the watchlists' bars and the screener's
        if report.state == "down":  # the provider answered nothing: stay unmarked so the next tick retries
            return JobResult(NAME, ok=False, error="market data unavailable")
    else:
        today = now.astimezone(ET).date()
        symbols = session_.execute(select(WatchlistItem.symbol, WatchlistItem.asset_type).distinct()).all()
        for symbol, asset_type in symbols:
            if asset_type != "stock":
                continue
            backfill(session_, symbol, "1d", asset_type, today, today, bars_source=data_sources.bars, now=now)

    tick(session_, now=now, live_cadences=frozenset({NAME}))
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")
