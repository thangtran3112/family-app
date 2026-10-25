"""The daily-list practice routes end to end (02o-b v1): plan, open, read, star, the day's session, end the day. Real
Postgres (`scripts/test-db.sh`); the history comes from `tests/daily_world.py`, no network. The background prep is
skipped in a test client (no session factory), so the tests run `plan.run_prep` themselves."""

from datetime import date
from typing import Any

import pytest
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from daily_world import DAYS, NOW, SYMBOLS, make_services
from fastapi.testclient import TestClient
from sqlalchemy import select

from ai_trading.api.app import app
from ai_trading.api.replay import get_services
from ai_trading.cli.seed_technical import seed_user
from ai_trading.core.calendar import et
from ai_trading.db.models import FilterStrategy, PracticePlan, User
from ai_trading.replay import plan as plan_mod

BASE = "/api/desk/replay"
THREAD_BODY = {"schemaVersion": 1, "mode": "day", "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"}}


@pytest.fixture
def daily(client: TestClient, db_session):
    services = make_services()
    app.dependency_overrides[get_services] = lambda: services
    client.get(f"{BASE}/daily", headers=auth_headers())  # creates the user
    user_id = db_session.execute(select(User.id).where(User.email == OWNER_EMAIL)).scalar_one()
    seed_user(db_session, user_id, now=NOW)
    db_session.commit()
    created = client.post(f"{BASE}/threads", json=THREAD_BODY, headers=auth_headers())
    assert created.status_code == 200, created.text
    return client, services, user_id


def _plan_body(db_session, user_id: int, **screen: Any) -> dict[str, Any]:
    ids = {
        name: db_session.execute(
            select(FilterStrategy.id).where(FilterStrategy.owner_user_id == user_id, FilterStrategy.name == name)
        ).scalar_one()
        for name in ("Gap up", "Gap down")
    }
    return {
        "schemaVersion": 1,
        "firstDay": DAYS[0].isoformat(),
        "sessions": 5,
        "hideDates": "yes",
        "screen": {
            "filters": [{"id": ids["Gap up"]}, {"id": ids["Gap down"]}],
            "listAt": "08:30",
            "maxList": 30,
            **screen,
        },
        "setup": {
            "window": {"from": "09:30", "to": "11:30"},
            "session": "regular",
            "interval": "5m",
            "shares": 100,
            "armed": [],
            "plan": {"stopRequired": "no", "signalOnly": "no"},
        },
    }


def _start_plan(daily, db_session) -> dict[str, Any]:
    client, services, user_id = daily
    response = client.post(f"{BASE}/daily/next", json={"plan": _plan_body(db_session, user_id)}, headers=auth_headers())
    assert response.status_code == 200, response.text
    plan = db_session.execute(select(PracticePlan).where(PracticePlan.owner_user_id == user_id)).scalar_one()
    plan.universe = {**plan.universe, "symbols": SYMBOLS}  # the three synthetic names, not the seed universe
    db_session.commit()
    return response.json()


def test_no_plan_yet_is_null(daily) -> None:
    client, _, _ = daily
    daily_card = client.get(f"{BASE}/daily", headers=auth_headers()).json()
    assert daily_card["plan"] is None and daily_card["thread"]["thread"]["status"] == "active"
    assert client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).status_code == 409


def test_starting_a_plan_waits_for_prep_then_opens_day_one(daily, db_session) -> None:
    client, services, user_id = daily
    started = _start_plan(daily, db_session)
    assert started["day_list_id"] is None and started["plan"]["prep"]["state"] == "running"
    assert started["plan"]["next_weekday"] == "Mon" and started["plan"]["next_day_no"] == 1
    assert started["plan"]["spec"]["screen"]["listAt"] == "08:30"  # the plan as authored: no nulls
    plan_mod.run_prep(db_session, services, started["plan"]["id"])
    opened = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()
    assert opened["day_list_id"] is not None and opened["plan"]["current"]["status"] == "listed"
    assert opened["plan"]["prep"] == {"state": "done", "done": 3, "total": 3, "failed": 0}
    again = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()
    assert again["day_list_id"] == opened["day_list_id"]  # Continue, not a second list
    assert client.get(f"{BASE}/daily", headers=auth_headers()).json()["plan"]["current"]["id"] == opened["day_list_id"]


