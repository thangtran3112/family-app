"""Market-data family (02m §a3.3): bars, technicals, chart markers, signals and the quote stream in stub mode
(`DESK_MVP_STUB=1`, the SNAPSHOT fixture for SPY, NVDA, MSFT), plus the real-mode extended-hours and stamp."""

import asyncio
import json
from datetime import date

import pandas as pd
from conftest import OWNER_EMAIL, auth_headers
from fakes import FakeBarsSource, fake_data_sources
from sqlalchemy.orm import sessionmaker

from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.api.quotes import quote_events
from ai_trading.core.calendar import previous_session, session

STUB = "DESK_MVP_STUB"


def _stub_on(monkeypatch) -> None:
    monkeypatch.setenv(STUB, "1")


def test_bars_stub_nvda_15m_spot_checks(client, monkeypatch):
    _stub_on(monkeypatch)
    body = client.get("/api/desk/bars/NVDA?interval=15m", headers=auth_headers()).json()
    assert len(body["bars"]) == 52
    assert body["bars"][0] == {
        "t": "2026-10-22T13:30:00+00:00",
        "o": 217.22,
        "h": 218.88,
        "l": 216.74,
        "c": 217.75,
        "v": 7544059.0,
        "ext": False,
    }
    assert body["bars"][-1]["t"] == "2026-10-23T19:45:00+00:00"
    assert body["as_of"] == "2026-10-23T19:45:00+00:00"
    assert body["quality"] == "delayed-15m"
    assert body["stamp"] == {
        "as_of": "2026-10-23T20:00:00Z",
        "source": "alpaca",
        "quality": "delayed-15m",
        "freshness": "closed",
    }


def test_bars_stub_marks_friday_extended_hours_5m(client, monkeypatch):
    _stub_on(monkeypatch)
    body = client.get("/api/desk/bars/SPY?interval=5m&session=extended", headers=auth_headers()).json()
    first = body["bars"][0]
    assert first["t"] == "2026-10-23T08:00:00+00:00"  # 04:00 ET, pre-market
    assert first["ext"] is True
    # The Friday series holds only off-hours bars (session=extended), so every one is extended.
    assert all(bar["ext"] for bar in body["bars"])
    regular = client.get("/api/desk/bars/SPY?interval=5m", headers=auth_headers()).json()
    assert regular["bars"] and not any(bar["ext"] for bar in regular["bars"])


def test_bars_stub_daily_rows_are_midnight_utc_and_end_on_the_last_session(client, monkeypatch):
    _stub_on(monkeypatch)
    body = client.get("/api/desk/bars/SPY?interval=1d&days=3650", headers=auth_headers()).json()
    assert len(body["bars"]) == 60
    assert body["bars"][-1]["t"] == "2026-10-23"  # a daily bar is its bare date, as the real route emits
    assert body["bars"][-1]["ext"] is False
    assert body["quality"] == "eod"
    assert body["stamp"]["quality"] == "eod"


def test_bars_stub_days_counts_calendar_days_back_from_the_last_row(client, monkeypatch):
    _stub_on(monkeypatch)
    body = client.get("/api/desk/bars/NVDA?interval=15m&days=1", headers=auth_headers()).json()
    assert len(body["bars"]) == 26
    assert {bar["t"][:10] for bar in body["bars"]} == {"2026-10-23"}


