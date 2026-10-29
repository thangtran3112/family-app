"""Alpaca option chains against canned response bodies (never the live API). The bodies follow Alpaca's documented
shapes: market data `/v1beta1/options/snapshots/{underlying}` and trading `/v2/options/contracts`."""

import re
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from ai_trading_common.errors import NoData, NotConfigured, ProviderError, SoftBanned, Unavailable
from ai_trading_common.providers import alpaca_options
from ai_trading_common.providers.alpaca_options import MAX_PAGES, AlpacaOptionChain
from ai_trading_common.registry import REGISTRY
from ai_trading_common.testing import FakeResponse, make_client
from ai_trading_common.types import OptionContract

NOW = pd.Timestamp("2026-10-29T15:00:00Z")  # 11:00 in New York, Thursday 2026-10-29
QUOTE_AT = "2026-10-29T14:44:58.123456789Z"
KEY, SECRET = "key-id-sentinel", "secret-sentinel"
SNAPSHOT_URL = "https://data.alpaca.markets/v1beta1/options/snapshots/AAPL"
CONTRACTS_URL = "https://paper-api.alpaca.markets/v2/options/contracts"


def occ(root: str, expiry: str, right: str, strike: float) -> str:
    """An OCC contract symbol: root, YYMMDD, C or P, strike x 1000 in eight digits."""
    return f"{root}{expiry}{right}{round(strike * 1000):08d}"


def snap(bid, ask, *, delta=None, iv=None, at=QUOTE_AT):
    out = {"latestTrade": {"p": 1.0, "s": 1, "t": at}}
    if bid is not None or ask is not None:
        out["latestQuote"] = {"ap": ask, "as": 10, "ax": "C", "bp": bid, "bs": 10, "bx": "C", "c": "A", "t": at}
    if delta is not None:
        out["greeks"] = {"delta": delta, "gamma": 0.01, "rho": 0.1, "theta": -0.05, "vega": 0.2}
    if iv is not None:
        out["impliedVolatility"] = iv
    return out


def contract_row(symbol, open_interest):
    return {"symbol": symbol, "type": "call", "style": "american", "open_interest": open_interest}


C_290 = occ("AAPL", "261120", "C", 290)
C_300 = occ("AAPL", "261120", "C", 300)
C_DEC = occ("AAPL", "261204", "C", 290)


def chain_responses(snapshots=None, rows=None, *, snapshot_token=None):
    snapshots = snapshots if snapshots is not None else {C_300: snap(1.9, 2.0, delta=0.2, iv=0.24)}
    rows = rows if rows is not None else [contract_row(C_300, "1900")]
    return [
        FakeResponse(200, {"snapshots": snapshots, "next_page_token": snapshot_token}),
        FakeResponse(200, {"option_contracts": rows, "next_page_token": None}),
    ]


def fetch(responses, **kwargs):
    client, session, _ = make_client(responses)
    chain = AlpacaOptionChain(KEY, SECRET, http=client)
    kwargs.setdefault("max_dte", 45)
    return chain.option_chain("AAPL", now=NOW, **kwargs), session


