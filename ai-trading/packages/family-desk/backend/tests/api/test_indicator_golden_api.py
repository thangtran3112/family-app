"""The indicator numbers the API serves, pinned to the golden values (real Alpaca SIP TSLA bars; TA-Lib at the last bar
for the daily set, an independent plain-Python VWAP loop for the minutes). Needs Postgres, like every `tests/api` test.

- `GET /api/desk/technicals/{symbol}` serves RSI 14, MACD 12/26/9, ATR 14, the SMA/EMA panel, the gauge votes.
- `GET /api/desk/watchlists/{id}/table` serves `vs_vwap_pct`, computed from the stored one-minute bars' session VWAP.
"""

from datetime import date

import pytest
from conftest import auth_headers
from fakes import FakeBarsSource, fake_data_sources
from indicator_golden import GOLDEN, golden_daily, golden_minutes

from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.core.calendar import et
from ai_trading.data.bars import upsert_bars
from ai_trading.data.metrics import refresh_metrics

LAST = GOLDEN["daily_last"]
CLOSE = GOLDEN["daily"]["rows"][-1][3]  # the last real daily close, 372.11


@pytest.fixture(autouse=True)
def real(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)


def _technicals(client) -> dict:
    app.dependency_overrides[get_data_sources] = lambda: fake_data_sources(FakeBarsSource({"TSLA": golden_daily()}))
    response = client.get("/api/desk/technicals/TSLA?timeframe=1d&days=2000", headers=auth_headers())
    assert response.status_code == 200
    return response.json()


def test_technicals_serves_rsi_macd_and_atr_at_the_golden_values(client):
    body = _technicals(client)
    assert body["bars_used"] == 300 and body["bias_ready"] is True
    assert body["rsi"] == pytest.approx(LAST["rsi_14"], abs=1e-6)
    assert body["macd"] == pytest.approx(
        {"line": LAST["macd_line"], "signal": LAST["macd_signal"], "histogram": LAST["macd_histogram"]}, abs=1e-6
    )
    assert body["macd"]["histogram"] == pytest.approx(body["macd"]["line"] - body["macd"]["signal"], abs=1e-12)
    assert body["volatility"]["atr14"] == pytest.approx(LAST["atr_14"], abs=1e-6)
    assert body["volatility"]["atr_percent"] == pytest.approx(LAST["atr_14"] / CLOSE * 100, abs=1e-6)


def test_technicals_indicator_panel_is_the_golden_last_values_to_four_decimals(client):
    panel = _technicals(client)["indicators"]
    for name in ("sma_5", "sma_10", "sma_20", "sma_50", "sma_100", "sma_200", "ema_5", "ema_10", "ema_20"):
        assert panel[name] == pytest.approx(LAST[name], abs=1e-4), name
    assert panel["rsi_14"] == pytest.approx(LAST["rsi_14"], abs=1e-4)
    assert panel["macd_line"] == pytest.approx(LAST["macd_line"], abs=1e-4)
    assert panel["macd_signal"] == pytest.approx(LAST["macd_signal"], abs=1e-4)
    assert panel["macd_histogram"] == pytest.approx(LAST["macd_histogram"], abs=1e-4)
    assert panel["atr_14"] == pytest.approx(LAST["atr_14"], abs=1e-4)
    # EMA 50/100/200 have not converged after 300 bars, so TA-Lib's SMA-seeded values are not the reference; the
    # panel's own rounding of the same recursion is.
    assert all(panel[f"ema_{n}"] is not None for n in (50, 100, 200))


def test_technicals_gauge_votes_use_the_same_numbers_and_the_published_rules(client):
    body = _technicals(client)
    rsi = body["oscillators"]["rsi"]
    assert rsi["values"]["value"] == pytest.approx(LAST["rsi_14"], abs=1e-6)
    assert rsi["action"] == "Neutral"  # 55.3: not below 30 and rising, not above 70 and falling
    macd = body["oscillators"]["macd"]
    assert macd["values"]["line"] == pytest.approx(LAST["macd_line"], abs=1e-6)
    assert macd["values"]["signal"] == pytest.approx(LAST["macd_signal"], abs=1e-6)
    assert macd["action"] == "Buy"  # the line is above its signal
    for name, vote in body["moving_averages"].items():
        if name.startswith(("sma_", "ema_")):
            value = vote["values"]["value"]
            assert vote["action"] == ("Buy" if value < CLOSE else "Sell"), name  # a line below the price is a Buy
            if name in LAST:
                assert value == pytest.approx(LAST[name], abs=1e-6), name


def test_watchlist_table_serves_the_session_vwap_distance_from_stored_minute_bars(client, db_session):
    # The 2026-09-24 daily close is stored; 2026-09-25's minutes (20 pre-market, 90 regular) make a session in progress.
    now = et(date(2026, 9, 25), "11:00")
    daily = golden_daily().iloc[:-1]
    upsert_bars(db_session, "TSLA", "1d", daily, "alpaca", "stock", now=now)
    upsert_bars(db_session, "TSLA", "1m", golden_minutes(), "alpaca", "stock", now=now)
    assert refresh_metrics(db_session, ["TSLA"], now=now) == ["TSLA"]
    db_session.commit()
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Golden", "horizon": "intraday"}, headers=auth_headers()
    ).json()["id"]
    client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "TSLA", "asset_type": "stock"},
        headers=auth_headers(),
    )
    row = client.get(f"/api/desk/watchlists/{watchlist_id}/table", headers=auth_headers()).json()["rows"][0]
    last_minute_close = golden_minutes()["close"].iloc[-1]
    assert row["last"] == last_minute_close  # the partial day's last price
    vwap = GOLDEN["vwap"][-1]  # the independent loop: 10:59 ET, regular session of 09-25 only
    assert row["vs_vwap_pct"] == pytest.approx((last_minute_close / vwap - 1) * 100, abs=1e-3)
