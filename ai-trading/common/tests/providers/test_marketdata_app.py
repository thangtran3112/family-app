"""marketdata.app quotes and option chains against canned response bodies (never the live API). The bodies follow
marketdata.app's documented shapes: parallel columns, one entry per symbol or contract."""

from datetime import date

import pandas as pd
import pytest

from ai_trading_common.errors import NotConfigured, SoftBanned, Unavailable
from ai_trading_common.providers import marketdata_app
from ai_trading_common.providers.marketdata_app import MarketDataApp
from ai_trading_common.registry import REGISTRY
from ai_trading_common.testing import FakeResponse, make_client
from ai_trading_common.types import OptionContract, Quote

NOW = pd.Timestamp("2026-10-29T15:00:00Z")  # 11:00 in New York, Thursday 2026-10-29
TODAY = NOW.tz_convert("America/New_York").date()
QUOTE_AT = "2026-10-29T14:44:58Z"
TOKEN = "token-sentinel"
QUOTE_URL = "https://api.marketdata.app/v1/stocks/quotes/AAPL/"
CHAIN_URL = "https://api.marketdata.app/v1/options/chain/AAPL/"
CHAIN_COLUMNS = (
    "optionSymbol",
    "underlying",
    "expiration",
    "side",
    "strike",
    "firstTraded",
    "dte",
    "updated",
    "bid",
    "bidSize",
    "mid",
    "ask",
    "askSize",
    "last",
    "openInterest",
    "volume",
    "inTheMoney",
    "intrinsicValue",
    "extrinsicValue",
    "underlyingPrice",
    "iv",
    "delta",
    "gamma",
    "theta",
    "vega",
)


def epoch(iso: str) -> int:
    """A UTC instant as Unix seconds, the unit marketdata.app uses for `updated` and `expiration`."""
    return int(pd.Timestamp(iso).timestamp())


def occ(root: str, expiry: str, right: str, strike: float) -> str:
    """An OCC contract symbol: root, YYMMDD, C or P, strike x 1000 in eight digits."""
    return f"{root}{expiry}{right}{round(strike * 1000):08d}"


def quote_body(symbol: str = "AAPL", *, last: float | None = 208.58) -> dict:
    """A stock quote: one entry per column, for one symbol."""
    return {
        "s": "ok",
        "symbol": [symbol],
        "ask": [208.6],
        "askSize": [100],
        "bid": [208.5],
        "bidSize": [100],
        "mid": [208.55],
        "last": [last],
        "change": [-2.45],
        "changepct": [-0.0116],
        "volume": [23133570],
        "updated": [epoch(QUOTE_AT)],
    }


def row(
    expiry: str,
    right: str,
    strike: float,
    *,
    bid: float | None = 4.1,
    ask: float | None = 4.3,
    iv: float | None = 0.25,
    delta: float | None = 0.34,
    open_interest: int | None = 2500,
    updated: str | None = QUOTE_AT,
) -> dict:
    """One contract as one entry in every documented column; `expiry` is an ISO date. The adapter reads bid, ask, iv,
    delta, openInterest and updated; the other columns are filler it ignores."""
    return {
        "optionSymbol": occ("AAPL", date.fromisoformat(expiry).strftime("%y%m%d"), right, strike),
        "underlying": "AAPL",
        "expiration": epoch(f"{expiry}T21:00:00Z"),
        "side": "call" if right == "C" else "put",
        "strike": strike,
        "firstTraded": epoch("2025-01-02T14:30:00Z"),
        "dte": (date.fromisoformat(expiry) - TODAY).days,
        "updated": None if updated is None else epoch(updated),
        "bid": bid,
        "bidSize": 10,
        "mid": 4.2,
        "ask": ask,
        "askSize": 10,
        "last": 4.2,
        "openInterest": open_interest,
        "volume": 150,
        "inTheMoney": False,
        "intrinsicValue": 0.0,
        "extrinsicValue": 4.2,
        "underlyingPrice": 208.58,
        "iv": iv,
        "delta": delta,
        "gamma": 0.01,
        "theta": -0.05,
        "vega": 0.2,
    }


def chain_body(rows: list[dict]) -> dict:
    """A chain response: every documented column, one entry per row, so the columns stay parallel."""
    return {"s": "ok", **{column: [r[column] for r in rows] for column in CHAIN_COLUMNS}}


