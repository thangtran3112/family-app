"""`/api/desk/screener*` on the real path (stub flag off): filter CRUD against Postgres, the runner that fills
results, and the preview. Needs a real Postgres (`scripts/test-db.sh`)."""

from datetime import UTC, date, datetime, timedelta

import pytest
from bars import daily_bars, trading_days
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import func, select

from ai_trading.cli.seed_technical import seed_user
from ai_trading.core.calendar import session as trading_session
from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import (
    FeedHealth,
    FilterMatch,
    FilterRun,
    FilterStrategy,
    SymbolMetrics,
    UniverseSymbol,
    User,
    Watchlist,
    WatchlistItem,
)
from ai_trading.library.catalog import load_catalog, load_template
from ai_trading.screener import runner, service

BASE = "/api/desk/screener"
LAST = date(2026, 10, 6)  # a regular session
#: 21:00 ET on the session: past the extended-hours close, so the market is closed and every bar has closed.
NOW = trading_session("stock", LAST).regular_close.to_pydatetime() + timedelta(hours=5)
ABOVE_100 = {
    "schemaVersion": 1,
    "name": "Above 100",
    "watch": {"universe": {"market": "us_equities"}, "session": "regular", "runOn": "daily_close"},
    "liquidity": {"minPrice": 5, "minAvgVolume": 500000},
    "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 100}},
    "rank": {"by": {"series": "volume"}, "order": "desc"},
    "maxResults": 50,
}


@pytest.fixture(autouse=True)
def real(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)


def _user_id(client, db_session, email: str = OWNER_EMAIL) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _seed(client, db_session, email: str = OWNER_EMAIL) -> int:
    user_id = _user_id(client, db_session, email)
    seed_user(db_session, user_id, now=NOW)
    db_session.commit()
    return user_id


def _bars(db_session, symbol: str, closes: list[float], volume: float = 1_000_000, name: str | None = None) -> None:
    upsert_bars(
        db_session,
        symbol,
        "1d",
        daily_bars(trading_days("stock", LAST, len(closes)), closes, volume=volume),
        "alpaca",
        "stock",
        now=NOW,
    )
    db_session.add(
        UniverseSymbol(
            symbol=symbol,
            name=name or symbol,
            asset_type="stock",
            exchange="NASDAQ",
            active=True,
            passed_floor=True,
            floor_reason=None,
            updated_at=NOW,
        )
    )
    db_session.commit()


def _create(client, spec: dict, email: str = OWNER_EMAIL):
    return client.post(f"{BASE}/filters", json={"spec": spec}, headers=auth_headers(email))


# -- list, detail, ownership -------------------------------------------------------------------------------


def test_list_has_the_ten_seeds_in_catalog_order_then_hers_by_name(client, db_session):
    _seed(client, db_session)
    _create(client, {**ABOVE_100, "name": "Zebra"})
    _create(client, {**ABOVE_100, "name": "apple"})
    rows = client.get(f"{BASE}/filters", headers=auth_headers()).json()
    catalog = [e.id for e in load_catalog().entries if e.kind == "filter"]
    assert [r["seed_key"] for r in rows[:10]] == catalog
    assert [r["name"] for r in rows[10:]] == ["apple", "Zebra"]
    assert all(r["read_only"] and r["origin"] == "seed" for r in rows[:10])
    assert all(not r["read_only"] and r["origin"] == "user" and r["seed_key"] is None for r in rows[10:])
    assert rows[0]["last_run"] is None  # nothing has run yet


def test_detail_of_a_seed_is_read_only_and_a_copy_knows_the_seed_it_came_from(client, db_session):
    _seed(client, db_session)
    rows = client.get(f"{BASE}/filters", headers=auth_headers()).json()
    abnormal = next(r for r in rows if r["seed_key"] == "abnormal-volume")
    seed = client.get(f"{BASE}/filters/{abnormal['id']}", headers=auth_headers()).json()
    assert (seed["origin"], seed["read_only"], seed["version"], seed["default_spec"]) == ("seed", True, 1, None)
    assert seed["spec"]["watch"]["runOn"] == "bar_close_15m"

    copy = client.post(f"{BASE}/filters", json={"copy_of": abnormal["id"]}, headers=auth_headers())
    assert copy.status_code == 201
    body = copy.json()
    assert (body["name"], body["origin"], body["read_only"], body["version"]) == (
        "Abnormal volume (copy)",
        "user",
        False,
        1,
    )
    assert body["spec"]["name"] == "Abnormal volume (copy)"
    assert body["default_spec"] == seed["spec"]  # "Reset to default" returns to the seed template
    again = client.post(f"{BASE}/filters", json={"copy_of": abnormal["id"]}, headers=auth_headers()).json()
    assert again["name"] == "Abnormal volume (copy 2)"
    copy_of_copy = client.post(f"{BASE}/filters", json={"copy_of": body["id"]}, headers=auth_headers()).json()
    assert copy_of_copy["name"] == "Abnormal volume (copy) (copy)"
    assert copy_of_copy["default_spec"] == seed["spec"]


