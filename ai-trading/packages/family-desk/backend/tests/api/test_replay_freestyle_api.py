"""The freestyle thread's routes end to end (ADR-0025): create with a setup, the clock (play, Jump, 422 on a past or
over-horizon time), lanes, marks, orders, the Portfolio, the Screen, close, and the routes the day model had that are
gone. Real Postgres (`scripts/test-db.sh`); the history comes from `tests/daily_world.py`, no network."""

from typing import Any

import pandas as pd
import pytest
from conftest import OTHER_EMAIL, auth_headers
from daily_world import DAYS, NOW, make_services
from fastapi.testclient import TestClient
from sqlalchemy import select

from ai_trading.api.app import app
from ai_trading.api.replay import get_services
from ai_trading.cli.seed_technical import seed_user
from ai_trading.core.calendar import ET, et
from ai_trading.db.models import FilterStrategy, User

BASE = "/api/desk/replay"


def _iso(day: int, hhmm: str) -> str:
    return et(DAYS[day], hhmm).tz_convert(ET).isoformat(timespec="seconds")


@pytest.fixture
def api(client: TestClient, db_session):
    services = make_services()
    app.dependency_overrides[get_services] = lambda: services
    client.get(f"{BASE}/threads", headers=auth_headers())  # creates the user
    user_id = db_session.execute(select(User.id).where(User.email == "owner@example.com")).scalar_one()
    seed_user(db_session, user_id, now=NOW)
    db_session.commit()
    gap_up = db_session.execute(
        select(FilterStrategy.id).where(FilterStrategy.owner_user_id == user_id, FilterStrategy.name == "Gap up")
    ).scalar_one()
    return client, services, gap_up


def _setup(gap_up: int, day: int = 0, hhmm: str = "10:00") -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "startAt": _iso(day, hhmm),
        "screen": {"filters": [{"id": gap_up}], "maxList": 30},
        "setup": {"interval": "5m", "session": "regular", "armed": []},
    }


def _body(setup: dict[str, Any]) -> dict[str, Any]:
    plan = {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"}
    return {"schemaVersion": 1, "mode": "day", "startingBalance": 50000, "plan": plan, "setup": setup}


def _thread(client: TestClient, gap_up: int, **setup) -> dict[str, Any]:
    body = {
        "schemaVersion": 1,
        "mode": "day",
        "startingBalance": 50000,
        "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"},
        "setup": _setup(gap_up, **setup),
    }
    made = client.post(f"{BASE}/threads", json=body, headers=auth_headers())
    assert made.status_code == 200, made.text
    return made.json()


def test_a_thread_created_with_a_setup_has_a_paused_clock_at_its_start_and_a_screen(api) -> None:
    client, _, gap_up = api
    made = _thread(client, gap_up)
    thread_id = made["thread"]["id"]
    assert made["thread"]["name"].startswith("Freestyle · ") and made["positions_open"] == 0
    assert pd.Timestamp(made["clock"]["clock"]) == et(DAYS[0], "10:00") and made["clock"]["running"] is False

    clock = client.get(f"{BASE}/threads/{thread_id}/clock", headers=auth_headers()).json()
    assert clock["state"] == "paused" and pd.Timestamp(clock["next_open"]) == et(DAYS[1], "09:30")
    assert clock["account"]["equity_usd"] == 50000.0 and clock["pause"] is None
    assert pd.Timestamp(clock["start_at"]) == et(DAYS[0], "10:00") and "horizon" in clock

    screen = client.get(f"{BASE}/threads/{thread_id}/screen", headers=auth_headers())
    assert screen.status_code == 200, screen.text
    assert screen.json()["day"] == DAYS[0].isoformat() and screen.json()["lanes"] == []


