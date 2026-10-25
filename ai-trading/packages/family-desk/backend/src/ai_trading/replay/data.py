"""Replay inputs for (symbol, day) (02o §c1 `replay/data.py`): raw 1-minute bars of the day plus the 10 prior
sessions (indicator warm-up and levels), 300 raw daily bars, and the day checks behind the plain 422 messages.

- **Raw prices** (`adjustment: "raw"`): chart, tape and stored practice prices agree forever, and a later split
  cannot change an old journal.
- **Never writes `bars_1m`** (its 90-day `prune_1m` retention would delete old days anyway): history lives in the
  `replay_blobs` cache, one blob per symbol and session, so adjacent practice days share their lookback.
- **Rate-aware.** Missing sessions are fetched as contiguous runs (one request per 10,000 bars); a month of
  one symbol is 3 to 4 requests. The registry's throttled client already spaces requests (200 a minute).
- **A day is finished** when its regular close plus the 15-minute SIP embargo has passed, and so is the window.
"""

import logging
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

import pandas as pd
from ai_trading_common.errors import NoData
from ai_trading_common.registry import DataSources

from ai_trading.core.calendar import ET, et, previous_session, session
from ai_trading.replay.cache import (
    BlobKey,
    BlobStore,
    decode_bars,
    decode_daily,
    encode_bars,
    encode_daily,
)

log = logging.getLogger(__name__)

EARLIEST_DAY = date(2016, 1, 4)  # Alpaca's SIP history floor
LOOKBACK_SESSIONS = 10
DAILY_BARS = 300
EMBARGO = timedelta(minutes=15)
LRU_DAYS = 8
_DAILY_LOOKBACK_DAYS = 460  # calendar days that hold 300 sessions with room for holidays
_BARS_FEED = "sip"


class ReplayDayError(Exception):
    """A day the replay cannot open. `message` is the plain sentence the hub shows under the day field."""

    def __init__(self, message: str, path: str = "day") -> None:
        super().__init__(message)
        self.message = message
        self.path = path


@dataclass(frozen=True)
class DayInputs:
    """Everything a session reads about its day. All prices are raw (unadjusted), all frames sorted."""

    symbol: str
    day: date
    bars_1m: pd.DataFrame  # UTC bar-start index; open..volume; extended hours; lookback sessions plus the day
    daily: pd.DataFrame  # `date` index; raw; up to 300 sessions ending at `day`
    prior_close: float | None
    avg_shares_per_s: float | None  # prior-session regular-hours average, for the pace meter


def _weekday(day: date) -> str:
    return day.strftime("%a %Y-%m-%d")


def _clock(moment: datetime | pd.Timestamp) -> str:
    local = pd.Timestamp(moment).tz_convert(ET)
    return f"{local.hour % 12 or 12}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'} ET"


def check_day(day: date, now: datetime) -> None:
    """Raises `ReplayDayError` with the hub's plain sentence when `day` cannot be replayed."""
    if day < EARLIEST_DAY:
        raise ReplayDayError("Replay goes back to Jan 4, 2016")
    found = session("stock", day)
    if found is None:
        raise ReplayDayError(
            f"No trading on {_weekday(day)} · pick a weekday"
            if day.weekday() >= 5
            else f"No trading on {_weekday(day)} · the market was closed"
        )
    opens = found.regular_close + EMBARGO
    if pd.Timestamp(now) < opens:
        raise ReplayDayError(f"This session isn't finished yet · replay opens at {_clock(opens)}")


def check_window(day: date, window_end: pd.Timestamp, now: datetime) -> None:
    """An extended window ends after the regular close: its data is available 15 minutes after its own end."""
    opens = window_end + EMBARGO
    if pd.Timestamp(now) < opens:
        raise ReplayDayError(f"This window isn't finished yet · replay opens at {_clock(opens)}", path="window")


def window_bounds(day: date, from_hhmm: str, to_hhmm: str) -> tuple[pd.Timestamp, pd.Timestamp]:
    return et(day, from_hhmm), et(day, to_hhmm)


def prior_sessions(day: date, count: int = LOOKBACK_SESSIONS) -> list[date]:
    out = []
    cursor = day
    for _ in range(count):
        cursor = previous_session("stock", cursor)
        out.append(cursor)
    return sorted(out)


def _extended_window(day: date) -> tuple[pd.Timestamp, pd.Timestamp]:
    found = session("stock", day)
    assert found is not None
    return found.extended_open, found.extended_close


def _runs(days: list[date]) -> list[list[date]]:
    """Group sorted session days that are consecutive in the calendar's sense (no session between them)."""
    runs: list[list[date]] = []
    for day in days:
        if runs and previous_session("stock", day) == runs[-1][-1]:
            runs[-1].append(day)
        else:
            runs.append([day])
    return runs


