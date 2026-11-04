import threading
from datetime import date

import pytest
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers, wait_for
from sqlalchemy.orm import sessionmaker

import ai_trading.api.watchlists as watchlists_module
from ai_trading.api.app import app
from ai_trading.data.backfill import BackfillResult
from ai_trading.db.models import Bar1d


@pytest.fixture(autouse=True)
def backfill_thread(db_engine):
    """A process without a session factory skips the add's backfill thread; give it one, as the app has."""
    app.state.session_factory = sessionmaker(db_engine, expire_on_commit=False)
    yield
    del app.state.session_factory


def test_create_and_list_watchlist(client):
    created = client.post("/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers())
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "Core"
    assert body["horizon"] == "swing"

    listed = client.get("/api/desk/watchlists", headers=auth_headers())
    assert [row["id"] for row in listed.json()] == [body["id"]]


def test_add_item_calls_backfill_on_join_with_the_right_arguments(client, monkeypatch):
    calls = []

    def fake_backfill_on_join(session, data_sources, *, symbol, asset, now):
        calls.append((symbol, asset))
        return BackfillResult(requested=(now.date(), now.date()), written=[], uncovered=[])

    monkeypatch.setattr(watchlists_module, "backfill_on_join", fake_backfill_on_join)

    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "intraday"}, headers=auth_headers()
    ).json()["id"]

    response = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "AAPL", "asset_type": "stock"},
        headers=auth_headers(),
    )

    assert response.status_code == 201
    assert response.json() == {"watchlist_id": watchlist_id, "symbol": "AAPL", "asset_type": "stock"}
    assert wait_for(lambda: calls == [("AAPL", "stock")])


def test_adding_a_future_symbol_still_creates_the_item_even_though_backfill_writes_nothing(client):
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Futures", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]

    response = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "/ES", "asset_type": "future"},
        headers=auth_headers(),
    )

    assert response.status_code == 201
    assert response.json()["asset_type"] == "future"


def _join_threads_done() -> bool:
    return not any(t.name == "backfill_on_join" and t.is_alive() for t in threading.enumerate())


def _backfill_by_symbol(client, watchlist_id):
    rows = client.get(f"/api/desk/watchlists/{watchlist_id}/items", headers=auth_headers()).json()
    return {row["symbol"]: row["backfill"] for row in rows}


def test_a_future_is_not_pending_once_its_join_is_done(client):
    """D-246: a future never writes `Bar1d` (no data source until 2b), so `pending` could never clear for it."""
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Futures", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]
    client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "/ES", "asset_type": "future"},
        headers=auth_headers(),
    )
    assert wait_for(_join_threads_done)

    assert _backfill_by_symbol(client, watchlist_id) == {"/ES": "ready"}


def test_a_stock_stays_pending_until_its_daily_bars_land_and_a_future_beside_it_does_not(
    client, db_session, monkeypatch
):
    """The stock path is unchanged: only stored daily bars clear `pending` (D-244); an empty join leaves it."""
    monkeypatch.setattr(
        watchlists_module,
        "backfill_on_join",
        lambda session, data_sources, *, symbol, asset, now: BackfillResult(
            requested=(now.date(), now.date()), written=[], uncovered=[]
        ),
    )
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Mixed", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]
    for symbol, asset_type in (("AAPL", "stock"), ("/ES", "future"), ("MSFT", "stock")):
        client.post(
            f"/api/desk/watchlists/{watchlist_id}/items",
            json={"symbol": symbol, "asset_type": asset_type},
            headers=auth_headers(),
        )
    assert wait_for(_join_threads_done)

    # Two stocks still filling; the future does not count among them.
    assert _backfill_by_symbol(client, watchlist_id) == {"AAPL": "pending", "/ES": "ready", "MSFT": "pending"}

    db_session.add(
        Bar1d(symbol="AAPL", day=date(2024, 12, 30), open=10, high=11, low=9, close=10, volume=1, source="test")
    )
    db_session.add(
        Bar1d(symbol="MSFT", day=date(2024, 12, 30), open=10, high=11, low=9, close=10, volume=1, source="test")
    )
    db_session.commit()

    assert _backfill_by_symbol(client, watchlist_id) == {"AAPL": "ready", "/ES": "ready", "MSFT": "ready"}
    reordered = client.put(
        f"/api/desk/watchlists/{watchlist_id}/order", json={"symbols": ["/ES", "MSFT", "AAPL"]}, headers=auth_headers()
    )
    assert [(row["symbol"], row["backfill"]) for row in reordered.json()] == [
        ("/ES", "ready"),
        ("MSFT", "ready"),
        ("AAPL", "ready"),
    ]


def test_watchlist_item_actions_404_for_a_watchlist_owned_by_someone_else(client):
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers(OWNER_EMAIL)
    ).json()["id"]

    add = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "AAPL", "asset_type": "stock"},
        headers=auth_headers(OTHER_EMAIL),
    )
    delete = client.delete(f"/api/desk/watchlists/{watchlist_id}/items/AAPL", headers=auth_headers(OTHER_EMAIL))

    assert add.status_code == 404
    assert delete.status_code == 404