C_290 = occ("AAPL", "261120", "C", 290)
C_300 = occ("AAPL", "261120", "C", 300)
C_DEC = occ("AAPL", "261204", "C", 290)
# Expiries 2026-11-20 and 2026-12-04 (dte 22 and 36 from NOW), calls and puts.
HAPPY_ROWS = [
    row("2026-11-20", "C", 290.0, bid=4.1, ask=4.3, delta=0.34, iv=0.25, open_interest=2500),
    row("2026-11-20", "C", 300.0, bid=1.9, ask=2.0, delta=0.2, iv=0.24, open_interest=1900),
    row("2026-12-04", "C", 290.0, bid=5.6, ask=5.8, delta=0.42, iv=0.26, open_interest=800),
    row("2026-11-20", "P", 280.0, bid=0.9, ask=1.0, delta=-0.12, iv=0.27, open_interest=1200),
    row("2026-11-20", "P", 290.0, bid=2.6, ask=2.8, delta=-0.3, iv=0.26, open_interest=3100),
    row("2026-12-04", "P", 280.0, bid=3.3, ask=3.5, delta=-0.25, iv=0.27, open_interest=400),
]


class TestQuotes:
    def test_maps_the_last_trade_stamped_with_the_quote_time(self):
        client, _, _ = make_client([FakeResponse(200, quote_body())])
        got = MarketDataApp(TOKEN, http=client).latest(["AAPL"], now=NOW)
        assert got == [
            Quote(
                symbol="AAPL",
                price=208.58,
                as_of=pd.Timestamp(QUOTE_AT),
                provider="marketdata_app",
                quality="eod",
            )
        ]

    def test_the_request_is_a_bearer_get_on_the_quote_path(self):
        client, session, _ = make_client([FakeResponse(200, quote_body())])
        MarketDataApp(TOKEN, http=client).latest(["AAPL"], now=NOW)
        assert len(session.calls) == 1
        url, _, headers = session.calls[0]
        assert url == QUOTE_URL
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        assert headers["Accept"] == "application/json"
        assert TOKEN not in url

    def test_one_request_per_symbol(self):
        responses = [FakeResponse(200, quote_body("AAPL")), FakeResponse(200, quote_body("MSFT", last=411.2))]
        client, session, _ = make_client(responses)
        got = MarketDataApp(TOKEN, http=client).latest(["AAPL", "MSFT"], now=NOW)
        assert [url for url, _, _ in session.calls] == [QUOTE_URL, "https://api.marketdata.app/v1/stocks/quotes/MSFT/"]
        assert [q.symbol for q in got] == ["AAPL", "MSFT"]

    @pytest.mark.parametrize(
        "empty",
        [FakeResponse(200, {"s": "no_data"}), FakeResponse(404), FakeResponse(204)],
        ids=["no-data", "http-404", "http-204"],
    )
    def test_a_symbol_with_no_quote_is_left_out_not_an_error(self, empty):
        client, _, _ = make_client([empty, FakeResponse(200, quote_body())])
        got = MarketDataApp(TOKEN, http=client).latest(["MSFT", "AAPL"], now=NOW)
        assert [q.symbol for q in got] == ["AAPL"]

    def test_a_quote_with_no_last_price_is_left_out(self):
        responses = [FakeResponse(200, quote_body("MSFT", last=None)), FakeResponse(200, quote_body())]
        client, _, _ = make_client(responses)
        got = MarketDataApp(TOKEN, http=client).latest(["MSFT", "AAPL"], now=NOW)
        assert [q.symbol for q in got] == ["AAPL"]

    def test_a_cache_tier_answer_is_success(self):
        client, _, _ = make_client([FakeResponse(203, quote_body())])
        (got,) = MarketDataApp(TOKEN, http=client).latest(["AAPL"], now=NOW)
        assert got.price == 208.58

    @pytest.mark.parametrize("quality", ["delayed-15m", "realtime"])
    def test_the_quality_setting_is_stamped_through(self, quality):
        client, _, _ = make_client([FakeResponse(200, quote_body())])
        (got,) = MarketDataApp(TOKEN, http=client, quality=quality).latest(["AAPL"], now=NOW)
        assert got.quality == quality

    def test_an_unknown_quality_is_not_configured_without_a_request(self):
        client, session, _ = make_client([])
        with pytest.raises(NotConfigured, match="fast"):
            MarketDataApp(TOKEN, http=client, quality="fast").latest(["AAPL"], now=NOW)
        assert session.calls == []