class TestMapping:
    def test_maps_a_snapshot_and_its_open_interest_into_a_delayed_contract(self):
        got, _ = fetch(chain_responses({C_290: snap(4.1, 4.3, delta=0.34, iv=0.25)}, [contract_row(C_290, "2500")]))
        assert got == [
            OptionContract(
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
                provider="alpaca_options",
                quality="delayed-15m",
            )
        ]
        assert got[0].as_of.tzinfo is not None

    def test_contracts_come_back_by_expiry_then_strike(self):
        snapshots = {C_DEC: snap(5.6, 5.8), C_300: snap(1.9, 2.0), C_290: snap(4.1, 4.3)}
        got, _ = fetch(chain_responses(snapshots, []))
        assert [c.symbol for c in got] == [C_290, C_300, C_DEC]

    def test_missing_model_values_are_none_not_zero(self):
        got, _ = fetch(chain_responses({C_290: snap(4.1, 4.3)}, [contract_row(C_290, None)]))
        assert (got[0].delta, got[0].iv, got[0].open_interest) == (None, None, None)

    def test_a_contract_absent_from_the_contract_list_has_unknown_open_interest(self):
        got, _ = fetch(chain_responses({C_290: snap(4.1, 4.3)}, [contract_row(C_300, "10")]))
        assert got[0].open_interest is None

    def test_a_zero_bid_is_kept_for_the_engine_to_filter(self):
        got, _ = fetch(chain_responses({C_290: snap(0.0, 0.05)}, []))
        assert (got[0].bid, got[0].ask) == (0.0, 0.05)

    @pytest.mark.parametrize(
        "row",
        [
            pytest.param(snap(None, None), id="no-quote"),
            pytest.param(snap(1.0, 0.0), id="zero-ask"),
            pytest.param(snap(2.0, 1.0), id="crossed"),
            pytest.param(snap(-1.0, 1.0), id="negative-bid"),
            pytest.param({"latestQuote": {"bp": 1.0, "ap": 1.1}}, id="no-quote-time"),
        ],
    )
    def test_a_contract_that_cannot_be_priced_is_left_out(self, row):
        got, _ = fetch(chain_responses({C_290: row, C_300: snap(1.9, 2.0)}, []))
        assert [c.symbol for c in got] == [C_300]

    def test_an_adjusted_root_is_left_out(self):
        adjusted = occ("AAPL1", "261120", "C", 290)
        got, _ = fetch(chain_responses({adjusted: snap(4.1, 4.3), C_300: snap(1.9, 2.0)}, []))
        assert [c.symbol for c in got] == [C_300]

    def test_a_class_share_symbol_matches_its_dotless_root(self):
        brk = occ("BRKB", "261120", "C", 500)
        client, _, _ = make_client(chain_responses({brk: snap(9.0, 9.5)}, []))
        got = AlpacaOptionChain(KEY, SECRET, http=client).option_chain("BRK.B", now=NOW, max_dte=45)
        assert [c.symbol for c in got] == [brk]
        assert got[0].underlying == "BRK.B"

    def test_a_put_is_not_returned_for_a_call_request(self):
        put = occ("AAPL", "261120", "P", 270)
        got, _ = fetch(chain_responses({put: snap(1.0, 1.1), C_300: snap(1.9, 2.0)}, []))
        assert [c.symbol for c in got] == [C_300]

    def test_puts_are_returned_for_a_put_request(self):
        put = occ("AAPL", "261120", "P", 270)
        got, session = fetch(chain_responses({put: snap(1.0, 1.1)}, []), right="P")
        assert [(c.symbol, c.right) for c in got] == [(put, "P")]
        assert session.calls[0][1]["type"] == "put"

    def test_an_empty_window_is_an_empty_list_without_a_contract_request(self):
        client, session, _ = make_client([FakeResponse(200, {"snapshots": {}, "next_page_token": None})])
        got = AlpacaOptionChain(KEY, SECRET, http=client).option_chain("AAPL", now=NOW, max_dte=45)
        assert got == []
        assert len(session.calls) == 1