def test_bars_stub_interval_without_bars_is_empty_with_an_unavailable_stamp(client, monkeypatch):
    _stub_on(monkeypatch)
    body = client.get("/api/desk/bars/NVDA?interval=30m", headers=auth_headers()).json()
    assert body["bars"] == []
    assert body["quality"] == "unavailable"
    assert body["stamp"] == {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"}


def test_bars_stub_unknown_symbol_is_404(client, monkeypatch):
    _stub_on(monkeypatch)
    response = client.get("/api/desk/bars/AAPL?interval=1d", headers=auth_headers())
    assert response.status_code == 404
    assert response.json()["detail"] == "symbol not in the stub fixture"


def test_bars_rejects_an_invalid_symbol_in_stub_mode(client, monkeypatch):
    _stub_on(monkeypatch)
    assert client.get("/api/desk/bars/ABC!", headers=auth_headers()).status_code == 422


def test_technicals_stub_nvda_15m_carries_every_new_field(client, monkeypatch):
    _stub_on(monkeypatch)
    body = client.get("/api/desk/technicals/NVDA?timeframe=15m", headers=auth_headers()).json()
    assert body["timeframe"] == "15m"
    assert body["bars_used"] == 858
    assert body["first_bar"] == "2026-09-09T13:30:00Z"
    assert body["last_bar"] == "2026-10-23T19:45:00Z"
    assert body["bias_ready"] is True
    assert body["indicators"]["rsi_14"] == 36.0418
    assert body["indicators"]["atr_label"] == "low"
    assert len(body["bias_history"]["history"]) == 26
    assert body["bias_history"]["history"][-1] == {
        "bar": "2026-10-23T19:45:00Z",
        "summary": "Sell",
        "score": -0.421,
        "oscillators": "Neutral",
        "moving_averages": "Strong Sell",
    }
    assert body["bias_history"]["last_change_in_window"] == {
        "from": "Strong Sell",
        "to": "Sell",
        "at_bar": "2026-10-23T19:45:00Z",
    }
    assert body["levels"] == {"prior_close": 212.21, "session_high": 213.85, "session_low": 210.18}
    assert body["gauges"]["strategies"]["label"] == "Buy"
    assert body["gauges"]["strategies"]["counts"] == {"buy": 2, "neutral": 0, "sell": 1}
    assert body["gauges"]["strategies"]["watching"] == [{"strategy_id": 1, "name": "ORB 15m"}]
    assert body["stamp"]["quality"] == "delayed-15m"
    assert body["gauges"]["summary"]["label"] == "Sell"  # the existing fields are unchanged


def test_technicals_stub_daily_bounds_are_midnight_utc_and_no_strategy_gauge_off_nvda_15m(client, monkeypatch):
    _stub_on(monkeypatch)
    body = client.get("/api/desk/technicals/NVDA?timeframe=1d", headers=auth_headers()).json()
    assert body["first_bar"] == "2025-07-31T00:00:00Z"
    assert body["bars_used"] == 311
    assert body["bias_history"]["last_change_in_window"]["at_bar"] == "2026-10-22T00:00:00Z"
    assert body["gauges"]["strategies"] is None
    assert body["stamp"]["quality"] == "eod"
    spy = client.get("/api/desk/technicals/SPY?timeframe=15m", headers=auth_headers()).json()
    assert spy["gauges"]["strategies"] is None


def test_technicals_stub_unknown_symbol_and_timeframe_are_404(client, monkeypatch):
    _stub_on(monkeypatch)
    assert client.get("/api/desk/technicals/AAPL?timeframe=15m", headers=auth_headers()).status_code == 404
    response = client.get("/api/desk/technicals/NVDA?timeframe=1m", headers=auth_headers())
    assert response.status_code == 404
    assert response.json()["detail"] == "timeframe not in the stub fixture"


def test_markers_stub_default_is_the_hammer_on_msft_15m(client, monkeypatch):
    _stub_on(monkeypatch)
    body = client.get("/api/desk/charts/MSFT/markers", params={"timeframe": "15m"}, headers=auth_headers()).json()
    assert [(p["pattern"], p["bar_start"], p["bar_close"]) for p in body["patterns"]] == [
        ("hammer", "2026-10-23T18:45:00Z", "2026-10-23T19:00:00Z")
    ]
    assert body["patterns"][0]["ohlc"] == [523.805, 524.09, 523.27, 524.035]
    assert body["fires"] == []


def test_markers_all_patterns_and_the_from_to_range(client, monkeypatch):
    _stub_on(monkeypatch)
    everything = client.get(
        "/api/desk/charts/NVDA/markers", params={"timeframe": "15m", "all_patterns": "true"}, headers=auth_headers()
    ).json()
    assert len(everything["patterns"]) == 15
    later = client.get(
        "/api/desk/charts/NVDA/markers",
        params={"timeframe": "15m", "all_patterns": "true", "from": "2026-10-23T18:00:00Z"},
        headers=auth_headers(),
    ).json()
    assert len(later["patterns"]) == 4  # the NVDA 15m occurrences from 14:00 ET on
    assert all(p["bar_start"] >= "2026-10-23T18:00:00" for p in later["patterns"])


def test_markers_fires_come_from_the_signal_feed_and_filter_on_bar_time(client, monkeypatch):
    _stub_on(monkeypatch)
    body = client.get("/api/desk/charts/AAPL/markers", headers=auth_headers()).json()
    assert body["patterns"] == []
    assert body["fires"] == [{"signal_id": 15, "strategy_name": "EMA 9/21 cross", "bar_time": "2026-10-23T16:15:00Z"}]
    after = client.get(
        "/api/desk/charts/AAPL/markers", params={"from": "2026-10-24T00:00:00Z"}, headers=auth_headers()
    ).json()
    assert after["fires"] == []


def test_markers_futures_root_path_and_auth_and_flag(client, monkeypatch):
    _stub_on(monkeypatch)
    futures = client.get("/api/desk/charts/%2FES/markers", headers=auth_headers())
    assert futures.status_code == 200
    assert futures.json() == {"patterns": [], "fires": []}
    assert client.get("/api/desk/charts/NVDA/markers").status_code == 401
    assert client.get("/api/desk/charts/ABC!/markers", headers=auth_headers()).status_code == 422
    monkeypatch.delenv(STUB, raising=False)
    off = client.get("/api/desk/charts/NVDA/markers", headers=auth_headers())
    assert off.status_code == 503
    assert off.json()["detail"] == "not available yet"


def test_signals_stub_is_newest_first_in_the_signal_shape(client, monkeypatch):
    _stub_on(monkeypatch)
    rows = client.get("/api/desk/signals", headers=auth_headers(OWNER_EMAIL)).json()
    assert len(rows) == 15
    newest = rows[0]
    assert newest["id"] == 15
    assert newest["symbol"] == "AAPL"
    assert newest["strategy_version_id"] == newest["strategy_id"] == 6
    assert newest["strategy_name"] == "EMA 9/21 cross"
    assert newest["kind"] == "other"
    assert newest["bar_time"] == newest["created_at"] == "2026-10-23T16:15:00Z"
    assert newest["data_quality"] == "delayed-15m"
    assert newest["evidence"] == {"ema(9)": 347.562449, "ema(21)": 347.643793}


def test_signals_stub_honours_symbol_since_and_paging(client, monkeypatch):
    _stub_on(monkeypatch)
    everything = [row["id"] for row in client.get("/api/desk/signals", headers=auth_headers()).json()]
    aapl = client.get("/api/desk/signals", params={"symbol": "AAPL"}, headers=auth_headers()).json()
    assert [row["symbol"] for row in aapl] == ["AAPL"]
    recent = client.get("/api/desk/signals", params={"since": "2026-10-23T16:00:00Z"}, headers=auth_headers()).json()
    assert [row["id"] for row in recent] == [15]
    page = client.get("/api/desk/signals", params={"limit": 2, "offset": 1}, headers=auth_headers()).json()
    assert [row["id"] for row in page] == everything[1:3]


def test_quote_stub_yields_the_last_15m_bar_close_then_stays_open(db_session, monkeypatch):
    _stub_on(monkeypatch)
    factory = sessionmaker(db_session.get_bind(), expire_on_commit=False)
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    calls = 0

    async def disconnect_after_two_polls() -> bool:
        nonlocal calls
        calls += 1
        return calls > 2

    async def run():
        return [event async for event in quote_events("NVDA", factory, disconnect_after_two_polls, sleep=fake_sleep)]

    events = asyncio.run(run())

    assert len(events) == 1
    assert events[0]["event"] == "quote"
    assert json_data(events[0]) == {
        "symbol": "NVDA",
        "close": 210.9975,
        "quality": "delayed-15m",
        "as_of": "2026-10-23T19:45:00Z",
        "freshness": "closed",
        "source": "alpaca",
        "session": "closed",
    }
    assert sleeps == [60.0, 60.0]  # two polls, one event: the stream stays open and does not resend


def test_quote_stub_leaves_other_symbols_to_the_stored_bars(db_session, monkeypatch):
    _stub_on(monkeypatch)
    factory = sessionmaker(db_session.get_bind(), expire_on_commit=False)

    async def disconnect_now() -> bool:
        return True

    async def run():
        return [event async for event in quote_events("AAPL", factory, disconnect_now)]

    assert asyncio.run(run()) == []


def test_real_bars_flag_extended_hours_and_carry_a_stamp(client):
    last_session = session("stock", previous_session("stock", date.today()))
    minutes = pd.DatetimeIndex(
        [
            last_session.regular_open - pd.Timedelta(minutes=1),
            last_session.regular_open,
            last_session.regular_close + pd.Timedelta(minutes=1),
        ]
    )
    frame = pd.DataFrame(
        {"open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5, "volume": 1.0},
        index=minutes,
    )
    app.dependency_overrides[get_data_sources] = lambda: fake_data_sources(FakeBarsSource({"AAPL": frame}))

    regular = client.get("/api/desk/bars/AAPL?interval=1m&days=30", headers=auth_headers()).json()
    extended = client.get("/api/desk/bars/AAPL?interval=1m&days=30&session=extended", headers=auth_headers()).json()

    assert [bar["ext"] for bar in regular["bars"]] == [False]
    assert [bar["ext"] for bar in extended["bars"]] == [True, True]
    assert extended["stamp"]["source"] == "alpaca"
    assert extended["stamp"]["quality"] == "delayed-15m"
    assert extended["stamp"]["as_of"] == minutes[-1].isoformat().replace("+00:00", "Z")


def json_data(event: dict[str, str]) -> dict:
    return json.loads(event["data"])
