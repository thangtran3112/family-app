"""Tradier quotes and option chains against canned response bodies (never the live API). The bodies follow Tradier's
documented shapes: `/v1/markets/quotes`, `/v1/markets/options/expirations`, and `/v1/markets/options/chains`."""

from datetime import date, timedelta

import pandas as pd
import pytest

from ai_trading_common.errors import NotConfigured, ProviderError, SoftBanned, Unavailable
from ai_trading_common.http import DEFAULT_COOLDOWN_S
from ai_trading_common.providers import tradier
from ai_trading_common.providers.tradier import MAX_EXPIRATIONS, Tradier
from ai_trading_common.registry import REGISTRY
from ai_trading_common.testing import FakeResponse, make_client
from ai_trading_common.types import OptionContract, Quote

NOW = pd.Timestamp("2026-10-29T15:00:00Z")  # 11:00 in New York, Thursday 2026-10-29
TOKEN = "token-sentinel"
QUOTE_AT = "2026-10-29T14:44:00Z"  # the trade time, and the ask time, of the canned option rows
BID_AT = "2026-10-29T14:40:00Z"  # an earlier bid time, so `as_of` has to pick the newer of the two
NOV_6, NOV_20, DEC_4, JAN_15 = date(2026, 11, 6), date(2026, 11, 20), date(2026, 12, 4), date(2027, 1, 15)
QUOTES_URL = "https://api.tradier.com/v1/markets/quotes"
SANDBOX_QUOTES_URL = "https://sandbox.tradier.com/v1/markets/quotes"
EXPIRATIONS_URL = "https://api.tradier.com/v1/markets/options/expirations"
CHAINS_URL = "https://api.tradier.com/v1/markets/options/chains"
GREEKS = {
    "delta": 0.34,
    "gamma": 0.01,
    "theta": -0.05,
    "vega": 0.2,
    "rho": 0.1,
    "phi": 0.0,
    "bid_iv": 0.24,
    "mid_iv": 0.25,
    "ask_iv": 0.26,
    "smv_vol": 0.25,
    "updated_at": "2026-10-29 10:15:07",
}
QUOTA_VIOLATION = {
    "fault": {
        "faultstring": "Rate limit quota violation. Quota Limit exceeded.",
        "detail": {"errorcode": "policies.ratelimit.QuotaViolation"},
    }
}
CALLS = {
    "latest": lambda adapter: adapter.latest(["AAPL"], now=NOW),
    "option_chain": lambda adapter: adapter.option_chain("AAPL", now=NOW, max_dte=45),
}


def ms(iso):
    """Epoch milliseconds of a UTC instant, as Tradier stamps its times."""
    return int(pd.Timestamp(iso).timestamp() * 1000)


def quote_row(symbol, last, traded=QUOTE_AT):
    """One quote in Tradier's shape, with its three times set to `traded`."""
    stamp = ms(traded)
    return {
        "symbol": symbol,
        "description": f"{symbol} Inc",
        "type": "stock",
        "last": last,
        "bid": last,
        "ask": last,
        "volume": 23133570,
        "trade_date": stamp,
        "bid_date": stamp,
        "ask_date": stamp,
    }


def option_row(expiry, strike, right="C", *, root="AAPL", **changes):
    """One chain row in Tradier's shape, with greeks. `changes` overrides any field, e.g. `ask=0.0`."""
    row = {
        "symbol": f"{root}{expiry:%y%m%d}{right}{round(strike * 1000):08d}",
        "type": "option",
        "bid": 4.1,
        "ask": 4.3,
        "underlying": root,
        "strike": strike,
        "bid_date": ms(BID_AT),
        "ask_date": ms(QUOTE_AT),
        "open_interest": 2500,
        "expiration_date": expiry.isoformat(),
        "expiration_type": "standard",
        "option_type": "call" if right == "C" else "put",
        "root_symbol": root,
        "greeks": GREEKS,
    }
    return {**row, **changes}


def expirations(*dates):
    """The expirations body for `dates`. Tradier sends a single date as a bare string; a test writes that inline."""
    return {"expirations": {"date": [d.isoformat() for d in dates]}}


def chain(rows):
    return {"options": {"option": list(rows)}}