def test_another_users_filter_is_a_404_for_every_verb(client, db_session):
    _seed(client, db_session, OTHER_EMAIL)
    theirs = client.get(f"{BASE}/filters", headers=auth_headers(OTHER_EMAIL)).json()[0]["id"]
    _user_id(client, db_session, OWNER_EMAIL)
    for method, path, body in (
        ("GET", f"/filters/{theirs}", None),
        ("GET", f"/filters/{theirs}/results", None),
        ("PUT", f"/filters/{theirs}", {"spec": ABOVE_100}),
        ("DELETE", f"/filters/{theirs}", None),
        ("POST", "/filters", {"copy_of": theirs}),
    ):
        response = client.request(method, f"{BASE}{path}", json=body, headers=auth_headers())
        assert response.status_code == 404, (method, path)


def test_an_unknown_filter_is_404(client):
    assert client.get(f"{BASE}/filters/999", headers=auth_headers()).status_code == 404


# -- create, update, archive -------------------------------------------------------------------------------


def test_create_from_a_spec_stores_version_one_and_a_duplicate_name_is_409(client, db_session):
    created = _create(client, ABOVE_100)
    assert created.status_code == 201
    body = created.json()
    assert (body["name"], body["origin"], body["version"], body["default_spec"]) == ("Above 100", "user", 1, None)
    clash = _create(client, {**ABOVE_100, "name": "above 100"})
    assert clash.status_code == 409
    assert clash.json()["detail"] == "You already have a filter named above 100"
    assert _create(client, ABOVE_100, OTHER_EMAIL).status_code == 201  # names are per user


def test_a_spec_the_screener_cannot_run_is_422_with_the_reason(client):
    vwap_daily = {**ABOVE_100, "when": {"op": "gt", "left": {"series": "close"}, "right": {"series": "vwap"}}}
    response = _create(client, vwap_daily)
    assert response.status_code == 422
    (problem,) = response.json()["detail"]["problems"]
    assert problem["message"] == "vwap needs intraday bars; daily_close uses daily bars"
    pattern = {**ABOVE_100, "when": {"op": "pattern", "pattern": "hammer"}}
    assert _create(client, pattern).status_code == 422


def test_put_makes_a_new_version_an_unchanged_put_does_not_and_a_seed_is_409(client, db_session):
    _seed(client, db_session)
    seed_id = client.get(f"{BASE}/filters", headers=auth_headers()).json()[0]["id"]
    seed_put = client.put(f"{BASE}/filters/{seed_id}", json={"spec": ABOVE_100}, headers=auth_headers())
    assert seed_put.status_code == 409
    assert seed_put.json()["detail"] == "Default filters can't be edited · copy it to edit"

    filter_id = _create(client, ABOVE_100).json()["id"]
    unchanged = client.put(f"{BASE}/filters/{filter_id}", json={"spec": ABOVE_100}, headers=auth_headers())
    assert unchanged.json()["version"] == 1
    edited = {**ABOVE_100, "name": "Above 120", "when": {**ABOVE_100["when"], "right": {"value": 120}}}
    saved = client.put(
        f"{BASE}/filters/{filter_id}", json={"spec": edited, "change_note": "raise the bar"}, headers=auth_headers()
    )
    assert saved.status_code == 200
    assert (saved.json()["version"], saved.json()["name"]) == (2, "Above 120")
    row = db_session.get(FilterStrategy, filter_id)
    db_session.refresh(row)
    assert row.name == "Above 120"
    other = _create(client, {**ABOVE_100, "name": "Other"}).json()["id"]
    clash = client.put(f"{BASE}/filters/{other}", json={"spec": edited}, headers=auth_headers())
    assert clash.status_code == 409
    bad = client.put(f"{BASE}/filters/{filter_id}", json={"spec": {**edited, "maxResults": 0}}, headers=auth_headers())
    assert bad.status_code == 422


