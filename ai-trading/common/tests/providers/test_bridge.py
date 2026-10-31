"""`providers/bridge.py` against canned Connect unary-JSON bodies (never a live bridge).

The bodies follow the bridge's own contract goldens (`testdata/contract/*.json`): lowerCamelCase
fields, proto enum names, int64 as strings. A test never reads that directory -- the shapes are
copied here, so the suite does not depend on where the Go service sits in the tree.
"""

import pandas as pd
import requests

from ai_trading_common.errors import NoData, NotConfigured, ProviderError, SoftBanned, Unavailable
from ai_trading_common.providers import bridge
from ai_trading_common.providers.bridge import BridgeClient
from ai_trading_common.registry import REGISTRY, DataSources
from ai_trading_common.sources import BridgeSource
from ai_trading_common.testing import FakeResponse, make_client
from ai_trading_common.types import GatewayStatus, Quote, Routing

URL = "http://market-data-bridge:8080"
TOKEN = "read-token-sentinel"
ADMIN = "admin-token-sentinel"
NOW = pd.Timestamp("2026-10-30T14:30:00Z")

QUOTES = {
    "quotes": [
        {
            "asOf": "2024-05-02T20:30:00Z",
            "ask": 190.01,
            "bid": 189.99,
            "last": 190.0,
            "provider": "alpaca",
            "quality": "DELAYED_15M",
            "symbol": "AAPL",
        }
    ],
    "served": {"provider": "alpaca", "quality": "DELAYED_15M"},
}

BARS = {
    "symbol": "AAPL",
    "bars": [
        {
            "start": "2026-10-29T04:00:00Z",
            "open": 188.0,
            "high": 191.0,
            "low": 187.5,
            "close": 190.0,
            "volume": "1000",
        }
    ],
    "served": {"provider": "alpaca", "quality": "EOD"},
}

PROVIDERS = {
    "providers": [
        {
            "classes": ["EQUITY_QUOTES", "EQUITY_BARS"],
            "configured": True,
            "counters": {"requests": "4", "p95Ms": 42},
            "lastOk": "2024-05-02T20:30:00Z",
            "provider": "alpaca",
            "quality": "DELAYED_15M",
            "state": "HEALTH_STATE_OK",
        },
        {
            "classes": ["EQUITY_QUOTES"],
            "configured": False,
            "provider": "ibkr",
            "reason": "gateway_down",
            "state": "HEALTH_STATE_NOT_CONFIGURED",
        },
    ]
}

ROUTING = {
    "classes": [
        {"dataClass": "EQUITY_QUOTES", "ladder": ["alpaca"], "preferred": "", "serving": "alpaca"},
    ],
    "source": "DESK",
    "version": "3",
}


def client(*bodies, token=TOKEN, admin=ADMIN):
    """A `BridgeClient` over a fake session that answers `bodies` in order."""
    http, session, _ = make_client([FakeResponse(200, body) if isinstance(body, dict) else body for body in bodies])
    return BridgeClient(URL, token, admin, http=http), session


def test_enabled_only_once_the_url_is_set():
    assert bridge.enabled({"MARKET_DATA_BRIDGE_URL": URL}) is True
    assert bridge.enabled({"MARKET_DATA_BRIDGE_TOKEN": TOKEN}) is False


def test_from_env_leaves_the_bridge_out_of_every_chain_but_builds_it():
    sources = DataSources.from_env({"MARKET_DATA_BRIDGE_URL": URL, "MARKET_DATA_BRIDGE_TOKEN": TOKEN})
    assert isinstance(sources.bridge, BridgeSource)
    names = [getattr(provider, "url", None) for provider in sources.quotes.providers]
    assert URL not in names  # B2: shadowed, never in a chain
    assert [p.__class__.__name__ for p in sources.quotes.providers] == ["AlpacaBars"]


def test_from_env_without_a_url_has_no_bridge_and_alpaca_stays_primary():
    sources = DataSources.from_env({})
    assert sources.bridge is None
    assert len(sources.quotes.providers) == 1


def test_registry_builds_one_bridge_instance_and_serves_quotes_bars_and_options():
    assert REGISTRY["bridge"].kinds == ("quotes", "bars", "option_chain")
    http, _, _ = make_client([])
    assert isinstance(REGISTRY["bridge"].build({"MARKET_DATA_BRIDGE_URL": URL}, http), BridgeClient)