def weekly(count):
    """`count` consecutive Fridays from 2026-10-30; with `max_dte=90` from NOW, all of them are in the window."""
    return [date(2026, 10, 30) + timedelta(weeks=k) for k in range(count)]


def run(responses, **kwargs):
    """`option_chain` for AAPL over canned responses: the expirations body, then one chain body per expiry."""
    client, session, _ = make_client(responses)
    kwargs.setdefault("max_dte", 45)
    return Tradier(TOKEN, http=client).option_chain("AAPL", now=NOW, **kwargs), session


def fetch(rows, **kwargs):
    """`run` for a single expiry (NOV_20) whose chain lists `rows`."""
    return run([FakeResponse(200, expirations(NOV_20)), FakeResponse(200, chain(rows))], **kwargs)


class TestQuotes:
    def test_the_last_trade_of_each_symbol_is_a_realtime_quote_on_production(self):
        body = {
            "quotes": {
                "quote": [quote_row("AAPL", 208.58), quote_row("MSFT", 512.3, "2026-10-29T14:43:12Z")],
            }
        }
        client, session, _ = make_client([FakeResponse(200, body)])
        got = Tradier(TOKEN, http=client).latest(["AAPL", "MSFT"], now=NOW)
        assert got == [
            Quote(symbol="AAPL", price=208.58, as_of=pd.Timestamp(QUOTE_AT), provider="tradier", quality="realtime"),
            Quote(
                symbol="MSFT",
                price=512.3,
                as_of=pd.Timestamp("2026-10-29T14:43:12Z"),
                provider="tradier",
                quality="realtime",
            ),
        ]
        assert len(session.calls) == 1  # one request for the whole list
        url, params, headers = session.calls[0]
        assert url == QUOTES_URL
        assert params == {"symbols": "AAPL,MSFT"}
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        assert headers["Accept"] == "application/json"
        assert TOKEN not in url and TOKEN not in str(params)

    def test_a_single_symbol_comes_back_as_a_bare_object(self):
        client, _, _ = make_client([FakeResponse(200, {"quotes": {"quote": quote_row("AAPL", 208.58)}})])
        got = Tradier(TOKEN, http=client).latest(["AAPL"], now=NOW)
        assert got == [
            Quote(symbol="AAPL", price=208.58, as_of=pd.Timestamp(QUOTE_AT), provider="tradier", quality="realtime")
        ]

    def test_an_unmatched_symbol_beside_a_match_is_left_out_not_raised(self):
        body = {"quotes": {"quote": quote_row("AAPL", 208.58), "unmatched_symbols": {"symbol": "ZZZZ"}}}
        client, _, _ = make_client([FakeResponse(200, body)])
        got = Tradier(TOKEN, http=client).latest(["AAPL", "ZZZZ"], now=NOW)
        assert [q.symbol for q in got] == ["AAPL"]

    def test_a_request_that_matches_nothing_is_an_empty_list(self):
        client, _, _ = make_client([FakeResponse(200, {"quotes": {"unmatched_symbols": {"symbol": "ZZZZ"}}})])
        assert Tradier(TOKEN, http=client).latest(["ZZZZ"], now=NOW) == []

    def test_a_symbol_with_no_last_trade_is_left_out(self):
        body = {"quotes": {"quote": [quote_row("AAPL", None), quote_row("MSFT", 512.3)]}}
        client, _, _ = make_client([FakeResponse(200, body)])
        got = Tradier(TOKEN, http=client).latest(["AAPL", "MSFT"], now=NOW)
        assert [q.symbol for q in got] == ["MSFT"]

    def test_an_empty_symbol_list_is_an_empty_list_without_a_request(self):
        client, session, _ = make_client([])
        assert Tradier(TOKEN, http=client).latest([], now=NOW) == []
        assert session.calls == []

    def test_sandbox_quotes_come_from_the_sandbox_host_and_are_delayed(self):
        client, session, _ = make_client([FakeResponse(200, {"quotes": {"quote": quote_row("AAPL", 208.58)}})])
        got = Tradier(TOKEN, http=client, environment="sandbox").latest(["AAPL"], now=NOW)
        assert [q.quality for q in got] == ["delayed-15m"]
        assert session.calls[0][0] == SANDBOX_QUOTES_URL


