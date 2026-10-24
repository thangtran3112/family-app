"""02m §a3.5: watchlist rename, delete, order, and table. The table's stub values are the fixture's
(`mvp_stub.world`); everything else is real database behaviour in both modes."""

from datetime import UTC, datetime

from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.db.models import (
    FeedHealth,
    Strategy,
    StrategyVersion,
    SymbolMetrics,
    UniverseSymbol,
    User,
    WatchlistItem,
)
from ai_trading.mvp_stub import world

NOW = datetime(2026, 10, 24, 14, 0, tzinfo=UTC)
NOT_FOUND = {"detail": "watchlist not found"}


def _watchlist(client, name="Day movers", horizon="intraday", email=OWNER_EMAIL) -> int:
    response = client.post("/api/desk/watchlists", json={"name": name, "horizon": horizon}, headers=auth_headers(email))
    assert response.status_code == 201
    return response.json()["id"]


def _add(client, watchlist_id: int, symbol: str, asset_type: str = "stock") -> None:
    response = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": symbol, "asset_type": asset_type},
        headers=auth_headers(),
    )
    assert response.status_code == 201


def _positions(db_session, watchlist_id: int) -> dict[str, int]:
    rows = db_session.execute(
        select(WatchlistItem.symbol, WatchlistItem.position).where(WatchlistItem.watchlist_id == watchlist_id)
    ).all()
    return {symbol: position for symbol, position in rows}


def _strategy_naming(db_session, watchlist_name: str, *, email: str = OWNER_EMAIL, archived: bool = False) -> Strategy:
    """A strategy whose current version names `watchlist_name` in `watch.universe`, written directly
    because attach does not persist yet."""
    user_id = db_session.execute(select(User.id).where(User.email == email)).scalar_one()
    strategy = Strategy(
        owner_user_id=user_id,
        name="ORB 15m",
        stage="alert_only",
        created_at=NOW,
        archived_at=NOW if archived else None,
    )
    db_session.add(strategy)
    db_session.flush()
    version = StrategyVersion(
        strategy_id=strategy.id,
        version=1,
        schema_version=1,
        spec={"watch": {"universe": {"watchlist": watchlist_name}}},
        created_by=user_id,
        created_at=NOW,
    )
    db_session.add(version)
    db_session.flush()
    strategy.current_version_id = version.id
    db_session.commit()
    return strategy


def test_rename_normalizes_the_name_and_refuses_another_lists_name(client):
    first = _watchlist(client, "Core")
    other = _watchlist(client, "Swing", horizon="swing")

    renamed = client.patch(f"/api/desk/watchlists/{first}", json={"name": "  Day   Movers "}, headers=auth_headers())
    clash = client.patch(f"/api/desk/watchlists/{other}", json={"name": "day movers"}, headers=auth_headers())
    same = client.patch(f"/api/desk/watchlists/{first}", json={"name": "Day Movers"}, headers=auth_headers())
    blank = client.patch(f"/api/desk/watchlists/{first}", json={"name": "   "}, headers=auth_headers())

    assert renamed.status_code == 200
    assert renamed.json() == {"id": first, "name": "Day Movers", "horizon": "intraday"}
    assert clash.status_code == 409
    assert clash.json() == {"detail": "watchlist name already exists"}
    assert same.status_code == 200  # renaming a list to its own name is a no-op
    assert blank.status_code == 422


def test_delete_is_blocked_while_a_live_strategy_names_the_list(client, db_session):
    watchlist_id = _watchlist(client, "Day movers")
    _strategy_naming(db_session, "Day movers")

    blocked = client.delete(f"/api/desk/watchlists/{watchlist_id}", headers=auth_headers())
    assert blocked.status_code == 409
    assert blocked.json() == {"detail": "Remove the alert strategies that watch Day movers first"}

    strategy = db_session.execute(select(Strategy)).scalar_one()
    strategy.archived_at = NOW
    db_session.commit()
    removed = client.delete(f"/api/desk/watchlists/{watchlist_id}", headers=auth_headers())
    assert removed.status_code == 204
    assert client.get("/api/desk/watchlists", headers=auth_headers()).json() == []


def test_another_owners_strategy_does_not_block_delete(client, db_session):
    client.get("/api/desk/watchlists", headers=auth_headers(OTHER_EMAIL))  # creates the other user
    watchlist_id = _watchlist(client, "Day movers")
    _strategy_naming(db_session, "Day movers", email=OTHER_EMAIL)

    removed = client.delete(f"/api/desk/watchlists/{watchlist_id}", headers=auth_headers())

    assert removed.status_code == 204