class TestOptionChain:
    def test_maps_a_contract_from_its_occ_symbol_and_columns(self):
        client, _, _ = make_client([FakeResponse(200, chain_body(HAPPY_ROWS))])
        got = MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, min_dte=21, max_dte=45)
        assert got[0] == OptionContract(
            underlying="AAPL",
            symbol=C_290,
            right="C",
            expiry=date(2026, 11, 20),
            strike=290.0,
            dte=22,
            bid=4.1,
            ask=4.3,
            delta=0.34,
            iv=0.25,
            open_interest=2500,
            as_of=pd.Timestamp(QUOTE_AT),
            provider="marketdata_app",
            quality="eod",
        )
        assert [c.symbol for c in got] == [C_290, C_300, C_DEC]

    def test_the_request_carries_the_window_from_the_new_york_date(self):
        client, session, _ = make_client([FakeResponse(200, chain_body(HAPPY_ROWS))])
        MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, min_dte=21, max_dte=45)
        url, params, headers = session.calls[0]
        assert url == CHAIN_URL
        assert params == {"side": "call", "from": "2026-11-19", "to": "2026-12-13"}
        assert headers["Authorization"] == f"Bearer {TOKEN}"

    def test_contracts_come_back_by_expiry_then_strike(self):
        rows = [
            row("2026-12-04", "C", 290.0),
            row("2026-11-20", "C", 300.0),
            row("2026-11-06", "C", 285.0),  # a weekly, dte 8: inside the default window from 0
            row("2026-11-20", "C", 290.0),
        ]
        client, _, _ = make_client([FakeResponse(200, chain_body(rows))])
        got = MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, max_dte=45)
        assert [(c.expiry, c.strike) for c in got] == [
            (date(2026, 11, 6), 285.0),
            (date(2026, 11, 20), 290.0),
            (date(2026, 11, 20), 300.0),
            (date(2026, 12, 4), 290.0),
        ]

    def test_a_put_request_sends_side_put_and_keeps_only_puts(self):
        # The fake server returns a mixed chain for a put request: the adapter must drop the calls itself.
        rows = [row("2026-11-20", "C", 290.0), row("2026-11-20", "P", 280.0), row("2026-12-04", "P", 290.0)]
        client, session, _ = make_client([FakeResponse(200, chain_body(rows))])
        got = MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, right="P", max_dte=45)
        assert session.calls[0][1]["side"] == "put"
        assert [(c.right, c.expiry, c.strike) for c in got] == [
            ("P", date(2026, 11, 20), 280.0),
            ("P", date(2026, 12, 4), 290.0),
        ]

    def test_strike_bounds_narrow_the_result_client_side(self):
        rows = [row("2026-11-20", "C", 280.0), row("2026-11-20", "C", 290.0), row("2026-11-20", "C", 300.0)]
        client, session, _ = make_client([FakeResponse(200, chain_body(rows))])
        got = MarketDataApp(TOKEN, http=client).option_chain(
            "AAPL", now=NOW, max_dte=45, min_strike=285.0, max_strike=295.0
        )
        assert [c.strike for c in got] == [290.0]
        assert session.calls[0][1] == {"side": "call", "from": "2026-10-29", "to": "2026-12-13"}

    def test_the_expiry_window_is_applied_client_side_too(self):
        # A server that ignores `from` and `to` still cannot put a dte-8 weekly or a dte-78 January into 21..45.
        rows = [row("2026-11-06", "C", 285.0), row("2026-11-20", "C", 290.0), row("2027-01-15", "C", 290.0)]
        client, _, _ = make_client([FakeResponse(200, chain_body(rows))])
        got = MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, min_dte=21, max_dte=45)
        assert [(c.expiry, c.dte) for c in got] == [(date(2026, 11, 20), 22)]

    @pytest.mark.parametrize("quality", ["eod", "delayed-15m", "realtime"])
    def test_the_quality_setting_is_stamped_on_every_contract(self, quality):
        client, _, _ = make_client([FakeResponse(200, chain_body(HAPPY_ROWS))])
        got = MarketDataApp(TOKEN, http=client, quality=quality).option_chain("AAPL", now=NOW, min_dte=21, max_dte=45)
        assert len(got) == 3
        assert {c.quality for c in got} == {quality}