class TestOptionChain:
    def test_only_the_expiries_inside_the_window_are_requested(self):
        responses = [
            FakeResponse(200, expirations(NOV_6, NOV_20, DEC_4, JAN_15)),  # dte 8, 22, 36, 78
            FakeResponse(200, chain([option_row(NOV_20, 290.0)])),
            FakeResponse(200, chain([option_row(DEC_4, 290.0)])),
        ]
        got, session = run(responses, min_dte=21, max_dte=45)
        assert [(url, params) for url, params, _ in session.calls] == [
            (EXPIRATIONS_URL, {"symbol": "AAPL"}),
            (CHAINS_URL, {"symbol": "AAPL", "expiration": "2026-11-20", "greeks": "true"}),
            (CHAINS_URL, {"symbol": "AAPL", "expiration": "2026-12-04", "greeks": "true"}),
        ]
        assert [c.dte for c in got] == [22, 36]

    def test_a_contract_maps_to_the_full_record(self):
        got, _ = fetch([option_row(NOV_20, 290.0)], min_dte=21, max_dte=45)
        assert got == [
            OptionContract(
                underlying="AAPL",
                symbol="AAPL261120C00290000",
                right="C",
                expiry=NOV_20,
                strike=290.0,
                dte=22,
                bid=4.1,
                ask=4.3,
                delta=0.34,
                iv=0.25,
                open_interest=2500,
                as_of=pd.Timestamp(QUOTE_AT),
                provider="tradier",
                quality="delayed-15m",
            )
        ]

    @pytest.mark.parametrize(
        ("bid_at", "ask_at"),
        [
            pytest.param(BID_AT, QUOTE_AT, id="ask-newer"),
            pytest.param(QUOTE_AT, BID_AT, id="bid-newer"),
        ],
    )
    def test_as_of_is_the_newer_of_the_bid_and_ask_times(self, bid_at, ask_at):
        got, _ = fetch([option_row(NOV_20, 290.0, bid_date=ms(bid_at), ask_date=ms(ask_at))])
        assert got[0].as_of == pd.Timestamp(QUOTE_AT)

    def test_contracts_come_back_by_expiry_then_strike(self):
        responses = [
            FakeResponse(200, expirations(NOV_20, DEC_4)),
            FakeResponse(200, chain([option_row(NOV_20, 300.0), option_row(NOV_20, 290.0)])),
            FakeResponse(200, chain([option_row(DEC_4, 290.0), option_row(DEC_4, 270.0)])),
        ]
        got, _ = run(responses)
        assert [(c.expiry, c.strike) for c in got] == [
            (NOV_20, 290.0),
            (NOV_20, 300.0),
            (DEC_4, 270.0),
            (DEC_4, 290.0),
        ]

    def test_a_put_request_returns_only_puts(self):
        got, _ = fetch([option_row(NOV_20, 290.0), option_row(NOV_20, 270.0, "P")], right="P")
        assert [(c.symbol, c.right) for c in got] == [("AAPL261120P00270000", "P")]

    def test_strike_bounds_are_inclusive_and_applied_here_not_by_the_endpoint(self):
        rows = [option_row(NOV_20, strike) for strike in (270.0, 290.0, 300.0, 310.0)]
        got, session = fetch(rows, min_strike=290.0, max_strike=300.0)
        assert [c.strike for c in got] == [290.0, 300.0]
        assert session.calls[1][1] == {"symbol": "AAPL", "expiration": "2026-11-20", "greeks": "true"}

    def test_a_single_expiry_and_a_single_option_arrive_as_bare_values(self):
        responses = [
            FakeResponse(200, {"expirations": {"date": "2026-11-20"}}),
            FakeResponse(200, {"options": {"option": option_row(NOV_20, 290.0)}}),
        ]
        got, session = run(responses)
        assert [c.symbol for c in got] == ["AAPL261120C00290000"]
        assert len(session.calls) == 2

    def test_a_chain_with_no_options_is_an_empty_list(self):
        got, _ = run([FakeResponse(200, expirations(NOV_20)), FakeResponse(200, {"options": None})])
        assert got == []

    def test_no_expirations_is_an_empty_list_with_no_chain_request(self):
        got, session = run([FakeResponse(200, {"expirations": None})])
        assert got == []
        assert len(session.calls) == 1


