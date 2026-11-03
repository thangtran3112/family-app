"""The practice routes that the service-level tests (`tests/replay/test_thread_clock.py`, `test_thread_capacity.py`)
prove one layer down, asserted here through the HTTP routes with the status codes and response shapes a client reads:
the clock Jump (`POST /threads/{id}/clock {to}`), `list_pending` on the day list, Close thread ending the open day, the
shared 10-slot capacity with the 49-name list cap, and the open-to-open hand-over a jump or a skip drives. Real
Postgres (`scripts/test-db.sh`); the history comes from `tests/daily_world.py`, no network."""

from datetime import date

import pandas as pd
import pytest
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from daily_world import DAYS, NOW, SYMBOLS, make_services
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_replay_daily_api import _plan_body
from test_replay_threads_api import BASE, CREATE, _advance, _create, _day_one, _mark, _problems

from ai_trading.api.app import app
from ai_trading.api.replay import get_services
from ai_trading.cli.seed_technical import seed_user
from ai_trading.contracts.practice_thread import PracticeLedgerEntryV1
from ai_trading.core.calendar import et
from ai_trading.db.models import PracticePlan, User
from ai_trading.replay import plan as plan_mod

AFTER_PLAN = et(date(2026, 10, 5), "09:30")  # the open after the plan's last day (Fri 2026-10-02): where it ends


@pytest.fixture
def world(client: TestClient, db_session):
    services = make_services()
    services.wall = lambda: (
        NOW
    )  # the thread clock's wall: pinned, so a paused or jumped clock is exactly where it was put
    app.dependency_overrides[get_services] = lambda: services
    client.get(f"{BASE}/daily", headers=auth_headers())  # creates the user
    user_id = db_session.execute(select(User.id).where(User.email == OWNER_EMAIL)).scalar_one()
    seed_user(db_session, user_id, now=NOW)
    db_session.commit()
    return client, services, user_id


def _iso(ts: pd.Timestamp) -> str:
    return ts.isoformat()  # a time with its UTC offset, as the route asks


def _thread_id(client) -> int:
    return client.get(f"{BASE}/daily", headers=auth_headers()).json()["thread"]["thread"]["id"]


# -- the clock Jump ----------------------------------------------------------------------------------------------------


def test_the_clock_jump_route_is_forward_only_and_stops_at_the_end_of_the_plan(world, db_session) -> None:
    client, _, _ = world
    list_id = _day_one(world, db_session)
    url = f"{BASE}/threads/{_thread_id(client)}/clock"

    start = client.get(url, headers=auth_headers()).json()
    assert pd.Timestamp(start["clock"]) == et(DAYS[0], "09:30") and start["state"] == "paused"
    assert pd.Timestamp(start["jump_limit"]) == AFTER_PLAN  # the plan's last day ends at the open after it

    jumped = client.post(url, json={"to": _iso(et(DAYS[0], "11:03"))}, headers=auth_headers())
    assert jumped.status_code == 200, jumped.text
    body = jumped.json()
    assert pd.Timestamp(body["clock"]) == et(DAYS[0], "11:03") and body["day_list_id"] == list_id
    assert body["state"] == "paused" and body["running"] is False  # a jump does not play the clock
    assert pd.Timestamp(body["account"]["as_of"]) == et(DAYS[0], "11:03")  # the account is read at the new time

    back = client.post(url, json={"to": _iso(et(DAYS[0], "10:00"))}, headers=auth_headers())
    assert back.status_code == 200 and pd.Timestamp(back.json()["clock"]) == et(DAYS[0], "11:03")  # past: stays put

    beyond = client.post(url, json={"to": _iso(AFTER_PLAN + pd.Timedelta(minutes=1))}, headers=auth_headers())
    assert beyond.status_code == 422
    assert _problems(beyond)[0]["path"] == "to" and "plan ends" in _problems(beyond)[0]["message"]
    assert pd.Timestamp(client.get(url, headers=auth_headers()).json()["clock"]) == et(DAYS[0], "11:03")  # unmoved

    for bad in (
        {"to": "not a time"},
        {"to": _iso(et(DAYS[0], "12:00")), "step": "bar"},  # a jump or a step, not both
    ):
        assert client.post(url, json=bad, headers=auth_headers()).status_code == 422, bad


