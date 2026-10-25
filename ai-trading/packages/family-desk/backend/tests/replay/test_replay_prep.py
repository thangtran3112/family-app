"""The replay prep (02o, owner request): a month of bars for many symbols in a handful of requests, resumable,
and opt-in tape pre-warming."""

from dataclasses import replace
from datetime import UTC, date, datetime

import pandas as pd
import pytest
from ai_trading_common.registry import DataSources

from ai_trading.replay import fixture, prep
from ai_trading.replay.cache import BlobKey, MemoryBlobStore
from ai_trading.replay.data import History, prior_sessions
from ai_trading.replay.tape import Tape

NOW = datetime(2026, 10, 24, tzinfo=UTC)
EMPTY = DataSources(**{name: None for name in DataSources.__dataclass_fields__})
LINES: list[str] = []


def say(text: str) -> None:
    LINES.append(text)


def history() -> History:
    return History(replace(EMPTY, bars=fixture.FixtureBars()), now=lambda: NOW)


def test_needed_sessions_are_the_days_plus_ten_prior():
    days = prep.sessions_between(date(2026, 9, 21), date(2026, 9, 25))
    needed = prep.needed_sessions(days)
    assert len(days) == 5 and len(needed) == 15 and needed[-1] == date(2026, 9, 25)
    assert set(prior_sessions(days[0])) <= set(needed)


def test_a_month_of_bars_is_one_minute_run_and_one_daily_request_per_symbol():
    hist, store = history(), MemoryBlobStore()
    days = prep.sessions_between(date(2026, 9, 21), date(2026, 9, 25))
    report = prep.preload_bars(hist, store, ["TSLA"], days, now=NOW, say=say)
    assert report.symbols == 1 and report.fetched_sessions == 15 and report.failed == {}
    assert hist.fetches == 2  # one contiguous minute run, one daily frame for every day
    assert BlobKey("bars1m", "TSLA", date(2026, 9, 25), "", "sip") in store.blobs
    assert BlobKey("bars1d", "TSLA", date(2026, 9, 21), "", "sip") in store.blobs


def test_a_second_run_fetches_nothing():
    store = MemoryBlobStore()
    days = prep.sessions_between(date(2026, 9, 21), date(2026, 9, 25))
    prep.preload_bars(history(), store, ["TSLA"], days, now=NOW, say=say)
    again = history()
    report = prep.preload_bars(again, store, ["TSLA"], days, now=NOW, say=say)
    assert again.fetches == 0 and report.fetched_sessions == 0


def test_one_failing_symbol_is_reported_and_the_run_continues():
    class Failing(fixture.FixtureBars):
        def bars(self, symbol, *args, **kwargs):
            if symbol == "BAD":
                raise RuntimeError("boom")
            return super().bars(symbol, *args, **kwargs)

    hist = History(replace(EMPTY, bars=Failing()), now=lambda: NOW)
    report = prep.preload_bars(hist, MemoryBlobStore(), ["BAD", "TSLA"], [date(2026, 9, 25)], now=NOW, say=say)
    assert report.failed == {"BAD": "RuntimeError"} and report.symbols == 1


def test_unfinished_days_are_skipped():
    hist = history()
    report = prep.preload_bars(
        hist, MemoryBlobStore(), ["TSLA"], [date(2026, 9, 25)], now=datetime(2026, 9, 25, 21, tzinfo=UTC), say=say
    )
    assert report.symbols == 0 and hist.fetches == 0


@pytest.mark.parametrize(
    ("mode", "start", "end"),
    [("first-hour", "13:30", "14:30"), ("regular", "13:30", "20:00")],
)
def test_tape_windows(mode: str, start: str, end: str):
    lo, hi = prep.tape_window(date(2026, 9, 25), mode)
    assert (lo.strftime("%H:%M"), hi.strftime("%H:%M")) == (start, end)
    custom = prep.tape_window(date(2026, 9, 25), "window", "10:00", "10:15")
    assert custom[1] - custom[0] == pd.Timedelta(minutes=15)
    with pytest.raises(ValueError):
        prep.tape_window(date(2026, 9, 25), "window")


def test_tape_prewarm_stores_each_chunk_once_and_is_resumable():
    store = MemoryBlobStore()
    sources = fixture.fixture_sources(EMPTY)
    window = prep.tape_window(date(2026, 9, 25), "first-hour")
    first = prep.prewarm_tape(Tape(sources, now=lambda: NOW), store, "TSLA", date(2026, 9, 25), window, say=say)
    assert first.chunks == 12 and first.fetched_chunks == 12 and first.prints > 10_000
    again = Tape(sources, now=lambda: NOW)
    second = prep.prewarm_tape(again, store, "TSLA", date(2026, 9, 25), window, say=say)
    assert second.fetched_chunks == 0 and again.fetches == 0 and second.prints == first.prints