def test_the_day_list_is_spoiler_free_stars_and_ends_into_the_review(daily, db_session) -> None:
    client, services, _ = daily
    plan_id = _start_plan(daily, db_session)["plan"]["id"]
    plan_mod.run_prep(db_session, services, plan_id)
    list_id = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()["day_list_id"]

    read = client.get(f"{BASE}/day-lists/{list_id}", params={"peek": "GAPPER"}, headers=auth_headers())
    assert read.status_code == 200 and read.headers["cache-control"] == "no-store"
    body = read.json()
    assert (body["day_no"], body["of"], body["weekday"], body["status"]) == (1, 5, "Mon", "listed")
    assert body["data_through"] == "2026-09-28T12:15:00Z" and body["list_at"] == "2026-09-28T12:30:00Z"
    assert [c["symbol"] for c in body["candidates"]] == ["GAPPER"]
    assert body["candidates"][0]["list_price"] == 106.0 and body["candidates"][0]["price_at"] == "2026-09-28T12:15:00Z"
    assert body["universe"]["prev_basis"] is True and "Practice universe" in body["universe"]["footnote"]
    assert body["review"] is None and body["journal"] is None and body["clock"] is None
    assert body["peek"]["levels"]["premarket_high"] == 106.0 and body["peek"]["minutes"][-1]["t"] < body["data_through"]
    assert client.get(f"{BASE}/day-lists/{list_id}", params={"peek": "FLAT"}, headers=auth_headers()).status_code == 422

    starred = client.patch(
        f"{BASE}/day-lists/{list_id}", json={"watch": ["GAPPER"], "rating": 4}, headers=auth_headers()
    )
    assert starred.status_code == 200 and starred.json()["watch"][0]["symbol"] == "GAPPER"
    assert starred.json()["rating"] == 4
    assert (
        client.patch(f"{BASE}/day-lists/{list_id}", json={"watch": ["FLAT"]}, headers=auth_headers()).status_code == 422
    )
    assert (
        client.patch(f"{BASE}/day-lists/{list_id}", json={"watch": list("ABCDEF")}, headers=auth_headers()).status_code
        == 422
    )

    session = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers())
    assert session.status_code == 200, session.text
    assert session.json()["day_list_id"] == list_id and session.json()["revealed_through"] == "2026-09-28T13:30:00Z"
    sid = session.json()["id"]
    refused = client.post(f"{BASE}/sessions/{sid}/end", headers=auth_headers())
    assert refused.status_code == 409
    assert refused.json()["detail"]["problems"][0]["message"] == "End the day to score this session"

    to = (et(DAYS[0], "10:00").tz_convert("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")
    advanced = client.post(f"{BASE}/sessions/{sid}/advance", json={"to": to}, headers=auth_headers())
    assert advanced.status_code == 200 and advanced.json()["last"]["age_s"] == 0 and advanced.json()["quiet_s"] is None
    mid = client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers()).json()
    assert mid["clock"] == to and mid["status"] == "practicing" and mid["review"] is None
    marked = client.post(
        f"{BASE}/sessions/{sid}/marks", json={"schemaVersion": 1, "kind": "long_entry"}, headers=auth_headers()
    )
    assert marked.status_code == 200 and marked.json()["warning"] is None

    ended = client.post(f"{BASE}/day-lists/{list_id}/end", headers=auth_headers())
    assert ended.status_code == 200
    review = ended.json()["review"]
    assert review["rows"][0]["symbol"] == "GAPPER" and review["rows"][0]["move_pct"] == 3.77
    assert review["selection"]["picks"][0]["kind"] == "traded"
    assert ended.json()["journal"]["trades"] == 1 and ended.json()["status"] == "ended"
    assert client.post(f"{BASE}/day-lists/{list_id}/end", headers=auth_headers()).json()["review"] == review
    assert client.get(f"{BASE}/sessions/{sid}", headers=auth_headers()).json()["status"] == "ended"
    after = client.patch(f"{BASE}/day-lists/{list_id}", json={"watch": []}, headers=auth_headers())
    assert after.status_code == 409  # the stars close with the day

    nxt = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()
    assert nxt["day_list_id"] != list_id and nxt["plan"]["current"]["day_no"] == 2
    assert nxt["plan"]["next_weekday"] == "Tue"


def test_plan_rejections_are_plain_problems(daily, db_session) -> None:
    client, _, user_id = daily

    def post(body: dict[str, Any]):
        return client.post(f"{BASE}/daily/next", json={"plan": body}, headers=auth_headers())

    good = _plan_body(db_session, user_id)
    early = post({**good, "screen": {**good["screen"], "listAt": "10:00"}})
    assert early.status_code == 422
    assert early.json()["detail"]["problems"][0]["message"] == "window.from must be at or after screen.listAt"
    volume = db_session.execute(
        select(FilterStrategy.id).where(
            FilterStrategy.owner_user_id == user_id, FilterStrategy.name == "Abnormal volume"
        )
    ).scalar_one()
    cadence = post({**good, "screen": {**good["screen"], "filters": [{"id": volume}]}})  # a 15-minute filter at 08:30
    assert cadence.status_code == 422
    assert cadence.json()["detail"]["problems"] == [
        {
            "path": "screen.listAt",
            "message": "Abnormal volume needs a list time of 10:00 AM or later"
            " · before then none of its bars of the day has closed",
        }
    ]
    wrong = post({**good, "extra": 1})
    assert wrong.status_code == 422
    missing = post({**good, "screen": {**good["screen"], "filters": [{"id": 999}]}})
    assert missing.json()["detail"]["problems"] == [{"path": "screen.filters.0.id", "message": "Filter not found"}]
    stray = client.post(f"{BASE}/daily/next", json={"plans": {}}, headers=auth_headers())
    assert stray.status_code == 422


def test_a_non_owner_gets_not_found_everywhere(daily, db_session) -> None:
    client, services, _ = daily
    plan_id = _start_plan(daily, db_session)["plan"]["id"]
    plan_mod.run_prep(db_session, services, plan_id)
    list_id = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()["day_list_id"]
    other = auth_headers(OTHER_EMAIL)
    assert client.get(f"{BASE}/daily", headers=other).json() == {"plan": None, "thread": None}
    assert client.get(f"{BASE}/day-lists/{list_id}", headers=other).status_code == 404
    assert client.patch(f"{BASE}/day-lists/{list_id}", json={"notes": "x"}, headers=other).status_code == 404
    assert (
        client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=other).status_code == 404
    )
    assert client.post(f"{BASE}/day-lists/{list_id}/end", headers=other).status_code == 404


def test_the_hub_session_rows_say_which_day_list_they_belong_to(daily, db_session) -> None:
    client, services, _ = daily
    plan_id = _start_plan(daily, db_session)["plan"]["id"]
    plan_mod.run_prep(db_session, services, plan_id)
    list_id = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()["day_list_id"]
    client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers())
    rows = client.get(f"{BASE}/sessions", headers=auth_headers()).json()
    assert [r["day_list_id"] for r in rows] == [list_id]
    assert isinstance(date.fromisoformat(rows[0]["day"]), date)