class TestEmptyAndLeftOut:
    @pytest.mark.parametrize(
        "empty",
        [FakeResponse(200, {"s": "no_data"}), FakeResponse(404)],
        ids=["no-data", "http-404"],
    )
    def test_an_empty_window_is_an_empty_list_not_no_data(self, empty):
        client, _, _ = make_client([empty])
        assert MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, max_dte=45) == []

    @pytest.mark.parametrize(
        "bad",
        [
            pytest.param(row("2026-11-20", "C", 290.0, bid=None), id="null-bid"),
            pytest.param(row("2026-11-20", "C", 290.0, ask=None), id="null-ask"),
            pytest.param(row("2026-11-20", "C", 290.0, ask=0.0), id="zero-ask"),
            pytest.param(row("2026-11-20", "C", 290.0, bid=2.0, ask=1.0), id="crossed"),
            pytest.param(row("2026-11-20", "C", 290.0, updated=None), id="null-updated"),
            pytest.param(
                {**row("2026-11-20", "C", 290.0), "optionSymbol": "AAPL1261120C00290000"},
                id="adjusted-root",
            ),
        ],
    )
    def test_a_contract_that_cannot_be_priced_or_is_nonstandard_is_left_out(self, bad):
        client, _, _ = make_client([FakeResponse(200, chain_body([bad, row("2026-11-20", "C", 300.0)]))])
        got = MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, max_dte=45)
        assert [c.symbol for c in got] == [C_300]

    def test_absent_model_columns_are_none_not_zero(self):
        body = chain_body([row("2026-11-20", "C", 290.0)])
        for column in ("iv", "delta", "openInterest"):
            del body[column]
        client, _, _ = make_client([FakeResponse(200, body)])
        (got,) = MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, max_dte=45)
        assert (got.iv, got.delta, got.open_interest) == (None, None, None)
        assert (got.bid, got.ask) == (4.1, 4.3)

    def test_a_null_entry_inside_a_column_is_none(self):
        rows = [row("2026-11-20", "C", 290.0, iv=None, open_interest=None)]
        client, _, _ = make_client([FakeResponse(200, chain_body(rows))])
        (got,) = MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, max_dte=45)
        assert (got.iv, got.open_interest, got.delta) == (None, None, 0.34)

    def test_a_column_that_does_not_match_the_option_symbols_is_unavailable(self):
        body = chain_body([row("2026-11-20", "C", 290.0), row("2026-11-20", "C", 300.0)])
        body["bid"] = body["bid"][:1]
        client, _, _ = make_client([FakeResponse(200, body)])
        with pytest.raises(Unavailable, match="bid"):
            MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, max_dte=45)


class TestNotConfigured:
    """No token, or an inverted window, fails before any request is sent."""

    def test_an_empty_token_is_not_configured_on_both_kinds_without_a_request(self):
        client, session, _ = make_client([])
        feed = MarketDataApp("", http=client)
        with pytest.raises(NotConfigured):
            feed.latest(["AAPL"], now=NOW)
        with pytest.raises(NotConfigured):
            feed.option_chain("AAPL", now=NOW, max_dte=45)
        assert session.calls == []

    def test_an_inverted_window_is_a_value_error_without_a_request(self):
        client, session, _ = make_client([])
        with pytest.raises(ValueError):
            MarketDataApp(TOKEN, http=client).option_chain("AAPL", now=NOW, min_dte=30, max_dte=21)
        assert session.calls == []


