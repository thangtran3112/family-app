"""A real occurrence of a library preset on her stored bars (02m §a3.6 `example`).

The template is evaluated over the symbols on her watchlists, on the bars already stored, for the last ten
sessions; the newest firing is the example. It is `None` when nothing fired, when the template cannot run on
this engine (a pattern on a cadence with no closed candle), or when the time budget ran out
(production hides the block; the mock draws a simulated one).
"""

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import ET, annotate
from ai_trading.core.evaluate import CADENCE_MINUTES, INTRADAY_CADENCES, _resample, evaluate
from ai_trading.data.bars import read_bars
from ai_trading.db.models import Watchlist, WatchlistItem

log = logging.getLogger(__name__)

SESSIONS = 10
MINUTE_DAYS = 24  # calendar days of minutes: ten sessions plus the RVOL baseline
DAILY_DAYS = 420
MAX_SYMBOLS = 20
BUDGET_SECONDS = 2.5
_TIMEFRAME = {"bar_close_1m": "1m", "bar_close_5m": "5m", "bar_close_15m": "15m", "bar_close_1h": "1h"}


def _watchlist_symbols(session: Session, user_id: int) -> list[str]:
    rows = session.execute(
        select(WatchlistItem.symbol)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(Watchlist.user_id == user_id, WatchlistItem.asset_type == "stock")
        .distinct()
    ).scalars()
    return sorted(rows)[:MAX_SYMBOLS]


def _ohlc(
    run_on: str, bars_1m: pd.DataFrame | None, bars_1d: pd.DataFrame, bar_time: pd.Timestamp, as_of
) -> list | None:
    if run_on in CADENCE_MINUTES and bars_1m is not None:
        frame = _resample(annotate(bars_1m, "stock"), "stock", CADENCE_MINUTES[run_on], as_of)
        if bar_time in frame.index:
            row = frame.loc[bar_time]
            return [float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])]
        return None
    day: date = bar_time.tz_convert(ET).date()
    if day in bars_1d.index:
        row = bars_1d.loc[day]
        return [float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])]
    return None


def find_example(session: Session, user_id: int, template: dict[str, Any], *, now: datetime) -> dict[str, Any] | None:
    try:
        spec = StrategySpecV1.model_validate(template)
    except ValueError:
        return None
    run_on = spec.watch.runOn
    as_of = pd.Timestamp(now).tz_convert("UTC")
    cutoff = as_of - pd.Timedelta(days=SESSIONS * 7 // 5 + 2)
    deadline = time.monotonic() + BUDGET_SECONDS
    best: tuple[pd.Timestamp, str, list] | None = None
    for symbol in _watchlist_symbols(session, user_id):
        if time.monotonic() > deadline:
            return None if best is None else _out(best, run_on)
        bars_1d = read_bars(
            session, symbol, "1d", as_of.date() - timedelta(days=DAILY_DAYS), as_of.date(), "stock", as_of=as_of
        )
        bars_1m = None
        if run_on in INTRADAY_CADENCES:
            # Timestamps, not dates: a date `end` is midnight and would hide that day's minutes.
            bars_1m = read_bars(
                session, symbol, "1m", as_of - pd.Timedelta(days=MINUTE_DAYS), as_of, "stock", as_of=as_of
            )
            if bars_1m.empty:
                continue
        try:
            fired = evaluate(spec, symbol, "stock", bars_1m=bars_1m, bars_1d=bars_1d, as_of=as_of)
        except ValueError as exc:  # the engine cannot run this template; no symbol will do better
            log.debug("library example: %s", exc)
            return None
        for candidate in fired:
            if candidate.bar_time < cutoff or (best is not None and candidate.bar_time <= best[0]):
                continue
            ohlc = _ohlc(run_on, bars_1m, bars_1d, candidate.bar_time, as_of)
            if ohlc is not None:
                best = (candidate.bar_time, symbol, ohlc)
    return None if best is None else _out(best, run_on)


def _out(best: tuple[pd.Timestamp, str, list], run_on: str) -> dict[str, Any]:
    bar_time, symbol, ohlc = best
    return {
        "symbol": symbol,
        "timeframe": _TIMEFRAME.get(run_on, "1d"),
        "bar_time": bar_time.to_pydatetime(),
        "ohlc": ohlc,
    }