class TestRows:
    """Which rows survive a chain, and which model values read as None rather than zero."""

    @pytest.mark.parametrize(
        "changes",
        [
            pytest.param({"bid": None, "ask": None}, id="no-quote"),
            pytest.param({"ask": 0.0}, id="zero-ask"),
            pytest.param({"bid": 4.3, "ask": 4.1}, id="crossed"),
            pytest.param({"bid_date": None, "ask_date": None}, id="no-quote-time"),
            pytest.param({"bid_date": 0, "ask_date": 0}, id="zero-quote-time"),
        ],
    )
    def test_a_row_that_cannot_be_priced_is_left_out(self, changes):
        got, _ = fetch([option_row(NOV_20, 290.0, **changes), option_row(NOV_20, 300.0)])
        assert [c.strike for c in got] == [300.0]

    def test_an_adjusted_root_is_left_out(self):
        got, _ = fetch([option_row(NOV_20, 290.0, root="AAPL1"), option_row(NOV_20, 300.0)])
        assert [c.strike for c in got] == [300.0]

    def test_a_class_share_symbol_matches_its_dotless_root(self):
        responses = [
            FakeResponse(200, expirations(NOV_20)),
            FakeResponse(200, chain([option_row(NOV_20, 500.0, root="BRKB")])),
        ]
        client, session, _ = make_client(responses)
        got = Tradier(TOKEN, http=client).option_chain("BRK.B", now=NOW, max_dte=45)
        assert [(c.underlying, c.symbol) for c in got] == [("BRK.B", "BRKB261120C00500000")]
        assert session.calls[0][1] == {"symbol": "BRK.B"}

    def test_missing_greeks_give_no_delta_and_no_iv(self):
        bare = option_row(NOV_20, 290.0)
        del bare["greeks"]
        got, _ = fetch([bare, option_row(NOV_20, 300.0, greeks=None)])
        assert [(c.delta, c.iv) for c in got] == [(None, None), (None, None)]

    def test_a_zero_mid_iv_is_no_iv_and_keeps_the_delta(self):
        got, _ = fetch([option_row(NOV_20, 290.0, greeks={**GREEKS, "mid_iv": 0.0})])
        assert (got[0].iv, got[0].delta) == (None, 0.34)

    def test_a_missing_open_interest_is_none(self):
        row = option_row(NOV_20, 290.0)
        del row["open_interest"]
        got, _ = fetch([row])
        assert got[0].open_interest is None


class TestGuards:
    @pytest.mark.parametrize(("min_dte", "max_dte"), [(30, 10), (-1, 5)], ids=["min-above-max", "negative-min"])
    def test_an_invalid_window_is_a_value_error_without_a_request(self, min_dte, max_dte):
        client, session, _ = make_client([])
        with pytest.raises(ValueError):
            Tradier(TOKEN, http=client).option_chain("AAPL", now=NOW, min_dte=min_dte, max_dte=max_dte)
        assert session.calls == []

    def test_more_expiries_than_the_cap_is_unavailable_not_a_short_chain(self):
        client, session, _ = make_client([FakeResponse(200, expirations(*weekly(MAX_EXPIRATIONS + 1)))])
        with pytest.raises(Unavailable, match="narrow"):
            Tradier(TOKEN, http=client).option_chain("AAPL", now=NOW, max_dte=90)
        assert len(session.calls) == 1  # the expirations request only; no chain is fetched

    def test_exactly_the_cap_is_served(self):
        responses = [FakeResponse(200, expirations(*weekly(MAX_EXPIRATIONS)))]
        responses += [FakeResponse(200, {"options": None})] * MAX_EXPIRATIONS
        client, session, _ = make_client(responses)
        got = Tradier(TOKEN, http=client).option_chain("AAPL", now=NOW, max_dte=90)
        assert got == []
        assert len(session.calls) == MAX_EXPIRATIONS + 1


