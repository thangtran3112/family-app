"""Private Finnhub bridge: source freshness, minimal output, and internal auth."""

import json
import threading
from datetime import UTC, date, datetime
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pandas as pd
import pytest
from server import NoRedirectSession, make_server, snapshot

from ai_trading_common.errors import NotConfigured
from ai_trading_common.types import AnalystTargets

NOW = datetime(2026, 10, 11, tzinfo=UTC)


def targets(*, period=date(2026, 9, 1), symbol="AAPL", buy=22):
    return AnalystTargets(
        symbol=symbol,
        target_mean=None,
        target_median=None,
        target_high=None,
        target_low=None,
        strong_buy=12,
        buy=buy,
        hold=15,
        sell=3,
        strong_sell=1,
        provider="finnhub",
        quality="eod",
        as_of=pd.Timestamp(NOW),
        period=period,
    )


def source(value=None, error=None):
    def analyst_targets(symbol, *, now):
        if error:
            raise error
        return value or targets()

    return SimpleNamespace(targets=SimpleNamespace(analyst_targets=analyst_targets))


def test_source_period_not_retrieval_clock_governs_freshness():
    assert snapshot("AAPL.US", source(targets(period=date(2026, 8, 1))), NOW) == {
        "status": "unavailable",
        "reason": "stale",
    }


def test_count_response_never_includes_price_targets():
    result = snapshot("AAPL.US", source(), NOW)
    assert result == {
        "status": "ok",
        "symbol": "AAPL.US",
        "provider": "finnhub",
        "period": "2026-09-01",
        "retrieved_at": "2026-10-11T00:00:00Z",
        "strong_buy": 12,
        "buy": 22,
        "hold": 15,
        "sell": 3,
        "strong_sell": 1,
    }


@pytest.mark.parametrize("ticker", ["AAPL", "AAPL.HK", "http://bad.US", "AAPL.US?x=y", "aapl.US"])
def test_untrusted_or_non_us_symbol_never_reaches_provider(ticker):
    with pytest.raises(ValueError, match="US ticker"):
        snapshot(ticker, source(), NOW)


def test_wrong_provider_symbol_cannot_supply_independent_counts():
    assert snapshot("AAPL.US", source(targets(symbol="MSFT")), NOW) == {
        "status": "unavailable",
        "reason": "no_data",
    }


def test_missing_key_is_unavailable_without_external_request():
    assert snapshot("AAPL.US", source(error=NotConfigured("finnhub", "missing key")), NOW) == {
        "status": "unavailable",
        "reason": "not_configured",
    }


def test_zero_analysts_is_not_corroboration():
    empty = targets(buy=0)
    empty = AnalystTargets(**{**empty.__dict__, **dict.fromkeys(("strong_buy", "hold", "sell", "strong_sell"), 0)})
    assert snapshot("AAPL.US", source(empty), NOW) == {"status": "unavailable", "reason": "no_data"}


def test_finnhub_request_does_not_follow_key_bearing_redirect(monkeypatch):
    session = NoRedirectSession()
    monkeypatch.setattr(session, "request", lambda method, url, **kwargs: kwargs)
    assert session.get("https://finnhub.io/path", params={"token": "fake"})["allow_redirects"] is False


def request(server, path, key=None):
    url = f"http://127.0.0.1:{server.server_port}{path}"
    req = Request(url, headers={"X-API-Key": key} if key is not None else {})
    try:
        with urlopen(req, timeout=2) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


def test_http_auth_precedes_provider_access_and_health_discloses_no_key():
    server = make_server(0, "fake-internal-key", source(), clock=lambda: NOW)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert request(server, "/healthz") == (200, {"status": "ok"})
        assert request(server, "/v1/recommendations/AAPL.US")[0] == 401
        assert request(server, "/v1/recommendations/AAPL.US", "wrong")[0] == 401
        assert request(server, "/v1/recommendations/AAPL.HK", "fake-internal-key")[0] == 400
        assert request(server, "/v1/recommendations/AAPL.US", "fake-internal-key") == (
            200,
            snapshot("AAPL.US", source(), NOW),
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