def test_order_rewrites_positions_and_returns_the_new_order(client, db_session):
    watchlist_id = _watchlist(client, "Core")
    for symbol in ("MSFT", "AAPL", "NVDA"):
        _add(client, watchlist_id, symbol)
    listed = client.get(f"/api/desk/watchlists/{watchlist_id}/items", headers=auth_headers()).json()
    assert [row["symbol"] for row in listed] == ["MSFT", "AAPL", "NVDA"]  # stored position, not alphabetical

    reordered = client.put(
        f"/api/desk/watchlists/{watchlist_id}/order",
        json={"symbols": ["NVDA", "MSFT", "AAPL"]},
        headers=auth_headers(),
    )

    assert reordered.status_code == 200
    assert reordered.json()[0] == {"symbol": "NVDA", "asset_type": "stock", "backfill": "pending"}
    assert [row["symbol"] for row in reordered.json()] == ["NVDA", "MSFT", "AAPL"]
    assert _positions(db_session, watchlist_id) == {"NVDA": 0, "MSFT": 1, "AAPL": 2}


def test_order_must_be_a_permutation_of_the_list(client):
    watchlist_id = _watchlist(client, "Core")
    _add(client, watchlist_id, "MSFT")
    _add(client, watchlist_id, "AAPL")

    for symbols in (["MSFT"], ["MSFT", "AAPL", "NVDA"], ["MSFT", "MSFT"], ["MSFT", "TSLA"]):
        response = client.put(
            f"/api/desk/watchlists/{watchlist_id}/order", json={"symbols": symbols}, headers=auth_headers()
        )
        assert response.status_code == 422, symbols
        assert response.json() == {"detail": "symbols must be the same symbols as the list"}


def test_add_gives_each_new_item_the_next_position(client, db_session):
    watchlist_id = _watchlist(client, "Core")
    for symbol in ("NVDA", "AAPL", "MSFT"):
        _add(client, watchlist_id, symbol)
    assert _positions(db_session, watchlist_id) == {"NVDA": 0, "AAPL": 1, "MSFT": 2}

    client.delete(f"/api/desk/watchlists/{watchlist_id}/items/AAPL", headers=auth_headers())
    _add(client, watchlist_id, "TSLA")

    assert _positions(db_session, watchlist_id) == {"NVDA": 0, "MSFT": 2, "TSLA": 3}


