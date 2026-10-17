from dataclasses import asdict
from datetime import date

import pandas as pd
import pytest
from ai_trading_common.bars import Bars
from ai_trading_common.errors import NoData, Unavailable
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from fakes import fake_data_sources
from fastapi.testclient import TestClient

from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.core.futures import SPECS
from ai_trading.db.models import Bar1d, WatchlistItem
from ai_trading.engine.cardback import compute_card_back


class FakeBars:
    def __init__(self, frame: pd.DataFrame, quality: str = "eod", error: Exception | None = None) -> None:
        self.frame = frame
        self.quality = quality
        self.error = error
        self.calls: list[tuple[str, str, pd.Timestamp, pd.Timestamp, pd.Timestamp]] = []

    def bars(self, symbol: str, timeframe: str, start, end, *, now) -> Bars:
        self.calls.append((symbol, timeframe, start, end, now))
        if self.error is not None:
            raise self.error
        return Bars(self.frame, "fake", self.quality)


def _daily_frame(rows: int = 1, *, end: str = "2024-12-31") -> pd.DataFrame:
    index = pd.bdate_range(end=end, periods=rows).date
    values = [100.0 + i / 10 for i in range(rows)]
    return pd.DataFrame(
        {
            "open": values,
            "high": [value + 1 for value in values],
            "low": [value - 1 for value in values],
            "close": [value + 0.5 for value in values],
            "volume": [1000.0] * rows,
        },
        index=pd.Index(index),
    )


def _set_bars(client: TestClient, source: FakeBars) -> None:
    app.dependency_overrides[get_data_sources] = lambda: fake_data_sources(source)


def test_me_requires_verified_header(client):
    assert client.get("/api/desk/me").status_code == 401
    response = client.get("/api/desk/me", headers=auth_headers())
    assert response.status_code == 200
    assert response.json() == {"email": OWNER_EMAIL}


@pytest.mark.parametrize(
    "path",
    [
        "/api/desk/bars/AAPL",
        "/api/desk/technicals/AAPL",
        "/api/desk/futures/specs",
        "/api/desk/status",
        "/api/desk/watchlists/1/items",
    ],
)
def test_read_routes_require_verified_identity(client, path):
    assert client.get(path).status_code == 401


def test_bars_unavailable_is_empty_not_fabricated(client):
    _set_bars(client, FakeBars(pd.DataFrame(columns=["open", "high", "low", "close", "volume"])))
    response = client.get("/api/desk/bars/AAPL", headers=auth_headers())
    assert response.status_code == 200
    assert response.json() == {
        "symbol": "AAPL",
        "interval": "1d",
        "quality": "unavailable",
        "as_of": None,
        "bars": [],
    }