def test_a_jump_keeps_the_position_and_the_portfolio_prices_it_at_the_new_time(api) -> None:
    client, _, gap_up = api
    thread_id = _thread(client, gap_up)["thread"]["id"]
    opened = client.post(f"{BASE}/threads/{thread_id}/lanes", json={"symbol": "GAPPER"}, headers=auth_headers())
    assert opened.status_code == 200, opened.text
    session_id = opened.json()["id"]
    bought = client.post(
        f"{BASE}/sessions/{session_id}/marks",
        json={"schemaVersion": 1, "kind": "long_entry", "shares": 100},
        headers=auth_headers(),
    )
    assert bought.status_code == 200 and bought.json()["mark"]["price"] == 110.0

    jumped = client.post(f"{BASE}/threads/{thread_id}/clock", json={"to": _iso(2, "12:00")}, headers=auth_headers())
    assert jumped.status_code == 200, jumped.text
    book = client.get(f"{BASE}/threads/{thread_id}/portfolio", headers=auth_headers()).json()
    [held] = book["positions"]
    assert (held["symbol"], held["shares"], held["avg_cost"], held["price"]) == ("GAPPER", 100, 110.0, 100.0)
    assert held["unrealized_usd"] == -1000.0 and book["account"]["equity_usd"] == 49000.0
    assert client.get(f"{BASE}/threads/{thread_id}/ledger", headers=auth_headers()).json()["total"] == 0

    # The lane is behind the clock until a screen syncs it; the sync is the only thing a name may do to time
    behind = client.post(
        f"{BASE}/sessions/{session_id}/marks", json={"schemaVersion": 1, "kind": "long_exit"}, headers=auth_headers()
    )
    assert behind.status_code == 422 and "behind the thread clock" in behind.text
    synced = client.post(f"{BASE}/sessions/{session_id}/advance", json={"sync": True}, headers=auth_headers())
    assert synced.status_code == 200 and pd.Timestamp(synced.json()["thread_time"]) == et(DAYS[2], "12:00")
    assert (
        client.post(
            f"{BASE}/sessions/{session_id}/advance", json={"to": _iso(3, "10:00")}, headers=auth_headers()
        ).status_code
        == 422
    )


def test_the_clock_refuses_the_past_and_the_unavailable(api) -> None:
    client, services, gap_up = api
    services.now = lambda: et(DAYS[4], "20:30").to_pydatetime()
    thread_id = _thread(client, gap_up, day=2)["thread"]["id"]
    ok = client.post(f"{BASE}/threads/{thread_id}/clock", json={"to": _iso(3, "10:00")}, headers=auth_headers())
    assert ok.status_code == 200
    past = client.post(f"{BASE}/threads/{thread_id}/clock", json={"to": _iso(3, "09:59")}, headers=auth_headers())
    assert past.status_code == 422 and past.json()["detail"]["problems"][0]["path"] == "to"
    same = client.post(f"{BASE}/threads/{thread_id}/clock", json={"to": _iso(3, "10:00")}, headers=auth_headers())
    assert same.status_code == 200
    over = client.post(f"{BASE}/threads/{thread_id}/clock", json={"to": _iso(4, "20:01")}, headers=auth_headers())
    assert over.status_code == 422 and "no data past" in over.text
    assert (
        client.post(
            f"{BASE}/threads/{thread_id}/clock", json={"step": "next_signal"}, headers=auth_headers()
        ).status_code
        == 422
    )
    stepped = client.post(f"{BASE}/threads/{thread_id}/clock", json={"step": "bar"}, headers=auth_headers())
    assert stepped.status_code == 200 and pd.Timestamp(stepped.json()["clock"]) == et(DAYS[3], "10:05")


def test_a_day_order_carries_its_lifetime_and_a_closing_order_is_reduce_only(api) -> None:
    client, _, gap_up = api
    thread_id = _thread(client, gap_up)["thread"]["id"]
    session_id = client.post(
        f"{BASE}/threads/{thread_id}/lanes", json={"symbol": "FLAT"}, headers=auth_headers()
    ).json()["id"]
    client.post(
        f"{BASE}/sessions/{session_id}/marks", json={"schemaVersion": 1, "kind": "long_entry"}, headers=auth_headers()
    )
    stop = client.post(
        f"{BASE}/sessions/{session_id}/orders",
        json={"side": "sell", "orderType": "stop", "stopPrice": 45.0, "timeInForce": "day"},
        headers=auth_headers(),
    )
    assert stop.status_code == 200, stop.text
    order = stop.json()["order"]
    assert (order["tif"], order["reduce_only"]) == ("day", True)
    assert pd.Timestamp(order["expires_at"]) == et(DAYS[0], "20:00")
    book = client.get(f"{BASE}/threads/{thread_id}/portfolio", headers=auth_headers()).json()
    assert [(o["symbol"], o["reduce_only"]) for o in book["orders"]] == [("FLAT", True)]
    bad = client.post(
        f"{BASE}/sessions/{session_id}/orders",
        json={"side": "sell", "orderType": "stop", "stopPrice": 45.0, "timeInForce": "forever"},
        headers=auth_headers(),
    )
    assert bad.status_code == 422