def test_delete_archives_her_filter_frees_the_name_and_refuses_a_seed(client, db_session):
    _seed(client, db_session)
    seed_id = client.get(f"{BASE}/filters", headers=auth_headers()).json()[0]["id"]
    refused = client.delete(f"{BASE}/filters/{seed_id}", headers=auth_headers())
    assert refused.status_code == 409 and refused.json()["detail"] == "Default filters can't be deleted"

    filter_id = _create(client, ABOVE_100).json()["id"]
    assert client.delete(f"{BASE}/filters/{filter_id}", headers=auth_headers()).status_code == 204
    assert client.get(f"{BASE}/filters/{filter_id}", headers=auth_headers()).status_code == 404
    assert client.get(f"{BASE}/filters/{filter_id}/results", headers=auth_headers()).status_code == 404
    assert client.delete(f"{BASE}/filters/{filter_id}", headers=auth_headers()).status_code == 404
    assert _create(client, ABOVE_100).status_code == 201  # the archived name is free again
    assert db_session.get(FilterStrategy, filter_id).archived_at is not None  # archived, not deleted


# -- results, the runner, preview -----------------------------------------------------------------------------


def test_results_before_the_first_run_are_empty_with_an_unavailable_stamp(client):
    filter_id = _create(client, ABOVE_100).json()["id"]  # no bars at all: the save-time run finds nothing
    body = client.get(f"{BASE}/filters/{filter_id}/results", headers=auth_headers()).json()
    assert (body["matches"], body["matches_total"], body["scanned"]) == ([], 0, 0)
    assert body["stamp"] == {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"}
    assert body["table_columns"][0]["key"] == "last"


def test_a_save_runs_the_filter_once_and_the_results_show_ranked_matches(client, db_session, monkeypatch):
    _bars(db_session, "AAA", [99.0, 105.0], volume=2_000_000)
    _bars(db_session, "BBB", [99.0, 110.0], volume=3_000_000)
    _bars(db_session, "CCC", [99.0, 90.0], volume=4_000_000)
    db_session.add(
        SymbolMetrics(symbol="BBB", as_of=NOW, source="alpaca", quality="eod", metrics={"last": 110.0, "rsi_14": 61.5})
    )
    db_session.add(FeedHealth(feed="scan", state="ok", last_ok_at=NOW, updated_at=NOW))
    db_session.commit()
    monkeypatch.setattr("ai_trading.api.screener.datetime", _FrozenDatetime)

    filter_id = _create(client, ABOVE_100).json()["id"]
    body = client.get(f"{BASE}/filters/{filter_id}/results", headers=auth_headers()).json()
    assert (body["scanned"], body["no_data_on_eval_day"], body["matches_total"], body["matches_returned"]) == (
        3,
        0,
        2,
        2,
    )
    assert [m["symbol"] for m in body["matches"]] == ["BBB", "AAA"]  # volume, descending
    top = body["matches"][0]
    assert (top["rank_value"], top["operands"]) == (3_000_000.0, {"close": 110.0})
    assert top["columns"]["rsi_14"] == 61.5 and top["columns"]["last"] == 110.0
    assert body["matches"][1]["columns"]["last"] is None  # AAA has no metrics row: nulls, not a failure
    assert body["evaluation_point"] == "2026-10-06T20:00:00Z"
    assert body["stamp"] == {
        "as_of": "2026-10-06T20:00:00Z",
        "source": "alpaca",
        "quality": "eod",
        "freshness": "closed",
    }
    assert body["rank"] == {"by": {"series": "volume"}, "order": "desc"}
    listed = next(r for r in client.get(f"{BASE}/filters", headers=auth_headers()).json() if r["id"] == filter_id)
    assert listed["last_run"]["matches_total"] == 2 and listed["last_run"]["scanned"] == 3


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz or UTC)