class TestRequestErrors:
    """HTTP and body failures map to the shared taxonomy: auth and plan to NotConfigured, a second device or a spent
    window to SoftBanned, everything else to Unavailable. A no-data answer is skipped by `latest`, not raised."""

    @pytest.mark.parametrize(("status", "match"), [(401, "HTTP 401"), (402, "plan")])
    def test_a_rejected_or_uncovered_token_is_not_configured(self, status, match):
        client, _, _ = make_client([FakeResponse(status)])
        with pytest.raises(NotConfigured, match=match):
            MarketDataApp(TOKEN, http=client).latest(["AAPL"], now=NOW)

    def test_a_second_device_403_latches_the_host_for_five_minutes(self):
        client, session, clock = make_client([FakeResponse(403), FakeResponse(200, quote_body())])
        feed = MarketDataApp(TOKEN, http=client)
        with pytest.raises(SoftBanned):
            feed.latest(["AAPL"], now=NOW)
        with pytest.raises(SoftBanned):  # the next call is refused before any request
            feed.latest(["AAPL"], now=NOW)
        assert len(session.calls) == 1
        clock.t += 299
        with pytest.raises(SoftBanned):
            feed.latest(["AAPL"], now=NOW)
        assert len(session.calls) == 1
        clock.t += 2  # now past the five minutes
        assert [q.symbol for q in feed.latest(["AAPL"], now=NOW)] == ["AAPL"]
        assert len(session.calls) == 2

    def test_a_429_is_soft_banned_until_retry_after_passes(self):
        client, session, clock = make_client(
            [FakeResponse(429, headers={"Retry-After": "120"}), FakeResponse(200, quote_body())]
        )
        feed = MarketDataApp(TOKEN, http=client)
        with pytest.raises(SoftBanned):
            feed.latest(["AAPL"], now=NOW)
        clock.t += 121
        assert [q.symbol for q in feed.latest(["AAPL"], now=NOW)] == ["AAPL"]
        assert len(session.calls) == 2

    def test_four_server_errors_are_unavailable_after_bounded_retries(self):
        client, session, _ = make_client([FakeResponse(500)] * 4)
        with pytest.raises(Unavailable, match="500"):
            MarketDataApp(TOKEN, http=client).latest(["AAPL"], now=NOW)
        assert len(session.calls) == 4

    def test_a_client_error_other_than_auth_is_unavailable(self):
        client, _, _ = make_client([FakeResponse(400)])
        with pytest.raises(Unavailable, match="HTTP 400"):
            MarketDataApp(TOKEN, http=client).latest(["AAPL"], now=NOW)

    def test_an_error_status_in_a_200_is_unavailable_with_its_message(self):
        client, _, _ = make_client([FakeResponse(200, {"s": "error", "errmsg": "bad"})])
        with pytest.raises(Unavailable, match="bad"):
            MarketDataApp(TOKEN, http=client).latest(["AAPL"], now=NOW)

    def test_a_non_json_body_is_unavailable(self):
        client, _, _ = make_client([FakeResponse(200, "not-json")])
        with pytest.raises(Unavailable):
            MarketDataApp(TOKEN, http=client).latest(["AAPL"], now=NOW)

    def test_a_json_list_body_is_unavailable(self):
        client, _, _ = make_client([FakeResponse(200, ["nope"])])
        with pytest.raises(Unavailable):
            MarketDataApp(TOKEN, http=client).latest(["AAPL"], now=NOW)


class TestThrottle:
    def test_single_symbol_requests_are_spaced_two_tenths_of_a_second_apart(self):
        client, session, clock = make_client([FakeResponse(200, quote_body())] * 3)
        feed = MarketDataApp(TOKEN, http=client)
        for _ in range(3):
            feed.latest(["AAPL"], now=NOW)
        assert len(session.calls) == 3
        assert clock.t == pytest.approx(0.4)


class TestRegistryEntry:
    def test_it_serves_the_quotes_and_option_chain_kinds(self):
        assert REGISTRY["marketdata_app"] is marketdata_app.PROVIDER
        assert REGISTRY["marketdata_app"].kinds == ("quotes", "option_chain")

    def test_the_build_reads_the_token_and_the_quality_setting(self):
        client, _, _ = make_client([])
        env = {"MARKETDATA_APP_TOKEN": "t", "MARKETDATA_APP_QUALITY": "delayed-15m"}
        adapter = marketdata_app.PROVIDER.build(env, client)
        assert isinstance(adapter, MarketDataApp)
        assert (adapter.token, adapter.quality) == ("t", "delayed-15m")

    def test_an_empty_environment_builds_with_no_token_and_the_eod_stamp(self):
        client, _, _ = make_client([])
        adapter = marketdata_app.PROVIDER.build({}, client)
        assert (adapter.token, adapter.quality) == ("", "eod")