def test_closing_a_thread_keeps_its_positions_and_refuses_more_time(api) -> None:
    client, _, gap_up = api
    thread_id = _thread(client, gap_up)["thread"]["id"]
    session_id = client.post(
        f"{BASE}/threads/{thread_id}/lanes", json={"symbol": "FLAT"}, headers=auth_headers()
    ).json()["id"]
    client.post(
        f"{BASE}/sessions/{session_id}/marks", json={"schemaVersion": 1, "kind": "long_entry"}, headers=auth_headers()
    )
    closed = client.post(f"{BASE}/threads/{thread_id}/close", headers=auth_headers())
    assert closed.status_code == 200 and closed.json()["thread"]["status"] == "closed"
    assert closed.json()["positions_open"] == 1 and closed.json()["clock"]["running"] is False
    book = client.get(f"{BASE}/threads/{thread_id}/portfolio", headers=auth_headers()).json()
    assert [p["shares"] for p in book["positions"]] == [100]
    frozen = client.post(f"{BASE}/threads/{thread_id}/clock", json={"to": _iso(2, "10:00")}, headers=auth_headers())
    assert frozen.status_code == 409
    assert (
        client.delete(f"{BASE}/threads/{thread_id}", headers=auth_headers()).status_code == 204
    )  # no open day to wait for


def test_the_thread_cap_is_ten_across_every_thread(api) -> None:
    client, _, gap_up = api
    for _ in range(10):
        _thread(client, gap_up)
    full = client.post(
        f"{BASE}/threads",
        json={"schemaVersion": 1, "mode": "day", "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"}},
        headers=auth_headers(),
    )
    assert full.status_code == 409 and "slots are in use" in full.text
    assert client.get(f"{BASE}/threads/capacity", headers=auth_headers()).json() == {"day_active": 10, "day_max": 10}


def test_the_day_model_routes_are_gone_and_a_stranger_sees_nothing(api) -> None:
    client, _, gap_up = api
    thread_id = _thread(client, gap_up)["thread"]["id"]
    for method, path in (
        ("POST", f"/threads/{thread_id}/skip-day"),
        ("GET", "/daily"),
        ("POST", "/daily/next"),
        ("GET", "/day-lists/1"),
        ("POST", "/day-lists/1/end"),
        ("POST", "/day-lists/1/relist"),
        ("POST", "/sessions"),
        ("GET", "/days"),
        ("GET", f"/threads/{thread_id}/holds"),
        ("POST", "/threads/swing-universe"),
    ):
        assert client.request(method, f"{BASE}{path}", headers=auth_headers(), json={}).status_code in (404, 405), path
    other = auth_headers(OTHER_EMAIL)
    for path in ("clock", "portfolio", "screen"):
        assert client.get(f"{BASE}/threads/{thread_id}/{path}", headers=other).status_code == 404
    assert client.post(f"{BASE}/threads/{thread_id}/lanes", json={"symbol": "FLAT"}, headers=other).status_code == 404
    swing = client.post(f"{BASE}/threads", json={"schemaVersion": 1, "mode": "swing"}, headers=auth_headers())
    assert swing.status_code == 409 and "Swing threads are closed" in swing.text


def _abnormal_volume(db_session) -> int:
    return db_session.execute(
        select(FilterStrategy.id)
        .join(User, User.id == FilterStrategy.owner_user_id)
        .where(User.email == "owner@example.com", FilterStrategy.name == "Abnormal volume")
    ).scalar_one()


def test_a_fresh_thread_scans_at_the_form_default_start_and_the_filter_that_waits_says_so(api, db_session) -> None:
    """D-216: Abnormal volume reads 15-minute bars, so it has none to read at 09:30. The scan lists the other filter's
    names, says when Abnormal volume starts to list, and does not refuse the scan."""
    from ai_trading.replay import plan as plan_mod

    client, services, gap_up = api
    setup = _setup(gap_up, day=0, hhmm="09:30")
    setup["screen"]["filters"].append({"id": _abnormal_volume(db_session)})
    made = client.post(f"{BASE}/threads", json=_body(setup), headers=auth_headers())
    assert made.status_code == 200, made.text
    thread_id = made.json()["thread"]["id"]
    started = client.post(f"{BASE}/threads/{thread_id}/screen/rescan", headers=auth_headers())
    assert started.status_code == 200, started.text
    screen = db_session.execute(
        select(plan_mod.ReplayDayList).where(plan_mod.ReplayDayList.thread_id == thread_id)
    ).scalar_one()
    plan_mod.run_rescan(db_session, services, screen.id, screen.rescan_job["run"])
    done = client.get(f"{BASE}/threads/{thread_id}/screen", headers=auth_headers()).json()
    assert done["rescan_job"]["state"] == "done"
    filters = {item["name"]: item for item in done["universe"]["filters"]}
    assert filters["Abnormal volume"]["reads_from"] == "10:00" and filters["Abnormal volume"]["scanned"] == 0
    assert filters["Gap up"]["reads_from"] is None and filters["Gap up"]["scanned"] > 0
    assert [c["symbol"] for c in done["candidates"]] == ["GAPPER"]
    assert done["warnings"][0] == (
        "Abnormal volume lists no names until 10:00 AM ET · at 9:30 AM ET its first bar of the day cannot be read yet"
    )