def test_get_quotes_is_a_connect_post_with_the_bearer_token():
    client_, session = client(QUOTES)
    quotes = client_.latest(["AAPL"], now=NOW)
    url, body, headers = session.posts[0]
    assert url == f"{URL}/familyapp.marketdata.v1.MarketData/GetQuotes"
    assert body == {"symbols": ["AAPL"]}
    assert headers["Authorization"] == f"Bearer {TOKEN}"
    assert quotes == [
        Quote(
            symbol="AAPL",
            price=190.0,
            as_of=pd.Timestamp("2024-05-02T20:30:00Z"),
            provider="alpaca",
            quality="delayed-15m",
        )
    ]


def test_the_pin_is_sent_only_when_the_shadow_job_asks_for_one():
    client_, session = client(QUOTES)
    client_.pinned_quotes(["AAPL"], now=NOW, provider="alpaca")
    assert session.posts[0][1] == {"symbols": ["AAPL"], "pinProvider": "alpaca"}


def test_an_empty_quote_list_is_no_data_not_an_empty_answer():
    client_, _ = client({"quotes": [], "served": {"provider": "alpaca", "quality": "DELAYED_15M"}})
    try:
        client_.latest(["ZZZZ"], now=NOW)
    except NoData:
        pass
    else:  # pragma: no cover - the assertion below is the test
        raise AssertionError("expected NoData")


def test_bars_keep_the_shared_frame_shape_and_the_serving_vendors_label():
    client_, session = client(BARS)
    bars = client_.bars(
        "AAPL", "1d", pd.Timestamp("2026-10-29T00:00:00Z"), pd.Timestamp("2026-10-30T00:00:00Z"), now=NOW
    )
    sent = session.posts[0][1]
    assert {key: sent[key] for key in ("symbol", "timeframe", "adjustment")} == {
        "symbol": "AAPL",
        "timeframe": "DAY_1",
        "adjustment": "ALL",
    }
    assert pd.Timestamp(sent["start"]) == pd.Timestamp("2026-10-29T00:00:00Z")
    assert pd.Timestamp(sent["end"]) == pd.Timestamp("2026-10-30T00:00:00Z")
    assert bars.source == "alpaca" and bars.quality == "eod"
    assert list(bars.frame.columns) == ["open", "high", "low", "close", "volume"]
    assert bars.frame.index[0].isoformat() == "2026-10-29"


def test_a_minute_bar_frame_is_a_utc_datetime_index():
    body = {
        "symbol": "AAPL",
        "bars": [{"start": "2026-10-29T14:31:00Z", "open": 1, "high": 1, "low": 1, "close": 1, "volume": "5"}],
        "served": {"provider": "alpaca", "quality": "DELAYED_15M"},
    }
    client_, _ = client(body)
    bars = client_.bars("AAPL", "1m", NOW, NOW, now=NOW)
    assert isinstance(bars.frame.index, pd.DatetimeIndex) and str(bars.frame.index.tz) == "UTC"


def test_connect_codes_map_onto_the_shared_taxonomy():
    cases = [
        (401, {"code": "unauthenticated", "message": "no"}, NotConfigured),
        (404, {"code": "not_found", "message": "no"}, NoData),
        (400, {"code": "invalid_argument", "message": "no"}, ProviderError),
        (400, {"code": "resource_exhausted", "message": "no"}, SoftBanned),
        (400, {"code": "unimplemented", "message": "no"}, NotConfigured),
        (400, {"code": "failed_precondition", "message": "no provider answered"}, Unavailable),
    ]
    for status, body, expected in cases:
        client_, _ = client(FakeResponse(status, body))
        try:
            client_.latest(["AAPL"], now=NOW)
        except expected:
            continue
        raise AssertionError(f"{status} {body['code']} did not raise {expected.__name__}")


def test_a_missing_token_is_not_configured_before_any_request():
    client_, session = client(QUOTES, token="")
    try:
        client_.latest(["AAPL"], now=NOW)
    except NotConfigured:
        assert session.posts == []
    else:  # pragma: no cover
        raise AssertionError("expected NotConfigured")


