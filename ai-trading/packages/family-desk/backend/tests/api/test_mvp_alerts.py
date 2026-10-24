"""Alerts inbox, delivery log, and alert strategies (02m §a3.7) in stub mode and in the real database path."""

import copy
from collections import Counter
from datetime import UTC, datetime

import pytest
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.api.app import app
from ai_trading.db.models import Alert, Delivery, Strategy, User, Watchlist, WatchlistItem
from ai_trading.mvp_stub import alerts as mvp_alerts
from ai_trading.mvp_stub import world

NOW = datetime(2026, 7, 15, 20, 0, tzinfo=UTC)
VALIDATE = "/api/desk/alert-strategies/validate"
RUNTIME_OFF = "Alerts start when live quotes are connected"


@pytest.fixture
def stub(monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    monkeypatch.delenv("DESK_ALERTS_RUNTIME_ENABLED", raising=False)
    return monkeypatch


@pytest.fixture
def real(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    monkeypatch.delenv("DESK_ALERTS_RUNTIME_ENABLED", raising=False)
    return monkeypatch


def _world_spec(strategy_id: int) -> dict:
    row = next(row for row in world.alert_strategies() if row["id"] == strategy_id)
    return copy.deepcopy(row["spec"])


def _user_id(client, db_session, email: str) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _strategy(db_session, owner_id: int, name: str) -> Strategy:
    row = Strategy(owner_user_id=owner_id, name=name, stage="alert_only", created_at=NOW)
    db_session.add(row)
    db_session.flush()
    return row


def _alert(db_session, user_id: int, *, strategy_id=None, symbol=None, read_at=None) -> Alert:
    row = Alert(
        user_id=user_id,
        kind="signal",
        severity="info",
        title="t",
        body="b",
        created_at=NOW,
        read_at=read_at,
        symbol=symbol,
        strategy_id=strategy_id,
    )
    db_session.add(row)
    db_session.flush()
    return row


def _delivery(db_session, alert: Alert, channel: str, status: str, error: str | None = None) -> None:
    db_session.add(Delivery(alert_id=alert.id, channel=channel, status=status, error=error))
    db_session.flush()


# -- inbox ---------------------------------------------------------------------------------------------


def test_inbox_stub_lists_newest_first_with_the_strategy_fields(client, stub):
    rows = client.get("/api/desk/alerts", params={"limit": 3}, headers=auth_headers()).json()

    assert [row["id"] for row in rows] == [15, 14, 13]
    assert rows[0]["symbol"] == "AAPL"
    assert rows[0]["strategy_id"] == 6
    assert rows[0]["strategy_name"] == "EMA 9/21 cross"
    assert rows[0]["created_at"] == "2026-10-23T16:15:00Z"
    assert rows[0]["read_at"] is None


def test_inbox_stub_filters_and_pages(client, stub):
    def ids(params: dict) -> list[int]:
        return [row["id"] for row in client.get("/api/desk/alerts", params=params, headers=auth_headers()).json()]

    assert ids({"unread": "true"}) == [15, 14]
    assert ids({"symbol": "COIN"}) == [4, 3]
    assert ids({"strategy_id": 6, "limit": 2, "offset": 1}) == [14, 13]
    assert client.get("/api/desk/alerts", params={"limit": 0}, headers=auth_headers()).status_code == 422


def test_mark_read_stub_sets_read_at_on_a_fixture_alert(client, stub):
    response = client.post("/api/desk/alerts/14/read", headers=auth_headers())

    assert response.status_code == 200
    assert response.json()["read_at"] == "2026-10-23T20:00:00Z"
    assert response.json()["strategy_name"] == "EMA 9/21 cross"


def test_read_all_stub_reports_two_marked(client, stub):
    response = client.post("/api/desk/alerts/read-all", headers=auth_headers())

    assert response.status_code == 200
    assert response.json() == {"marked": 2}


def test_inbox_real_joins_the_strategy_and_filters_by_symbol(client, db_session, real):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    strategy = _strategy(db_session, owner_id, "ORB 15m")
    mine = _alert(db_session, owner_id, strategy_id=strategy.id, symbol="NVDA")
    _alert(db_session, owner_id, symbol="AMD")

    rows = client.get("/api/desk/alerts", params={"symbol": "NVDA"}, headers=auth_headers()).json()

    assert [row["id"] for row in rows] == [mine.id]
    assert rows[0]["strategy_id"] == strategy.id
    assert rows[0]["strategy_name"] == "ORB 15m"


def test_read_all_real_marks_only_the_owners_unread_alerts(client, db_session, real):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    other_id = _user_id(client, db_session, OTHER_EMAIL)
    _alert(db_session, owner_id)
    _alert(db_session, owner_id)
    _alert(db_session, owner_id, read_at=NOW)
    _alert(db_session, other_id)

    response = client.post("/api/desk/alerts/read-all", headers=auth_headers())

    assert response.json() == {"marked": 2}
    still_unread = client.get("/api/desk/alerts", params={"unread": "true"}, headers=auth_headers(OTHER_EMAIL))
    assert len(still_unread.json()) == 1


# -- delivery log --------------------------------------------------------------------------------------


def test_log_stub_shows_every_status_once_or_more(client, stub):
    rows = client.get("/api/desk/alerts/log", params={"limit": 200}, headers=auth_headers()).json()
    assert Counter(row["status"] for row in rows) == {
        "delivered": 15,
        "held_quiet_hours": 1,
        "no_channel": 8,
        "failed": 1,
    }

    first = client.get("/api/desk/alerts/log", params={"limit": 1}, headers=auth_headers()).json()[0]
    assert first == {
        "delivery_id": 1,
        "alert_id": 15,
        "created_at": "2026-10-23T16:15:00Z",
        "symbol": "AAPL",
        "strategy_id": 6,
        "strategy_name": "EMA 9/21 cross",
        "channel": "inbox",
        "status": "delivered",
        "detail": "Delivered",
    }

    held = client.get("/api/desk/alerts/log", params={"status": "held_quiet_hours"}, headers=auth_headers()).json()
    assert [(row["alert_id"], row["channel"], row["detail"]) for row in held] == [
        (11, "telegram", "Held until quiet hours end")
    ]
    failed = client.get("/api/desk/alerts/log", params={"status": "failed"}, headers=auth_headers()).json()
    assert [(row["alert_id"], row["detail"]) for row in failed] == [(10, "Couldn't deliver · will not retry")]


def test_log_real_maps_statuses_and_never_echoes_the_provider_error(client, db_session, real):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    strategy = _strategy(db_session, owner_id, "VWAP reclaim")
    first = _alert(db_session, owner_id, strategy_id=strategy.id, symbol="COIN")
    _delivery(db_session, first, "inbox", "sent")
    _delivery(db_session, first, "telegram", "skipped_quiet_hours")
    _delivery(db_session, first, "slack", "skipped_preferences")
    _delivery(db_session, first, "inbox", "pending")  # wired (inbox): still on its way, left out
    second = _alert(db_session, owner_id, strategy_id=strategy.id, symbol="PLTR")
    _delivery(db_session, second, "telegram", "failed", error="HTTP 401 bot token 123:secret")
    _delivery(db_session, second, "telegram", "pending")  # no telegram channel connected: no_channel
    _delivery(db_session, second, "telegram", "queued")  # unknown status: left out

    rows = client.get("/api/desk/alerts/log", headers=auth_headers()).json()

    assert sorted((row["channel"], row["status"], row["detail"]) for row in rows) == sorted(
        [
            ("inbox", "delivered", "Delivered"),
            ("telegram", "held_quiet_hours", "Held until quiet hours end"),
            ("slack", "no_channel", "No channel connected for slack"),
            ("telegram", "failed", "Couldn't deliver · will not retry"),
            ("telegram", "no_channel", "No channel connected for telegram"),
        ]
    )
    assert "123:secret" not in client.get("/api/desk/alerts/log", headers=auth_headers()).text
    failed = client.get("/api/desk/alerts/log", params={"status": "failed"}, headers=auth_headers()).json()
    assert [row["symbol"] for row in failed] == ["PLTR"]


def test_log_real_treats_a_wired_pending_channel_as_still_on_its_way(client, db_session, real, monkeypatch):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    alert = _alert(db_session, owner_id, symbol="COIN")
    _delivery(db_session, alert, "telegram", "pending")
    monkeypatch.setattr(app.state, "channels", {"telegram": object()}, raising=False)

    assert client.get("/api/desk/alerts/log", headers=auth_headers()).json() == []


def test_log_stub_filters_by_symbol(client, stub):
    rows = client.get(
        "/api/desk/alerts/log", params={"symbol": "COIN", "status": "no_channel"}, headers=auth_headers()
    ).json()

    assert [row["alert_id"] for row in rows] == [4, 3]


# -- alert strategies: reads ---------------------------------------------------------------------------


def test_list_stub_is_sorted_by_name_and_filters(client, stub):
    def ids(params: dict) -> list[int]:
        return [
            row["id"] for row in client.get("/api/desk/alert-strategies", params=params, headers=auth_headers()).json()
        ]

    rows = client.get("/api/desk/alert-strategies", headers=auth_headers()).json()
    assert len(rows) == 7
    assert (rows[0]["name"], rows[-1]["name"]) == ("Abnormal volume", "VWAP reclaim")
    assert ids({"status": "paused"}) == [7]
    assert ids({"status": "draft"}) == [4, 3, 5, 1]
    assert ids({"category": "pattern"}) == [3]
    assert ids({"symbol": "MSFT"}) == [7]
    assert ids({"watchlist_id": 2}) == [7]
    assert ids({"sort": "last_fired"})[0] == 6


def test_get_detail_stub_has_the_one_seed_version(client, stub):
    body = client.get("/api/desk/alert-strategies/2", headers=auth_headers()).json()

    assert body["name"] == "VWAP reclaim"
    assert (body["stage"], body["status"], body["origin"]) == ("alert_only", "active", "seed")
    assert body["source"] == {"kind": "watchlist", "id": 1, "label": "Day movers"}
    assert body["channels"] == ["inbox", "telegram"]
    assert (body["cooldown_minutes"], body["fires_7d"]) == (30, 5)
    assert body["last_fired_at"] == "2026-10-23T14:19:00Z"
    assert body["versions"] == [{"version": 1, "created_at": "2026-10-22T14:00:00Z", "change_note": None}]


def test_fires_are_newest_first_with_signal_ids_and_deliveries(client, stub):
    rows = client.get("/api/desk/alert-strategies/2/fires", params={"limit": 3}, headers=auth_headers()).json()

    assert [(row["signal_id"], row["symbol"]) for row in rows] == [(10, "AVGO"), (8, "TSLA"), (7, "AMD")]
    assert rows[0]["bar_time"] == "2026-10-23T14:19:00Z"
    assert rows[0]["deliveries"] == [
        {"channel": "inbox", "status": "delivered"},
        {"channel": "telegram", "status": "no_channel"},
    ]
    assert rows[0]["thumb"] == {"interval": "15m", "bars": []}  # AVGO is outside the trimmed snapshot


def test_thumb_is_forty_bars_ending_at_the_fire_bar():
    bars = mvp_alerts.thumb("NVDA", "2026-10-23T19:45:00Z")

    assert len(bars) == 40
    assert bars[-1]["t"] == "2026-10-23T19:45:00Z"
    assert set(bars[-1]) == {"t", "o", "h", "l", "c", "v"}


# -- alert strategies: create, validate, update --------------------------------------------------------


def test_create_draft_returns_201_with_the_next_id(client, stub):
    spec = _world_spec(2)
    spec["name"] = "Copy of VWAP"

    response = client.post(
        "/api/desk/alert-strategies", json={"spec": spec, "save_as": "draft"}, headers=auth_headers()
    )

    assert response.status_code == 201
    body = response.json()
    assert (body["id"], body["stage"], body["status"], body["origin"], body["version"]) == (
        8,
        "draft",
        "draft",
        "user",
        1,
    )
    assert body["name"] == "Copy of VWAP"
    assert body["source"] == {"kind": "watchlist", "id": 1, "label": "Day movers"}


def test_create_on_is_409_while_the_runtime_flag_is_off(client, stub):
    response = client.post(
        "/api/desk/alert-strategies", json={"spec": _world_spec(2), "save_as": "on"}, headers=auth_headers()
    )

    assert response.status_code == 409
    assert response.json()["detail"] == RUNTIME_OFF


def test_create_with_a_channel_rule_violation_is_422_with_the_problem_path(client, stub):
    spec = _world_spec(2)
    spec["then"]["alert"]["channels"] = ["telegram", "inbox"]

    response = client.post(
        "/api/desk/alert-strategies", json={"spec": spec, "save_as": "draft"}, headers=auth_headers()
    )

    assert response.status_code == 422
    assert response.json()["detail"]["problems"] == [
        {"path": "then.alert.channels", "message": "the first alert channel must be inbox"}
    ]


def test_validate_reports_the_channel_rule_at_then_alert_channels(client, stub):
    spec = _world_spec(2)
    spec["then"]["alert"]["channels"] = ["telegram", "inbox"]

    response = client.post(VALIDATE, json={"spec": spec}, headers=auth_headers())

    assert response.status_code == 200
    assert response.json() == {
        "problems": [{"path": "then.alert.channels", "message": "the first alert channel must be inbox"}],
        "resolved_symbols": [],
        "run_on": None,
    }


def test_validate_engine_gate_names_the_unsupported_operand_and_still_resolves(client, stub):
    body = client.post(VALIDATE, json={"spec": _world_spec(3)}, headers=auth_headers()).json()

    assert {"path": "when", "message": "the pattern condition is not supported by the engine yet"} in body["problems"]
    assert {"path": "then.alert.frequency", "message": "then.alert.frequency is not supported by the engine yet"} in (
        body["problems"]
    )
    assert body["resolved_symbols"][:2] == ["NVDA", "AMD"]
    assert body["run_on"] == "bar_close_15m"


def test_validate_resolves_the_users_watchlist_in_position_order(client, db_session, real):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    watchlist = Watchlist(user_id=owner_id, name="Mine", horizon="swing")
    db_session.add(watchlist)
    db_session.flush()
    db_session.add_all(
        [
            WatchlistItem(watchlist_id=watchlist.id, symbol="MSFT", asset_type="stock", position=1),
            WatchlistItem(watchlist_id=watchlist.id, symbol="AAPL", asset_type="stock", position=0),
        ]
    )
    db_session.flush()
    spec = _world_spec(2)
    spec["watch"]["universe"] = {"watchlist": "Mine"}

    body = client.post(VALIDATE, json={"spec": spec}, headers=auth_headers()).json()

    assert body == {"problems": [], "resolved_symbols": ["AAPL", "MSFT"], "run_on": "bar_close_1m"}


def test_validate_uses_the_fixture_watchlist_only_in_the_stub(client, db_session, monkeypatch):
    spec = _world_spec(2)
    spec["watch"]["universe"] = {"watchlist": "Day movers"}
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    stubbed = client.post(VALIDATE, json={"spec": spec}, headers=auth_headers()).json()
    monkeypatch.delenv("DESK_MVP_STUB")
    real_path = client.post(VALIDATE, json={"spec": spec}, headers=auth_headers()).json()

    assert stubbed["resolved_symbols"] == ["NVDA", "AMD", "TSLA", "PLTR", "META", "AAPL", "AVGO", "COIN"]
    assert real_path["resolved_symbols"] == []


def test_validate_resolves_a_filter_source_to_the_top_of_its_screener_in_the_stub(client, stub):
    spec = _world_spec(2)
    spec["watch"]["universe"] = {"filter": "Abnormal volume"}

    body = client.post(VALIDATE, json={"spec": spec}, headers=auth_headers()).json()

    assert body["resolved_symbols"] == ["BOLT", "LKQ", "SPTI", "RHI", "TNGX"]
    assert [problem["path"] for problem in body["problems"]] == ["when"]  # the engine cannot run filter sources yet


def test_put_creates_the_next_version_with_its_change_note(client, stub):
    spec = _world_spec(2)
    spec["name"] = "VWAP reclaim v2"

    response = client.put(
        "/api/desk/alert-strategies/2",
        json={"spec": spec, "change_note": "tighter"},
        headers=auth_headers(),
    )

    body = response.json()
    assert response.status_code == 200
    assert (body["version"], body["name"]) == (2, "VWAP reclaim v2")
    assert [version["version"] for version in body["versions"]] == [1, 2]
    assert body["versions"][1]["change_note"] == "tighter"


def test_delete_archives_with_204(client, stub):
    response = client.delete("/api/desk/alert-strategies/2", headers=auth_headers())

    assert response.status_code == 204
    assert response.content == b""


# -- alert strategies: pause, resume ---------------------------------------------------------------------


def test_pause_sets_the_reason_and_the_paused_status(client, stub):
    response = client.post("/api/desk/alert-strategies/2/pause", json={"reason": "user"}, headers=auth_headers())

    assert response.status_code == 200
    assert (response.json()["paused_reason"], response.json()["status"]) == ("user", "paused")
    invalid = client.post("/api/desk/alert-strategies/2/pause", json={"reason": "system"}, headers=auth_headers())
    assert invalid.status_code == 422


def test_resume_a_draft_is_409_while_the_runtime_flag_is_off(client, stub):
    response = client.post("/api/desk/alert-strategies/1/resume", headers=auth_headers())

    assert response.status_code == 409
    assert response.json()["detail"] == RUNTIME_OFF


def test_resume_a_draft_moves_it_to_alert_only_when_the_runtime_is_on(client, stub):
    stub.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")

    body = client.post("/api/desk/alert-strategies/1/resume", headers=auth_headers()).json()

    assert (body["stage"], body["status"]) == ("alert_only", "active")


def test_resume_a_paused_strategy_clears_the_reason(client, stub):
    body = client.post("/api/desk/alert-strategies/7/resume", headers=auth_headers()).json()

    assert (body["paused_reason"], body["status"]) == (None, "active")


# -- stub-off and not-found behaviour -------------------------------------------------------------------


def _valid_body() -> dict:
    return {"spec": _world_spec(2), "save_as": "draft", "change_note": None}


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/api/desk/alert-strategies", None),
        ("POST", "/api/desk/alert-strategies", _valid_body()),
        ("GET", "/api/desk/alert-strategies/2", None),
        ("PUT", "/api/desk/alert-strategies/2", _valid_body()),
        ("DELETE", "/api/desk/alert-strategies/2", None),
        ("POST", "/api/desk/alert-strategies/2/pause", {"reason": "user"}),
        ("POST", "/api/desk/alert-strategies/2/resume", None),
        ("GET", "/api/desk/alert-strategies/2/fires", None),
    ],
)
def test_stub_off_answers_503_for_every_pure_stub_endpoint(client, real, method, path, body):
    response = client.request(method, path, json=body, headers=auth_headers())

    assert response.status_code == 503


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/api/desk/alert-strategies/99", None),
        ("PUT", "/api/desk/alert-strategies/99", _valid_body()),
        ("DELETE", "/api/desk/alert-strategies/99", None),
        ("POST", "/api/desk/alert-strategies/99/pause", {"reason": "user"}),
        ("POST", "/api/desk/alert-strategies/99/resume", None),
        ("GET", "/api/desk/alert-strategies/99/fires", None),
    ],
)
def test_an_id_outside_the_stub_world_is_404(client, stub, method, path, body):
    response = client.request(method, path, json=body, headers=auth_headers())

    assert response.status_code == 404


def test_validate_answers_200_with_the_stub_off(client, real):
    response = client.post(VALIDATE, json={"spec": _world_spec(2)}, headers=auth_headers())

    assert response.status_code == 200
    assert response.json() == {"problems": [], "resolved_symbols": [], "run_on": "bar_close_1m"}


def test_create_with_a_bad_spec_is_422_even_with_the_stub_off(client, real):
    response = client.post(
        "/api/desk/alert-strategies", json={"spec": {"name": "x"}, "save_as": "draft"}, headers=auth_headers()
    )

    assert response.status_code == 422
    assert response.json()["detail"]["problems"]
