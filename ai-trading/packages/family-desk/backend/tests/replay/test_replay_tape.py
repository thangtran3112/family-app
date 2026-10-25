"""The tape service and the blob cache (02o decision 2, §i): eligible prints, the tick rule, size filters and the
cap, the pace meter, the IEX fallback label, chunk caching, and the codec. No network, no database."""

from datetime import UTC, datetime

import numpy as np
import pandas as pd
import pytest
from ai_trading_common.errors import Unavailable
from ai_trading_common.registry import DataSources
from ai_trading_common.testing import FakeTrades
from ai_trading_common.trades import Trades

from ai_trading.replay import cache, fixture
from ai_trading.replay import tape as T
from ai_trading.replay.cache import BlobKey, MemoryBlobStore

OPEN = pd.Timestamp("2026-09-25T13:30:00Z")
LONG_AGO = datetime(2026, 10, 24, tzinfo=UTC)


def frame(rows: list[tuple[float, float, int, str]]) -> pd.DataFrame:
    """Rows of `(seconds after the open, price, size, conditions)` in the Trades shape."""
    return pd.DataFrame(
        {
            "t": pd.DatetimeIndex([OPEN + pd.Timedelta(seconds=r[0]) for r in rows], tz="UTC"),
            "p": [r[1] for r in rows],
            "s": [r[2] for r in rows],
            "x": ["Q"] * len(rows),
            "c": [r[3] for r in rows],
        }
    )


def tape_over(rows: list[tuple[float, float, int, str]], *, refuse_sip: bool = False, iex=None, now=LONG_AGO):
    fake = FakeTrades(
        {("TSLA", "sip"): frame(rows), **({("TSLA", "iex"): frame(iex)} if iex else {})}, refuse_sip=refuse_sip
    )
    sources = DataSources(**{name: None for name in DataSources.__dataclass_fields__} | {"trades": fake})
    return T.Tape(sources, now=lambda: now), fake


# -- eligibility, ticks, filters, pace -----------------------------------------------------------------------


def test_prints_that_do_not_update_the_last_sale_are_dropped():
    rows = [(1, 10.0, 100, "@"), (2, 10.1, 200, "@TI"), (3, 10.2, 50, "@Z"), (4, 10.3, 60, "C"), (5, 10.4, 70, "4")]
    tape, _ = tape_over(rows)
    got = tape.prints(MemoryBlobStore(), "TSLA", OPEN, OPEN + pd.Timedelta(seconds=10), "sip")
    assert list(got.s) == [100, 200, 70]  # Z (out of sequence) and C (cash) dropped; I (odd lot) and 4 stay
    assert got.volume == 370 and len(got) == 3


def test_window_is_open_closed_and_cut_at_the_playhead():
    rows = [(1, 10.0, 1, "@"), (2, 10.1, 1, "@"), (3, 10.2, 1, "@"), (301, 10.3, 1, "@")]  # the last is in chunk 2
    tape, _ = tape_over(rows)
    store = MemoryBlobStore()
    two = OPEN + pd.Timedelta(seconds=2)
    assert list(tape.prints(store, "TSLA", OPEN + pd.Timedelta(seconds=1), two, "sip").p) == [10.1]  # (1, 2]
    allp = tape.prints(store, "TSLA", OPEN, OPEN + pd.Timedelta(seconds=400), "sip")
    assert list(allp.p) == [10.0, 10.1, 10.2, 10.3]
    assert len(tape.prints(store, "TSLA", two, two, "sip")) == 0  # an empty window


def test_tick_rule_up_down_same_and_first_print():
    p = np.array([10.0, 10.1, 10.1, 10.0])
    assert list(T.ticks(p, None)) == [0, 1, 0, -1]
    assert list(T.ticks(p, 9.9)) == [1, 1, 0, -1]  # the first print compares with the previous window's last print
    assert len(T.ticks(np.array([]), 1.0)) == 0