def test_a_5xx_is_unavailable():
    # `ThrottledClient` retries a 5xx (three backoffs, so four attempts) before giving up.
    client_, _ = client(*[FakeResponse(503, {"code": "unavailable", "message": "no"})] * 4)
    try:
        client_.latest(["AAPL"], now=NOW)
    except Unavailable:
        return
    raise AssertionError("expected Unavailable")


def test_healthz_is_a_plain_get_and_false_when_the_process_is_down():
    client_, session = client(FakeResponse(200, {}))
    assert client_.healthz() is True
    assert session.calls[0][0] == f"{URL}/healthz"
    client_, _ = client(requests.ConnectionError("refused"))
    assert client_.healthz() is False


def test_list_providers_and_routing_read_the_bridges_own_words():
    client_, _ = client(PROVIDERS)
    health = {row.provider: row for row in client_.providers()}
    assert health["alpaca"].state == "ok" and health["alpaca"].classes == ("equity_quotes", "equity_bars")
    assert health["alpaca"].quality == "delayed-15m" and health["alpaca"].p95_ms == 42
    assert health["ibkr"].state == "not_configured" and health["ibkr"].reason == "gateway_down"

    client_, _ = client({"routing": ROUTING})
    routing = client_.routing()
    assert routing == Routing(
        classes=(bridge.ClassRouting("equity_quotes", "", ("alpaca",), "alpaca"),),
        version=3,
        source="desk",
    )


def test_set_routing_sends_the_admin_header_and_the_desks_version():
    client_, session = client({"classes": ROUTING["classes"], "source": "DESK", "version": "4"})
    routing = client_.set_routing({"equity_quotes": "alpaca"}, 4)
    url, body, headers = session.posts[0]
    assert url.endswith("/SetRouting")
    assert body == {"preferences": [{"dataClass": "EQUITY_QUOTES", "provider": "alpaca"}], "version": "4"}
    assert headers["X-Admin-Token"] == ADMIN
    assert routing.version == 4


def test_set_routing_without_an_admin_token_never_sends():
    client_, session = client({"classes": [], "source": "DESK", "version": "1"}, admin="")
    try:
        client_.set_routing({"equity_quotes": "alpaca"}, 1)
    except NotConfigured:
        assert session.posts == []
    else:  # pragma: no cover
        raise AssertionError("expected NotConfigured")


def test_gateway_status_maps_the_bridges_ibkr_health_onto_the_four_states():
    ok = {
        "providers": [
            {
                **PROVIDERS["providers"][1],
                "configured": True,
                "state": "HEALTH_STATE_OK",
                "quality": "REALTIME",
                "newestTick": "2024-05-02T20:30:00Z",
                "linesUsed": 7,
            }
        ]
    }
    client_, _ = client(ok)
    status = client_.gateway_status()
    assert status == GatewayStatus(
        "connected", "realtime", pd.Timestamp("2024-05-02T20:30:00Z"), lines_used=7, reason="gateway_down"
    )

    off = {
        "providers": [{**PROVIDERS["providers"][1], "configured": True, "state": "HEALTH_STATE_OFF", "reason": "off"}]
    }
    client_, _ = client(off)
    assert client_.gateway_status().state == "not_configured"

    client_, _ = client(PROVIDERS)  # ibkr not configured
    assert client_.gateway_status().state == "not_configured"


def test_a_bridge_that_cannot_be_reached_reads_down_not_connected():
    client_, _ = client(*[requests.ConnectionError("refused")] * 4)
    assert client_.gateway_status().state == "down"


def test_stage_b2_keeps_the_bridge_out_of_every_default_chain():
    from ai_trading_common.registry import DEFAULT_CHAINS

    assert all("bridge" not in names for names in DEFAULT_CHAINS.values())
    assert "bridge" in REGISTRY  # registered, selectable, chainless


def test_the_bridge_can_join_a_chain_first_and_comes_back_as_the_serving_vendor():
    sources = DataSources.from_env({"MARKET_DATA_BRIDGE_URL": URL, "DATA_PROVIDERS_QUOTES": "bridge,alpaca"})
    assert sources.serving["quotes"] == "bridge"
    assert type(sources.quotes.providers[0]).__name__ == "BridgeClient"