class TestRequests:
    def test_snapshots_and_contracts_carry_the_expiry_window_from_the_new_york_date(self):
        # 02:00 UTC on the 30th is still the 29th in New York
        client, session, _ = make_client(chain_responses())
        late = pd.Timestamp("2026-10-30T02:00:00Z")
        AlpacaOptionChain(KEY, SECRET, http=client).option_chain("AAPL", now=late, min_dte=21, max_dte=45)
        (snap_url, snap_params, _), (contracts_url, contracts_params, _) = session.calls
        assert snap_url == SNAPSHOT_URL
        assert contracts_url == CONTRACTS_URL
        for params in (snap_params, contracts_params):
            assert params["type"] == "call"
            assert params["expiration_date_gte"] == "2026-11-19"
            assert params["expiration_date_lte"] == "2026-12-13"
            assert "strike_price_gte" not in params
        assert snap_params["feed"] == "indicative"
        assert snap_params["limit"] == "1000"
        assert contracts_params["underlying_symbols"] == "AAPL"
        assert contracts_params["status"] == "active"

    def test_strike_bounds_narrow_both_requests(self):
        _, session = fetch(chain_responses(), min_strike=280.0, max_strike=320.5)
        for _, params, _ in session.calls:
            assert (params["strike_price_gte"], params["strike_price_lte"]) == ("280.0", "320.5")

    def test_the_key_goes_in_headers_only(self):
        _, session = fetch(chain_responses())
        for url, params, headers in session.calls:
            assert (headers["APCA-API-KEY-ID"], headers["APCA-API-SECRET-KEY"]) == (KEY, SECRET)
            assert KEY not in url and SECRET not in url
            assert KEY not in str(params) and SECRET not in str(params)

    def test_every_snapshot_page_is_followed(self):
        second = occ("AAPL", "261204", "C", 290)
        responses = [
            FakeResponse(200, {"snapshots": {C_290: snap(4.1, 4.3)}, "next_page_token": "p2"}),
            FakeResponse(200, {"snapshots": {second: snap(5.6, 5.8)}, "next_page_token": None}),
            FakeResponse(200, {"option_contracts": [], "next_page_token": None}),
        ]
        got, session = fetch(responses)
        assert [c.symbol for c in got] == [C_290, second]
        assert "page_token" not in session.calls[0][1]
        assert session.calls[1][1]["page_token"] == "p2"
        assert len(session.calls) == 3

    def test_every_contract_page_is_followed_for_open_interest(self):
        responses = [
            FakeResponse(200, {"snapshots": {C_290: snap(4.1, 4.3), C_300: snap(1.9, 2.0)}, "next_page_token": None}),
            FakeResponse(200, {"option_contracts": [contract_row(C_290, "7")], "next_page_token": "c2"}),
            FakeResponse(200, {"option_contracts": [contract_row(C_300, "9")], "next_page_token": None}),
        ]
        got, session = fetch(responses)
        assert [c.open_interest for c in got] == [7, 9]
        assert session.calls[2][1]["page_token"] == "c2"

    def test_a_chain_over_the_page_budget_is_an_error_not_a_short_chain(self):
        page = {"snapshots": {C_290: snap(4.1, 4.3)}, "next_page_token": "more"}
        client, session, _ = make_client([FakeResponse(200, page)] * (MAX_PAGES + 5))
        with pytest.raises(Unavailable, match="narrow"):
            AlpacaOptionChain(KEY, SECRET, http=client).option_chain("AAPL", now=NOW, max_dte=45)
        assert len(session.calls) == MAX_PAGES

    def test_an_invalid_window_is_a_value_error_without_a_request(self):
        client, session, _ = make_client([])
        chain = AlpacaOptionChain(KEY, SECRET, http=client)
        for kwargs in ({"min_dte": 10, "max_dte": 5}, {"min_dte": -1, "max_dte": 5}):
            with pytest.raises(ValueError):
                chain.option_chain("AAPL", now=NOW, **kwargs)
        assert session.calls == []


class TestFailures:
    """Every failure maps to the shared taxonomy, and none of them carries the key."""

    def failure(self, responses, *, key=KEY, secret=SECRET, feed="indicative"):
        client, session, _ = make_client(responses)
        chain = AlpacaOptionChain(key, secret, http=client, feed=feed)
        with pytest.raises(Exception) as caught:
            chain.option_chain("AAPL", now=NOW, max_dte=45)
        return caught.value, session

    def test_no_key_is_not_configured_without_a_request(self):
        error, session = self.failure([], key="", secret="")
        assert isinstance(error, NotConfigured)
        assert session.calls == []

    @pytest.mark.parametrize("status", [401, 403])
    def test_a_rejected_key_is_not_configured_and_names_the_feed(self, status):
        error, _ = self.failure([FakeResponse(status)], feed="opra")
        assert isinstance(error, NotConfigured)
        assert "opra" in str(error)

    def test_an_unknown_feed_is_not_configured_without_a_request(self):
        error, session = self.failure([], feed="sip")
        assert isinstance(error, NotConfigured)
        assert session.calls == []

    def test_an_unknown_underlying_is_no_data(self):
        error, _ = self.failure([FakeResponse(404)])
        assert isinstance(error, NoData)

    def test_a_server_error_is_unavailable_after_bounded_retries(self):
        error, session = self.failure([FakeResponse(500)] * 10)
        assert isinstance(error, Unavailable)
        assert len(session.calls) == 4  # the http layer's default retry bound

    def test_a_malformed_body_is_unavailable(self):
        error, _ = self.failure([FakeResponse(200, "not-json")])
        assert isinstance(error, Unavailable)

    def test_a_body_that_is_not_an_object_is_unavailable(self):
        error, _ = self.failure([FakeResponse(200, ["nope"])])
        assert isinstance(error, Unavailable)

    def test_a_failing_contract_request_fails_the_chain(self):
        error, _ = self.failure([chain_responses()[0], FakeResponse(500)] + [FakeResponse(500)] * 10)
        assert isinstance(error, Unavailable)

    def test_a_429_latches_the_host_and_the_next_call_sends_nothing(self):
        client, session, _ = make_client([FakeResponse(429, headers={"Retry-After": "30"})])
        chain = AlpacaOptionChain(KEY, SECRET, http=client)
        with pytest.raises(SoftBanned):
            chain.option_chain("AAPL", now=NOW, max_dte=45)
        with pytest.raises(SoftBanned):
            chain.option_chain("AAPL", now=NOW, max_dte=45)
        assert len(session.calls) == 1

    def test_no_failure_message_carries_the_key(self):
        cases = [
            [FakeResponse(401)],
            [FakeResponse(404)],
            [FakeResponse(500)] * 10,
            [FakeResponse(429)],
            [FakeResponse(200, "not-json")],
            [chain_responses({C_290: snap(1, 2, at="garbage")}, [])[0], chain_responses()[1]],
        ]
        for responses in cases:
            error, _ = self.failure(responses)
            assert isinstance(error, ProviderError), responses  # a mapped failure, not a test-double slip
            assert KEY not in str(error) and SECRET not in str(error), responses

    def test_a_malformed_quote_time_is_a_provider_error(self):
        error, _ = self.failure(chain_responses({C_290: snap(1, 2, at="garbage")}, []))
        assert type(error) is ProviderError