class History:
    """Bars for replay days. One per process; the LRU holds decoded inputs of recently used days."""

    def __init__(self, sources: DataSources, *, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._sources = sources
        self._now = now
        self._lru: OrderedDict[tuple[str, date], DayInputs] = OrderedDict()
        self.fetches = 0  # provider bar requests (one per contiguous run), for tests and the prep CLI

    # -- public ----------------------------------------------------------------------------------------------

    def day_inputs(self, store: BlobStore, symbol: str, day: date) -> DayInputs:
        key = (symbol, day)
        if key in self._lru:
            self._lru.move_to_end(key)
            return self._lru[key]
        sessions = [*prior_sessions(day), day]
        frames = self.minute_bars(store, symbol, sessions)
        today = frames.get(day)
        if today is None or today.empty:
            raise ReplayDayError(f"No trades for {symbol} on {_weekday(day)}")
        bars = pd.concat([frames[d] for d in sessions if d in frames]).sort_index()
        daily = self.daily_bars(store, symbol, day)
        before = daily[[d < day for d in daily.index]]
        inputs = DayInputs(
            symbol=symbol,
            day=day,
            bars_1m=bars,
            daily=daily,
            prior_close=float(before["close"].iloc[-1]) if len(before) else None,
            avg_shares_per_s=_avg_shares_per_s(frames, sessions[:-1]),
        )
        self._lru[key] = inputs
        while len(self._lru) > LRU_DAYS:
            self._lru.popitem(last=False)
        return inputs

    def minute_bars(self, store: BlobStore, symbol: str, sessions: list[date]) -> dict[date, pd.DataFrame]:
        """Raw 1-minute bars (extended hours) per session: blob store first, then one request per missing run."""
        have = {k.day for k in store.keys("bars1m", symbol, sessions) if k.feed == _BARS_FEED}
        out: dict[date, pd.DataFrame] = {}
        for day in sessions:
            if day in have:
                payload = store.get(BlobKey("bars1m", symbol, day, "", _BARS_FEED))
                if payload is not None:
                    out[day] = decode_bars(payload)
        missing = [d for d in sessions if d not in out]
        for run in _runs(missing):
            out.update(self._fetch_run(store, symbol, run))
        return out

    def daily_bars(self, store: BlobStore, symbol: str, day: date) -> pd.DataFrame:
        """Up to 300 raw daily bars ending at `day`'s session."""
        key = BlobKey("bars1d", symbol, day, "", _BARS_FEED)
        payload = store.get(key)
        if payload is not None:
            return decode_daily(payload)
        close = session("stock", day)
        assert close is not None
        start = close.regular_open - timedelta(days=_DAILY_LOOKBACK_DAYS)
        try:
            frame = self._sources.bars.bars(
                symbol, "1d", start, close.extended_close, now=self._now(), adjustment="raw"
            ).frame
        except NoData:
            frame = pd.DataFrame({c: [] for c in ("open", "high", "low", "close", "volume")}, index=pd.Index([]))
        self.fetches += 1
        frame = frame.tail(DAILY_BARS)
        if len(frame):
            payload, raw = encode_daily(frame)
            store.put(key, payload, len(frame), raw)
        return frame

    # -- internals -------------------------------------------------------------------------------------------

    def _fetch_run(self, store: BlobStore, symbol: str, run: list[date]) -> dict[date, pd.DataFrame]:
        start, _ = _extended_window(run[0])
        _, end = _extended_window(run[-1])
        try:
            frame = self._sources.bars.bars(symbol, "1m", start, end, now=self._now(), adjustment="raw").frame
        except NoData:
            frame = pd.DataFrame(
                {c: [] for c in ("open", "high", "low", "close", "volume")}, index=pd.DatetimeIndex([], tz="UTC")
            )
        self.fetches += 1
        now = pd.Timestamp(self._now())
        out: dict[date, pd.DataFrame] = {}
        for day in run:
            lo, hi = _extended_window(day)
            part = frame[(frame.index >= lo) & (frame.index < hi)]
            out[day] = part
            # Only a finished day (its extended close plus the embargo) is stored: before that it is incomplete.
            if now >= hi + EMBARGO:
                payload, raw = encode_bars(part)
                store.put(BlobKey("bars1m", symbol, day, "", _BARS_FEED), payload, len(part), raw)
        return out


def _avg_shares_per_s(frames: dict[date, pd.DataFrame], days: list[date]) -> float | None:
    """Mean regular-hours shares per second over the prior sessions (the pace meter's baseline)."""
    totals = []
    for day in days:
        found = session("stock", day)
        frame = frames.get(day)
        if found is None or frame is None or frame.empty:
            continue
        regular = frame[(frame.index >= found.regular_open) & (frame.index < found.regular_close)]
        seconds = (found.regular_close - found.regular_open).total_seconds()
        if len(regular):
            totals.append(float(regular["volume"].sum()) / seconds)
    return sum(totals) / len(totals) if totals else None
