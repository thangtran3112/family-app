"""The real covered-call routes over HTTP (02n §c3 #6 to #10): the response models accept what the service builds, the
key-401 state reads as an unavailable chain and not a fake, and `/status` follows the chain. The engine's numbers are
proved on a golden chain in `tests/covered_calls/test_service.py`. Needs Postgres; no network."""

from datetime import date

import pandas as pd
import pytest
from ai_trading_common.errors import NotConfigured
from ai_trading_common.testing import FakeOptionChain
from ai_trading_common.types import OptionContract
from conftest import OWNER_EMAIL, auth_headers
from fundamental_world import (
    ACCOUNT_A,
    NOW,
    FakeQuotes,
    data_sources,
    frozen,
    import_xml,
    option_lot,
    response,
    statement,
    stock_lot,
    user,
)

from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.covered_calls import service
from ai_trading.fundamental.sources import ALPACA_KEY_VARS
from ai_trading.fundamental_stub import STUB_FLAG

PREFIX = "/api/desk"
NOV20 = date(2026, 11, 20)
CHAIN = {
    "AAPL": [
        OptionContract(
            "AAPL",
            "AAPL261120C00215000",
            "C",
            NOV20,
            215.0,
            0,
            2.85,
            3.00,
            0.28,
            0.31,
            900,
            pd.Timestamp("2026-10-23T19:15:00Z"),
            "alpaca_options",
            "delayed-15m",
        )  # fmt: skip
    ]
}


@pytest.fixture
def world(client, db_session, monkeypatch):
    monkeypatch.delenv(STUB_FLAG, raising=False)
    for name in ("IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID", "DESK_FLEX_USER", *ALPACA_KEY_VARS):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr("ai_trading.api.covered_calls.datetime", frozen(NOW))
    monkeypatch.setattr("ai_trading.api.holdings.datetime", frozen(NOW))
    service.CHAIN_HEALTH.update(ok=None, at=None)
    lots = [stock_lot("AAPL", 1000, 150.0, "20240312"), option_lot("AAPL", -1, 200, "20261106")]
    import_xml(db_session, user(db_session, OWNER_EMAIL).id, response(statement(ACCOUNT_A, "20261023", lots)))
    use(FakeOptionChain(CHAIN))
    return client


def use(chain=None, quotes=None) -> None:
    sources = data_sources(quotes=quotes or FakeQuotes({"AAPL": 200.0}), option_chain=chain)
    app.dependency_overrides[get_data_sources] = lambda: sources


def get(client, url):
    return client.get(f"{PREFIX}{url}", headers=auth_headers())


def test_candidates_come_back_in_the_response_model_with_the_engines_yield(world):
    body = get(world, "/covered-calls/candidates?symbol=aapl").json()
    (row,) = body["candidates"]
    assert (row["strike"], row["expiry"], row["dte"]) == (215.0, "2026-11-20", 28)
    assert row["premium_yield"] == pytest.approx(2.85 / 200)  # bid / spot
    assert row["annualized_yield"] == pytest.approx(2.85 / 200 * 365 / 28, abs=1e-6)
    assert body["chain_stamp"]["source"] == "alpaca_options" and body["ai_context"] is None
    assert body["iv_rank"] is None and body["iv_history_sessions"] == 0  # no IV history yet: the engine hides it


def test_the_rejected_key_is_an_empty_list_and_an_unavailable_stamp_over_http(world):
    use(FakeOptionChain(CHAIN, raises=NotConfigured("alpaca_options", "401")))
    body = get(world, "/covered-calls/candidates?symbol=AAPL")
    assert body.status_code == 200
    assert body.json()["candidates"] == [] and body.json()["chain_stamp"]["quality"] == "unavailable"
    short = get(world, "/covered-calls/short-calls").json()
    assert short[0]["delta"] is None and short[0]["spot"] == 200.0  # the spot still reads; the delta is simply unknown
    roll = get(world, f"/covered-calls/short-calls/{short[0]['id']}/roll").json()
    assert (
        roll["cost_to_close"] is None and roll["candidates"] == [] and roll["chain_stamp"]["quality"] == "unavailable"
    )


def test_short_calls_roll_coverage_and_income_answer_in_their_models(world):
    (call,) = get(world, "/covered-calls/short-calls").json()
    assert (call["symbol"], call["contracts"], call["dte"]) == ("AAPL", 1, 14)
    assert get(world, f"/covered-calls/short-calls/{call['id']}/roll").status_code == 200
    assert get(world, "/covered-calls/short-calls/99999/roll").status_code == 404
    coverage = get(world, "/covered-calls/coverage").json()
    assert coverage["cap_pct"] == 50 and coverage["rows"][0]["coverable"] == 4  # 5 contracts at the cap, 1 open
    assert get(world, "/covered-calls/income").json()["state"] == "needs_trades"
    assert get(world, "/covered-calls/income?months=0").status_code == 422
    assert get(world, "/covered-calls/income?months=37").status_code == 422
    assert get(world, "/covered-calls/candidates?symbol=TSLA").status_code == 404
    assert get(world, "/covered-calls/candidates").status_code == 422


def test_every_route_needs_the_gateway_identity(world):
    for url in ("/coverage", "/candidates?symbol=AAPL", "/short-calls", "/short-calls/1/roll", "/income"):
        assert world.get(f"{PREFIX}/covered-calls{url}").status_code == 401


def test_status_options_follow_the_key_and_the_last_chain_read(world, monkeypatch):
    assert get(world, "/status").json()["options"]["state"] == "not_connected"  # no key set
    for name in ALPACA_KEY_VARS:
        monkeypatch.setenv(name, "set")
    options = get(world, "/status").json()["options"]
    assert options["state"] == "connected" and options["source"] == "alpaca_options"  # key set, nothing read yet
    assert options["quality"] == "delayed-15m" and options["as_of"] is None
    get(world, "/covered-calls/candidates?symbol=AAPL")  # a good read stamps its time
    assert get(world, "/status").json()["options"]["as_of"] == "2026-10-23T19:30:00Z"
    use(FakeOptionChain(CHAIN, raises=NotConfigured("alpaca_options", "401")))
    get(world, "/covered-calls/candidates?symbol=AAPL")  # the key is rejected
    rejected = get(world, "/status").json()["options"]
    assert (rejected["state"], rejected["quality"], rejected["source"]) == ("not_connected", "unavailable", None)


def test_status_holdings_is_the_real_import_state(world):
    holdings = get(world, "/status").json()["holdings"]
    assert (holdings["state"], holdings["statement_date"], holdings["lots"]) == ("ok", "2026-10-23", 2)
