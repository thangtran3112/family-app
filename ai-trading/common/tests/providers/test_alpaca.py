import pandas as pd
import pytest

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.providers.alpaca import AlpacaBars
from ai_trading_common.testing import FakeClock, FakeResponse, make_client


def bar(t, c, v=100):
    return {"t": t, "o": c - 1, "h": c + 1, "l": c - 2, "c": c, "v": v}


class WindowedSession:
    """Alpaca's server-side window, for `1Day` bars.

    Recorded from the live API: a daily bar is stamped at **midnight America/New_York** of its
    trading date (`04:00Z` in EDT, `05:00Z` in EST), i.e. *before* that session's 04:00 ET
    extended open, and both `start` and `end` bounds are inclusive. This fake applies exactly
    that filter to the stored rows, so a request window too narrow to contain a bar's timestamp
    comes back empty the way the real endpoint answers.
    """

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.calls: list[tuple[str, dict, dict]] = []

    def get(self, url, params=None, headers=None, timeout=None):
        query = dict(params or {})
        self.calls.append((url, query, dict(headers or {})))
        start = pd.Timestamp(query["start"])
        end = pd.Timestamp(query["end"])
        return FakeResponse(200, {"bars": [r for r in self.rows if start <= pd.Timestamp(r["t"]) <= end]})


def windowed(rows: list[dict]) -> tuple[AlpacaBars, WindowedSession]:
    clock = FakeClock()
    session = WindowedSession(rows)
    client = ThrottledClient(clock=clock.now, sleep=clock.sleep, jitter=lambda a, b: 0.0, session=session)
    return AlpacaBars("kid", "sec", http=client), session


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


class TestDailyWindowWidth:
    """Regression (D-076): a one-session daily window used to come back empty.

    Alpaca stamps a `1Day` bar at midnight America/New_York of its trading date, which is
    *earlier* than that session's 04:00 ET extended open. Every caller (backfill, refresher,
    replay) requests `session.extended_open .. session.extended_close`, so a single-session
    range asked for a window that started after the only bar it wanted and Alpaca answered
    `{"bars": []}` -> `NoData`, aborting that symbol's whole backfill. A wider range was only
    ever partially right: it silently lost its first session the same way.
    """

    @staticmethod
    def _session(day: str) -> tuple[pd.Timestamp, pd.Timestamp]:
        """One session's extended hours: 04:00 ET open to 20:00 ET close."""
        return (
            pd.Timestamp(f"{day} 04:00", tz="America/New_York"),
            pd.Timestamp(f"{day} 20:00", tz="America/New_York"),
        )

    def test_a_one_session_window_returns_that_sessions_bar(self):
        alpaca, session = windowed([bar("2026-10-26T04:00:00Z", 765.37)])  # live shape, EDT
        start, end = self._session("2026-10-26")
        got = alpaca.bars("SPY", "1d", start, end, now=pd.Timestamp("2026-10-31 12:00", tz="UTC"))
        assert list(got.frame.index) == [pd.Timestamp("2026-10-26").date()]
        assert got.frame["close"].iloc[0] == 765.37
        # The request is padded back to the bar's own stamp (midnight ET), never forward.
        assert session.calls[0][1]["start"] == pd.Timestamp("2026-10-26T04:00:00Z").isoformat()
        assert session.calls[0][1]["end"] == pd.Timestamp("2026-10-27T00:00:00Z").isoformat()

    def test_a_one_session_window_works_in_standard_time_too(self):
        alpaca, _ = windowed([bar("2026-01-06T05:00:00Z", 600.0)])  # EST: midnight ET is 05:00Z
        got = alpaca.bars("SPY", "1d", *self._session("2026-01-06"), now=pd.Timestamp("2026-01-10 12:00", tz="UTC"))
        assert list(got.frame.index) == [pd.Timestamp("2026-01-06").date()]

    def test_a_multi_session_window_keeps_its_first_session(self):
        rows = [
            bar("2026-10-28T04:00:00Z", 772.31),
            bar("2026-10-29T04:00:00Z", 769.36),
            bar("2026-10-30T04:00:00Z", 755.72),
        ]
        alpaca, _ = windowed(rows)
        got = alpaca.bars(
            "SPY",
            "1d",
            self._session("2026-10-28")[0],
            self._session("2026-10-30")[1],
            now=pd.Timestamp("2026-10-31 12:00", tz="UTC"),
        )
        assert [day.isoformat() for day in got.frame.index] == ["2026-10-28", "2026-10-29", "2026-10-30"]
        assert got.frame["close"].tolist() == [772.31, 769.36, 755.72]

    def test_bars_outside_the_callers_trading_dates_are_sliced_away(self):
        body = {
            "bars": [
                bar("2026-10-23T04:00:00Z", 770.0),  # the session before the window
                bar("2026-10-26T04:00:00Z", 765.37),
                bar("2026-10-27T04:00:00Z", 766.0),  # the session after it
            ]
        }
        client, _, _ = make_client([FakeResponse(200, body)])
        alpaca = AlpacaBars("kid", "sec", http=client)
        got = alpaca.bars("SPY", "1d", *self._session("2026-10-26"), now=pd.Timestamp("2026-10-31 12:00", tz="UTC"))
        assert list(got.frame.index) == [pd.Timestamp("2026-10-26").date()]

    def test_intraday_requests_are_not_padded(self):
        for timeframe in ("1h", "1m"):
            client, session, _ = make_client([FakeResponse(200, {"bars": [bar("2026-01-09T15:00:00Z", 10)]})])
            alpaca = AlpacaBars("kid", "sec", http=client)
            start, end = pd.Timestamp("2026-01-09T14:30:00Z"), pd.Timestamp("2026-01-09T16:00:00Z")
            alpaca.bars("AAPL", timeframe, start, end, now=pd.Timestamp("2026-01-10 12:00", tz="UTC"))
            assert session.calls[0][1]["start"] == start.isoformat()


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
