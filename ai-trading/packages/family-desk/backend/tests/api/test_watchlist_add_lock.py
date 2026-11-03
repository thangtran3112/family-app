"""D-244: adding a stock must not hold the watchlist's row lock while its 10-year bar backfill runs.

The backfill is ~90 s of provider calls (hourly bars from 2016). It used to run inside the request, between the
`FOR UPDATE` on the list and the commit, so any second request on that list (a retry, a double click, another
symbol) waited on the lock and died at `lock_timeout` as 503 "The Desk is busy". These tests use real per-request
sessions on an engine with a short `lock_timeout` (the shared `client` fixture hands every request one session, which
can never contend), and a gate in place of the provider.
"""

import logging
import threading
import time

import pytest
from ai_trading_common.errors import Unavailable
from conftest import auth_headers, wait_for
from fakes import fake_data_sources
from fastapi.testclient import TestClient

import ai_trading.api.watchlists as watchlists_module
from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.db.engine import make_engine, make_session_factory

LOCK_TIMEOUT_MS = 1500
PATH = "/api/desk/watchlists"


@pytest.fixture
def live_client(db_engine, db_session, monkeypatch: pytest.MonkeyPatch):
    """The real `get_session` on `app.state.session_factory`, as in production, with a short `lock_timeout`."""
    monkeypatch.delenv("DESK_RUNTIME_DATABASE_URL", raising=False)
    engine = make_engine(db_engine.url.render_as_string(hide_password=False), lock_timeout_ms=LOCK_TIMEOUT_MS)
    app.state.session_factory = make_session_factory(engine)
    app.dependency_overrides[get_data_sources] = lambda: fake_data_sources()
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        del app.state.session_factory
        engine.dispose()


def _new_list(client: TestClient) -> int:
    response = client.post(PATH, json={"name": "Core", "horizon": "swing"}, headers=auth_headers())
    return response.json()["id"]


def test_a_slow_backfill_does_not_hold_the_list_against_the_next_add(live_client, monkeypatch):
    gate = threading.Event()
    finished: list[str] = []

    def slow_backfill(session, data_sources, *, symbol, asset, now):
        gate.wait(30)  # the provider, still fetching
        finished.append(symbol)

    monkeypatch.setattr(watchlists_module, "backfill_on_join", slow_backfill)
    watchlist_id = _new_list(live_client)
    answers: dict[str, tuple[int, float]] = {}

    def add(symbol: str) -> None:
        started = time.monotonic()
        response = live_client.post(
            f"{PATH}/{watchlist_id}/items", json={"symbol": symbol, "asset_type": "stock"}, headers=auth_headers()
        )
        answers[symbol] = (response.status_code, time.monotonic() - started)

    try:
        for symbol in ("AAPL", "MSFT"):
            request = threading.Thread(target=add, args=(symbol,))
            request.start()
            request.join(LOCK_TIMEOUT_MS / 1000 + 5)
            assert not request.is_alive(), f"adding {symbol} is still waiting on the backfill"
    finally:
        gate.set()

    # Neither add waited on the other's backfill: both answered 201 well inside the lock timeout.
    assert {symbol: answer[0] for symbol, answer in answers.items()} == {"AAPL": 201, "MSFT": 201}
    assert all(answer[1] < LOCK_TIMEOUT_MS / 1000 for answer in answers.values())
    assert wait_for(lambda: sorted(finished) == ["AAPL", "MSFT"])
    items = live_client.get(f"{PATH}/{watchlist_id}/items", headers=auth_headers()).json()
    assert [item["symbol"] for item in items] == ["AAPL", "MSFT"]


def test_a_provider_that_is_down_still_adds_the_symbol_and_the_failure_is_logged(live_client, monkeypatch, caplog):
    called = threading.Event()
    monkeypatch.setattr(watchlists_module.log, "disabled", False)  # alembic's fileConfig in the db fixture turns it off

    def provider_down(session, data_sources, *, symbol, asset, now):
        called.set()
        raise Unavailable("alpaca", "timed out")

    monkeypatch.setattr(watchlists_module, "backfill_on_join", provider_down)
    watchlist_id = _new_list(live_client)

    with caplog.at_level(logging.WARNING, logger=watchlists_module.__name__):
        response = live_client.post(
            f"{PATH}/{watchlist_id}/items", json={"symbol": "AAPL", "asset_type": "stock"}, headers=auth_headers()
        )
        assert called.wait(10)
        assert wait_for(lambda: "alpaca: timed out" in caplog.text)

    assert response.status_code == 201
    items = live_client.get(f"{PATH}/{watchlist_id}/items", headers=auth_headers()).json()
    assert items == [{"symbol": "AAPL", "asset_type": "stock", "backfill": "pending"}]
