from datetime import UTC, datetime, timedelta

import pytest
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers

from ai_trading.db.models import Alert, FeedHealth, UniverseSymbol, User, Watchlist, WatchlistItem

NOW = datetime(2026, 10, 23, 20, 0, tzinfo=UTC)
STUB_STAMP = {"as_of": "2026-10-23T20:00:00Z", "source": "alpaca", "quality": "delayed-15m", "freshness": "closed"}
UNAVAILABLE_STAMP = {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"}


def _user(db_session, email=OWNER_EMAIL, settings=None) -> User:
    user = User(email=email, settings=settings or {})
    db_session.add(user)
    db_session.flush()
    return user


def _universe(symbol: str, name: str, asset_type: str = "stock", active: bool = True) -> UniverseSymbol:
    return UniverseSymbol(
        symbol=symbol,
        name=name,
        asset_type=asset_type,
        exchange="NASDAQ",
        active=active,
        passed_floor=True,
        floor_reason=None,
        updated_at=NOW,
    )


def test_status_stub_returns_the_a31_example(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    # The Fundamental fields (02n §c3 #18) are the honest "nothing connected yet" ones while their own stub flag is off.
    monkeypatch.delenv("DESK_FUNDAMENTAL_STUB", raising=False)
    monkeypatch.delenv("IBKR_FLEX_TOKEN", raising=False)
    monkeypatch.delenv("IBKR_FLEX_QUERY_ID", raising=False)
    response = client.get("/api/desk/status", headers=auth_headers())
    assert response.status_code == 200
    assert response.json() == {
        "market": {"session": "closed", "next_open": "2026-10-26T13:30:00Z", "last_close": "2026-10-23T20:00:00Z"},
        "quotes": STUB_STAMP,
        "scans": {**STUB_STAMP, "freshness": "delayed", "next_run_at": "2026-10-26T12:30:00Z"},
        "alerts": {"state": "running", "unread": 2},
        "gateway": "not_configured",
        "gateway_reason": None,
        "data_sources": {
            "quotes": "alpaca",
            "bars": "alpaca",
            "option_chain": "alpaca_options",
            "trades": "alpaca",
            "universe": "alpaca",
        },
        "streaming_slots": {"used": 0, "max": 70},
        "backups": None,
        "reconciliation": None,
        "holdings": {
            "source": "ibkr_flex",
            "account_scope": "data",
            "statement_date": None,
            "imported_at": None,
            "lots": 0,
            "state": "not_configured",
        },
        "options": {**UNAVAILABLE_STAMP, "state": "not_connected"},
        "ai_daily": {"state": "not_started", "last_run_at": None},
    }


def test_status_real_mode_without_feed_rows_is_unavailable_not_fabricated(client, monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    body = client.get("/api/desk/status", headers=auth_headers()).json()
    assert body["quotes"] == UNAVAILABLE_STAMP
    assert body["scans"] == {**UNAVAILABLE_STAMP, "next_run_at": None}
    assert body["data_sources"]["quotes"] == "unknown"  # nothing has served quotes yet
    assert body["alerts"] == {"state": "not_started", "unread": 0}
    assert body["market"]["session"] in {"pre", "regular", "after", "closed"}


def test_status_real_mode_reads_feed_health_pause_and_unread_alerts(client, db_session, monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    now = datetime.now(UTC)
    last_ok = now - timedelta(minutes=1)
    db_session.add(FeedHealth(feed="bars_delayed", state="ok", last_ok_at=last_ok, updated_at=now))
    user = _user(db_session, settings={"pause_all": True})
    for read_at in (None, None, now):
        db_session.add(
            Alert(user_id=user.id, kind="signal", severity="info", title="t", body="b", created_at=now, read_at=read_at)
        )
    db_session.commit()

    body = client.get("/api/desk/status", headers=auth_headers()).json()
    assert body["data_sources"]["quotes"] == "alpaca"
    assert body["quotes"]["source"] == "alpaca"
    assert body["quotes"]["quality"] == "delayed-15m"
    assert datetime.fromisoformat(body["quotes"]["as_of"].replace("Z", "+00:00")) == last_ok
    assert body["quotes"]["freshness"] in {"closed", "delayed"}
    assert body["scans"]["quality"] == "unavailable"  # no `scan` feed row yet
    assert body["alerts"] == {"state": "paused_by_user", "unread": 2}


def test_symbol_search_orders_prefix_then_name_and_scopes_watchlists(client, db_session, monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    owner = _user(db_session)
    other = _user(db_session, email=OTHER_EMAIL)
    db_session.add_all(
        [
            _universe("NVDA", "NVIDIA Corp"),
            _universe("NVAX", "Novavax Inc"),
            _universe("ENVR", "Enviro Corp"),  # matches "nv" only as a name substring
            _universe("OLDX", "Nvidia Old", active=False),  # inactive rows never match
        ]
    )
    mine = Watchlist(user_id=owner.id, name="Core", horizon="swing")
    theirs = Watchlist(user_id=other.id, name="Theirs", horizon="swing")
    db_session.add_all([mine, theirs])
    db_session.flush()
    db_session.add_all(
        [
            WatchlistItem(watchlist_id=mine.id, symbol="NVDA", asset_type="stock"),
            WatchlistItem(watchlist_id=mine.id, symbol="NVXX", asset_type="stock"),  # no universe row
            WatchlistItem(watchlist_id=mine.id, symbol="/NQ", asset_type="future"),
            WatchlistItem(watchlist_id=theirs.id, symbol="NVQQ", asset_type="stock"),  # another user's list
        ]
    )
    db_session.commit()

    response = client.get("/api/desk/symbols/search", params={"q": "nv"}, headers=auth_headers())
    assert response.status_code == 200
    assert response.json() == [
        {"symbol": "NVAX", "name": "Novavax Inc", "asset_type": "stock", "in_watchlist": False},
        {"symbol": "NVDA", "name": "NVIDIA Corp", "asset_type": "stock", "in_watchlist": True},
        {"symbol": "NVXX", "name": "NVXX", "asset_type": "stock", "in_watchlist": True},
        {"symbol": "ENVR", "name": "Enviro Corp", "asset_type": "stock", "in_watchlist": False},
    ]
    # Futures roots are never returned, even from the caller's own watchlist.
    assert client.get("/api/desk/symbols/search", params={"q": "/N"}, headers=auth_headers()).json() == []


def test_symbol_search_uses_stub_names_and_asset_types_for_unknown_watchlist_symbols(client, db_session, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    owner = _user(db_session)
    watchlist = Watchlist(user_id=owner.id, name="Core", horizon="intraday")
    db_session.add(watchlist)
    db_session.flush()
    db_session.add_all(
        [
            WatchlistItem(watchlist_id=watchlist.id, symbol="PLTR", asset_type="stock"),
            WatchlistItem(watchlist_id=watchlist.id, symbol="SPY", asset_type="stock"),
        ]
    )
    db_session.commit()

    palantir = client.get("/api/desk/symbols/search", params={"q": "palantir"}, headers=auth_headers()).json()
    assert palantir == [
        {"symbol": "PLTR", "name": "Palantir Technologies", "asset_type": "stock", "in_watchlist": True}
    ]
    spdr = client.get("/api/desk/symbols/search", params={"q": "spdr"}, headers=auth_headers()).json()
    assert spdr == [{"symbol": "SPY", "name": "SPDR S&P 500 ETF", "asset_type": "etf", "in_watchlist": True}]


def test_symbol_search_limit_defaults_to_eight(client, db_session, monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    db_session.add_all([_universe(f"AB{index:02d}", f"Name {index}") for index in range(10)])
    db_session.commit()

    everything = client.get("/api/desk/symbols/search", params={"q": "AB"}, headers=auth_headers()).json()
    assert len(everything) == 8
    assert (
        len(client.get("/api/desk/symbols/search", params={"q": "AB", "limit": 3}, headers=auth_headers()).json()) == 3
    )


@pytest.mark.parametrize("params", [{}, {"q": ""}, {"q": "A", "limit": 0}, {"q": "A", "limit": 21}])
def test_symbol_search_rejects_a_bad_query(client, params):
    assert client.get("/api/desk/symbols/search", params=params, headers=auth_headers()).status_code == 422


def test_dashboard_stub_spot_values(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    response = client.get("/api/desk/dashboard", headers=auth_headers())
    assert response.status_code == 200
    body = response.json()

    assert body["stamp"] == STUB_STAMP
    assert body["market"] == {"session": "closed", "next_open": "2026-10-26T13:30:00Z", "next_update_at": None}
    assert [tile["symbol"] for tile in body["market_strip"]] == ["SPY", "QQQ", "IWM", "/ES", "/NQ"]
    assert body["market_strip"][0] == {"symbol": "SPY", "last": 759.97, "change_pct": -0.522, "stamp": STUB_STAMP}
    assert body["market_strip"][3] == {"symbol": "/ES", "last": None, "change_pct": None, "stamp": UNAVAILABLE_STAMP}

    bar_times = [signal["bar_time"] for signal in body["signals"]]
    assert len(bar_times) == 15
    assert bar_times == sorted(bar_times, reverse=True)
    assert body["signals"][0]["id"] == 15
    assert body["signals"][0]["symbol"] == "AAPL"

    assert len(body["screener_matches"]) == 10
    assert body["screener_matches"][0] == {
        "filter_id": 1,
        "name": "Abnormal volume",
        "run_on": "bar_close_15m",
        "scanned": 131,
        "matches_total": 9,
        "top": ["BOLT", "LKQ", "SPTI"],
        "stamp": STUB_STAMP,
    }

    assert body["watchlist"]["id"] == 1
    assert body["watchlist"]["name"] == "Day movers"
    assert len(body["watchlist"]["rows"]) == 8
    assert body["watchlist"]["rows"][0] == {
        "symbol": "NVDA",
        "last": 210.96,
        "change_pct": -0.589,
        "rvol_10d": 0.805,
        "vs_vwap_pct": -0.526,
        "bias_label": "Sell",
    }
    assert body["events"][0] == {"symbol": "MSFT", "kind": "earnings", "date": "2026-10-28", "timing": "after_close"}
    assert body["alerts_state"] == "running"


def test_dashboard_watchlist_id_selects_the_list_and_unknown_id_is_404(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    swing = client.get("/api/desk/dashboard", params={"watchlist_id": 2}, headers=auth_headers()).json()
    assert swing["watchlist"]["name"] == "Swing"
    assert [row["symbol"] for row in swing["watchlist"]["rows"]][0] == "MSFT"

    missing = client.get("/api/desk/dashboard", params={"watchlist_id": 99}, headers=auth_headers())
    assert missing.status_code == 404
    assert missing.json() == {"detail": "watchlist not found"}


def test_status_real_mode_names_the_next_scan_once_a_scan_has_run(client, db_session, monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    now = datetime.now(UTC)
    db_session.add(FeedHealth(feed="scan", state="ok", last_ok_at=now, updated_at=now))
    db_session.commit()

    body = client.get("/api/desk/status", headers=auth_headers()).json()

    next_run = datetime.fromisoformat(body["scans"]["next_run_at"].replace("Z", "+00:00"))
    assert next_run > now and next_run.minute % 15 == 0 and next_run.second == 0
