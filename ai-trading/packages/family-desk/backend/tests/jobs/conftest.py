"""Shared, network-free test support for the `ai_trading.jobs` suite (Lane L3)."""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest
from ai_trading_common.bars import Bars
from sqlalchemy import insert
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # tests/bars.py's flat-bar helpers
from bars import daily_bars, minute_bars  # noqa: E402

from ai_trading.core.calendar import session as _session
from ai_trading.data.bars import bar_close
from ai_trading.db.models import User, Watchlist, WatchlistItem


class FakeBarsSource:
    """A `BarsSource` double: never touches the network. Serves flat, already-closed-as-of-`now`
    bars built from `tests/bars.py`'s helpers, and records every call it answered."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, pd.Timestamp, pd.Timestamp]] = []

    def bars(self, symbol: str, timeframe: str, start: pd.Timestamp, end: pd.Timestamp, *, now: pd.Timestamp) -> Bars:
        self.calls.append((symbol, timeframe, start, end))
        quality = "eod" if timeframe == "1d" else "delayed-15m"
        return Bars(frame=_frame(timeframe, start, end, now), source="fake", quality=quality)


def _days_between(start: pd.Timestamp, end: pd.Timestamp) -> list[date]:
    start_day = pd.Timestamp(start).tz_convert("America/New_York").date()
    end_day = pd.Timestamp(end).tz_convert("America/New_York").date()
    days, cursor = [], start_day
    while cursor <= end_day:
        days.append(cursor)
        cursor += timedelta(days=1)
    return days


def _frame(timeframe: str, start: pd.Timestamp, end: pd.Timestamp, now: pd.Timestamp) -> pd.DataFrame:
    days = [d for d in _days_between(start, end) if _session("stock", d) is not None]

    if timeframe == "1d":
        closed = [d for d in days if bar_close("stock", "1d", d) <= now]
        return daily_bars(closed, [100.0] * len(closed))

    if (end.tz_convert("America/New_York").date() - start.tz_convert("America/New_York").date()).days == 0:
        # A single-day request (refresh_15m's own `start=end=today`): the whole session's worth
        # of minute bars, same shape `test_templates.py` already relies on.
        full = minute_bars("stock", days[0]) if days else minute_bars("stock", start.date())
        mask = [bar_close("stock", timeframe, pd.Timestamp(idx)) <= now for idx in full.index]
        return full[mask]

    # A multi-day request (`backfill_on_join`'s whole-history span): one bar per trading day, at
    # that day's open -- cheap (no minute-by-minute blowup over a decade) and still enough to
    # mark every day in range as "present" to `ai_trading.data.bars.missing_sessions`.
    index = [_session("stock", d).extended_open for d in days]
    index = [point for point in index if bar_close("stock", timeframe, point) <= now]
    return pd.DataFrame(
        {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 1_000.0},
        index=pd.DatetimeIndex(index),
    )


@pytest.fixture
def owner(db_session: Session) -> int:
    return db_session.execute(insert(User).values(email="owner@example.test").returning(User.id)).scalar_one()


@pytest.fixture
def watchlist_with_items(db_session: Session, owner: int) -> int:
    """One watchlist with one stock (`AAPL`) and one future (`ES`) item."""
    watchlist_id = db_session.execute(
        insert(Watchlist).values(user_id=owner, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="AAPL", asset_type="stock"))
    db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="ES", asset_type="future"))
    db_session.commit()
    return watchlist_id