def test_the_clock_routes_answer_409_once_the_thread_has_no_open_day(world, db_session) -> None:
    client, _, _ = world
    _day_one(world, db_session)
    tid = _thread_id(client)
    assert client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers()).status_code == 200
    refused = client.post(
        f"{BASE}/threads/{tid}/clock", json={"to": _iso(et(DAYS[0], "11:03"))}, headers=auth_headers()
    )
    assert refused.status_code == 409
    assert _problems(refused) == [{"path": "clock", "message": "No practice day is under way"}]


# -- the open-to-open hand-over ----------------------------------------------------------------------------------------


def test_a_jump_across_an_open_hands_the_day_over_through_the_route(world, db_session) -> None:
    client, _, _ = world
    first = _day_one(world, db_session)
    url = f"{BASE}/threads/{_thread_id(client)}/clock"

    short = client.post(url, json={"to": _iso(et(DAYS[1], "09:29"))}, headers=auth_headers()).json()
    assert short["day_no"] == 1 and short["day_list_id"] == first  # a minute short of the open: still day 1
    assert client.get(f"{BASE}/day-lists/{first}", headers=auth_headers()).json()["review"] is None

    handed = client.post(url, json={"to": _iso(et(DAYS[1], "09:30"))}, headers=auth_headers())
    assert handed.status_code == 200, handed.text
    body = handed.json()
    assert (body["day_no"], pd.Timestamp(body["clock"])) == (2, et(DAYS[1], "09:30"))  # the clock is carried over
    assert body["day_list_id"] != first and body["state"] == "paused"
    ended = client.get(f"{BASE}/day-lists/{first}", headers=auth_headers()).json()
    assert ended["status"] == "ended" and ended["review"] is not None  # scored with no End day press
    assert client.get(f"{BASE}/daily", headers=auth_headers()).json()["plan"]["current"]["id"] == body["day_list_id"]

    across = client.post(url, json={"to": _iso(et(DAYS[3], "11:03"))}, headers=auth_headers()).json()
    assert (across["day_no"], pd.Timestamp(across["clock"])) == (4, et(DAYS[3], "11:03"))  # day by day, three opens
    assert client.get(f"{BASE}/day-lists/{body['day_list_id']}", headers=auth_headers()).json()["status"] == "ended"


# -- list_pending ------------------------------------------------------------------------------------------------------


def test_the_day_list_is_pending_until_the_clock_reaches_its_time(world, db_session) -> None:
    client, services, user_id = world
    assert _create(client).status_code == 200
    body = _plan_body(db_session, user_id, listAt="10:00")
    body["setup"]["window"]["from"] = (
        "10:00"  # a plan's first day starts at its "Start at", which cannot precede the list
    )
    started = client.post(f"{BASE}/daily/next", json={"plan": body}, headers=auth_headers())
    assert started.status_code == 200, started.text
    plan = db_session.execute(select(PracticePlan).where(PracticePlan.owner_user_id == user_id)).scalar_one()
    plan.universe = {**plan.universe, "symbols": SYMBOLS}
    db_session.commit()
    plan_mod.run_prep(db_session, services, plan.id)
    first = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()["day_list_id"]
    day_one = client.get(f"{BASE}/day-lists/{first}", headers=auth_headers()).json()
    assert pd.Timestamp(day_one["clock"]) == et(DAYS[0], "10:00") and day_one["list_pending"] is False

    # A later day opens at the exchange's 9:30, half an hour before its list: the hand-over lands there.
    url = f"{BASE}/threads/{_thread_id(client)}/clock"
    landed = client.post(url, json={"to": _iso(et(DAYS[2], "09:30"))}, headers=auth_headers()).json()
    assert landed["day_no"] == 3
    list_id = landed["day_list_id"]
    early = client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers())
    assert early.status_code == 200 and early.json()["list_pending"] is True
    held = early.json()
    assert pd.Timestamp(held["clock"]) == et(DAYS[2], "09:30") and held["list_at"] == "2026-09-30T14:00:00Z"
    assert held["candidates"] == [] and held["universe"]["shown"] == 0  # nothing leaks before the list is out
    blocked = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers())
    assert blocked.status_code == 409 and "10:00 AM" in _problems(blocked)[0]["message"]
    starred = client.patch(f"{BASE}/day-lists/{list_id}", json={"watch": ["GAPPER"]}, headers=auth_headers())
    assert starred.status_code == 409  # no star either

    assert client.post(url, json={"to": _iso(et(DAYS[2], "10:00"))}, headers=auth_headers()).status_code == 200
    ready = client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers()).json()
    assert ready["list_pending"] is False and [c["symbol"] for c in ready["candidates"]] == ["GAPPER"]
    opened = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers())
    assert opened.status_code == 200 and pd.Timestamp(opened.json()["revealed_through"]) == et(DAYS[2], "10:00")