def test_the_runner_is_idempotent_and_a_rerun_after_new_data_writes_one_more_run(client, db_session):
    user_id = _user_id(client, db_session)
    _bars(db_session, "AAA", [99.0, 105.0], volume=2_000_000)
    view = service.create_from_spec(db_session, user_id, ABOVE_100, now=NOW)
    db_session.commit()

    first = runner.run_filters(db_session, now=NOW)
    db_session.commit()
    assert (first.written, first.already_run, first.skipped) == (1, 0, {})
    second = runner.run_filters(db_session, now=NOW)  # a catch-up of the same bar
    db_session.commit()
    assert (second.written, second.already_run) == (0, 1)
    assert db_session.scalar(select(func.count()).select_from(FilterRun)) == 1
    assert db_session.scalar(select(func.count()).select_from(FilterMatch)) == 1
    (match,) = db_session.scalars(select(FilterMatch)).all()
    assert (match.symbol, match.rank, match.rank_value) == ("AAA", 1, 2_000_000.0)
    assert match.matched_since.astimezone(UTC) == datetime(2026, 10, 6, 20, 0, tzinfo=UTC)

    next_day = date(2026, 10, 7)
    upsert_bars(
        db_session,
        "AAA",
        "1d",
        daily_bars([next_day], [106.0], volume=1_000_000),
        "alpaca",
        "stock",
        now=_close(next_day),
    )
    db_session.commit()
    third = runner.run_filters(db_session, now=_close(next_day))
    db_session.commit()
    assert third.written == 1 and db_session.scalar(select(func.count()).select_from(FilterRun)) == 2
    latest = runner.newest_run(db_session, view.version.id)
    assert latest.evaluation_point == _close(next_day)
    (carried,) = runner.run_matches(db_session, latest.id)
    assert carried.matched_since.astimezone(UTC) == datetime(2026, 10, 6, 20, 0, tzinfo=UTC)  # the run continues


def _close(day: date) -> datetime:
    return trading_session("stock", day).regular_close.to_pydatetime()


def test_seeds_with_the_same_spec_are_scanned_once_and_stored_for_each_user(client, db_session):
    first = _user_id(client, db_session)
    second = _user_id(client, db_session, OTHER_EMAIL)
    for user_id in (first, second):
        service.create_from_spec(db_session, user_id, ABOVE_100, now=NOW)
    _bars(db_session, "AAA", [99.0, 105.0])
    db_session.commit()
    report = runner.run_filters(db_session, now=NOW)
    db_session.commit()
    assert report.written == 2
    assert db_session.scalar(select(func.count()).select_from(FilterMatch)) == 2


def test_the_runner_only_runs_the_requested_cadences_and_reports_what_it_cannot_run(client, db_session):
    user_id = _user_id(client, db_session)
    intraday = {**ABOVE_100, "name": "Intraday", "watch": {**ABOVE_100["watch"], "runOn": "bar_close_15m"}}
    daily = service.create_from_spec(db_session, user_id, ABOVE_100, now=NOW)
    service.create_from_spec(db_session, user_id, intraday, now=NOW)
    broken = {**ABOVE_100, "name": "Broken", "when": {"op": "pattern", "pattern": "hammer"}}
    stale = service.create_from_spec(db_session, user_id, broken, now=NOW)  # stored before the gate existed
    _bars(db_session, "AAA", [99.0, 105.0])
    db_session.commit()

    report = runner.run_filters(db_session, now=NOW, run_on={"daily_close"})
    assert report.written == 1
    assert stale.row.id in report.skipped and "pattern" in report.skipped[stale.row.id]
    assert runner.newest_run(db_session, daily.version.id) is not None

    nothing = runner.run_filters(db_session, now=NOW, run_on={"bar_close_15m"})
    assert nothing.written == 0  # no minutes stored: no symbol has the bars this filter needs
    assert list(nothing.skipped.values()) == ["no symbol has the bars this filter needs"]


def test_a_watchlist_or_symbol_source_scans_only_those_symbols_and_asset_types_narrow_the_market(client, db_session):
    user_id = _user_id(client, db_session)
    _bars(db_session, "AAA", [99.0, 105.0])
    _bars(db_session, "BBB", [99.0, 106.0])
    _bars(db_session, "ETFX", [99.0, 107.0])
    db_session.get(UniverseSymbol, "ETFX").asset_type = "etf"
    watchlist = Watchlist(user_id=user_id, name="Mine", horizon="swing")
    db_session.add(watchlist)
    db_session.flush()
    db_session.add(WatchlistItem(watchlist_id=watchlist.id, symbol="BBB", asset_type="stock", position=0))
    db_session.commit()

    def symbols(universe: dict, **extra) -> list[str]:
        spec = {**ABOVE_100, "watch": {**ABOVE_100["watch"], "universe": universe}, **extra}
        return runner.source_symbols(db_session, spec, user_id)

    assert symbols({"market": "us_equities"}) == ["AAA", "BBB", "ETFX"]
    assert symbols({"market": "us_equities"}, assetTypes=["etf"]) == ["ETFX"]
    assert symbols({"watchlist": "Mine"}) == ["BBB"]
    assert symbols({"watchlist": "Nobody's"}) == []
    assert symbols({"symbols": ["AAA", "/ES"]}) == ["AAA"]  # futures are never scanned


