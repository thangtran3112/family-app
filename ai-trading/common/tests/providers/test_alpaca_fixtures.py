"""Contract tests against real Alpaca responses recorded by scripts/record.py.

No network: each fixture is a `{"params": ..., "body": ...}` JSON file under
tests/fixtures/alpaca/, replayed through a fake session so the client code path
(pagination, bar mapping, hygiene) runs on real response shapes.
"""

import json
from pathlib import Path

import pandas as pd

from ai_trading_common.providers.alpaca import AlpacaBars
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent.parent / "fixtures" / "alpaca"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def alpaca_for(*fixture_names: str) -> tuple[AlpacaBars, object]:
    responses = [FakeResponse(200, load(name)["body"]) for name in fixture_names]
    client, session, _ = make_client(responses)
    return AlpacaBars("kid", "sec", http=client), session


class TestDailyFixture:
    def test_daily_range_round_trips_through_validate_and_drop_unclosed(self):
        alpaca, _ = alpaca_for("daily_range_aapl")
        now = pd.Timestamp("2026-02-01", tz="UTC")
        start, end = pd.Timestamp("2026-01-01", tz="UTC"), pd.Timestamp("2026-01-15", tz="UTC")
        got = alpaca.bars("AAPL", "1d", start, end, now=now)
        assert got.quality == "eod"
        assert len(got.frame) == 9
        assert list(got.frame.columns) == ["open", "high", "low", "close", "volume"]
        assert all(isinstance(day, type(got.frame.index[0])) for day in got.frame.index)


class TestDstChangeFixture:
    def test_hourly_bars_span_the_dst_gap_with_a_consistent_utc_index(self):
        alpaca, _ = alpaca_for("hourly_dst_change")
        now = pd.Timestamp("2026-03-10", tz="UTC")
        got = alpaca.bars(
            "AAPL", "1h", pd.Timestamp("2026-03-06T15:00:00Z"), pd.Timestamp("2026-03-09T17:00:00Z"), now=now
        )
        assert str(got.frame.index.tz) == "UTC"
        # Bars exist both before (2026-03-06, EST) and after (2026-03-09, EDT) the
        # transition; the index stays a plain, monotonic UTC DatetimeIndex either side.
        assert got.frame.index.min().date().isoformat() == "2026-03-06"
        assert got.frame.index.max().date().isoformat() == "2026-03-09"
        assert got.frame.index.is_monotonic_increasing

    def test_minute_bars_cross_the_weekend_and_dst_gap_cleanly(self):
        alpaca, _ = alpaca_for("minute_dst_change")
        now = pd.Timestamp("2026-03-10", tz="UTC")
        got = alpaca.bars(
            "AAPL", "1m", pd.Timestamp("2026-03-06T20:45:00Z"), pd.Timestamp("2026-03-09T14:00:00Z"), now=now
        )
        assert not got.frame.empty
        assert got.frame.index.is_monotonic_increasing
        # The weekend (plus the DST-change Sunday) leaves the largest gap in the
        # index by a wide margin over any ordinary overnight gap.
        gaps = got.frame.index.to_series().diff().dropna()
        assert gaps.max() > pd.Timedelta(hours=24)


class TestHalfDayFixture:
    def test_hourly_half_day_includes_a_post_close_extended_hours_bar(self):
        alpaca, _ = alpaca_for("hourly_half_day")
        now = pd.Timestamp("2025-11-29", tz="UTC")
        got = alpaca.bars(
            "AAPL", "1h", pd.Timestamp("2025-11-28T00:00:00Z"), pd.Timestamp("2025-11-29T00:00:00Z"), now=now
        )
        # The regular session on a half day closes 13:00 ET (18:00 UTC); Alpaca's
        # sip feed still reports post-market hourly bars after that, which must
        # survive drop_unclosed once their own 60 minutes have actually elapsed.
        assert (got.frame.index >= pd.Timestamp("2025-11-28T18:00:00Z")).any()

    def test_minute_half_day_bars_keep_their_real_minute_closes(self):
        alpaca, _ = alpaca_for("minute_half_day")
        now = pd.Timestamp("2025-11-29", tz="UTC")
        got = alpaca.bars(
            "AAPL", "1m", pd.Timestamp("2025-11-28T17:45:00Z"), pd.Timestamp("2025-11-28T18:15:00Z"), now=now
        )
        assert len(got.frame) > 0
        assert got.frame.index.max() <= pd.Timestamp("2025-11-28T18:15:00Z")


class TestPaginationFixture:
    def test_every_page_is_followed_and_concatenated_in_order(self):
        names = ["minute_paginated"] + [f"minute_paginated_page{n}" for n in range(2, 8)]
        alpaca, session = alpaca_for(*names)
        now = pd.Timestamp("2026-01-06", tz="UTC")
        got = alpaca.bars(
            "SPY", "1m", pd.Timestamp("2026-01-05T14:30:00Z"), pd.Timestamp("2026-01-05T15:00:00Z"), now=now
        )
        assert len(session.calls) == 7
        assert len(got.frame) == 31  # 6 pages of 5 bars plus a final page of 1
        assert got.frame.index.is_monotonic_increasing