def test_table_in_stub_mode_takes_metrics_bias_and_tags_from_the_fixture(client, db_session, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    watchlist_id = _watchlist(client, "Day movers")
    _add(client, watchlist_id, "NVDA")
    _add(client, watchlist_id, "SPY")
    db_session.add(
        UniverseSymbol(
            symbol="SPY",
            name="SPDR S&P 500 ETF",
            asset_type="etf",
            exchange="ARCA",
            active=True,
            passed_floor=True,
            updated_at=NOW,
        )
    )
    db_session.commit()

    body = client.get(f"/api/desk/watchlists/{watchlist_id}/table", headers=auth_headers()).json()

    assert body["watchlist"] == {"id": watchlist_id, "name": "Day movers", "horizon": "intraday"}
    assert body["stamp"] == {
        "as_of": "2026-10-23T20:00:00Z",
        "source": "alpaca",
        "quality": "delayed-15m",
        "freshness": "closed",
    }
    nvda, spy = body["rows"]
    assert (nvda["symbol"], nvda["name"], nvda["asset_type"]) == ("NVDA", "NVIDIA Corp", "stock")
    assert {key: nvda[key] for key in ("last", "change_pct", "rvol_10d", "vs_vwap_pct", "bias_label")} == {
        "last": 210.96,
        "change_pct": -0.589,
        "rvol_10d": 0.805,
        "vs_vwap_pct": -0.526,
        "bias_label": "Sell",
    }
    assert nvda["freshness"] == "closed"
    assert nvda["tags"] == [
        {"kind": "armed", "label": "VWAP reclaim armed", "at": None},
        {"kind": "armed", "label": "EMA 9/21 cross armed", "at": None},
    ]
    assert (spy["name"], spy["asset_type"]) == ("SPDR S&P 500 ETF", "etf")


def test_stub_table_caps_each_rows_tags_at_three(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    watchlist_id = _watchlist(client, "Day movers")
    _add(client, watchlist_id, "NVDA")
    pattern_signals = [
        {"symbol": "NVDA", "kind": "pattern", "strategy_name": f"Hammer {n}", "bar_time": "2026-10-23T14:15:00Z"}
        for n in range(4)
    ]
    monkeypatch.setattr(world, "signals", lambda: pattern_signals)

    body = client.get(f"/api/desk/watchlists/{watchlist_id}/table", headers=auth_headers()).json()

    assert [tag["kind"] for tag in body["rows"][0]["tags"]] == ["pattern", "pattern", "pattern"]
    assert body["rows"][0]["tags"][0]["at"] == "2026-10-23T14:15:00Z"


def test_table_in_real_mode_reads_symbol_metrics_and_reports_no_data_honestly(client, db_session, monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    watchlist_id = _watchlist(client, "Day movers")
    _add(client, watchlist_id, "NVDA")
    _add(client, watchlist_id, "AMD")

    empty = client.get(f"/api/desk/watchlists/{watchlist_id}/table", headers=auth_headers())

    assert empty.status_code == 200
    assert empty.json()["stamp"] == {
        "as_of": None,
        "source": "alpaca",
        "quality": "delayed-15m",
        "freshness": "unavailable",
    }
    assert [row["freshness"] for row in empty.json()["rows"]] == ["unavailable", "unavailable"]
    assert empty.json()["rows"][0] == {
        "symbol": "NVDA",
        "name": "NVDA",
        "asset_type": "stock",
        "last": None,
        "change_pct": None,
        "rvol_10d": None,
        "vs_vwap_pct": None,
        "bias_label": "warming up",
        "freshness": "unavailable",
        "tags": [],
    }

    db_session.add(
        SymbolMetrics(
            symbol="NVDA",
            as_of=NOW,
            source="alpaca",
            quality="delayed-15m",
            metrics={"last": 211.5, "change_pct": 0.4, "rvol_10d": 1.1, "vs_vwap_pct": 0.2, "rsi_14": 55.0},
        )
    )
    db_session.commit()
    filled = client.get(f"/api/desk/watchlists/{watchlist_id}/table", headers=auth_headers()).json()

    assert filled["stamp"]["as_of"] == "2026-10-24T14:00:00Z"  # newest metric row
    assert filled["rows"][0]["last"] == 211.5
    assert filled["rows"][0]["tags"] == []
    assert filled["rows"][1]["last"] is None  # AMD has no row


def test_table_in_real_mode_has_a_freshness_once_the_scan_feed_has_run(client, db_session, monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    watchlist_id = _watchlist(client, "Day movers")
    _add(client, watchlist_id, "NVDA")
    db_session.add(SymbolMetrics(symbol="NVDA", as_of=NOW, source="alpaca", quality="delayed-15m", metrics={}))
    db_session.add(FeedHealth(feed="scan", state="ok", last_ok_at=NOW, updated_at=NOW))
    db_session.commit()

    body = client.get(f"/api/desk/watchlists/{watchlist_id}/table", headers=auth_headers()).json()

    # closed/delayed/paused depends on the wall clock; a row the scan feed has run for is never "unavailable".
    assert body["rows"][0]["freshness"] != "unavailable"


def test_order_table_and_mutations_404_for_a_non_owner(client):
    watchlist_id = _watchlist(client, "Core")
    _add(client, watchlist_id, "MSFT")
    other = auth_headers(OTHER_EMAIL)

    responses = [
        client.patch(f"/api/desk/watchlists/{watchlist_id}", json={"name": "Mine"}, headers=other),
        client.delete(f"/api/desk/watchlists/{watchlist_id}", headers=other),
        client.put(f"/api/desk/watchlists/{watchlist_id}/order", json={"symbols": ["MSFT"]}, headers=other),
        client.get(f"/api/desk/watchlists/{watchlist_id}/table", headers=other),
        client.patch("/api/desk/watchlists/999999", json={"name": "Mine"}, headers=auth_headers()),
    ]

    assert [response.status_code for response in responses] == [404] * 5
    assert responses[0].json() == NOT_FOUND
    assert client.get("/api/desk/watchlists", headers=auth_headers()).json()[0]["name"] == "Core"


def test_table_of_an_empty_list_has_no_rows_in_either_mode(client, monkeypatch):
    watchlist_id = _watchlist(client, "Day movers")
    for flag in (None, "1"):
        if flag is None:
            monkeypatch.delenv("DESK_MVP_STUB", raising=False)
        else:
            monkeypatch.setenv("DESK_MVP_STUB", flag)
        body = client.get(f"/api/desk/watchlists/{watchlist_id}/table", headers=auth_headers()).json()
        assert body["rows"] == []
