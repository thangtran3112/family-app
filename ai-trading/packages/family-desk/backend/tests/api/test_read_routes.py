from dataclasses import asdict
from datetime import date, timedelta

import pandas as pd
import pytest
from ai_trading_common.bars import Bars
from ai_trading_common.errors import NoData, Unavailable
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from fakes import fake_data_sources
from fastapi.testclient import TestClient

from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.api.market_data import _weekly_bars, get_market_bars
from ai_trading.core import indicators
from ai_trading.core.calendar import previous_session, session
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


def _year_boundary_frame(end: date) -> pd.DataFrame:
    dates = []
    rows = []
    day = date(2024, 12, 2)
    while day <= end:
        if session("stock", day) is not None:
            dates.append(day)
            if day.month == 12:
                rows.append({"open": 100.0, "high": 110.0, "low": 60.0, "close": 100.0, "volume": 1.0})
            elif day == date(2025, 1, 2):
                rows.append({"open": 250.0, "high": 300.0, "low": 5.0, "close": 250.0, "volume": 1.0})
            elif day == date(2025, 1, 3):
                rows.append({"open": 350.0, "high": 400.0, "low": 4.0, "close": 350.0, "volume": 1.0})
            else:
                rows.append({"open": 100.0, "high": 120.0, "low": 80.0, "close": 100.0 + day.day, "volume": 1.0})
        day += timedelta(days=1)
    return pd.DataFrame(rows, index=pd.Index(dates))


def _minute_frame(rows: int = 390) -> pd.DataFrame:
    index = pd.date_range(_full_stock_session().regular_open, periods=rows, freq="min")
    values = [100.0 + i / 100 for i in range(rows)]
    return pd.DataFrame(
        {
            "open": values,
            "high": [value + 1 for value in values],
            "low": [value - 1 for value in values],
            "close": values,
            "volume": [1.0] * rows,
        },
        index=index,
    )


def _empty_minute_frame() -> pd.DataFrame:
    return pd.DataFrame(columns=["open", "high", "low", "close", "volume"], index=pd.DatetimeIndex([], tz="UTC"))


def _recent_full_stock_sessions(count: int = 1):
    day = date.today()
    found = []
    while len(found) < count:
        day = previous_session("stock", day)
        result = session("stock", day)
        if result.regular_close - result.regular_open == pd.Timedelta(hours=6, minutes=30):
            found.append(result)
    return list(reversed(found))


def _full_stock_session():
    return _recent_full_stock_sessions()[0]


def _most_recent_complete_week_session():
    cursor = date.today() + timedelta(days=1)
    now = pd.Timestamp.now(tz="UTC")
    while True:
        day = previous_session("stock", cursor)
        cursor = day
        found = session("stock", day)
        week_has_later_session = any(
            session("stock", day + timedelta(days=offset)) is not None for offset in range(1, 7 - day.weekday())
        )
        if found.regular_close <= now and not week_has_later_session:
            return found


def _minute_history(sessions: int = 15) -> pd.DataFrame:
    frames = []
    for trading_session in _recent_full_stock_sessions(sessions):
        index = pd.date_range(trading_session.regular_open, periods=390, freq="min")
        frames.append(pd.DataFrame({"open": 10.0, "high": 11.0, "low": 9.0, "close": 10.0, "volume": 1.0}, index=index))
    return pd.concat(frames).sort_index()


def _extended_minute_frame() -> pd.DataFrame:
    day = _full_stock_session()
    index = pd.DatetimeIndex(
        [
            *pd.date_range(day.regular_open - pd.Timedelta(minutes=5), periods=5, freq="min"),
            *pd.date_range(day.regular_open, periods=5, freq="min"),
            *pd.date_range(day.regular_close, periods=5, freq="min"),
        ]
    )
    values = [float(i + 10) for i in range(len(index))]
    return pd.DataFrame(
        {
            "open": values,
            "high": [value + 1 for value in values],
            "low": [value - 1 for value in values],
            "close": values,
            "volume": [1.0] * len(values),
        },
        index=index,
    )


def _premarket_minute_frame() -> pd.DataFrame:
    day = _full_stock_session()
    index = pd.date_range(day.regular_open - pd.Timedelta(minutes=5), periods=5, freq="min")
    return pd.DataFrame({"open": 10.0, "high": 11.0, "low": 9.0, "close": 10.0, "volume": 1.0}, index=index)


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
        "stamp": {"as_of": None, "source": "alpaca", "quality": "unavailable", "freshness": "unavailable"},
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
    starts = pd.date_range(_full_stock_session().regular_open, periods=5, freq="min")
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
        {"t": starts[0].isoformat(), "o": 10.0, "h": 15.0, "l": 9.0, "c": 14.5, "v": 15.0, "ext": False}
    ]


