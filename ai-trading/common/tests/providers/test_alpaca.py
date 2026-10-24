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


class TestUniverse:
    def test_assets_maps_name_and_exchange_and_drops_untradable(self):
        body = [
            {"symbol": "AAPL", "name": "Apple Inc. Common Stock", "exchange": "NASDAQ", "tradable": True},
            {"symbol": "ZZZZ", "name": "Delisted", "exchange": "OTC", "tradable": False},
        ]
        client, session, _ = make_client([FakeResponse(200, body)])
        got = AlpacaBars("kid", "sec", http=client).assets()
        assert [(a.symbol, a.name, a.exchange, a.quality) for a in got] == [
            ("AAPL", "Apple Inc. Common Stock", "NASDAQ", "eod")
        ]
        url, params, headers = session.calls[0]
        assert url == "https://paper-api.alpaca.markets/v2/assets"
        assert params == {"status": "active", "asset_class": "us_equity"}
        assert headers["APCA-API-KEY-ID"] == "kid"

    def test_most_actives_maps_volume_and_trade_count(self):
        body = {"most_actives": [{"symbol": "NVDA", "volume": 1000, "trade_count": 50}]}
        client, session, _ = make_client([FakeResponse(200, body)])
        got = AlpacaBars("kid", "sec", http=client).most_actives("trades", 100)
        assert [(a.symbol, a.volume, a.trade_count, a.quality) for a in got] == [("NVDA", 1000.0, 50, "delayed-15m")]
        assert session.calls[0][1] == {"by": "trades", "top": "100"}

    def test_movers_keeps_both_sides(self):
        body = {
            "gainers": [{"symbol": "UP", "percent_change": 12.5, "price": 3.0}],
            "losers": [{"symbol": "DN", "percent_change": -9.0, "price": 4.0}],
        }
        client, _, _ = make_client([FakeResponse(200, body)])
        got = AlpacaBars("kid", "sec", http=client).movers(50)
        assert [(m.symbol, m.side, m.change_pct) for m in got] == [("UP", "gainer", 12.5), ("DN", "loser", -9.0)]

    def test_a_rejected_key_is_not_configured_and_an_empty_key_sends_nothing(self):
        client, _, _ = make_client([FakeResponse(401)])
        with pytest.raises(NotConfigured):
            AlpacaBars("bad", "key", http=client).movers(5)
        client, session, _ = make_client([])
        with pytest.raises(NotConfigured):
            AlpacaBars("", "", http=client).assets()
        assert session.calls == []

    def test_the_trading_host_is_configurable(self):
        client, session, _ = make_client([FakeResponse(200, [])])
        AlpacaBars("kid", "sec", http=client, trading_url="https://api.alpaca.markets/").assets()
        assert session.calls[0][0] == "https://api.alpaca.markets/v2/assets"


class TestLatestQuotes:
    def test_returns_the_newest_closed_bar_per_symbol_and_skips_unknown_symbols(self):
        now = pd.Timestamp("2026-01-10 12:00", tz="UTC")
        client, session, _ = make_client(
            [
                FakeResponse(200, {"bars": [bar("2026-01-09T20:59:00Z", 11)]}),
                FakeResponse(404),
            ]
        )
        got = AlpacaBars("kid", "sec", http=client).latest(["AAPL", "ZZZZ"], now=now)
        assert [(q.symbol, q.price, q.quality) for q in got] == [("AAPL", 11.0, "delayed-15m")]
        assert got[0].as_of == pd.Timestamp("2026-01-09T20:59:00Z")
        params = session.calls[0][1]
        assert params["sort"] == "desc" and params["limit"] == "1"
        assert params["end"] == (now - pd.Timedelta(minutes=15)).isoformat()
