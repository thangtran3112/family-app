"""`AlpacaBars.trades` (`/v2/stocks/{symbol}/trades`) and the bars `adjustment` pass-through.

No network: `make_client` replays scripted responses through a fake session, so what is under test is the
request (feed, embargo cap, page token) and the row mapping.
"""

import pandas as pd
import pytest

from ai_trading_common.errors import NoData, NotConfigured, ProviderError
from ai_trading_common.providers.alpaca import AlpacaBars
from ai_trading_common.testing import FakeResponse, make_client
from ai_trading_common.trades import TRADE_COLUMNS

NOW = pd.Timestamp("2026-01-10 12:00", tz="UTC")
START = pd.Timestamp("2026-01-02 14:30", tz="UTC")
END = pd.Timestamp("2026-01-02 14:31", tz="UTC")
URL = "https://data.alpaca.markets/v2/stocks/AAPL/trades"


def trade(t, p=10.5, s=100, x="V", c=()):
    return {"t": t, "x": x, "p": p, "s": s, "c": list(c), "i": 1, "z": "C"}


class TestTrades:
    def test_maps_prints_with_nanosecond_times_and_joined_conditions(self):
        body = {
            "trades": [
                trade("2026-01-02T14:30:00.123456789Z", c=("@", "T", "I")),
                trade("2026-01-02T14:30:00.5Z", p=10.6, s=5, x="", c=()),
            ]
        }
        client, session, _ = make_client([FakeResponse(200, body)])
        got = AlpacaBars("kid", "sec", http=client).trades("AAPL", START, END, now=NOW)
        frame = got.frame
        assert (got.source, got.feed) == ("alpaca", "sip")
        assert list(frame.columns) == list(TRADE_COLUMNS)
        assert frame["t"].dtype == "datetime64[ns, UTC]"
        assert frame["t"].iloc[0] == pd.Timestamp("2026-01-02T14:30:00.123456789Z")
        assert frame["c"].tolist() == ["@TI", ""]
        assert frame["x"].tolist() == ["V", ""]
        assert frame["p"].tolist() == [10.5, 10.6]
        assert frame["s"].dtype == "int64"
        url, params, headers = session.calls[0]
        assert url == URL
        assert params == {"start": START.isoformat(), "end": END.isoformat(), "feed": "sip", "limit": "10000"}
        assert headers["APCA-API-KEY-ID"] == "kid"

    def test_follows_next_page_token(self):
        client, session, _ = make_client(
            [
                FakeResponse(200, {"trades": [trade("2026-01-02T14:30:00Z")], "next_page_token": "p2"}),
                FakeResponse(200, {"trades": [trade("2026-01-02T14:30:01Z")], "next_page_token": None}),
            ]
        )
        got = AlpacaBars("kid", "sec", http=client).trades("AAPL", START, END, now=NOW)
        assert len(got.frame) == 2
        assert "page_token" not in session.calls[0][1]
        assert session.calls[1][1]["page_token"] == "p2"

    def test_sip_end_is_capped_to_the_embargo(self):
        client, session, _ = make_client([FakeResponse(200, {"trades": [trade("2026-01-10T11:00:00Z")]})])
        start = pd.Timestamp("2026-01-10 10:00", tz="UTC")
        AlpacaBars("kid", "sec", http=client).trades("AAPL", start, NOW + pd.Timedelta(hours=1), now=NOW)
        assert session.calls[0][1]["end"] == (NOW - pd.Timedelta(minutes=15)).isoformat()

    def test_iex_end_is_not_capped(self):
        end = NOW + pd.Timedelta(hours=1)
        client, session, _ = make_client([FakeResponse(200, {"trades": []})])
        got = AlpacaBars("kid", "sec", http=client).trades("AAPL", START, end, feed="iex", now=NOW)
        assert session.calls[0][1]["end"] == end.isoformat()
        assert session.calls[0][1]["feed"] == "iex"
        assert got.feed == "iex"

    def test_a_window_inside_the_embargo_is_empty_without_a_request(self):
        client, session, _ = make_client([])
        got = AlpacaBars("kid", "sec", http=client).trades("AAPL", NOW - pd.Timedelta(minutes=10), NOW, now=NOW)
        assert got.frame.empty
        assert list(got.frame.columns) == list(TRADE_COLUMNS)
        assert session.calls == []

    def test_an_empty_body_is_an_empty_trades_not_no_data(self):
        client, _, _ = make_client([FakeResponse(200, {"trades": [], "next_page_token": None})])
        got = AlpacaBars("kid", "sec", http=client).trades("AAPL", START, END, now=NOW)
        assert got.frame.empty
        assert list(got.frame.columns) == list(TRADE_COLUMNS)
        assert got.frame["t"].dtype == "datetime64[ns, UTC]"

    def test_drops_non_positive_prints_and_sorts_by_time_stably(self):
        body = {
            "trades": [
                trade("2026-01-02T14:30:02Z", p=11.0, x="V"),
                trade("2026-01-02T14:30:01Z", p=0.0),
                trade("2026-01-02T14:30:01.5Z", s=0),
                trade("2026-01-02T14:30:00Z", p=10.0, x="Q"),
                trade("2026-01-02T14:30:00Z", p=10.1, x="N"),
            ]
        }
        client, _, _ = make_client([FakeResponse(200, body)])
        frame = AlpacaBars("kid", "sec", http=client).trades("AAPL", START, END, now=NOW).frame
        assert frame["p"].tolist() == [10.0, 10.1, 11.0]
        assert frame["x"].tolist() == ["Q", "N", "V"]
        assert frame["t"].is_monotonic_increasing
        assert frame["t"].dtype == "datetime64[ns, UTC]"  # whole-second strings alone would infer a coarser unit

    @pytest.mark.parametrize(
        "bad",
        [
            {"t": "2026-01-02T14:30:00Z", "s": 100},  # no price
            {"t": "not-a-time", "p": 10.0, "s": 100},
            {"t": None, "p": 10.0, "s": 100},
            "garbage",
        ],
    )
    def test_a_malformed_print_raises_provider_error(self, bad):
        client, _, _ = make_client([FakeResponse(200, {"trades": [bad]})])
        with pytest.raises(ProviderError):
            AlpacaBars("kid", "sec", http=client).trades("AAPL", START, END, now=NOW)

    @pytest.mark.parametrize(("status", "error"), [(403, NotConfigured), (404, NoData)])
    def test_rejected_key_and_unknown_symbol_map_like_bars(self, status, error):
        client, _, _ = make_client([FakeResponse(status)])
        with pytest.raises(error):
            AlpacaBars("kid", "sec", http=client).trades("AAPL", START, END, now=NOW)

    def test_an_empty_key_raises_not_configured_without_a_request(self):
        client, session, _ = make_client([])
        with pytest.raises(NotConfigured):
            AlpacaBars("", "", http=client).trades("AAPL", START, END, now=NOW)
        assert session.calls == []


class TestBarsAdjustment:
    def test_a_raw_adjustment_is_sent_and_the_default_is_all(self):
        bar = {"t": "2026-01-02T05:00:00Z", "o": 9.0, "h": 11.0, "l": 8.0, "c": 10.0, "v": 100}
        client, session, _ = make_client([FakeResponse(200, {"bars": [bar]}), FakeResponse(200, {"bars": [bar]})])
        alpaca = AlpacaBars("kid", "sec", http=client)
        alpaca.bars("AAPL", "1d", START, END, now=NOW, adjustment="raw")
        alpaca.bars("AAPL", "1d", START, END, now=NOW)
        assert session.calls[0][1]["adjustment"] == "raw"
        assert session.calls[1][1]["adjustment"] == "all"