class TestRegistryEntry:
    def test_it_serves_only_the_option_chain_kind(self):
        assert REGISTRY["alpaca_options"].kinds == ("option_chain",)

    def test_the_build_reads_the_shared_alpaca_keys_and_defaults_to_the_indicative_feed(self):
        client, _, _ = make_client([])
        adapter = REGISTRY["alpaca_options"].build({"ALPACA_API_KEY_ID": KEY, "ALPACA_API_SECRET_KEY": SECRET}, client)
        assert (adapter.key_id, adapter.secret, adapter.feed) == (KEY, SECRET, "indicative")

    def test_the_feed_can_move_to_opra_when_the_paid_tier_is_bought(self):
        client, _, _ = make_client([])
        env = {"ALPACA_API_KEY_ID": KEY, "ALPACA_API_SECRET_KEY": SECRET, "ALPACA_OPTIONS_FEED": "opra"}
        assert REGISTRY["alpaca_options"].build(env, client).feed == "opra"

    def test_a_missing_key_is_a_call_time_error_not_a_build_error(self):
        client, session, _ = make_client([])
        adapter = REGISTRY["alpaca_options"].build({}, client)
        with pytest.raises(NotConfigured):
            adapter.option_chain("AAPL", now=NOW, max_dte=45)
        assert session.calls == []

    def test_the_quality_stamp_is_delayed_whatever_the_feed(self):
        assert alpaca_options.QUALITY == "delayed-15m"
        for feed in alpaca_options.FEEDS:
            client, _, _ = make_client(chain_responses())
            got = AlpacaOptionChain(KEY, SECRET, http=client, feed=feed).option_chain("AAPL", now=NOW, max_dte=45)
            assert {c.quality for c in got} == {"delayed-15m"}


SOURCE = Path(alpaca_options.__file__)


class TestReadOnlyAndNoSecrets:
    """Static checks on the client's source: it reads, and it holds no credential."""

    def test_the_client_only_reads(self):
        text = SOURCE.read_text()
        assert text.count("self._http.get(") == 1
        for forbidden in (".post(", ".put(", ".patch(", ".delete(", "/v2/orders", "/v2/positions", "/v2/account"):
            assert forbidden not in text, forbidden

    def test_every_request_the_client_makes_is_a_get_on_a_read_path(self):
        _, session = fetch(chain_responses())
        for url, _, _ in session.calls:
            assert url in (SNAPSHOT_URL, CONTRACTS_URL)

    def test_no_credential_shaped_literal_is_in_the_client_or_its_tests(self):
        # Alpaca key ids are `PK`/`AK` plus 18 characters; secrets are 40 characters of base64.
        key_id = re.compile(r"\b(?:PK|AK)[A-Z0-9]{18}\b")
        secret = re.compile(r"""["'][A-Za-z0-9/+]{40}["']""")
        for path in (SOURCE, Path(__file__), SOURCE.parent.parent / "testing.py"):
            text = path.read_text()
            assert not key_id.search(text), path.name
            assert not secret.search(text), path.name

    def test_no_result_repr_carries_the_key(self):
        got, _ = fetch(chain_responses())
        assert KEY not in repr(got) and SECRET not in repr(got)
