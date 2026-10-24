"""The 15-minute in-session refresh (02 §8): backfills the day's forming session for every
distinct stock watchlist symbol, then evaluates the live (`bar_close_*`) cadences against the
freshly delayed bars. Stocks only -- futures stay `unavailable` without IBKR (D-c)."""

from datetime import datetime, time

from ai_trading_common.registry import DataSources
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import tick
from ai_trading.core.calendar import ET, session
from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import WatchlistItem
from ai_trading.jobs import JobResult

NAME = "refresh_15m"
_WINDOW_START = time(7, 0)
_WINDOW_END = time(17, 0)
_LIVE_CADENCES = frozenset({"bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h"})


def due_now(now: datetime) -> bool:
    """Every 15 minutes, 07:00-17:00 ET, on an XNYS stock trading day."""
    et_now = now.astimezone(ET)
    if session("stock", et_now.date()) is None:
        return False
    if not (_WINDOW_START <= et_now.time() <= _WINDOW_END):
        return False
    return et_now.minute % 15 == 0


def run(session_: Session, data_sources: DataSources, *, now: datetime) -> JobResult:
    """Fetches today's 1-minute bars for every distinct stock watchlist symbol directly from
    `data_sources.bars` and `upsert_bars`s them, then runs `alerts.runtime.tick` for the live
    cadences (quality stays `delayed-15m`: this job supplies fresher delayed bars, never realtime
    ones).

    Integration fix: no longer routed through `ai_trading.data.backfill.backfill`.
    `backfill()`'s own `missing_sessions` check only ever reports a whole day as "missing" when
    *no* bar at all is stored for it yet (Phase 2a's own contract, built for filling
    session-level gaps, not for continuously extending an already-started day) -- so once today's
    first 1-minute bar landed, a later same-day `backfill()` call found nothing new to fetch
    (REPORT-L3.md's own flagged limitation). Calling `data_sources.bars.bars()` directly every
    time and letting `upsert_bars` (idempotent, closed-bars-only) do the merge means a later
    same-day call always stores whatever new minutes have closed since the previous call.
    """
    today = now.astimezone(ET).date()
    found = session("stock", today)
    if found is None:
        tick(session_, now=now, live_cadences=_LIVE_CADENCES)
        return JobResult(NAME, ok=True)

    symbols = (
        session_.execute(select(WatchlistItem.symbol).where(WatchlistItem.asset_type == "stock").distinct())
        .scalars()
        .all()
    )
    for symbol in symbols:
        bars = data_sources.bars.bars(symbol, "1m", found.extended_open, found.extended_close, now=now)
        upsert_bars(session_, symbol, "1m", bars.frame, bars.source, "stock", now=now)

    tick(session_, now=now, live_cadences=_LIVE_CADENCES)
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")