def test_size_filter_cap_and_counts():
    prints = T.Prints(
        np.arange(6, dtype="int64"), np.array([10.0, 10, 10, 10, 10, 1000]), np.array([1, 99, 100, 1000, 5000, 2000])
    )
    tick = np.zeros(6, dtype="int8")
    rows, kept = T.select_rows(prints, tick, min_size=100)
    assert [r[2] for r in rows] == [100, 1000, 5000, 2000] and kept == 4
    rows, kept = T.select_rows(prints, tick, min_size=100, max_prints=2)
    assert [r[2] for r in rows] == [5000, 2000] and kept == 4  # the latest two, oldest first
    rows, _ = T.select_rows(prints, tick, min_notional=T.BIG_PRINT_USD)
    assert [r[2] for r in rows] == [5000 // 5000 * 2000]  # only 1000 x 2000 = $2M clears the big-print notional


def test_pace_bands():
    window = T.Prints(np.arange(5, dtype="int64"), np.full(5, 10.0), np.full(5, 1000))
    block = T.pace(window, seconds=10, avg_shares_per_s=100.0)
    assert block == {"window_s": 10, "prints_per_s": 0.5, "shares_per_s": 500.0, "x_of_avg": 5.0, "band": "busy"}
    assert T.band_of(1.0) == "quiet" and T.band_of(2.0) == "steady" and T.band_of(9.0) == "frantic"
    assert T.pace(window, seconds=10, avg_shares_per_s=None)["band"] is None


def test_last_print_looks_back_a_few_chunks_then_gives_up():
    tape, _ = tape_over([(1, 10.0, 1, "@")])
    store = MemoryBlobStore()
    found = tape.last_print(store, "TSLA", OPEN + pd.Timedelta(minutes=12), "sip")
    assert found is not None and found[1] == 10.0 and found[0] == OPEN + pd.Timedelta(seconds=1)
    assert tape.last_print(store, "TSLA", OPEN + pd.Timedelta(minutes=40), "sip") is None


# -- the feed label, the cache ------------------------------------------------------------------------------


def test_sip_refused_falls_back_to_iex_and_says_so():
    tape, fake = tape_over([(1, 10.0, 1, "@")], refuse_sip=True, iex=[(1, 10.0, 7, "@")])
    store = MemoryBlobStore()
    assert tape.probe_feed(store, "TSLA", OPEN) == "iex"
    assert tape.prints(store, "TSLA", OPEN, OPEN + pd.Timedelta(seconds=10), "iex").volume == 7
    assert [c[3] for c in fake.calls] == ["sip", "iex", "iex"][: len(fake.calls)] and fake.calls[0][3] == "sip"


def test_sip_that_works_stays_sip():
    tape, _ = tape_over([(1, 10.0, 1, "@")])
    assert tape.probe_feed(MemoryBlobStore(), "TSLA", OPEN) == "sip"


def test_a_chunk_is_fetched_once_then_served_from_the_store():
    tape, fake = tape_over([(1, 10.0, 1, "@")])
    store = MemoryBlobStore()
    tape.chunk(store, "TSLA", OPEN, "sip")
    tape.chunk(store, "TSLA", OPEN, "sip")
    assert len(fake.calls) == 1 and tape.fetches == 1
    fresh = T.Tape(tape._sources, now=lambda: LONG_AGO)  # a new process: empty LRU, same store
    fresh.chunk(store, "TSLA", OPEN, "sip")
    assert fresh.fetches == 0 and len(fake.calls) == 1
    key = BlobKey("tape", "TSLA", OPEN.date(), "1330", "sip")
    assert key in store.blobs


def test_a_chunk_inside_the_embargo_is_served_but_not_stored():
    now = datetime(2026, 9, 25, 13, 38, tzinfo=UTC)  # 8 minutes after the open: the 13:30 chunk ended 3 minutes ago
    tape, _ = tape_over([(1, 10.0, 1, "@")], now=now)
    store = MemoryBlobStore()
    assert len(tape.chunk(store, "TSLA", OPEN, "sip").t) == 1
    assert store.blobs == {}


def test_an_empty_chunk_is_cached_too():
    tape, fake = tape_over([])
    store = MemoryBlobStore()
    tape.chunk(store, "TSLA", OPEN, "sip")
    T.Tape(tape._sources, now=lambda: LONG_AGO).chunk(store, "TSLA", OPEN, "sip")
    assert len(fake.calls) == 1


def test_a_provider_outage_is_not_cached(monkeypatch):
    class Down:
        def trades(self, *a, **k):
            raise Unavailable("fake", "down")

    sources = DataSources(**{name: None for name in DataSources.__dataclass_fields__} | {"trades": Down()})
    store = MemoryBlobStore()
    with pytest.raises(Unavailable):
        T.Tape(sources, now=lambda: LONG_AGO).chunk(store, "TSLA", OPEN, "sip")
    assert store.blobs == {}


# -- the codec and the real prints --------------------------------------------------------------------------


def test_bar_blob_round_trips_exactly(inputs):
    bars = inputs.bars_1m.iloc[:400]
    payload, _ = cache.encode_bars(bars)
    back = cache.decode_bars(payload)
    pd.testing.assert_frame_equal(back, bars, check_freq=False, check_index_type=False)
    assert len(payload) < len(bars) * 40  # compressed well under the raw 48 bytes a row


def test_daily_blob_round_trips_exactly(inputs):
    payload, _ = cache.encode_daily(inputs.daily)
    pd.testing.assert_frame_equal(cache.decode_daily(payload), inputs.daily)


def test_tape_blob_round_trips_exactly_and_keeps_conditions():
    t = np.array([1, 5, 9], dtype="int64") * 1_000_000_000 + 1_790_000_000_000_000_000
    p = np.array([222.334, 222.3341, 0.5075])
    payload, _ = cache.encode_tape(t, p, np.array([100, 1, 5]), ["@T", "@", "@Z"])
    chunk = cache.decode_tape(payload, T.NOT_LAST_SALE)
    assert list(chunk.t) == list(t) and list(chunk.p) == [222.334, 222.3341, 0.5075]
    assert list(chunk.u) == [True, True, False] and chunk.raw_count == 3 and chunk.raw_shares == 106


def test_real_prints_sum_to_the_sip_minute_bar_volume(inputs, store):
    """R0's check on the fixture: a minute's print sizes sum to the SIP 1-minute bar's volume (the open's Q prints
    are the one exception, so compare minutes after the first)."""
    tape = T.Tape(
        fixture.fixture_sources(DataSources(**{n: None for n in DataSources.__dataclass_fields__})),
        now=lambda: LONG_AGO,
    )
    matched = 0
    for minute in range(2, 9):
        start = OPEN + pd.Timedelta(minutes=minute)
        chunk = tape.chunk(store, "TSLA", T.chunk_start(start), "sip")
        inside = (chunk.t >= start.value) & (chunk.t < (start + pd.Timedelta(minutes=1)).value)
        bar = inputs.bars_1m.loc[start]
        matched += int(chunk.s[inside].sum() == bar["volume"])
    assert matched >= 6  # R0: 59 of 60 minutes matched exactly


def test_trades_dataclass_is_the_registry_shape():
    assert Trades.__dataclass_fields__.keys() == {"frame", "source", "feed"}
