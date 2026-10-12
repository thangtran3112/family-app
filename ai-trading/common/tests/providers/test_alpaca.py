import pandas as pd
import pytest

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.providers.alpaca import AlpacaBars
from ai_trading_common.testing import FakeResponse, make_client


def bar(t, c, v=100):
    return {"t": t, "o": c - 1, "h": c + 1, "l": c - 2, "c": c, "v": v}


NOW = pd.Timestamp("2026-01-10 12:00", tz="UTC")
START = pd.Timestamp("2026-01-01", tz="UTC")
END = pd.Timestamp("2026-01-08", tz="UTC")


class TestDailyBars:
    def test_maps_bars_to_the_shared_shape_with_eod_quality(self):
        body = {"bars": [bar("2026-01-02T05:00:00Z", 10), bar("2026-01-05T05:00:00Z", 11)]}
        client, session, _ = make_client([FakeResponse(200, body)])
        alpaca = AlpacaBars("kid", "sec", http=client)
        got = alpaca.bars("AAPL", "1d", START, END, now=NOW)
        assert got.source == "alpaca"
        assert got.quality == "eod"
        assert list(got.frame.index) == [pd.Timestamp("2026-01-02").date(), pd.Timestamp("2026-01-05").date()]
        assert got.frame.loc[pd.Timestamp("2026-01-02").date(), "close"] == 10.0
        headers = session.calls[0][2]
        assert headers["APCA-API-KEY-ID"] == "kid"
        assert headers["APCA-API-SECRET-KEY"] == "sec"

    def test_follows_pagination(self):
        client, session, _ = make_client(
            [
                FakeResponse(200, {"bars": [bar("2026-01-02T05:00:00Z", 10)], "next_page_token": "p2"}),
                FakeResponse(200, {"bars": [bar("2026-01-05T05:00:00Z", 11)], "next_page_token": None}),
            ]
        )
        alpaca = AlpacaBars("kid", "sec", http=client)
        got = alpaca.bars("AAPL", "1d", START, END, now=NOW)
        assert len(got.frame) == 2
        assert len(session.calls) == 2

    def test_no_bars_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(200, {"bars": []})])
        alpaca = AlpacaBars("kid", "sec", http=client)
        with pytest.raises(NoData):
            alpaca.bars("ZZZZ", "1d", START, END, now=NOW)

    def test_404_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(404)])
        alpaca = AlpacaBars("kid", "sec", http=client)
        with pytest.raises(NoData):
            alpaca.bars("ZZZZ", "1d", START, END, now=NOW)

    def test_401_raises_not_configured(self):
        client, _, _ = make_client([FakeResponse(401)])
        alpaca = AlpacaBars("bad", "key", http=client)
        with pytest.raises(NotConfigured):
            alpaca.bars("AAPL", "1d", START, END, now=NOW)

    def test_empty_key_raises_not_configured_without_a_request(self):
        client, session, _ = make_client([])
        alpaca = AlpacaBars("", "", http=client)
        with pytest.raises(NotConfigured):
            alpaca.bars("AAPL", "1d", START, END, now=NOW)
        assert session.calls == []

    def test_500_raises_unavailable_after_bounded_retries(self):
        client, session, clock = make_client([FakeResponse(500)] * 10)
        alpaca = AlpacaBars("kid", "sec", http=client)
        with pytest.raises(Unavailable):
            alpaca.bars("AAPL", "1d", START, END, now=NOW)
        assert len(session.calls) == 4  # the http layer's default retry bound


class TestIntradayBars:
    def test_hourly_and_minute_bars_are_delayed_15m(self):
        for timeframe in ("1h", "1m"):
            client, _, _ = make_client([FakeResponse(200, {"bars": [bar("2026-01-02T14:30:00Z", 10)]})])
            alpaca = AlpacaBars("kid", "sec", http=client)
            got = alpaca.bars("AAPL", timeframe, START, END, now=NOW)
            assert got.quality == "delayed-15m"
            assert str(got.frame.index.tz) == "UTC"

    def test_sip_embargo_caps_the_request_end_15_minutes_before_now(self):
        now = pd.Timestamp("2026-01-10 12:00:00", tz="UTC")
        client, session, _ = make_client([FakeResponse(200, {"bars": [bar("2026-01-10T11:00:00Z", 10)]})])
        alpaca = AlpacaBars("kid", "sec", http=client)
        alpaca.bars("AAPL", "1m", pd.Timestamp("2026-01-10 10:00", tz="UTC"), now, now=now)
        params = session.calls[0][1]
        assert params["end"] == (now - pd.Timedelta(minutes=15)).isoformat()

    def test_capped_end_before_start_returns_empty_without_a_request(self):
        now = pd.Timestamp("2026-01-10 10:00:00", tz="UTC")
        start = pd.Timestamp("2026-01-10 09:58", tz="UTC")  # inside the 15-minute embargo
        client, session, _ = make_client([])
        alpaca = AlpacaBars("kid", "sec", http=client)
        got = alpaca.bars("AAPL", "1m", start, now, now=now)
        assert got.frame.empty
        assert session.calls == []