class TestNotConfigured:
    """A missing token or an unknown environment is NotConfigured when called, before any request is sent."""

    @pytest.mark.parametrize("call", list(CALLS.values()), ids=list(CALLS))
    @pytest.mark.parametrize(
        ("token", "environment"),
        [("", "production"), (TOKEN, "staging")],
        ids=["no-token", "unknown-environment"],
    )
    def test_it_is_not_configured_without_a_request(self, call, token, environment):
        client, session, _ = make_client([])
        with pytest.raises(NotConfigured):
            call(Tradier(token, http=client, environment=environment))
        assert session.calls == []


class TestFailures:
    """Every failure maps to the shared taxonomy, through `_get`, the one path every request takes."""

    def failure(self, responses):
        client, session, _ = make_client(responses)
        with pytest.raises(ProviderError) as caught:
            Tradier(TOKEN, http=client).latest(["AAPL"], now=NOW)
        return caught.value, session

    @pytest.mark.parametrize("status", [401, 403])
    def test_a_rejected_token_is_not_configured_and_names_the_environment(self, status):
        error, _ = self.failure([FakeResponse(status)])
        assert isinstance(error, NotConfigured)
        assert "production" in str(error)
        assert TOKEN not in str(error)

    def test_a_quota_violation_is_soft_banned_and_latches_the_host(self):
        client, session, clock = make_client(
            [
                FakeResponse(400, QUOTA_VIOLATION),
                FakeResponse(200, {"quotes": {"quote": quote_row("AAPL", 208.58)}}),
            ]
        )
        adapter = Tradier(TOKEN, http=client)
        with pytest.raises(SoftBanned):
            adapter.latest(["AAPL"], now=NOW)
        sent = len(session.calls)
        with pytest.raises(SoftBanned):  # latched: fails before any request is sent
            adapter.latest(["AAPL"], now=NOW)
        assert len(session.calls) == sent
        clock.t += DEFAULT_COOLDOWN_S + 1  # past the cooldown, the next call goes out again
        assert [q.symbol for q in adapter.latest(["AAPL"], now=NOW)] == ["AAPL"]
        assert len(session.calls) == sent + 1

    def test_any_other_400_is_unavailable(self):
        error, _ = self.failure([FakeResponse(400, {"fault": {"faultstring": "Invalid symbol"}})])
        assert type(error) is Unavailable  # not SoftBanned, which is a subclass

    def test_a_429_is_soft_banned(self):
        error, _ = self.failure([FakeResponse(429)])
        assert isinstance(error, SoftBanned)

    def test_four_server_errors_are_unavailable_after_the_http_retries(self):
        error, session = self.failure([FakeResponse(500)] * 4)
        assert type(error) is Unavailable
        assert len(session.calls) == 4  # the first try and the http layer's three retries

    def test_a_body_that_is_not_json_is_unavailable(self):
        error, _ = self.failure([FakeResponse(200, "not-json")])
        assert type(error) is Unavailable

    def test_a_json_list_instead_of_an_object_is_unavailable(self):
        error, _ = self.failure([FakeResponse(200, ["nope"])])
        assert type(error) is Unavailable


class TestThrottle:
    def test_three_requests_in_one_chain_call_are_spaced_half_a_second_apart(self):
        responses = [FakeResponse(200, expirations(NOV_20, DEC_4))] + [FakeResponse(200, chain([]))] * 2
        client, session, clock = make_client(responses)
        Tradier(TOKEN, http=client).option_chain("AAPL", now=NOW, max_dte=45)
        assert len(session.calls) == 3
        # the first request goes at once; each of the next two waits the 0.5 s minimum interval
        assert clock.t == 1.0


class TestRegistryEntry:
    def test_it_serves_quotes_and_option_chains(self):
        assert REGISTRY["tradier"] is tradier.PROVIDER
        assert REGISTRY["tradier"].kinds == ("quotes", "option_chain")

    def test_the_build_reads_the_token_and_the_environment(self):
        client, _, _ = make_client([])
        adapter = tradier.PROVIDER.build({"TRADIER_ACCESS_TOKEN": "t", "TRADIER_ENVIRONMENT": "sandbox"}, client)
        assert isinstance(adapter, Tradier)
        assert (adapter.token, adapter.environment) == ("t", "sandbox")

    def test_a_build_with_no_settings_is_production_with_no_token(self):
        client, _, _ = make_client([])
        adapter = tradier.PROVIDER.build({}, client)
        assert (adapter.token, adapter.environment) == ("", "production")