def test_delete_watchlist_item_is_idempotent(client):
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]
    client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "AAPL", "asset_type": "stock"},
        headers=auth_headers(),
    )

    first = client.delete(f"/api/desk/watchlists/{watchlist_id}/items/AAPL", headers=auth_headers())
    second = client.delete(f"/api/desk/watchlists/{watchlist_id}/items/AAPL", headers=auth_headers())

    assert first.status_code == 204
    assert second.status_code == 204


def test_watchlist_names_are_normalized_and_unique_per_owner(client):
    created = client.post(
        "/api/desk/watchlists", json={"name": "  Core   Movers ", "horizon": "swing"}, headers=auth_headers()
    )
    duplicate = client.post(
        "/api/desk/watchlists", json={"name": "core movers", "horizon": "intraday"}, headers=auth_headers()
    )
    other_owner = client.post(
        "/api/desk/watchlists", json={"name": "core movers", "horizon": "intraday"}, headers=auth_headers(OTHER_EMAIL)
    )

    assert created.status_code == 201
    assert created.json()["name"] == "Core Movers"
    assert duplicate.status_code == 409
    assert other_owner.status_code == 201


def test_invalid_item_is_rejected_before_backfill(client, monkeypatch):
    calls = []
    monkeypatch.setattr(watchlists_module, "backfill_on_join", lambda *args, **kwargs: calls.append((args, kwargs)))
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]

    response = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "/ES", "asset_type": "stock"},
        headers=auth_headers(),
    )

    assert response.status_code == 422
    assert calls == []


def test_duplicate_item_returns_conflict_without_second_backfill(client, monkeypatch):
    calls = []

    def fake_backfill(session, data_sources, *, symbol, asset, now):
        calls.append((symbol, asset))
        return BackfillResult(requested=(now.date(), now.date()), written=[], uncovered=[])

    monkeypatch.setattr(watchlists_module, "backfill_on_join", fake_backfill)
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]
    payload = {"symbol": "AAPL", "asset_type": "stock"}

    first = client.post(f"/api/desk/watchlists/{watchlist_id}/items", json=payload, headers=auth_headers())
    duplicate = client.post(f"/api/desk/watchlists/{watchlist_id}/items", json=payload, headers=auth_headers())

    assert first.status_code == 201
    assert duplicate.status_code == 409
    assert wait_for(lambda: calls == [("AAPL", "stock")])


def test_encoded_future_symbol_round_trips_through_add_and_owner_delete(client, monkeypatch):
    calls = []

    def fake_backfill(session, data_sources, *, symbol, asset, now):
        calls.append((symbol, asset))
        return BackfillResult(requested=(now.date(), now.date()), written=[], uncovered=[])

    monkeypatch.setattr(watchlists_module, "backfill_on_join", fake_backfill)
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Futures", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]
    added = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": " es ", "asset_type": "future"},
        headers=auth_headers(),
    )

    assert added.status_code == 201
    assert added.json() == {"watchlist_id": watchlist_id, "symbol": "/ES", "asset_type": "future"}
    assert wait_for(lambda: calls == [("/ES", "future")])
    assert client.get(f"/api/desk/watchlists/{watchlist_id}/items", headers=auth_headers()).json()[0]["symbol"] == "/ES"

    removed = client.delete(f"/api/desk/watchlists/{watchlist_id}/items/%2FES", headers=auth_headers())

    assert removed.status_code == 204
    assert client.get(f"/api/desk/watchlists/{watchlist_id}/items", headers=auth_headers()).json() == []


def test_encoded_future_delete_404s_for_non_owner(client):
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Futures", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]
    client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "/ES", "asset_type": "future"},
        headers=auth_headers(),
    )

    removed = client.delete(f"/api/desk/watchlists/{watchlist_id}/items/%2FES", headers=auth_headers(OTHER_EMAIL))

    assert removed.status_code == 404


def test_plain_stock_ticker_and_prefixed_future_root_remain_distinct(client, monkeypatch):
    calls = []

    def fake_backfill(session, data_sources, *, symbol, asset, now):
        calls.append((symbol, asset))
        return BackfillResult(requested=(now.date(), now.date()), written=[], uncovered=[])

    monkeypatch.setattr(watchlists_module, "backfill_on_join", fake_backfill)
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Energy", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]
    stock = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "CL", "asset_type": "stock"},
        headers=auth_headers(),
    )
    future = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "CL", "asset_type": "future"},
        headers=auth_headers(),
    )

    assert stock.status_code == 201
    assert future.status_code == 201
    assert wait_for(lambda: sorted(calls) == [("/CL", "future"), ("CL", "stock")])
    assert {
        row["symbol"]: row["asset_type"]
        for row in client.get(f"/api/desk/watchlists/{watchlist_id}/items", headers=auth_headers()).json()
    } == {"CL": "stock", "/CL": "future"}
