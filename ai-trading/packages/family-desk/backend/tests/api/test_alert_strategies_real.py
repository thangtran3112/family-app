"""`/api/desk/alert-strategies*` on the real path (stub flag off): CRUD against Postgres, the derived status and
stats, ownership, pause and the runtime flag, and the fires with their deliveries. Needs a real Postgres."""

import copy
from datetime import UTC, date, datetime, timedelta

import pytest
from bars import daily_bars, minute_bars, trading_days
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.alerts.service import status_of
from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import (
    Alert,
    Delivery,
    FilterMatch,
    FilterRun,
    Signal,
    Strategy,
    StrategyVersion,
    User,
    Watchlist,
    WatchlistItem,
)
from ai_trading.screener import service as filters

BASE = "/api/desk/alert-strategies"
NOW = datetime(2026, 10, 6, 21, 0, tzinfo=UTC)
SPEC = {
    "schemaVersion": 1,
    "name": "Close above 100",
    "watch": {"universe": {"watchlist": "Day movers"}, "session": "regular", "runOn": "bar_close_15m"},
    "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 100}},
    "then": {"alert": {"channels": ["inbox", "telegram"], "severity": "opportunity"}},
    "limits": {"cooldownMinutes": 30},
}


@pytest.fixture(autouse=True)
def real(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    monkeypatch.delenv("DESK_ALERTS_RUNTIME_ENABLED", raising=False)


def _user_id(client, db_session, email: str = OWNER_EMAIL) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _watchlist(db_session, user_id: int, name: str = "Day movers", symbols=("NVDA", "AMD")) -> Watchlist:
    watchlist = Watchlist(user_id=user_id, name=name, horizon="intraday")
    db_session.add(watchlist)
    db_session.flush()
    for position, symbol in enumerate(symbols):
        db_session.add(WatchlistItem(watchlist_id=watchlist.id, symbol=symbol, asset_type="stock", position=position))
    db_session.commit()
    return watchlist


def _create(client, spec=SPEC, save_as="draft", email: str = OWNER_EMAIL):
    return client.post(BASE, json={"spec": spec, "save_as": save_as}, headers=auth_headers(email))


def _signal(db_session, strategy_id: int, symbol: str, bar_time: datetime, *, evidence=None) -> Signal:
    version = (
        db_session.execute(
            select(StrategyVersion)
            .where(StrategyVersion.strategy_id == strategy_id)
            .order_by(StrategyVersion.version.desc())
        )
        .scalars()
        .first()
    )
    signal = Signal(
        strategy_version_id=version.id,
        symbol=symbol,
        bar_time=bar_time,
        evidence=evidence or {"close": 101.0},
        data_quality="delayed-15m",
        created_at=bar_time,
    )
    db_session.add(signal)
    db_session.commit()
    return signal


# -- create, read ------------------------------------------------------------------------------------------


def test_create_as_draft_returns_the_derived_fields(client, db_session):
    user_id = _user_id(client, db_session)
    watchlist = _watchlist(db_session, user_id)
    response = _create(client)
    assert response.status_code == 201
    body = response.json()
    assert (body["name"], body["origin"], body["stage"], body["status"], body["version"]) == (
        "Close above 100",
        "user",
        "draft",
        "draft",
        1,
    )
    assert body["source"] == {"kind": "watchlist", "id": watchlist.id, "label": "Day movers"}
    assert (body["category"], body["run_on"], body["frequency"], body["cooldown_minutes"]) == (
        "indicator",
        "bar_close_15m",
        "once_per_bar",
        30,
    )
    assert (body["channels"], body["severity"], body["expires_on"]) == (["inbox", "telegram"], "opportunity", None)
    assert (body["last_fired_at"], body["fires_7d"], body["paused_reason"]) == (None, 0, None)
    assert body["spec"]["when"] == SPEC["when"]


def test_a_strategy_may_name_a_watchlist_that_does_not_exist_yet(client):
    body = _create(client).json()
    assert body["source"] == {"kind": "watchlist", "id": None, "label": "Day movers"}


def test_save_as_on_is_409_until_the_runtime_flag_is_set(client, monkeypatch):
    refused = _create(client, save_as="on")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Alerts start when live quotes are connected"
    monkeypatch.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")
    accepted = _create(client, save_as="on")
    assert accepted.status_code == 201
    assert (accepted.json()["stage"], accepted.json()["status"]) == ("alert_only", "active")


def test_a_bad_spec_is_422_with_problems(client):
    assert _create(client, {"name": "x"}).status_code == 422
    daily_vwap = {
        **SPEC,
        "watch": {**SPEC["watch"], "runOn": "daily_close"},
        "when": {"op": "gt", "left": {"series": "close"}, "right": {"series": "vwap"}},
    }
    response = _create(client, daily_vwap)
    assert response.status_code == 422
    assert (
        response.json()["detail"]["problems"][0]["message"] == "vwap needs intraday bars; daily_close uses daily bars"
    )


def test_detail_has_the_version_history(client):
    strategy_id = _create(client).json()["id"]
    edited = {**SPEC, "when": {**SPEC["when"], "right": {"value": 120}}}
    client.put(f"{BASE}/{strategy_id}", json={"spec": edited, "change_note": "raise it"}, headers=auth_headers())
    body = client.get(f"{BASE}/{strategy_id}", headers=auth_headers()).json()
    assert body["version"] == 2
    assert [(v["version"], v["change_note"]) for v in body["versions"]] == [(1, "created"), (2, "raise it")]
    assert body["spec"]["when"]["right"] == {"value": 120}


def test_put_keeps_the_version_when_the_spec_is_unchanged_and_the_name_follows_the_spec(client, db_session):
    strategy_id = _create(client).json()["id"]
    same = client.put(f"{BASE}/{strategy_id}", json={"spec": SPEC}, headers=auth_headers())
    assert same.status_code == 200 and same.json()["version"] == 1
    renamed = client.put(f"{BASE}/{strategy_id}", json={"spec": {**SPEC, "name": "Renamed"}}, headers=auth_headers())
    assert (renamed.json()["version"], renamed.json()["name"]) == (2, "Renamed")
    assert db_session.get(Strategy, strategy_id).name == "Renamed"
    assert client.put(f"{BASE}/{strategy_id}", json={"spec": {"name": "x"}}, headers=auth_headers()).status_code == 422


# -- ownership, archive ------------------------------------------------------------------------------------


def test_another_users_strategy_is_a_404_for_every_verb(client, db_session):
    strategy_id = _create(client).json()["id"]
    _user_id(client, db_session, OTHER_EMAIL)
    for method, path, body in (
        ("GET", f"/{strategy_id}", None),
        ("PUT", f"/{strategy_id}", {"spec": SPEC}),
        ("DELETE", f"/{strategy_id}", None),
        ("POST", f"/{strategy_id}/pause", {"reason": "user"}),
        ("POST", f"/{strategy_id}/resume", None),
        ("GET", f"/{strategy_id}/fires", None),
    ):
        response = client.request(method, f"{BASE}{path}", json=body, headers=auth_headers(OTHER_EMAIL))
        assert response.status_code == 404, (method, path)
    assert client.get(BASE, headers=auth_headers(OTHER_EMAIL)).json() == []
    assert client.get(f"{BASE}/999", headers=auth_headers()).status_code == 404


def test_delete_archives_the_strategy_and_keeps_its_history(client, db_session):
    user_id = _user_id(client, db_session)
    strategy_id = _create(client).json()["id"]
    signal = _signal(db_session, strategy_id, "NVDA", NOW)
    assert client.delete(f"{BASE}/{strategy_id}", headers=auth_headers()).status_code == 204
    assert client.get(f"{BASE}/{strategy_id}", headers=auth_headers()).status_code == 404
    assert client.get(BASE, headers=auth_headers()).json() == []
    row = db_session.get(Strategy, strategy_id)
    db_session.refresh(row)
    assert row.archived_at is not None and row.owner_user_id == user_id
    assert db_session.get(Signal, signal.id) is not None  # the history stays


# -- pause, resume -----------------------------------------------------------------------------------------


def test_pause_and_resume(client, monkeypatch):
    monkeypatch.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")
    strategy_id = _create(client, save_as="on").json()["id"]
    paused = client.post(f"{BASE}/{strategy_id}/pause", json={"reason": "user"}, headers=auth_headers()).json()
    assert (paused["status"], paused["paused_reason"], paused["stage"]) == ("paused", "user", "alert_only")
    resumed = client.post(f"{BASE}/{strategy_id}/resume", headers=auth_headers()).json()
    assert (resumed["status"], resumed["paused_reason"]) == ("active", None)


def test_turn_on_moves_a_draft_to_alert_only_only_with_the_runtime_flag(client, monkeypatch):
    strategy_id = _create(client).json()["id"]
    refused = client.post(f"{BASE}/{strategy_id}/resume", headers=auth_headers())
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Alerts start when live quotes are connected"
    assert client.get(f"{BASE}/{strategy_id}", headers=auth_headers()).json()["stage"] == "draft"
    monkeypatch.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")
    on = client.post(f"{BASE}/{strategy_id}/resume", headers=auth_headers()).json()
    assert (on["stage"], on["status"]) == ("alert_only", "active")


def test_pause_all_reads_paused_on_every_live_strategy_but_not_on_a_draft(client, db_session, monkeypatch):
    monkeypatch.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")
    live = _create(client, save_as="on").json()["id"]
    draft = _create(client, {**SPEC, "name": "A draft"}).json()["id"]
    client.put("/api/desk/settings", json={"settings": {"pause_all": True}}, headers=auth_headers())
    assert client.get(f"{BASE}/{live}", headers=auth_headers()).json()["status"] == "paused"
    assert client.get(f"{BASE}/{draft}", headers=auth_headers()).json()["status"] == "draft"


def test_status_is_derived_from_stage_expiry_and_pause():
    def status(stage="alert_only", expires=None, reason=None, *, paused_all=False):
        return status_of(stage, expires, reason, "2026-10-06", paused_all=paused_all)

    assert status("draft", "2020-01-01", "user") == "draft"  # a draft is a draft whatever else is set
    assert status(expires="2026-10-06") == "active"  # the last day still runs
    assert status(expires="2026-10-05") == "expired"
    assert status(expires="2026-10-05", reason="user") == "expired"
    assert status(reason="user") == "paused"
    assert status(paused_all=True) == "paused"
    assert status() == "active"


def test_an_expired_strategy_is_listed_expired_with_its_date(client, db_session):
    user_id = _user_id(client, db_session)
    spec = copy.deepcopy(SPEC)
    spec["then"]["alert"]["expiresOn"] = "2020-01-02"
    row = Strategy(owner_user_id=user_id, name="Old", stage="alert_only", lane="technical", created_at=NOW)
    db_session.add(row)
    db_session.flush()
    version = StrategyVersion(
        strategy_id=row.id, version=1, schema_version=1, spec=spec, created_by=user_id, created_at=NOW
    )
    db_session.add(version)
    db_session.flush()
    row.current_version_id = version.id
    db_session.commit()
    (listed,) = client.get(BASE, headers=auth_headers()).json()
    assert (listed["status"], listed["expires_on"]) == ("expired", "2020-01-02")


# -- list --------------------------------------------------------------------------------------------------


def test_list_filters_and_sorts(client, db_session, monkeypatch):
    monkeypatch.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")
    user_id = _user_id(client, db_session)
    movers = _watchlist(db_session, user_id, "Day movers", ("NVDA", "AMD"))
    swing = _watchlist(db_session, user_id, "Swing", ("MSFT",))
    level = {
        **SPEC,
        "name": "Above prior high",
        "watch": {**SPEC["watch"], "universe": {"watchlist": "Swing"}},
        "when": {"op": "gt", "left": {"series": "close"}, "right": {"level": "prior_day_high"}},
    }
    a = _create(client, {**SPEC, "name": "b strategy"}, save_as="on").json()["id"]
    b = _create(client, level).json()["id"]
    c = _create(
        client, {**SPEC, "name": "A strategy", "watch": {**SPEC["watch"], "universe": {"symbols": ["TSLA"]}}}
    ).json()["id"]
    _signal(db_session, a, "NVDA", datetime.now(UTC) - timedelta(days=1))

    def ids(**params):
        return [row["id"] for row in client.get(BASE, params=params, headers=auth_headers()).json()]

    assert ids() == [c, b, a]  # by name, case-insensitive
    assert ids(status="draft") == [c, b]
    assert ids(category="level") == [b]
    assert ids(watchlist_id=movers.id) == [a]
    assert ids(watchlist_id=swing.id) == [b]
    assert ids(symbol="NVDA") == [a] and ids(symbol="TSLA") == [c] and ids(symbol="MSFT") == [b]
    assert ids(sort="status") == [a, c, b]  # active before draft
    assert ids(sort="last_fired")[0] == a  # the only one that fired comes first
    listed = next(r for r in client.get(BASE, headers=auth_headers()).json() if r["id"] == a)
    assert listed["last_fired_at"] is not None and listed["fires_7d"] == 1


# -- validate ----------------------------------------------------------------------------------------------


def test_validate_resolves_the_three_kinds_of_source(client, db_session):
    user_id = _user_id(client, db_session)
    _watchlist(db_session, user_id)
    by_watchlist = client.post(f"{BASE}/validate", json={"spec": SPEC}, headers=auth_headers()).json()
    assert by_watchlist == {"problems": [], "resolved_symbols": ["NVDA", "AMD"], "run_on": "bar_close_15m"}
    listed = {**SPEC, "watch": {**SPEC["watch"], "universe": {"symbols": ["TSLA", "PLTR"]}}}
    by_symbols = client.post(f"{BASE}/validate", json={"spec": listed}, headers=auth_headers()).json()
    assert by_symbols["resolved_symbols"] == ["TSLA", "PLTR"]

    view = filters.create_from_spec(
        db_session,
        user_id,
        {
            "schemaVersion": 1,
            "name": "Hot",
            "watch": {"universe": {"market": "us_equities"}, "session": "regular", "runOn": "daily_close"},
            "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 1}},
            "maxResults": 5,
        },
        now=NOW,
    )
    run = FilterRun(
        filter_strategy_version_id=view.version.id,
        run_on="daily_close",
        session="regular",
        evaluation_point=NOW,
        scanned=2,
        no_data=0,
        matches_total=2,
        source="alpaca",
        quality="eod",
        created_at=NOW,
    )
    db_session.add(run)
    db_session.flush()
    for rank, symbol in enumerate(("BOLT", "RHI"), start=1):
        db_session.add(
            FilterMatch(
                run_id=run.id, symbol=symbol, rank=rank, rank_value=1.0, matched_since=NOW, operands={}, columns={}
            )
        )
    db_session.commit()
    by_filter = {**SPEC, "watch": {**SPEC["watch"], "universe": {"filter": "Hot"}}}
    body = client.post(f"{BASE}/validate", json={"spec": by_filter}, headers=auth_headers()).json()
    assert body["resolved_symbols"] == ["BOLT", "RHI"]
    missing = {**SPEC, "watch": {**SPEC["watch"], "universe": {"filter": "Nope"}}}
    assert (
        client.post(f"{BASE}/validate", json={"spec": missing}, headers=auth_headers()).json()["resolved_symbols"] == []
    )


# -- fires -------------------------------------------------------------------------------------------------


def _fire(db_session, user_id: int, strategy_id: int, bar_time: datetime, deliveries: dict[str, str]) -> Signal:
    signal = _signal(db_session, strategy_id, "NVDA", bar_time)
    alert = Alert(
        user_id=user_id,
        signal_id=signal.id,
        kind="signal",
        severity="info",
        title="t",
        body="b",
        created_at=bar_time,
        symbol="NVDA",
        strategy_id=strategy_id,
    )
    db_session.add(alert)
    db_session.flush()
    for channel, status in deliveries.items():
        db_session.add(Delivery(alert_id=alert.id, channel=channel, status=status))
    db_session.commit()
    return signal


def test_fires_are_newest_first_with_mapped_deliveries_and_a_15_minute_thumbnail(client, db_session):
    user_id = _user_id(client, db_session)
    strategy_id = _create(client).json()["id"]
    day = date(2026, 10, 6)
    upsert_bars(
        db_session,
        "NVDA",
        "1m",
        minute_bars("stock", day, price=101.0),
        "alpaca",
        "stock",
        now=NOW + timedelta(hours=6),
    )
    db_session.commit()
    first = datetime(2026, 10, 6, 14, 0, tzinfo=UTC)  # 10:00 ET
    second = datetime(2026, 10, 6, 15, 0, tzinfo=UTC)
    _fire(db_session, user_id, strategy_id, first, {"inbox": "sent", "telegram": "failed"})
    newer = _fire(
        db_session,
        user_id,
        strategy_id,
        second,
        {"inbox": "sent", "telegram": "skipped_quiet_hours", "slack": "pending"},
    )
    body = client.get(f"{BASE}/{strategy_id}/fires", headers=auth_headers()).json()
    assert [row["signal_id"] for row in body][0] == newer.id and len(body) == 2
    assert body[0]["deliveries"] == [
        {"channel": "inbox", "status": "delivered"},
        {"channel": "telegram", "status": "held_quiet_hours"},
        {"channel": "slack", "status": "no_channel"},  # nothing is wired for slack in the test app
    ]
    assert body[1]["deliveries"][1] == {"channel": "telegram", "status": "failed"}
    thumb = body[0]["thumb"]
    assert thumb["interval"] == "15m" and 1 <= len(thumb["bars"]) <= 40
    assert thumb["bars"][-1]["t"] == "2026-10-06T15:00:00Z"  # the bar holding the fire is the last one
    assert thumb["bars"][-1]["c"] == 101.0
    limited = client.get(f"{BASE}/{strategy_id}/fires", params={"limit": 1}, headers=auth_headers()).json()
    assert len(limited) == 1
    assert client.get(f"{BASE}/{strategy_id}/fires", params={"limit": 0}, headers=auth_headers()).status_code == 422


def test_a_fire_with_no_stored_minutes_has_an_empty_thumbnail(client, db_session):
    user_id = _user_id(client, db_session)
    strategy_id = _create(client).json()["id"]
    _fire(db_session, user_id, strategy_id, datetime(2026, 10, 6, 15, 0, tzinfo=UTC), {"inbox": "sent"})
    (row,) = client.get(f"{BASE}/{strategy_id}/fires", headers=auth_headers()).json()
    assert row["thumb"] == {"interval": "15m", "bars": []}


def test_daily_bars_do_not_break_the_thumbnail(client, db_session):
    user_id = _user_id(client, db_session)
    strategy_id = _create(client).json()["id"]
    upsert_bars(
        db_session,
        "NVDA",
        "1d",
        daily_bars(trading_days("stock", date(2026, 10, 6), 3), [100.0, 101.0, 102.0]),
        "alpaca",
        "stock",
        now=NOW,
    )
    db_session.commit()
    _fire(db_session, user_id, strategy_id, datetime(2026, 10, 6, 15, 0, tzinfo=UTC), {"inbox": "sent"})
    (row,) = client.get(f"{BASE}/{strategy_id}/fires", headers=auth_headers()).json()
    assert row["thumb"]["bars"] == []
