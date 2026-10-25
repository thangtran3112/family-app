"""The practice-thread routes end to end (02r): create, list, read with stats and curve, edit the plan, close, the
ledger, the daily plan binding to a thread (and its plain 409s), the thread header on marks and day screens, and that
every payload that carries a balance says it is simulated. Real Postgres (`scripts/test-db.sh`); the history comes
from `tests/daily_world.py`, no network."""

from typing import Any

import pytest
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from daily_world import DAYS, NOW, make_services
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_replay_daily_api import _plan_body, _start_plan

from ai_trading.api.app import app
from ai_trading.api.replay import get_services
from ai_trading.cli.seed_technical import seed_user
from ai_trading.contracts.practice_thread import PracticeLedgerEntryV1, PracticeThreadV1
from ai_trading.core.calendar import et
from ai_trading.db.models import User
from ai_trading.replay import plan as plan_mod

BASE = "/api/desk/replay"
PLAN = {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"}
CREATE = {"schemaVersion": 1, "mode": "day", "plan": PLAN}


@pytest.fixture
def world(client: TestClient, db_session):
    services = make_services()
    app.dependency_overrides[get_services] = lambda: services
    client.get(f"{BASE}/daily", headers=auth_headers())  # creates the user
    user_id = db_session.execute(select(User.id).where(User.email == OWNER_EMAIL)).scalar_one()
    seed_user(db_session, user_id, now=NOW)
    db_session.commit()
    return client, services, user_id


def _problems(response) -> list[dict[str, str]]:
    return response.json()["detail"]["problems"]


def _strict(value: Any, path: str = "") -> None:
    """A contract object never carries a null: an empty figure is absent."""
    if isinstance(value, dict):
        for key, item in value.items():
            assert item is not None, f"{path}.{key} is null"
            _strict(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _strict(item, f"{path}[{index}]")


def _create(client, **body) -> Any:
    return client.post(f"{BASE}/threads", json={**CREATE, **body}, headers=auth_headers())


def _day_one(world, db_session):
    client, services, _ = world
    assert _create(client).status_code == 200
    plan_id = _start_plan(world, db_session)["plan"]["id"]
    plan_mod.run_prep(db_session, services, plan_id)
    return client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()["day_list_id"]


def _advance(client, session_id: int, hhmm: str) -> None:
    to = et(DAYS[0], hhmm).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")
    assert (
        client.post(f"{BASE}/sessions/{session_id}/advance", json={"to": to}, headers=auth_headers()).status_code == 200
    )


def _mark(client, session_id: int, kind: str, **extra) -> Any:
    body = {"schemaVersion": 1, "kind": kind, **extra}
    return client.post(f"{BASE}/sessions/{session_id}/marks", json=body, headers=auth_headers())


# -- create, list, read, patch, close ----------------------------------------------------------------------------


def test_a_thread_is_created_read_listed_edited_and_closed(world) -> None:
    client, _, _ = world
    created = _create(
        client, startingBalance=25_000, plan={**PLAN, "maxLossUsd": 400, "planNote": "Wait for the open."}
    )
    assert created.status_code == 200 and created.headers["cache-control"] == "no-store"
    body = created.json()
    thread = PracticeThreadV1.model_validate(body["thread"])  # the contract the web app parses it with
    assert (thread.startingBalance, thread.status, thread.mode) == (25_000, "active", "day")
    assert thread.stats.balance == 25_000 and thread.plan.maxLossUsd == 400 and thread.closedAt is None
    assert (
        body["curve"] == [{"n": 0, "day": None, "balance": 25_000.0}] and body["daily"] == [] and body["today"] is None
    )
    assert "Simulated" in body["label"]
    _strict(body["thread"])
    tid = thread.id

    assert client.get(f"{BASE}/threads/{tid}", headers=auth_headers()).json() == body
    listed = client.get(f"{BASE}/threads", headers=auth_headers()).json()
    assert (
        [row["thread"]["id"] for row in listed] == [tid]
        and "daily" not in listed[0]
        and "Simulated" in listed[0]["label"]
    )

    patched = client.patch(
        f"{BASE}/threads/{tid}",
        json={"schemaVersion": 1, "plan": {"stopNoteOnEntry": "yes", "tradeOnlyOnSignal": "yes", "maxTrades": 3}},
        headers=auth_headers(),
    )
    assert patched.status_code == 200
    assert patched.json()["thread"]["plan"] == {"stopNoteOnEntry": "yes", "tradeOnlyOnSignal": "yes", "maxTrades": 3}
    assert patched.json()["thread"]["startingBalance"] == 25_000

    closed = client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers())
    assert closed.status_code == 200 and closed.json()["thread"]["status"] == "closed"
    assert PracticeThreadV1.model_validate(closed.json()["thread"]).closedAt is not None
    assert client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers()).json() == closed.json()  # idempotent
    after = client.patch(f"{BASE}/threads/{tid}", json={"schemaVersion": 1, "plan": PLAN}, headers=auth_headers())
    assert after.status_code == 409 and "closed" in _problems(after)[0]["message"]
    assert _create(client).status_code == 200  # the old one is closed: a new thread may start