# -- Close thread ends the open day ------------------------------------------------------------------------------------


def test_closing_a_day_thread_ends_its_open_day_and_books_the_open_position(world, db_session) -> None:
    client, _, _ = world
    list_id = _day_one(world, db_session)
    tid = _thread_id(client)
    sid = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers()).json()[
        "id"
    ]
    _advance(client, sid, "09:30")
    assert _mark(client, sid, "long_entry", shares=10).status_code == 200
    _advance(client, sid, "10:00")  # the position is still open: no exit mark
    assert client.get(f"{BASE}/threads/{tid}/ledger", headers=auth_headers()).json()["total"] == 0
    assert client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers()).json()["status"] == "practicing"

    closed = client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers())
    assert closed.status_code == 200, closed.text
    assert closed.json()["thread"]["status"] == "closed" and closed.json()["thread"]["closedAt"] is not None
    day = client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers()).json()
    assert day["status"] == "ended" and day["review"] is not None  # the day ended with the thread, and was scored

    ledger = client.get(f"{BASE}/threads/{tid}/ledger", headers=auth_headers()).json()
    assert ledger["total"] == 1  # the open position booked at the clock
    entry = PracticeLedgerEntryV1.model_validate(ledger["entries"][0])
    assert (entry.symbol, entry.shares, entry.side, entry.threadId) == ("GAPPER", 10, "long", tid)
    assert closed.json()["thread"]["stats"]["balance"] == pytest.approx(
        50_000 + entry.pnlUsd
    )  # the balance is the ledger

    again = client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers())
    assert again.status_code == 200 and again.json() == closed.json()  # closing twice changes nothing
    assert client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers(OTHER_EMAIL)).status_code == 404


# -- capacity: 10 day slots across all users, 49 names a list ----------------------------------------------------------


def test_the_ten_day_slots_are_shared_by_every_user_and_a_closed_thread_frees_one(world) -> None:
    client, _, _ = world
    other = auth_headers(OTHER_EMAIL)
    assert client.get(f"{BASE}/threads/capacity", headers=other).json() == {"day_active": 0, "day_max": 10}
    for _ in range(9):
        assert _create(client).status_code == 200
    assert client.get(f"{BASE}/threads/capacity", headers=other).json() == {
        "day_active": 9,
        "day_max": 10,
    }  # hers count

    taken = client.post(f"{BASE}/threads", json=CREATE, headers=other)  # the stranger takes the tenth slot
    assert taken.status_code == 200, taken.text
    for who in (auth_headers(), other):
        assert client.get(f"{BASE}/threads/capacity", headers=who).json() == {"day_active": 10, "day_max": 10}
    refused = _create(client)
    assert refused.status_code == 409  # hers is refused: the house is full, whoever holds the slots
    assert _problems(refused) == [
        {"path": "mode", "message": "All 10 day-trade slots are in use · close a day thread to start another"}
    ]

    theirs = taken.json()["thread"]["id"]
    assert client.post(f"{BASE}/threads/{theirs}/close", headers=other).status_code == 200
    assert client.get(f"{BASE}/threads/capacity", headers=auth_headers()).json()["day_active"] == 9
    assert _create(client).status_code == 200  # the slot the stranger freed is hers


def test_a_new_plan_above_49_names_is_a_422_on_the_route_and_49_is_accepted(world, db_session) -> None:
    client, _, user_id = world
    assert _create(client).status_code == 200
    too_many = client.post(
        f"{BASE}/daily/next", json={"plan": _plan_body(db_session, user_id, maxList=50)}, headers=auth_headers()
    )
    assert too_many.status_code == 422, too_many.text
    assert _problems(too_many) == [{"path": "screen.maxList", "message": "A day list holds at most 49 names"}]
    assert client.get(f"{BASE}/daily", headers=auth_headers()).json()["plan"] is None  # nothing was saved
    fits = client.post(
        f"{BASE}/daily/next", json={"plan": _plan_body(db_session, user_id, maxList=49)}, headers=auth_headers()
    )
    assert fits.status_code == 200, fits.text
    assert fits.json()["plan"]["spec"]["screen"]["maxList"] == 49
