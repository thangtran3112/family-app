"""Replay inputs (02o §i data cases): each no-data message, raw adjustment, one request per missing run of
sessions, the blob cache, and the day/window checks."""

from datetime import UTC, date, datetime

import pandas as pd
import pytest
from ai_trading_common.registry import DataSources

from ai_trading.replay import fixture
from ai_trading.replay.cache import BlobKey, MemoryBlobStore
from ai_trading.replay.data import (
    History,
    ReplayDayError,
    check_day,
    check_window,
    prior_sessions,
    window_bounds,
)

DAY = date(2026, 9, 25)
LATER = datetime(2026, 10, 24, tzinfo=UTC)
EMPTY = DataSources(**{name: None for name in DataSources.__dataclass_fields__})


class Recorder:
    """The fixture bars source, recording every request's timeframe, range and adjustment."""

    def __init__(self) -> None:
        self.inner = fixture.FixtureBars()
        self.calls: list[tuple[str, pd.Timestamp, pd.Timestamp, str]] = []

    def bars(self, symbol, timeframe, start, end, *, now, adjustment="all"):
        self.calls.append((timeframe, start, end, adjustment))
        return self.inner.bars(symbol, timeframe, start, end, now=now, adjustment=adjustment)


def history(now: datetime = LATER) -> tuple[History, Recorder]:
    recorder = Recorder()
    from dataclasses import replace

    return History(replace(EMPTY, bars=recorder), now=lambda: now), recorder


def test_raw_prices_are_requested_for_minutes_and_daily():
    hist, rec = history()
    hist.day_inputs(MemoryBlobStore(), "TSLA", DAY)
    assert {c[0] for c in rec.calls} == {"1m", "1d"}
    assert {c[3] for c in rec.calls} == {"raw"}


def test_ten_prior_sessions_are_one_request_and_come_back_with_the_day():
    hist, rec = history()
    inputs = hist.day_inputs(MemoryBlobStore(), "TSLA", DAY)
    minute_calls = [c for c in rec.calls if c[0] == "1m"]
    assert len(minute_calls) == 1  # 11 consecutive sessions: one contiguous run
    days = {ts.tz_convert("America/New_York").date() for ts in inputs.bars_1m.index}
    assert days == {*prior_sessions(DAY), DAY}
    assert len(inputs.daily) == 300 and inputs.prior_close == 377.94
    assert inputs.avg_shares_per_s and inputs.avg_shares_per_s > 0


def test_a_second_call_reads_the_store_and_never_the_provider():
    hist, rec = history()
    store = MemoryBlobStore()
    hist.day_inputs(store, "TSLA", DAY)
    fetched = len(rec.calls)
    again, rec2 = history()  # a fresh process with the same store
    again.day_inputs(store, "TSLA", DAY)
    assert fetched == 2 and rec2.calls == []
    assert BlobKey("bars1m", "TSLA", DAY, "", "sip") in store.blobs


def test_only_the_missing_run_is_fetched():
    hist, rec = history()
    store = MemoryBlobStore()
    hist.minute_bars(store, "TSLA", prior_sessions(DAY)[:5])
    rec.calls.clear()
    hist.minute_bars(store, "TSLA", [*prior_sessions(DAY), DAY])
    (call,) = rec.calls
    assert call[0] == "1m" and call[1] > pd.Timestamp("2026-09-11T20:00:00Z")  # starts after the cached five


def test_an_unfinished_day_is_not_stored():
    now = datetime(2026, 9, 25, 20, 10, tzinfo=UTC)  # 4:10 PM ET: the day's extended session is still open
    hist, _ = history(now)
    store = MemoryBlobStore()
    hist.minute_bars(store, "TSLA", [DAY])
    assert BlobKey("bars1m", "TSLA", DAY, "", "sip") not in store.blobs


def test_no_bars_for_the_symbol_is_the_plain_no_trades_message():
    hist, _ = history()
    with pytest.raises(ReplayDayError, match="No trades for AAPL on Fri 2026-09-25"):
        hist.day_inputs(MemoryBlobStore(), "AAPL", DAY)


@pytest.mark.parametrize(
    ("day", "now", "message"),
    [
        (date(2026, 9, 26), LATER, "No trading on Sat 2026-09-26 · pick a weekday"),
        (date(2026, 9, 7), LATER, "No trading on Mon 2026-09-07 · the market was closed"),  # Labor Day
        (date(2015, 12, 31), LATER, "Replay goes back to Jan 4, 2016"),
        (date(2026, 10, 23), datetime(2026, 10, 23, 20, 10, tzinfo=UTC), "replay opens at 4:15 PM ET"),
        (date(2026, 11, 27), datetime(2026, 11, 27, 18, 14, tzinfo=UTC), "replay opens at 1:15 PM ET"),  # half day
    ],
)
def test_check_day_messages(day: date, now: datetime, message: str):
    with pytest.raises(ReplayDayError, match=message):
        check_day(day, now)
    assert ReplayDayError(message).path == "day"


def test_a_finished_day_passes_and_the_first_allowed_day_is_2016_01_04():
    check_day(DAY, LATER)
    check_day(date(2016, 1, 4), LATER)


def test_an_extended_window_opens_fifteen_minutes_after_its_own_end():
    _, end = window_bounds(DAY, "04:00", "20:00")
    check_window(DAY, end, datetime(2026, 9, 25, 0, 15, tzinfo=UTC) + pd.Timedelta(days=1))
    with pytest.raises(ReplayDayError) as raised:
        check_window(DAY, end, datetime(2026, 9, 26, 0, 10, tzinfo=UTC))  # 8:10 PM ET
    assert raised.value.path == "window" and "8:15 PM ET" in raised.value.message