def test_thread_requests_are_the_contracts_and_rejections_are_plain_problems(world) -> None:
    client, _, _ = world
    low = _create(client, startingBalance=999)
    assert low.status_code == 422 and _problems(low)[0]["path"] == "startingBalance"
    stray = _create(client, threadId=1)
    assert stray.status_code == 422 and _problems(stray)[0]["path"] == "threadId"
    bool_flag = _create(client, plan={**PLAN, "tradeOnlyOnSignal": True})
    assert bool_flag.status_code == 422
    swing = _create(client, mode="swing")
    assert swing.status_code == 422 and _problems(swing)[0] == {
        "path": "mode",
        "message": "Swing threads are not open yet · start a day thread",
    }
    rich = _create(client, startingBalance=1000, plan={**PLAN, "maxLossUsd": 5000})
    assert rich.status_code == 422 and "simulated starting balance ($1,000)" in _problems(rich)[0]["message"]
    not_json = client.post(f"{BASE}/threads", content="nope", headers=auth_headers())
    assert not_json.status_code == 422
    assert _create(client).status_code == 200
    second = _create(client)
    assert second.status_code == 409
    assert _problems(second) == [
        {"path": "mode", "message": "You already have an active day thread · close it before starting another"}
    ]
    patch_wrong = client.patch(
        f"{BASE}/threads/1", json={"schemaVersion": 1, "plan": PLAN, "mode": "day"}, headers=auth_headers()
    )
    assert patch_wrong.status_code == 422


def test_a_stranger_gets_not_found_everywhere(world) -> None:
    client, _, _ = world
    tid = _create(client).json()["thread"]["id"]
    other = auth_headers(OTHER_EMAIL)
    assert client.get(f"{BASE}/threads", headers=other).json() == []
    for method, path in (("get", ""), ("post", "/close"), ("get", "/ledger")):
        assert getattr(client, method)(f"{BASE}/threads/{tid}{path}", headers=other).status_code == 404
    assert (
        client.patch(f"{BASE}/threads/{tid}", json={"schemaVersion": 1, "plan": PLAN}, headers=other).status_code == 404
    )
    assert client.get(f"{BASE}/threads/99999", headers=auth_headers()).status_code == 404
    named = client.post(f"{BASE}/daily/next", json={"plan": {}, "threadId": tid}, headers=other)
    assert named.status_code in (404, 422)  # the body is checked first; never a 200 with someone else's thread


# -- the daily plan binds to a thread -----------------------------------------------------------------------------


def test_a_plan_without_a_thread_is_a_plain_409_and_a_closed_one_says_so(world, db_session) -> None:
    client, _, user_id = world
    body = {"plan": _plan_body(db_session, user_id)}
    none = client.post(f"{BASE}/daily/next", json=body, headers=auth_headers())
    assert none.status_code == 409
    assert _problems(none) == [
        {
            "path": "threadId",
            "message": "Start a practice thread first · it holds your simulated balance and risk plan",
        }
    ]
    tid = _create(client).json()["thread"]["id"]
    client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers())
    closed = "Your practice thread is closed · start a new thread to keep practising"
    for extra in ({}, {"threadId": tid}):
        refused = client.post(f"{BASE}/daily/next", json={**body, **extra}, headers=auth_headers())
        assert refused.status_code == 409 and _problems(refused)[0]["message"] == closed


def test_threadid_must_come_with_a_plan_and_be_a_whole_number(world, db_session) -> None:
    client, _, user_id = world
    tid = _create(client).json()["thread"]["id"]
    body = {"plan": _plan_body(db_session, user_id)}
    for bad in ({"threadId": tid}, {**body, "threadId": True}, {**body, "threadId": "1"}, {**body, "threadId": 1.5}):
        assert client.post(f"{BASE}/daily/next", json=bad, headers=auth_headers()).status_code == 422
    named = client.post(f"{BASE}/daily/next", json={**body, "threadId": tid}, headers=auth_headers())
    assert named.status_code == 200 and named.json()["plan"]["thread_id"] == tid