@pytest.mark.parametrize(("interval", "expected_rows"), [("15m", 26), ("30m", 13), ("4h", 2)])
def test_bars_aggregates_complete_new_intraday_intervals(client, interval, expected_rows):
    source = FakeBars(_minute_frame())
    _set_bars(client, source)
    response = client.get(f"/api/desk/bars/AAPL?interval={interval}&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert source.calls[0][1] == "1m"
    assert len(response.json()["bars"]) == expected_rows
    assert response.json()["bars"][0]["t"] == source.frame.index[0].isoformat()


def test_stock_chart_extended_bars_are_separate_and_opt_in(client):
    source = FakeBars(_extended_minute_frame())
    _set_bars(client, source)
    regular = client.get("/api/desk/bars/AAPL?interval=5m&days=2000", headers=auth_headers())
    extended = client.get("/api/desk/bars/AAPL?interval=5m&session=extended&days=2000", headers=auth_headers())
    assert regular.status_code == extended.status_code == 200
    assert [bar["t"] for bar in regular.json()["bars"]] == [source.frame.index[5].isoformat()]
    assert [bar["t"] for bar in extended.json()["bars"]] == [
        source.frame.index[0].isoformat(),
        source.frame.index[10].isoformat(),
    ]


def test_stock_technicals_exclude_extended_hours(client):
    source = FakeBars(_extended_minute_frame())
    _set_bars(client, source)
    response = client.get("/api/desk/technicals/AAPL?timeframe=1m&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["as_of"] == source.frame.index[9].isoformat()


@pytest.mark.parametrize("route", ["bars", "technicals"])
def test_regular_stock_route_returns_empty_when_premarket_is_all_that_survives(client, route):
    _set_bars(client, FakeBars(_premarket_minute_frame()))
    path = (
        "/api/desk/bars/AAPL?interval=15m&days=2000"
        if route == "bars"
        else "/api/desk/technicals/AAPL?timeframe=15m&days=2000"
    )
    response = client.get(path, headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["quality"] == "unavailable"
    if route == "bars":
        assert response.json()["bars"] == []
    else:
        assert response.json()["as_of"] is None
        assert response.json()["gauges"]["summary"]["label"] == "warming up"


def test_futures_technicals_keep_overnight_cme_bars(client):
    cme_day = previous_session("future", date.today())
    starts = pd.date_range(session("future", cme_day).extended_open + pd.Timedelta(minutes=30), periods=3, freq="min")
    frame = pd.DataFrame(
        {"open": [10.0] * 3, "high": [11.0] * 3, "low": [9.0] * 3, "close": [10.0] * 3, "volume": [1.0] * 3},
        index=starts,
    )
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/technicals/%2FES?timeframe=1m&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["as_of"] == starts[-1].isoformat()


def test_technicals_exposes_three_pivot_methods_from_prior_session(client):
    current = _full_stock_session()
    prior = session("stock", previous_session("stock", current.day))
    index = pd.DatetimeIndex([prior.regular_open, current.regular_open])
    frame = pd.DataFrame(
        {
            "open": [100.0, 110.0],
            "high": [105.0, 116.0],
            "low": [95.0, 109.0],
            "close": [100.0, 110.0],
            "volume": [10.0, 20.0],
        },
        index=index,
    )
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/technicals/AAPL?timeframe=1m&days=2000", headers=auth_headers())
    assert response.status_code == 200
    pivots = response.json()["pivots"]
    assert pivots["classic"]["P"] == 100.0
    assert pivots["classic"]["R1"] == 105.0
    assert pivots["fibonacci"]["R1"] == pytest.approx(103.82)
    assert pivots["camarilla"]["R1"] == pytest.approx(100 + 10 * 1.1 / 12)


def test_daily_technicals_pivots_use_prior_completed_week(client):
    index = pd.Index([date(2024, 12, day) for day in (23, 24, 26, 27, 30)])
    frame = pd.DataFrame(
        {
            "open": [100, 101, 102, 103, 115],
            "high": [101, 102, 103, 104, 120],
            "low": [99, 98, 97, 96, 110],
            "close": [100, 101, 102, 103, 115],
            "volume": [1] * 5,
        },
        index=index,
    )
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/technicals/AAPL?timeframe=1d&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["pivots"]["classic"]["P"] == 101.0


def test_weekly_technicals_pivots_use_prior_completed_month(client):
    dates = [date(2024, 11, day) for day in (25, 26, 27, 29)] + [date(2024, 12, day) for day in (2, 3, 4, 5, 6)]
    frame = pd.DataFrame(
        {
            "open": [100.0] * 9,
            "high": [101.0, 110.0, 105.0, 115.0, 121.0, 122.0, 123.0, 124.0, 125.0],
            "low": [99.0, 90.0, 95.0, 85.0, 119.0, 118.0, 117.0, 116.0, 115.0],
            "close": [100.0, 108.0, 103.0, 110.0, 120.0, 121.0, 122.0, 123.0, 124.0],
            "volume": [1.0] * 9,
        },
        index=pd.Index(dates),
    )
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/technicals/AAPL?timeframe=1w&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["pivots"]["classic"]["P"] == pytest.approx(310 / 3)


def test_weekly_pivots_use_january_after_jan_27_to_31_week(client):
    daily = _year_boundary_frame(date(2025, 1, 31))
    source = FakeBars(daily)
    _set_bars(client, source)
    response = client.get("/api/desk/technicals/AAPL?timeframe=1w&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert len(source.calls) == 1
    body = response.json()
    january_pivot = (400 + 4 + 131) / 3
    assert body["pivots"]["classic"]["P"] == pytest.approx(january_pivot)
    assert body["pivots"]["classic"]["R1"] == pytest.approx(2 * january_pivot - 4)
    assert body["pivots"]["fibonacci"]["P"] == pytest.approx(january_pivot)
    assert body["pivots"]["fibonacci"]["R1"] == pytest.approx(january_pivot + 0.382 * 396)
    assert body["pivots"]["camarilla"]["P"] == pytest.approx(january_pivot)
    assert body["pivots"]["camarilla"]["R1"] == pytest.approx(131 + 396 * 1.1 / 12)
    assert body["card_back"]["pivots"]["P"] == pytest.approx(january_pivot)
    assert body["card_back"]["pivots"]["R1"] == pytest.approx(2 * january_pivot - 4)
    weekly = _weekly_bars(daily, "stock")
    card_back = compute_card_back("AAPL", "1W", weekly, "stock", daily_bars=daily)
    assert body["card_back"] == asdict(card_back)
    assert weekly.index[-1] == date(2025, 1, 27)


def test_cross_month_week_does_not_mix_january_prices_into_december_pivots(client):
    daily = _year_boundary_frame(date(2025, 1, 10))
    source = FakeBars(daily)
    _set_bars(client, source)
    response = client.get("/api/desk/technicals/AAPL?timeframe=1w&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert len(source.calls) == 1
    body = response.json()
    december_pivot = (110 + 60 + 100) / 3
    assert body["pivots"]["classic"]["P"] == pytest.approx(december_pivot)
    assert body["pivots"]["classic"]["R1"] == pytest.approx(2 * december_pivot - 60)
    assert body["pivots"]["fibonacci"]["P"] == pytest.approx(december_pivot)
    assert body["pivots"]["fibonacci"]["R1"] == pytest.approx(december_pivot + 0.382 * 50)
    assert body["pivots"]["camarilla"]["P"] == pytest.approx(december_pivot)
    assert body["pivots"]["camarilla"]["R1"] == pytest.approx(100 + 50 * 1.1 / 12)
    assert body["card_back"]["pivots"]["P"] == pytest.approx(december_pivot)
    assert body["card_back"]["pivots"]["R1"] == pytest.approx(2 * december_pivot - 60)
    assert body["card_back"]["timeframe"] == "1W"
    assert _weekly_bars(daily, "stock").index[-1] == date(2025, 1, 6)


def test_technicals_serializes_nonfinite_pivots_as_null(client):
    current = _full_stock_session()
    prior = session("stock", previous_session("stock", current.day))
    frame = pd.DataFrame(
        {
            "open": [100.0, 110.0],
            "high": [float("inf"), 116.0],
            "low": [90.0, 109.0],
            "close": [100.0, 110.0],
            "volume": [10.0, 20.0],
        },
        index=pd.DatetimeIndex([prior.regular_open, current.regular_open]),
    )
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/technicals/AAPL?timeframe=1m&days=2000", headers=auth_headers())
    assert response.status_code == 200
    for method in response.json()["pivots"].values():
        assert method and all(value is None for value in method.values())


@pytest.mark.parametrize(
    ("timeframe", "card_timeframe", "source_timeframe"),
    [("15m", "15m", "1m"), ("30m", "30m", "1m"), ("4h", "4h", "1m"), ("1w", "1W", "1d")],
)
def test_technicals_support_approved_timeframes_and_normalize_card_names(
    client, timeframe, card_timeframe, source_timeframe
):
    frame = _daily_frame(40) if timeframe == "1w" else _minute_frame()
    source = FakeBars(frame)
    _set_bars(client, source)
    response = client.get(f"/api/desk/technicals/AAPL?timeframe={timeframe}&days=2000", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["card_back"]["timeframe"] == card_timeframe
    assert source.calls[0][1] == source_timeframe
    if timeframe == "1w":
        assert response.json()["as_of"] == "2024-12-23"


def test_weekly_bars_do_not_emit_a_partial_first_week(client):
    latest = _most_recent_complete_week_session()
    frame = pd.DataFrame(
        {"open": [10.0], "high": [11.0], "low": [9.0], "close": [10.0], "volume": [1.0]},
        index=pd.Index([latest.day]),
    )
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/bars/AAPL?interval=1w&days=14", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["bars"] == []
    assert response.json()["quality"] == "unavailable"


@pytest.mark.parametrize(("interval", "minutes"), [("15m", 15), ("30m", 30), ("4h", 240)])
def test_resampling_discards_left_cutoff_bin(interval, minutes):
    trading_session = _full_stock_session()
    frame = _minute_frame()
    cutoff = trading_session.regular_open + pd.Timedelta(minutes=2)
    now = cutoff + pd.Timedelta(days=1)
    source = FakeBars(frame)
    market = get_market_bars(
        fake_data_sources(source),
        "AAPL",
        interval,
        1,
        stock_session="regular",
        now=now,
    )
    result = market.frame
    expected_start = trading_session.regular_open + pd.Timedelta(minutes=minutes)
    expected_end = min(expected_start + pd.Timedelta(minutes=minutes), trading_session.regular_close)
    expected_rows = frame.loc[(frame.index >= expected_start) & (frame.index < expected_end)]
    assert market.quality == "eod"
    assert result.index[0] == expected_start
    assert result.iloc[0]["open"] == expected_rows["open"].iloc[0]
    assert result.iloc[0]["high"] == expected_rows["high"].max()
    assert result.iloc[0]["low"] == expected_rows["low"].min()
    assert result.iloc[0]["volume"] == expected_rows["volume"].sum()


def test_resampling_returns_empty_when_every_bin_is_still_forming():
    trading_session = _full_stock_session()
    starts = pd.date_range(trading_session.regular_open + pd.Timedelta(minutes=5), periods=2, freq="min")
    frame = pd.DataFrame({"open": 10.0, "high": 11.0, "low": 9.0, "close": 10.0, "volume": 1.0}, index=starts)
    now = trading_session.regular_open + pd.Timedelta(minutes=7)
    result = get_market_bars(fake_data_sources(FakeBars(frame)), "AAPL", "15m", 1, stock_session="regular", now=now)
    assert result.frame.empty
    assert result.quality == "unavailable"


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
    frame = _minute_history()
    _set_bars(client, FakeBars(frame))
    response = client.get("/api/desk/bars/AAPL?interval=1m", headers=auth_headers())
    assert response.status_code == 200
    assert len(response.json()["bars"]) == 5000


@pytest.mark.parametrize(
    ("path", "max_days", "source_interval"),
    [
        ("/api/desk/technicals/AAPL?timeframe=5m", 30, "1m"),
        ("/api/desk/bars/AAPL?interval=5m&days=3650", 30, "1m"),
        ("/api/desk/technicals/AAPL?timeframe=4h&days=3650", 220, "1m"),
    ],
)
def test_intraday_source_lookback_is_capped_before_provider_call(client, path, max_days, source_interval):
    source = FakeBars(_empty_minute_frame())
    _set_bars(client, source)
    response = client.get(path, headers=auth_headers())
    assert response.status_code == 200
    _, requested_interval, start, end, _ = source.calls[0]
    assert requested_interval == source_interval
    assert (end - start).days <= max_days


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
    assert body["oscillators"]["rsi"] == {"values": {"value": 100.0}, "action": "Neutral"}
    assert body["oscillators"]["momentum"]["values"]["value"] == pytest.approx(1.1)
    assert body["oscillators"]["momentum"]["action"] == "Buy"
    assert body["oscillators"]["stoch_rsi"]["values"]["k"] is None
    assert body["oscillators"]["stoch_rsi"]["action"] is None
    assert body["moving_averages"]["sma_10"]["values"]["value"] == pytest.approx(101.89)
    assert body["moving_averages"]["sma_10"]["action"] == "Buy"
    assert body["moving_averages"]["sma_200"]["action"] is None
    assert body["card_back"]["bias_label"] is None
    # Additive (02m §a3.3): real mode reports the bar bounds, readiness, the last-value map and the levels.
    assert body["timeframe"] == "1d"
    assert body["bars_used"] == 19  # 20 weekdays; the 2024-12-25 holiday has no closed bar
    assert body["first_bar"] == "2024-12-04T00:00:00Z"
    assert body["last_bar"] == "2024-12-31T00:00:00Z"
    assert body["bias_ready"] is False
    assert body["indicators"]["sma_10"] == pytest.approx(101.89)
    assert body["indicators"]["sma_50"] is None  # 19 bars: the long averages are not known yet
    assert body["bias_history"] is None  # still warming up: no bar has a bias
    assert body["levels"]["session_high"] is not None and body["levels"]["prior_close"] is not None
    assert body["gauges"]["strategies"] is None  # no attached strategy
    assert body["stamp"]["quality"] == "eod"
    assert body["stamp"]["source"] == "alpaca"


def test_technicals_volatility_is_unknown_for_empty_bars_without_changing_card_back(client):
    frame = pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    _set_bars(client, FakeBars(frame))

    response = client.get("/api/desk/technicals/AAPL?timeframe=1d&days=2000", headers=auth_headers())

    assert response.status_code == 200
    body = response.json()
    assert body["volatility"] == {"atr14": None, "atr_percent": None, "label": None}
    assert body["gauges"]["summary"]["label"] == "warming up"
    assert body["card_back"] == asdict(compute_card_back("AAPL", "1D", frame, "stock"))
    assert body["card_back"]["atr_pct_label"] == "normal"


def test_technicals_volatility_reports_atr_but_not_unwarmed_classification(client):
    frame = _daily_frame(20)
    _set_bars(client, FakeBars(frame))

    response = client.get("/api/desk/technicals/AAPL?timeframe=1d&days=2000", headers=auth_headers())

    assert response.status_code == 200
    body = response.json()
    assert body["gauges"]["summary"]["label"] == "warming up"
    assert body["volatility"]["atr14"] == pytest.approx(indicators.atr(frame, 14).iloc[-1])
    assert body["volatility"]["atr_percent"] == pytest.approx(indicators.atr_percent(frame).pct.iloc[-1])
    assert body["volatility"]["label"] is None
    assert body["card_back"]["atr_pct_label"] == "normal"


def test_technicals_volatility_withholds_nonfinite_measurements_and_label(client):
    frame = _daily_frame(113)
    frame.iloc[-1, frame.columns.get_loc("high")] = float("inf")
    _set_bars(client, FakeBars(frame))

    response = client.get("/api/desk/technicals/AAPL?timeframe=1d&days=2000", headers=auth_headers())

    assert response.status_code == 200
    assert response.json()["volatility"] == {"atr14": None, "atr_percent": None, "label": None}


def test_technicals_volatility_exposes_full_classification(client):
    frame = _daily_frame(130)
    _set_bars(client, FakeBars(frame))
    expected = indicators.atr_percent(frame)

    response = client.get("/api/desk/technicals/AAPL?timeframe=1d&days=2000", headers=auth_headers())

    assert response.status_code == 200
    volatility = response.json()["volatility"]
    assert volatility["atr14"] == pytest.approx(indicators.atr(frame, 14).iloc[-1])
    assert volatility["atr_percent"] == pytest.approx(expected.pct.iloc[-1])
    assert volatility["label"] == expected.label.iloc[-1] == "normal"


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
    frame = _minute_frame(3)
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
    # Additive fields (02m §a3.1): with no feed rows and no alerts, nothing is reported as live.
    assert body["data_sources"] == "unknown"
    assert body["quotes"]["quality"] == "unavailable"
    assert body["scans"]["next_run_at"] is None
    assert body["alerts"] == {"state": "not_started", "unread": 0}


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
