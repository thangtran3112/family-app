from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers

import ai_trading.api.watchlists as watchlists_module
from ai_trading.data.backfill import BackfillResult


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
    assert calls == [("AAPL", "stock")]


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
