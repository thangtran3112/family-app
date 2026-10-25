"""Replay data prep (02o, owner request): preload the history a practice session reads, so a replay opens from the
blob cache instead of waiting on Alpaca.

- **Bars** (`preload_bars`): raw 1-minute SIP bars (extended hours) for each replay day plus its 10 prior sessions,
  and the 300 raw daily bars of each day. Per symbol this is one contiguous request run (3 to 4 pages of 10,000 bars
  for a month) plus one daily request, so 50 symbols over a month is about 250 requests, minutes at the free plan's
  200 requests a minute. Resumable: stored sessions are skipped.
- **Tape** (`prewarm_tape`): consolidated prints in 5-minute chunks, opt-in per symbol and day, because one dense
  day is millions of prints (NVDA's first hour alone is about one million, 100+ requests). Modes: `first-hour`
  (09:30 to 10:30 ET), `regular` (09:30 to 16:00), or an explicit window.
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime

import pandas as pd

from ai_trading.core.calendar import et, session
from ai_trading.replay.cache import BlobKey, BlobStore
from ai_trading.replay.data import EMBARGO, LOOKBACK_SESSIONS, History, prior_sessions
from ai_trading.replay.tape import CHUNK, Feed, Tape, chunk_start

log = logging.getLogger(__name__)

Say = Callable[[str], None]


@dataclass
class BarsReport:
    symbols: int = 0
    sessions: int = 0  # minute-bar sessions stored or already present
    fetched_sessions: int = 0
    requests: int = 0
    seconds: float = 0.0
    failed: dict[str, str] = field(default_factory=dict)


@dataclass
class TapeReport:
    chunks: int = 0
    fetched_chunks: int = 0
    prints: int = 0
    requests: int = 0
    seconds: float = 0.0
    failed: dict[str, str] = field(default_factory=dict)


def sessions_between(first: date, last: date) -> list[date]:
    out, cursor = [], first
    while cursor <= last:
        if session("stock", cursor) is not None:
            out.append(cursor)
        cursor = date.fromordinal(cursor.toordinal() + 1)
    return out


def finished(days: list[date], now: datetime) -> list[date]:
    """Replay days whose data is complete: extended close plus the embargo has passed."""
    return [
        d
        for d in days
        if (found := session("stock", d)) is not None and pd.Timestamp(now) >= found.extended_close + EMBARGO
    ]


def needed_sessions(days: list[date], lookback: int = LOOKBACK_SESSIONS) -> list[date]:
    """Each replay day and its `lookback` (default 10) prior sessions, sorted and unique."""
    return sorted({s for d in days for s in (*prior_sessions(d, lookback), d)})


def preload_bars(
    history: History,
    store: BlobStore,
    symbols: list[str],
    days: list[date],
    *,
    now: datetime,
    say: Say = print,
    lookback: int = LOOKBACK_SESSIONS,
) -> BarsReport:
    """Minute bars and daily bars for `days` of every symbol. A symbol that fails is reported, never fatal.
    `lookback` is the prior sessions of minutes per day (a day list reads about two weeks of them)."""
    report = BarsReport()
    ready = finished(days, now)
    if len(ready) < len(days):
        say(f"skipping {len(days) - len(ready)} day(s) that are not finished yet")
    if not ready:
        return report
    needed = needed_sessions(ready, lookback)
    for symbol in symbols:
        t0, fetches0 = time.monotonic(), history.fetches
        have = {k.day for k in store.keys("bars1m", symbol, needed)}
        try:
            history.minute_bars(store, symbol, needed)
            history.preload_daily(store, symbol, ready)
        except Exception as exc:  # noqa: BLE001 -- one symbol must not stop a 50-symbol run
            report.failed[symbol] = f"{type(exc).__name__}"
            say(f"{symbol:<6} FAILED {type(exc).__name__}: {exc}")
            continue
        added = len([d for d in needed if d not in have])
        report.symbols += 1
        report.sessions += len(needed)
        report.fetched_sessions += added
        report.requests += history.fetches - fetches0
        report.seconds += time.monotonic() - t0
        say(
            f"{symbol:<6} {len(needed)} sessions ({added} fetched), {len(ready)} daily frames, "
            f"{history.fetches - fetches0} request(s), {time.monotonic() - t0:.1f}s"
        )
    return report


def tape_window(
    day: date, mode: str, start: str | None = None, end: str | None = None
) -> tuple[pd.Timestamp, pd.Timestamp]:
    if mode == "first-hour":
        return et(day, "09:30"), et(day, "10:30")
    if mode == "regular":
        return et(day, "09:30"), et(day, "16:00")
    if mode == "window" and start and end:
        return et(day, start), et(day, end)
    raise ValueError("mode is first-hour, regular, or window (with --from and --to)")


def prewarm_tape(
    tape: Tape,
    store: BlobStore,
    symbol: str,
    day: date,
    window: tuple[pd.Timestamp, pd.Timestamp],
    *,
    feed: Feed = "sip",
    say: Say = print,
) -> TapeReport:
    """Fetch and store every 5-minute chunk of `window` for one symbol and day (skipping stored ones)."""
    report = TapeReport()
    cursor, end = chunk_start(window[0]), window[1]
    t0 = time.monotonic()
    while cursor < end:
        stored = store.get(BlobKey("tape", symbol, cursor.date(), cursor.strftime("%H%M"), feed)) is not None
        fetches0 = tape.fetches
        try:
            chunk = tape.chunk(store, symbol, cursor, feed)
        except Exception as exc:  # noqa: BLE001
            report.failed[f"{symbol} {day} {cursor:%H:%M}"] = type(exc).__name__
            say(f"{symbol} {day} {cursor:%H:%M} FAILED {type(exc).__name__}: {exc}")
            break
        report.chunks += 1
        report.fetched_chunks += 0 if stored else 1
        report.prints += chunk.raw_count
        report.requests += tape.fetches - fetches0
        cursor += CHUNK
    report.seconds = time.monotonic() - t0
    say(
        f"{symbol} {day} tape: {report.chunks} chunks ({report.fetched_chunks} fetched), "
        f"{report.prints:,} prints, {report.seconds:.1f}s"
    )
    return report