def test_a_closed_day_is_refused_under_the_start_date_where_she_pressed_start(api) -> None:
    """D-230: a market holiday is the start date's problem, so the form shows it under the date, not at the note."""
    client, _, gap_up = api
    setup = _setup(gap_up)
    setup["startAt"] = "2026-07-03T10:00:00-04:00"  # Independence Day observed: the market was closed
    refused = client.post(f"{BASE}/threads", json=_body(setup), headers=auth_headers())
    assert refused.status_code == 422
    assert refused.json()["detail"]["problems"] == [
        {"path": "startAt", "message": "No trading on Fri 2026-07-03 · the market was closed"}
    ]


def test_a_screen_whose_every_filter_waits_is_refused_with_the_time_they_read_from(api, db_session) -> None:
    client, _, _ = api
    setup = _setup(_abnormal_volume(db_session), day=0, hhmm="09:30")
    thread_id = client.post(f"{BASE}/threads", json=_body(setup), headers=auth_headers()).json()["thread"]["id"]
    refused = client.post(f"{BASE}/threads/{thread_id}/screen/rescan", headers=auth_headers())
    assert refused.status_code == 409
    assert refused.json()["detail"]["problems"][0]["message"] == (
        "Abnormal volume waits until 10:00 AM ET · no filter has a bar to read at 9:30 AM ET"
    )


def test_the_screen_is_rescanned_at_the_threads_time(api, db_session) -> None:
    from ai_trading.replay import plan as plan_mod

    client, services, gap_up = api
    thread_id = _thread(client, gap_up, day=0, hhmm="10:30")["thread"]["id"]
    started = client.post(f"{BASE}/threads/{thread_id}/screen/rescan", headers=auth_headers())
    assert started.status_code == 200, started.text
    assert started.json()["rescan_job"]["state"] == "running"
    screen = db_session.execute(
        select(plan_mod.ReplayDayList).where(plan_mod.ReplayDayList.thread_id == thread_id)
    ).scalar_one()
    plan_mod.run_rescan(db_session, services, screen.id, screen.rescan_job["run"])  # the detached job, run inline
    done = client.get(f"{BASE}/threads/{thread_id}/screen?live=true", headers=auth_headers()).json()
    assert done["rescan_job"]["state"] == "done" and pd.Timestamp(done["rescan"]["as_of"]) == et(DAYS[0], "10:30")
    assert [c["symbol"] for c in done["candidates"]] == ["GAPPER"] and done["candidates"][0]["live"] is not None
    starred = client.patch(f"{BASE}/threads/{thread_id}/screen", json={"watch": ["GAPPER"]}, headers=auth_headers())
    assert starred.status_code == 200 and [w["symbol"] for w in starred.json()["watch"]] == ["GAPPER"]
    unknown = client.patch(f"{BASE}/threads/{thread_id}/screen", json={"watch": ["FLAT"]}, headers=auth_headers())
    assert unknown.status_code == 422
    # A second scan at the same time starts nothing; a Jump makes the next one real
    again = client.post(f"{BASE}/threads/{thread_id}/screen/rescan", headers=auth_headers()).json()
    assert again["rescan_job"]["state"] == "done"
    client.post(f"{BASE}/threads/{thread_id}/clock", json={"to": _iso(2, "10:30")}, headers=auth_headers())
    moved = client.post(f"{BASE}/threads/{thread_id}/screen/rescan", headers=auth_headers()).json()
    assert moved["rescan_job"]["state"] == "running" and moved["day"] == DAYS[2].isoformat()
