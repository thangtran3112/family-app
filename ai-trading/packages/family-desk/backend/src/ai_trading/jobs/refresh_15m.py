"""The 15-minute in-session refresh (02 §8, 02m §b3): stores the newest delayed minutes for every watchlist
symbol and every screener survivor (`data.refresher.intraday_pass`), recomputes their metrics and the 15-minute
bias, runs the intraday filters, then evaluates the live (`bar_close_*`) cadences with `alerts.runtime.tick`.
Stocks only -- futures stay `unavailable` without IBKR (D-c)."""

from datetime import datetime, time, timedelta

from ai_trading_common.registry import DataSources
from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import tick
from ai_trading.core.calendar import ET, session
from ai_trading.data import refresher
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


def next_due(now: datetime) -> datetime:
    """The next instant after `now` at which `due_now` is true (the `/status` "next scan" time)."""
    cursor = now.replace(second=0, microsecond=0) + timedelta(minutes=15 - now.minute % 15)
    for _ in range(8 * 24 * 4):  # eight days of quarter hours covers any weekend or holiday run
        if due_now(cursor):
            return cursor
        cursor += timedelta(minutes=15)
    raise ValueError("no refresh slot within eight days")


def run(session_: Session, data_sources: DataSources, *, now: datetime) -> JobResult:
    """Fetches the newest 1-minute bars for the watchlist symbols (and, with the universe kind, the screener
    survivors) directly from `data_sources.bars` and `upsert_bars`s them from each symbol's last stored bar, so a
    later same-day call always stores whatever new minutes have closed since the previous one. The data feed's
    health is recorded for the staleness guard, then `tick` runs for the live cadences (quality stays
    `delayed-15m`: this job supplies fresher delayed bars, never realtime ones).

    Integration fix: no longer routed through `ai_trading.data.backfill.backfill` for today. `backfill()`'s own
    `missing_sessions` check only ever reports a whole day as "missing" when *no* bar at all is stored for it yet,
    so once today's first 1-minute bar landed, a later same-day `backfill()` found nothing new to fetch.
    """
    refresher.intraday_pass(session_, data_sources, now=now)
    tick(session_, now=now, live_cadences=_LIVE_CADENCES)
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "next_due", "run")