def test_preview_counts_matches_over_the_stored_universe(client, db_session):
    _bars(db_session, "AAA", [99.0, 105.0], volume=2_000_000)
    _bars(db_session, "BBB", [99.0, 110.0], volume=3_000_000)
    _bars(db_session, "CCC", [99.0, 90.0], volume=4_000_000)
    body = client.post(f"{BASE}/preview", json={"spec": ABOVE_100}, headers=auth_headers()).json()
    assert body["problems"] == [] and (body["matches_total"], body["scanned"]) == (2, 3)
    assert [t["symbol"] for t in body["top"]] == ["BBB", "AAA"]


def test_preview_over_budget_says_unknown_and_an_unrunnable_spec_returns_its_problems(client, db_session, monkeypatch):
    _bars(db_session, "AAA", [99.0, 105.0])
    monkeypatch.setattr(runner, "PREVIEW_BUDGET_SECONDS", -1.0)
    over = client.post(f"{BASE}/preview", json={"spec": ABOVE_100}, headers=auth_headers()).json()
    assert over["problems"] == [] and over["matches_total"] is None and over["top"] == []
    vwap_daily = {**ABOVE_100, "when": {"op": "gt", "left": {"series": "close"}, "right": {"series": "vwap"}}}
    body = client.post(f"{BASE}/preview", json={"spec": vwap_daily}, headers=auth_headers()).json()
    assert body["problems"][0]["message"] == "vwap needs intraday bars; daily_close uses daily bars"
    assert body["matches_total"] is None


def test_universe_counts_come_from_the_stored_symbols(client, db_session):
    rows = [
        ("OKAY", True, True, None),
        ("ALSO", True, True, None),
        ("PENNY", True, False, {"reason": "below_floor", "last": 2.0}),
        ("NOBAR", True, False, {"reason": "no_daily_data"}),
        ("W.WS", False, False, {"reason": "non_plain_ticker"}),
    ]
    for symbol, active, passed, reason in rows:
        db_session.add(
            UniverseSymbol(
                symbol=symbol,
                name=symbol,
                asset_type="stock",
                exchange="",
                active=active,
                passed_floor=passed,
                floor_reason=reason,
                updated_at=NOW,
            )
        )
    db_session.add(SymbolMetrics(symbol="OKAY", as_of=NOW, source="alpaca", quality="eod", metrics={"last": 10.0}))
    db_session.commit()
    body = client.get(f"{BASE}/universe", headers=auth_headers()).json()
    assert (body["candidates"], body["scanned"], body["dropped_non_plain_tickers"], body["no_daily_data"]) == (
        4,
        2,
        1,
        1,
    )
    assert body["liquidity_floor"] == {"minPrice": 5.0, "minAvgVolume": 500000, "avgVolumeDays": 20}
    assert body["stamp"]["quality"] == "eod" and body["stamp"]["as_of"] == "2026-10-07T01:00:00Z"
    assert "not the full US equity universe" in body["scan_basis"]


def test_universe_with_nothing_stored_has_an_unavailable_stamp(client):
    body = client.get(f"{BASE}/universe", headers=auth_headers()).json()
    assert (body["candidates"], body["scanned"]) == (0, 0)
    assert body["stamp"]["freshness"] == "unavailable"


def test_the_templates_the_seed_cli_stores_still_pass_the_gate(client, db_session):
    user_id = _seed(client, db_session)
    report = runner.run_filters(db_session, now=NOW)
    # Every seed spec is runnable; with no bars each one simply has nothing to scan.
    assert set(report.skipped.values()) == {"no symbol has the bars this filter needs"}
    assert len(report.skipped) == 10
    assert len(service.list_filters(db_session, user_id)) == 10
    assert load_template("filters/gap-up.json")["watch"]["runOn"] == "premarket_0830"
