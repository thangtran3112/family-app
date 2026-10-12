"""Bar hygiene: the shared frame shape, and guards against a repainting or stale bar.

Modified from (no code copied; see THIRD_PARTY_NOTICES.md): TradingAgents
``dataflows/vendors/yahoo/ohlcv.py`` and
``market.py`` (Apache License 2.0, upstream commit
``1394a3f72aa4393e1a98f51b382434c4b4c2d972``). Their rules carry over as rules,
reworked for this package's frame shape: inclusive ends belong to each
client's own request range, not here; a bad row is dropped rather than failing the
whole frame, the same choice their ``_fill_price_gaps``/``_clean_dataframe`` make.
``drop_unclosed`` follows ai-hedge-fund ``hedge_fund/data/cached.py``'s rule in
spirit ("never cache a trading day that has not closed"; pattern reuse, no
notice needed), generalized to the 1h/1m bar edges the Desk's core needs.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from functools import cache
from typing import Literal
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import pandas as pd

from ai_trading_common.quality import Quality

Timeframe = Literal["1d", "1h", "1m"]

COLUMNS = ("open", "high", "low", "close", "volume")

ET = ZoneInfo("America/New_York")

# A fixed range so results don't drift as the wall clock advances (same choice as
# the Desk's core/calendar.py).
_CALENDAR_START = "2000-01-01"
_CALENDAR_END = "2035-12-31"


@cache
def _xnys() -> xcals.ExchangeCalendar:
    return xcals.get_calendar("XNYS", start=_CALENDAR_START, end=_CALENDAR_END)


@dataclass(frozen=True)
class Bars:
    frame: pd.DataFrame
    source: str
    quality: Quality


class BarValidationError(ValueError):
    """`validate` or a guard was given a frame or timestamp it cannot use."""


def to_utc(value: pd.Timestamp | datetime) -> pd.Timestamp:
    """A tz-aware timestamp as UTC; rejects a naive timestamp (ambiguous local time).

    Shared by every provider client's `now`/`start`/`end` arguments, not just the
    guards below.
    """
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        raise BarValidationError("timestamp must be tz-aware")
    return ts.tz_convert("UTC")


def validate(frame: pd.DataFrame, timeframe: Timeframe) -> pd.DataFrame:
    """Enforce the shared bar shape and drop rows that cannot be trusted.

    - exactly the columns open/high/low/close/volume, coerced numeric;
    - "1d": index of plain `date` objects (the Desk's core convention; see
      `ai_trading.core.backtest.SymbolBars`), unique and sorted;
    - "1h"/"1m": a tz-aware `DatetimeIndex` of bar starts, converted to UTC,
      unique and sorted;
    - a row with a non-positive price, `high < low`, or a NaN is dropped, not
      the whole frame — one bad print should not blank out an otherwise-good
      history. (Decision, not TradingAgents' whole-frame reject: a vendor's
      occasional malformed row is common; a vendor with no good rows at all
      still ends up empty, which the caller's `NoData` path already covers.)

    Raises `BarValidationError` when the shape itself is unusable (missing
    columns, or an index of the wrong kind) — row content does not get here.
    """
    missing = [c for c in COLUMNS if c not in frame.columns]
    if missing:
        raise BarValidationError(f"missing columns: {missing}")
    frame = frame[list(COLUMNS)].copy()
    for column in COLUMNS:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    if timeframe == "1d":
        if not all(isinstance(value, date) and not isinstance(value, datetime) for value in frame.index):
            raise BarValidationError("1d bars must be indexed by plain date objects")
    else:
        if not isinstance(frame.index, pd.DatetimeIndex) or frame.index.tz is None:
            raise BarValidationError(f"{timeframe} bars must have a tz-aware DatetimeIndex")
        if str(frame.index.tz) != "UTC":
            frame.index = frame.index.tz_convert("UTC")

    if not frame.index.is_monotonic_increasing:
        frame = frame.sort_index()
    if frame.index.has_duplicates:
        frame = frame[~frame.index.duplicated(keep="last")]

    good = (
        frame[list(COLUMNS)].notna().all(axis=1)
        & (frame["open"] > 0)
        & (frame["high"] > 0)
        & (frame["low"] > 0)
        & (frame["close"] > 0)
        & (frame["high"] >= frame["low"])
        & (frame["volume"] >= 0)
    )
    return frame[good]


def drop_unclosed(frame: pd.DataFrame, timeframe: Timeframe, now: pd.Timestamp | datetime) -> pd.DataFrame:
    """Drop any bar whose period has not closed by `now` (no repainting).

    - "1m": the bar closes one minute after its start.
    - "1h": the bar closes 60 minutes after its start, or at the session's
      close when that is earlier (a session's short last hour, or a half day).
    - "1d": the bar (indexed by trading day) closes at that day's XNYS close
      (16:00 ET on a regular day, 13:00 ET on a half day).

    A day in a "1d" frame that XNYS does not recognize as a session is dropped:
    it cannot be anything but a vendor error, since a closed exchange has no
    close to compare against.
    """
    now_utc = to_utc(now)
    calendar = _xnys()

    if timeframe == "1d":
        keep = []
        for day in frame.index:
            label = pd.Timestamp(day)
            if not calendar.is_session(label):
                keep.append(False)
                continue
            keep.append(calendar.session_close(label) <= now_utc)
        return frame[keep]

    if timeframe == "1m":
        return frame[frame.index + pd.Timedelta(minutes=1) <= now_utc]

    # "1h"
    keep = []
    for start in frame.index:
        label = pd.Timestamp(start.tz_convert(ET).date())
        close_cap = start + pd.Timedelta(minutes=60)
        if calendar.is_session(label):
            session_open, session_close = calendar.session_open(label), calendar.session_close(label)
            # Only shorten the bin when `start` is inside the *regular* session:
            # an extended-hours (pre/post-market) bar that starts after the
            # regular close has no session boundary to borrow, and still needs
            # its own full 60 minutes — capping it at the already-past regular
            # close would mark it closed the instant it starts (repainting risk).
            if session_open <= start < session_close:
                close_cap = min(close_cap, session_close)
        keep.append(close_cap <= now_utc)
    return frame[keep]
