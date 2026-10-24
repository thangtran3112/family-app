"""`GET /api/desk/dashboard` on the real path (stub flag off, 02m §a3.2): the market strip, today's signals, the
screener cards, the watchlist heat, the events, and the empty day, all composed from stored rows. Needs Postgres."""

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import pytest
from ai_trading_common.errors import Unavailable
from ai_trading_common.types import EarningsEvent
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from fakes import fake_data_sources
from sqlalchemy import select

from ai_trading.api import dashboard as dashboard_module
from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.cli.seed_technical import seed_user
from ai_trading.db.models import (
    FeedHealth,
    FilterMatch,
    FilterRun,
    Signal,
    Strategy,
    StrategyVersion,
    SymbolMetrics,
    User,
    WatchlistItem,
)
from ai_trading.screener import service

URL = "/api/desk/dashboard"
NOW = datetime(2026, 10, 6, 15, 0, tzinfo=UTC)  # Tuesday 11:00 ET, regular session
SCAN_AT = NOW - timedelta(minutes=15)
UNAVAILABLE = {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"}
PLAIN = {"op": "gt", "left": {"series": "close"}, "right": {"value": 1}}
ORB = {"op": "gt", "left": {"series": "close"}, "right": {"level": "opening_range_high"}}
PATTERN = {"op": "pattern", "pattern": "hammer"}


class _Frozen(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz or UTC)


class FakeCalendar:
    """`earnings_calendar` of `DataSources`: canned events per symbol; a symbol in `failing` raises."""

    def __init__(self, by_symbol=None, failing=()):
        self.by_symbol = by_symbol or {}
        self.failing = set(failing)
        self.calls: list[str] = []

    def earnings_calendar(self, symbol, start, end):
        self.calls.append(symbol)
        if symbol in self.failing:
            raise Unavailable("fake", "down")
        return self.by_symbol.get(symbol, [])


def _event(symbol: str, day: date, timing: str = "after_close") -> EarningsEvent:
    return EarningsEvent(
        symbol=symbol,
        report_date=day,
        timing=timing,
        fiscal_year=None,
        fiscal_quarter=None,
        eps_estimate=None,
        eps_actual=None,
        revenue_estimate=None,
        revenue_actual=None,
        provider="fake",
        quality="eod",
    )


@pytest.fixture(autouse=True)
def real(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    monkeypatch.setattr(dashboard_module, "datetime", _Frozen)
    dashboard_module._EVENT_CACHE.clear()
    yield
    dashboard_module._EVENT_CACHE.clear()


@pytest.fixture
def calendar(client) -> FakeCalendar:
    fake = FakeCalendar()
    app.dependency_overrides[get_data_sources] = lambda: replace(fake_data_sources(), earnings_calendar=fake)
    return fake


def _get(client, email: str = OWNER_EMAIL, **params):
    return client.get(URL, params=params, headers=auth_headers(email))


def _user_id(client, db_session, email: str = OWNER_EMAIL) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _watchlist(client, name: str, symbols=(), horizon: str = "intraday", email: str = OWNER_EMAIL) -> int:
    response = client.post("/api/desk/watchlists", json={"name": name, "horizon": horizon}, headers=auth_headers(email))
    watchlist_id = response.json()["id"]
    for symbol in symbols:
        client.post(
            f"/api/desk/watchlists/{watchlist_id}/items",
            json={"symbol": symbol, "asset_type": "stock"},
            headers=auth_headers(email),
        )
    return watchlist_id


def _metrics(db_session, symbol: str, as_of: datetime = SCAN_AT, **values) -> None:
    db_session.add(SymbolMetrics(symbol=symbol, as_of=as_of, source="alpaca", quality="delayed-15m", metrics=values))
    db_session.commit()


def _scan_ok(db_session, at: datetime = NOW) -> None:
    db_session.add(FeedHealth(feed="scan", state="ok", last_ok_at=at, updated_at=at))
    db_session.commit()


def _strategy(db_session, user_id: int, name: str, spec_extra: dict | None = None, when: dict | None = PLAIN):
    spec = {"schemaVersion": 1, "name": name, **({"when": when} if when else {}), **(spec_extra or {})}
    row = Strategy(owner_user_id=user_id, name=name, stage="alert_only", lane="technical", created_at=NOW)
    db_session.add(row)
    db_session.flush()
    version = StrategyVersion(
        strategy_id=row.id, version=1, schema_version=1, spec=spec, created_by=user_id, created_at=NOW
    )
    db_session.add(version)
    db_session.flush()
    row.current_version_id = version.id
    db_session.commit()
    return row, version


def _signal(db_session, version, symbol: str, bar_time: datetime, evidence: dict | None = None) -> None:
    db_session.add(
        Signal(
            strategy_version_id=version.id,
            symbol=symbol,
            bar_time=bar_time,
            evidence=evidence or {},
            data_quality="delayed-15m",
            created_at=bar_time,
        )
    )
    db_session.commit()


# -- the empty day -----------------------------------------------------------------------------------------------


def test_a_new_user_with_nothing_stored_gets_an_empty_but_valid_dashboard(client, calendar):
    body = _get(client).json()
    assert body["stamp"] == UNAVAILABLE
    assert body["market"] == {"session": "regular", "next_open": "2026-10-07T13:30:00Z"}
    assert [tile["symbol"] for tile in body["market_strip"]] == ["SPY", "QQQ", "IWM", "/ES", "/NQ"]
    assert all(
        t["last"] is None and t["change_pct"] is None and t["stamp"] == UNAVAILABLE for t in body["market_strip"]
    )
    assert body["signals"] == [] and body["screener_matches"] == [] and body["events"] == []
    assert body["watchlist"] == {"id": 0, "name": "", "rows": []}
    assert body["alerts_state"] == "not_started"
    assert calendar.calls == []  # no symbols, no provider call


# -- the market strip --------------------------------------------------------------------------------------------


def test_the_strip_reads_stored_metrics_and_never_fabricates_futures_or_a_missing_etf(client, db_session, calendar):
    _scan_ok(db_session)
    _metrics(db_session, "SPY", last=678.12, change_pct=0.31)
    _metrics(db_session, "QQQ", as_of=NOW - timedelta(minutes=30), last=500.0, change_pct=-0.2)
    body = _get(client).json()
    tiles = {tile["symbol"]: tile for tile in body["market_strip"]}
    assert tiles["SPY"]["last"] == 678.12 and tiles["SPY"]["change_pct"] == 0.31
    assert tiles["SPY"]["stamp"] == {
        "as_of": "2026-10-06T14:45:00Z",
        "source": "alpaca",
        "quality": "delayed-15m",
        "freshness": "delayed",
    }
    assert tiles["QQQ"]["stamp"]["as_of"] == "2026-10-06T14:30:00Z"
    assert (tiles["IWM"]["last"], tiles["IWM"]["stamp"]) == (None, UNAVAILABLE)  # no row yet
    for future in ("/ES", "/NQ"):
        assert (tiles[future]["last"], tiles[future]["change_pct"], tiles[future]["stamp"]) == (None, None, UNAVAILABLE)
    assert body["stamp"]["as_of"] == "2026-10-06T14:45:00Z"  # the newest stored row


def test_a_scan_feed_that_stopped_reads_paused_and_one_that_never_ran_reads_unavailable(client, db_session, calendar):
    _metrics(db_session, "SPY", last=678.12, change_pct=0.31)
    assert _get(client).json()["market_strip"][0]["stamp"]["freshness"] == "unavailable"  # no feed_health row
    _scan_ok(db_session, at=NOW - timedelta(hours=1))
    assert _get(client).json()["market_strip"][0]["stamp"]["freshness"] == "paused"


# -- signals -----------------------------------------------------------------------------------------------------


def test_signals_are_todays_session_newest_first_with_strategy_name_and_kind(client, db_session, calendar):
    user_id = _user_id(client, db_session)
    other_id = _user_id(client, db_session, OTHER_EMAIL)
    orb, orb_version = _strategy(db_session, user_id, "ORB 15m", when=ORB)
    _, hammer_version = _strategy(db_session, user_id, "Hammer", when=PATTERN)
    _, theirs = _strategy(db_session, other_id, "Theirs")
    _signal(db_session, orb_version, "NVDA", datetime(2026, 10, 6, 13, 45, tzinfo=UTC), {"close": 212.4})
    _signal(db_session, hammer_version, "AAPL", datetime(2026, 10, 6, 14, 30, tzinfo=UTC))
    _signal(db_session, hammer_version, "MSFT", datetime(2026, 10, 6, 7, 59, tzinfo=UTC))  # before 04:00 ET
    _signal(db_session, theirs, "TSLA", datetime(2026, 10, 6, 14, 0, tzinfo=UTC))

    signals = _get(client).json()["signals"]

    assert [(s["symbol"], s["kind"], s["strategy_name"]) for s in signals] == [
        ("AAPL", "pattern", "Hammer"),
        ("NVDA", "orb", "ORB 15m"),
    ]
    assert signals[1]["strategy_id"] == orb.id
    assert signals[1]["bar_time"] == "2026-10-06T13:45:00Z"
    assert signals[1]["evidence"] == {"close": 212.4}
    assert signals[1]["summary"] == "ORB 15m on NVDA"


def test_signals_are_capped_at_twenty_and_a_strategy_without_a_when_is_other(client, db_session, calendar):
    user_id = _user_id(client, db_session)
    _, plain = _strategy(db_session, user_id, "Plain")
    _, legacy = _strategy(db_session, user_id, "Legacy", when=None)  # the generic strategy lane has no `when`
    for index in range(25):
        _signal(db_session, plain, f"S{index:02d}", datetime(2026, 10, 6, 13, 0, tzinfo=UTC) + timedelta(minutes=index))
    _signal(db_session, legacy, "LGCY", datetime(2026, 10, 6, 14, 55, tzinfo=UTC))

    signals = _get(client).json()["signals"]

    assert len(signals) == 20
    assert signals[0]["symbol"] == "LGCY" and signals[0]["kind"] == "other"
    assert [s["bar_time"] for s in signals] == sorted((s["bar_time"] for s in signals), reverse=True)


@pytest.mark.parametrize(
    ("now", "opened"),
    [
        (datetime(2026, 10, 6, 15, 0, tzinfo=UTC), datetime(2026, 10, 6, 8, 0, tzinfo=UTC)),  # Tue 11:00 ET: today
        (datetime(2026, 10, 6, 7, 0, tzinfo=UTC), datetime(2026, 10, 5, 8, 0, tzinfo=UTC)),  # Tue 03:00 ET: Monday's
        (datetime(2026, 10, 10, 15, 0, tzinfo=UTC), datetime(2026, 10, 9, 8, 0, tzinfo=UTC)),  # Saturday: Friday's
        (datetime(2026, 11, 26, 15, 0, tzinfo=UTC), datetime(2026, 11, 25, 9, 0, tzinfo=UTC)),  # Thanksgiving: Wed's
    ],
)
def test_the_session_a_signal_must_fall_in_is_the_newest_one_that_has_begun(now, opened):
    assert dashboard_module.session_start(now) == opened


# -- screener cards ----------------------------------------------------------------------------------------------


def _run(db_session, version_id: int, symbols: list[str], *, scanned: int, total: int, run_on: str) -> None:
    run = FilterRun(
        filter_strategy_version_id=version_id,
        run_on=run_on,
        session="regular",
        evaluation_point=SCAN_AT,
        scanned=scanned,
        no_data=0,
        matches_total=total,
        source="alpaca",
        quality="delayed-15m",
        created_at=NOW,
    )
    db_session.add(run)
    db_session.flush()
    for rank, symbol in enumerate(symbols, start=1):
        db_session.add(
            FilterMatch(
                run_id=run.id,
                symbol=symbol,
                rank=rank,
                rank_value=float(100 - rank),
                matched_since=SCAN_AT,
                operands={},
                columns={},
            )
        )
    db_session.commit()


def test_each_active_filter_is_a_card_from_its_last_run_and_one_that_never_ran_reads_unavailable(
    client, db_session, calendar
):
    user_id = _user_id(client, db_session)
    seed_user(db_session, user_id, now=NOW)
    db_session.commit()
    _scan_ok(db_session)
    views = service.list_filters(db_session, user_id)
    abnormal = next(v for v in views if v.row.seed_key == "abnormal-volume")
    _run(db_session, abnormal.version.id, ["BOLT", "LKQ", "SPTI", "ZZZ"], scanned=131, total=9, run_on="bar_close_15m")

    cards = _get(client).json()["screener_matches"]

    assert [c["filter_id"] for c in cards] == [v.row.id for v in views]  # seeds in catalog order
    first = next(c for c in cards if c["filter_id"] == abnormal.row.id)
    assert first == {
        "filter_id": abnormal.row.id,
        "name": "Abnormal volume",
        "run_on": "bar_close_15m",
        "scanned": 131,
        "matches_total": 9,
        "top": ["BOLT", "LKQ", "SPTI"],
        "stamp": {
            "as_of": "2026-10-06T14:45:00Z",
            "source": "alpaca",
            "quality": "delayed-15m",
            "freshness": "delayed",
        },
    }
    rest = [c for c in cards if c["filter_id"] != abnormal.row.id]
    assert rest and all(c["scanned"] == 0 and c["matches_total"] == 0 and c["top"] == [] for c in rest)
    assert all(c["stamp"] == UNAVAILABLE for c in rest)


def test_another_users_filters_are_not_on_my_dashboard(client, db_session, calendar):
    other_id = _user_id(client, db_session, OTHER_EMAIL)
    seed_user(db_session, other_id, now=NOW)
    db_session.commit()
    _user_id(client, db_session)
    assert _get(client).json()["screener_matches"] == []


# -- watchlist heat ----------------------------------------------------------------------------------------------


def test_the_default_list_is_her_first_intraday_list_else_her_first_list(client, db_session, calendar):
    swing = _watchlist(client, "Swing", ["AAA"], horizon="swing")
    assert _get(client).json()["watchlist"]["id"] == swing  # no intraday list: the first list
    day = _watchlist(client, "Day movers", ["BBB"])
    watchlist = _get(client).json()["watchlist"]
    assert (watchlist["id"], watchlist["name"]) == (day, "Day movers")  # the older swing list is not the default


def test_rows_follow_her_order_and_carry_the_stored_metrics_and_bias(client, db_session, calendar):
    watchlist_id = _watchlist(client, "Day movers", ["AAA", "BBB", "CCC"])
    client.put(
        f"/api/desk/watchlists/{watchlist_id}/order", json={"symbols": ["CCC", "AAA", "BBB"]}, headers=auth_headers()
    )
    _metrics(db_session, "AAA", last=10.5, change_pct=-1.1, rvol_10d=0.98, vs_vwap_pct=-0.2, bias_15m="Sell")
    _metrics(db_session, "CCC", last=3.0, change_pct=2.0)

    rows = _get(client, watchlist_id=watchlist_id).json()["watchlist"]["rows"]

    assert rows == [
        {
            "symbol": "CCC",
            "last": 3.0,
            "change_pct": 2.0,
            "rvol_10d": None,
            "vs_vwap_pct": None,
            "bias_label": "warming up",
        },
        {
            "symbol": "AAA",
            "last": 10.5,
            "change_pct": -1.1,
            "rvol_10d": 0.98,
            "vs_vwap_pct": -0.2,
            "bias_label": "Sell",
        },
        {
            "symbol": "BBB",
            "last": None,
            "change_pct": None,
            "rvol_10d": None,
            "vs_vwap_pct": None,
            "bias_label": "warming up",
        },
    ]


def test_a_missing_or_another_users_watchlist_is_a_404(client, db_session, calendar):
    theirs = _watchlist(client, "Theirs", ["AAA"], email=OTHER_EMAIL)
    _user_id(client, db_session)
    for watchlist_id in (theirs, 9999):
        response = _get(client, watchlist_id=watchlist_id)
        assert response.status_code == 404
        assert response.json() == {"detail": "watchlist not found"}


# -- events ------------------------------------------------------------------------------------------------------


def test_events_are_earnings_in_the_next_two_weeks_for_stocks_on_any_of_her_lists(client, db_session, calendar):
    day = _watchlist(client, "Day movers", ["AAA", "BBB"])
    _watchlist(client, "Swing", ["AAA", "CCC"], horizon="swing")
    db_session.add(WatchlistItem(watchlist_id=day, symbol="/ES", asset_type="future", position=9))
    db_session.commit()
    calendar.by_symbol = {
        "AAA": [_event("AAA", date(2026, 10, 14)), _event("AAA", date(2026, 10, 28))],  # the second is out of range
        "BBB": [_event("BBB", date(2026, 10, 7), "before_open")],
        "CCC": [_event("CCC", date(2026, 10, 7))],
        "/ES": [_event("/ES", date(2026, 10, 8))],
    }

    events = _get(client, watchlist_id=day).json()["events"]

    assert events == [
        {"symbol": "BBB", "kind": "earnings", "date": "2026-10-07", "timing": "before_open"},
        {"symbol": "CCC", "kind": "earnings", "date": "2026-10-07", "timing": "after_close"},
        {"symbol": "AAA", "kind": "earnings", "date": "2026-10-14", "timing": "after_close"},
    ]
    assert sorted(calendar.calls) == ["AAA", "BBB", "CCC"]  # the future is never asked for


def test_a_failing_provider_leaves_its_symbol_out_and_the_page_still_loads(client, db_session, calendar):
    _watchlist(client, "Day movers", ["AAA", "BBB"])
    calendar.failing = {"AAA"}
    calendar.by_symbol = {"BBB": [_event("BBB", date(2026, 10, 7))]}

    response = _get(client)

    assert response.status_code == 200
    assert [e["symbol"] for e in response.json()["events"]] == ["BBB"]


def test_the_calendar_is_asked_once_per_symbol_not_per_page_load(client, db_session, calendar):
    _watchlist(client, "Day movers", ["AAA"])
    calendar.by_symbol = {"AAA": [_event("AAA", date(2026, 10, 7))]}
    _get(client)
    _get(client)
    assert calendar.calls == ["AAA"]


# -- alert state and ownership of the route ----------------------------------------------------------------------


def test_alerts_state_follows_pause_all(client, db_session, calendar):
    user_id = _user_id(client, db_session)
    _strategy(db_session, user_id, "Plain")
    assert _get(client).json()["alerts_state"] == "paused_no_quotes"  # a session is open and the feed never ran
    db_session.add(FeedHealth(feed="bars_delayed", state="ok", last_ok_at=NOW, updated_at=NOW))
    db_session.commit()
    assert _get(client).json()["alerts_state"] == "running"
    client.put("/api/desk/settings", json={"settings": {"pause_all": True}}, headers=auth_headers())
    assert _get(client).json()["alerts_state"] == "paused_by_user"


def test_the_route_needs_the_identity_header(client, calendar):
    assert client.get(URL).status_code == 401