def test_the_daily_card_carries_the_threads_plan_stats_and_the_simulated_label(world, db_session) -> None:
    client, _, _ = world
    assert client.get(f"{BASE}/daily", headers=auth_headers()).json() == {"plan": None, "thread": None}
    tid = _create(client).json()["thread"]["id"]
    _start_plan(world, db_session)
    card = client.get(f"{BASE}/daily", headers=auth_headers()).json()
    assert card["plan"]["thread_id"] == tid and card["thread"]["thread"]["id"] == tid
    assert "Simulated" in card["thread"]["label"] and card["thread"]["today"] is None
    _strict(card["thread"]["thread"])


# -- the ledger and the header on the screens ----------------------------------------------------------------------


def test_marks_move_the_balance_and_every_screen_carries_the_thread_header(world, db_session) -> None:
    client, _, _ = world
    list_id = _day_one(world, db_session)
    tid = client.get(f"{BASE}/daily", headers=auth_headers()).json()["thread"]["thread"]["id"]
    session = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers())
    assert session.status_code == 200, session.text
    sid = session.json()["id"]
    header = session.json()["thread"]
    assert session.json()["thread_id"] == tid
    assert header == {
        "id": tid,
        "mode": "day",
        "status": "active",
        "balance": 50_000.0,
        "today_pnl_usd": 0.0,
        "label": "Simulated money · practice only, never a real account",
    }
    _advance(client, sid, "09:30")
    assert (
        _mark(client, sid, "long_entry", shares=10).json()["thread"]["balance"] == 50_000.0
    )  # an entry realizes nothing
    _advance(client, sid, "10:00")
    exit_mark = _mark(client, sid, "long_exit")
    assert exit_mark.status_code == 200
    assert exit_mark.json()["thread"]["balance"] == 50_040.0 and exit_mark.json()["thread"]["today_pnl_usd"] == 40.0
    ledger = client.get(f"{BASE}/threads/{tid}/ledger", headers=auth_headers()).json()
    assert ledger["total"] == 1 and "Simulated" in ledger["label"]
    entry = PracticeLedgerEntryV1.model_validate(ledger["entries"][0])
    assert (entry.symbol, entry.pnlUsd, entry.sessionId, entry.threadId, entry.r) == ("GAPPER", 40.0, sid, tid, None)
    _strict(ledger["entries"])

    undone = client.delete(f"{BASE}/sessions/{sid}/marks/{exit_mark.json()['mark']['id']}", headers=auth_headers())
    assert undone.status_code == 200 and undone.json()["thread"]["balance"] == 50_000.0
    assert client.get(f"{BASE}/threads/{tid}/ledger", headers=auth_headers()).json()["total"] == 0
    assert _mark(client, sid, "long_exit").json()["thread"]["balance"] == 50_040.0

    mid = client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers()).json()
    assert mid["thread"]["balance"] == 50_040.0 and mid["thread"]["today_pnl_usd"] == 40.0
    assert mid["watch_check"]["verdict"] == "off_watch" and mid["watch_check"]["traded"] == ["GAPPER"]
    assert client.get(f"{BASE}/sessions/{sid}", headers=auth_headers()).json()["thread"]["balance"] == 50_040.0
    summary = client.get(f"{BASE}/sessions", headers=auth_headers()).json()
    assert [row["thread_id"] for row in summary] == [tid]

    ended = client.post(f"{BASE}/day-lists/{list_id}/end", headers=auth_headers())
    assert ended.json()["thread"]["balance"] == 50_040.0
    detail = client.get(f"{BASE}/threads/{tid}", headers=auth_headers()).json()
    assert detail["thread"]["stats"]["balance"] == 50_040.0 and detail["thread"]["stats"]["wins"] == 1
    assert [d["kind"] for d in detail["daily"]] == ["practiced"] and detail["curve"][-1]["balance"] == 50_040.0
    assert detail["today"] is None and detail["daily"][0]["pnl_usd"] == 40.0
    _strict(detail["thread"])


def test_a_standalone_session_has_no_thread_header(world) -> None:
    client, _, _ = world
    _create(client)
    spec = {
        "schemaVersion": 1,
        "symbol": "GAPPER",
        "day": DAYS[1].isoformat(),
        "window": {"from": "09:30", "to": "11:30"},
        "session": "regular",
        "interval": "5m",
        "shares": 10,
        "armed": [],
        "plan": {"stopRequired": "no", "signalOnly": "no"},
        "hideDate": "no",
    }
    made = client.post(f"{BASE}/sessions", json=spec, headers=auth_headers())
    assert made.status_code == 200, made.text
    assert made.json()["thread_id"] is None and made.json()["thread"] is None