def test_bars_maps_provider_no_data_to_unavailable(client):
    _set_bars(client, FakeBars(_daily_frame(), error=NoData("fake", "empty")))
    response = client.get("/api/desk/bars/AAPL", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["quality"] == "unavailable"
    assert response.json()["bars"] == []


def test_bars_keeps_fallback_label_and_valid_ticker_symbols(client):
    source = FakeBars(_daily_frame(), quality="fallback")
    _set_bars(client, source)
    response = client.get("/api/desk/bars/BRK.B?days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["symbol"] == "BRK.B"
    assert response.json()["quality"] == "fallback"
    assert response.json()["bars"][0]["c"] == 100.5
    assert source.calls[0][0:2] == ("BRK.B", "1d")


def test_bars_accepts_future_root_symbol(client):
    source = FakeBars(pd.DataFrame(columns=["open", "high", "low", "close", "volume"]))
    _set_bars(client, source)
    response = client.get("/api/desk/bars/%2FES", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["symbol"] == "/ES"
    assert source.calls[0][0] == "/ES"


def test_bars_rejects_invalid_symbol(client):
    response = client.get("/api/desk/bars/ABC!", headers=auth_headers())
    assert response.status_code == 422


@pytest.mark.parametrize("query", ["interval=bad", "days=0", "days=3651"])
def test_bars_rejects_invalid_interval_and_day_bounds(client, query):
    response = client.get(f"/api/desk/bars/AAPL?{query}", headers=auth_headers())
    assert response.status_code == 422


def test_bars_5m_resamples_provider_minute_bars(client):
    starts = pd.date_range("2024-12-30 14:30", periods=5, freq="min", tz="UTC")
    frame = pd.DataFrame(
        {
            "open": [10, 11, 12, 13, 14],
            "high": [11, 12, 13, 14, 15],
            "low": [9, 10, 11, 12, 13],
            "close": [10.5, 11.5, 12.5, 13.5, 14.5],
            "volume": [1, 2, 3, 4, 5],
        },
        index=starts,
    )
    source = FakeBars(frame)
    _set_bars(client, source)
    response = client.get("/api/desk/bars/AAPL?interval=5m&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert source.calls[0][1] == "1m"
    assert response.json()["interval"] == "5m"
    assert response.json()["bars"] == [
        {"t": "2024-12-30T14:30:00+00:00", "o": 10.0, "h": 15.0, "l": 9.0, "c": 14.5, "v": 15.0}
    ]


def test_bars_preserve_nonfinite_values_as_null(client):
    frame = _daily_frame()
    frame.iloc[0, frame.columns.get_loc("close")] = float("nan")
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/bars/AAPL?days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["bars"][0]["c"] is None


def test_bars_does_not_turn_provider_errors_into_empty_data(client):
    _set_bars(client, FakeBars(_daily_frame(), error=Unavailable("fake", "offline")))
    response = client.get("/api/desk/bars/AAPL", headers=auth_headers())
    assert response.status_code == 503


def test_bars_caps_returned_rows(client):
    now = pd.Timestamp.now(tz="UTC").floor("min")
    index = pd.date_range(end=now - pd.Timedelta(minutes=1), periods=6000, freq="min")
    frame = pd.DataFrame(
        {"open": 10.0, "high": 11.0, "low": 9.0, "close": 10.0, "volume": 1.0}, index=index
    )
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/bars/AAPL?interval=1m", headers=auth_headers())
    assert response.status_code == 200
    assert len(response.json()["bars"]) == 5000


def test_technicals_reports_warming_history(client):
    _set_bars(client, FakeBars(_daily_frame(20)))
    response = client.get("/api/desk/technicals/AAPL?timeframe=1d&days=2000", headers=auth_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["quality"] == "eod"
    assert body["as_of"] == "2024-12-31"
    assert body["gauges"]["summary"]["label"] == "warming up"
    assert body["gauges"]["summary"]["counts"] is None
    assert body["rsi"] == 100.0
    assert body["card_back"]["bias_label"] is None


def test_card_back_is_the_engine_output(client):
    frame = _daily_frame(262)
    from ai_trading.core.calendar import session

    frame = frame.loc[[session("stock", day) is not None for day in frame.index]]
    source = FakeBars(frame, quality="fallback")
    _set_bars(client, source)
    response = client.get("/api/desk/technicals/AAPL?timeframe=1d&days=2000", headers=auth_headers())
    assert response.status_code == 200
    card_back = compute_card_back("AAPL", "1D", frame, "stock")
    assert response.json()["card_back"] == asdict(card_back)
    assert response.json()["quality"] == "fallback"


def test_technicals_supports_one_minute_card_back(client):
    starts = pd.date_range("2024-12-30 14:30", periods=3, freq="min", tz="UTC")
    frame = pd.DataFrame(
        {"open": [10, 11, 12], "high": [11, 12, 13], "low": [9, 10, 11], "close": [10, 11, 12], "volume": [1, 2, 3]},
        index=starts,
    )
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/technicals/AAPL?timeframe=1m&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["card_back"]["timeframe"] == "1m"


@pytest.mark.parametrize("query", ["timeframe=bad", "days=0", "days=3651"])
def test_technicals_rejects_invalid_timeframe_and_day_bounds(client, query):
    response = client.get(f"/api/desk/technicals/AAPL?{query}", headers=auth_headers())
    assert response.status_code == 422


def test_futures_specs_have_all_contracts_and_no_guessed_margins(client):
    response = client.get("/api/desk/futures/specs", headers=auth_headers())
    assert response.status_code == 200
    specs = response.json()
    assert len(specs) == 12
    assert {spec["root"] for spec in specs} == set(SPECS)
    assert all(spec["approx_margin"] is None and spec["margin_as_of"] is None for spec in specs)
    assert all(spec["tick_size"] == SPECS[spec["root"]].tick_size for spec in specs)


def test_status_never_reports_gateway_up(client):
    response = client.get("/api/desk/status", headers=auth_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["gateway"] == "not_configured"
    assert body["streaming_slots"] == {"used": 0, "max": 70}
    assert body["backups"] is None
    assert body["reconciliation"] is None


def test_watchlist_items_backfill_is_derived_from_stored_daily_bars(client, db_session):
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]
    db_session.add(
        Bar1d(symbol="AAPL", day=date(2024, 12, 30), open=10, high=11, low=9, close=10, volume=1, source="test")
    )
    db_session.add(WatchlistItem(watchlist_id=watchlist_id, symbol="AAPL", asset_type="stock"))
    db_session.add(WatchlistItem(watchlist_id=watchlist_id, symbol="/ES", asset_type="future"))
    db_session.commit()

    response = client.get(f"/api/desk/watchlists/{watchlist_id}/items", headers=auth_headers())
    assert response.status_code == 200
    assert response.json() == [
        {"symbol": "AAPL", "asset_type": "stock", "backfill": "ready"},
        {"symbol": "/ES", "asset_type": "future", "backfill": "pending"},
    ]


def test_watchlist_items_are_owner_scoped(client):
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers(OWNER_EMAIL)
    ).json()["id"]
    response = client.get(f"/api/desk/watchlists/{watchlist_id}/items", headers=auth_headers(OTHER_EMAIL))
    assert response.status_code == 404


def test_openapi_has_every_desk_route(client):
    paths = client.get("/openapi.json").json()["paths"]
    expected = {
        "/api/desk/me": {"get"},
        "/api/desk/bars/{symbol}": {"get"},
        "/api/desk/technicals/{symbol}": {"get"},
        "/api/desk/futures/specs": {"get"},
        "/api/desk/status": {"get"},
        "/api/desk/watchlists/{watchlist_id}/items": {"get", "post"},
        "/api/desk/strategies": {"get", "post"},
        "/api/desk/strategies/{strategy_id}/versions": {"get", "post"},
        "/api/desk/strategies/{strategy_id}/stage": {"put"},
        "/api/desk/watchlists": {"get", "post"},
        "/api/desk/watchlists/{watchlist_id}/items/{symbol}": {"delete"},
        "/api/desk/signals": {"get"},
        "/api/desk/alerts": {"get"},
        "/api/desk/alerts/{alert_id}/read": {"post"},
        "/api/desk/settings": {"get", "put"},
    }
    assert all(methods <= paths[path].keys() for path, methods in expected.items())
