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
from ai_trading.api.schemas.replay import DayListPatch
from ai_trading.cli.seed_technical import seed_user
from ai_trading.core.calendar import et
from ai_trading.db.models import FilterStrategy, PracticePlan, ReplayDayList, User
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
            "armed": [],
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
        client.patch(
            f"{BASE}/day-lists/{list_id}", json={"watch": [f"S{i}" for i in range(21)]}, headers=auth_headers()
        ).status_code
        == 422
    )
    assert DayListPatch(watch=[f"S{i}" for i in range(20)]).watch  # 20 stars pass the schema; the 21st does not

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
    assert review["selection"]["median_move_pct"] == 3.77 and review["selection"]["picks_avg_move_pct"] == 3.77
    assert review["day"] == "2026-09-28" and review["dates_hidden"] is True  # the finished day shows its date (D-029)
    journal = ended.json()["journal"]
    assert journal["trades"] == 1 and ended.json()["status"] == "ended"
    (line,) = journal["lines"]  # a scratch: entered and exited at 110.00 (D-032)
    assert (line["symbol"], line["side"], line["shares"], line["entry_price"], line["exit_price"]) == (
        "GAPPER",
        "long",
        100,
        110.0,
        110.0,
    )
    assert (journal["wins"], journal["losses"], journal["scratches"], journal["pnl_usd"]) == (0, 0, 1, 0.0)
    assert (journal["balance_before"], journal["balance_after"]) == (50_000.0, 50_000.0)
    assert ended.json()["relist"] is None
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


def test_relist_moves_the_plan_and_rebuilds_the_day_and_answers_the_plan_rules(daily, db_session) -> None:
    client, services, _ = daily
    plan_id = _start_plan(daily, db_session)["plan"]["id"]
    plan_mod.run_prep(db_session, services, plan_id)
    list_id = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()["day_list_id"]
    url = f"{BASE}/day-lists/{list_id}/relist"

    assert client.post(url, json={"listAt": "9:00"}, headers=auth_headers()).status_code == 422  # not HH:MM
    early = client.post(url, json={"listAt": "08:00"}, headers=auth_headers())
    assert early.status_code == 422
    assert early.json()["detail"]["problems"] == [
        {"path": "listAt", "message": "Premarket filters need a list time of 8:30 AM or later"}
    ]
    assert client.post(url, json={"listAt": "10:00"}, headers=auth_headers(OTHER_EMAIL)).status_code == 404

    moved = client.post(url, json={"listAt": "10:00"}, headers=auth_headers())
    assert moved.status_code == 200, moved.text
    body = moved.json()
    assert body["id"] == list_id and body["screen"]["list_at"] == "10:00" and body["status"] == "listed"
    assert body["list_at"] == "2026-09-28T14:00:00Z" and body["data_through"] == "2026-09-28T13:45:00Z"
    assert (
        body["plan"]["spec"]["screen"]["listAt"] == "10:00"
        and body["plan"]["spec"]["setup"]["window"]["from"] == "10:00"
    )

    session = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers())
    assert session.status_code == 200, session.text
    under_way = client.post(url, json={"listAt": "10:30"}, headers=auth_headers())
    assert under_way.status_code == 409 and under_way.json()["detail"]["problems"][0]["path"] == "listAt"


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


def test_switching_names_over_the_routes_with_no_names_cap(daily, db_session) -> None:
    client, services, user_id = daily
    body = _plan_body(db_session, user_id)
    started = client.post(f"{BASE}/daily/next", json={"plan": body}, headers=auth_headers())
    assert started.status_code == 200, started.text
    assert "max_symbols" not in started.json()["plan"]
    plan = db_session.execute(select(PracticePlan).where(PracticePlan.owner_user_id == user_id)).scalar_one()
    plan.universe = {**plan.universe, "symbols": SYMBOLS}
    db_session.commit()
    plan_mod.run_prep(db_session, services, plan.id)
    list_id = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()["day_list_id"]
    row = db_session.get(ReplayDayList, list_id)
    row.candidates = [
        *row.candidates,
        {**row.candidates[0], "symbol": "FLAT", "rank": 2},
        {**row.candidates[0], "symbol": "SPLITTER", "rank": 3},
    ]
    db_session.commit()

    def start(symbol):
        return client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": symbol}, headers=auth_headers())

    def at(hhmm):
        return et(DAYS[0], hhmm).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")

    gapper = start("GAPPER").json()
    assert gapper["behind_clock"] is False and gapper["day_clock"] == "2026-09-28T13:30:00Z"
    client.post(f"{BASE}/sessions/{gapper['id']}/advance", json={"to": at("10:00")}, headers=auth_headers())
    flat = start("FLAT")
    assert flat.status_code == 200, flat.text
    assert flat.json()["revealed_through"] == at("10:00") and flat.json()["day_clock"] == at("10:00")
    assert start("GAPPER").json()["id"] == gapper["id"]  # a name in hand resumes

    client.post(f"{BASE}/sessions/{flat.json()['id']}/advance", json={"to": at("10:30")}, headers=auth_headers())
    behind = client.get(f"{BASE}/sessions/{gapper['id']}", headers=auth_headers()).json()
    assert behind["behind_clock"] is True and behind["revealed_through"] == at("10:00")
    feed = client.get(f"{BASE}/sessions/{gapper['id']}/feed", headers=auth_headers()).json()
    assert feed["behind_clock"] is True and feed["revealed_through"] == at("10:00")
    refused = client.post(
        f"{BASE}/sessions/{gapper['id']}/marks", json={"schemaVersion": 1, "kind": "long_entry"}, headers=auth_headers()
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["problems"][0]["message"].startswith("This name is behind the day clock")
    caught = client.post(f"{BASE}/sessions/{gapper['id']}/advance", json={"to": at("10:05")}, headers=auth_headers())
    assert caught.json()["revealed_through"] == at("10:30") and caught.json()["behind_clock"] is False

    entered = client.post(
        f"{BASE}/sessions/{gapper['id']}/marks", json={"schemaVersion": 1, "kind": "long_entry"}, headers=auth_headers()
    )
    assert entered.status_code == 200
    blocked = start("FLAT")
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["problems"][0]["message"].startswith("Close your open GAPPER practice trade")
    strip = client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers()).json()["sessions"]
    assert [(s["symbol"], s["behind_clock"], s["has_open_trade"]) for s in strip] == [
        ("GAPPER", False, True),
        ("FLAT", False, False),
    ]
    stars = client.patch(
        f"{BASE}/day-lists/{list_id}", json={"watch": ["GAPPER", "FLAT", "SPLITTER"]}, headers=auth_headers()
    )
    assert stars.status_code == 200, stars.text
    assert [w["symbol"] for w in stars.json()["watch"]] == ["GAPPER", "FLAT", "SPLITTER"]
    ended = client.post(f"{BASE}/day-lists/{list_id}/end", headers=auth_headers())
    assert ended.status_code == 200 and ended.json()["journal"]["trades"] == 1


def test_the_recorded_universe_route_reads_coverage_the_default_and_one_morning(daily, db_session) -> None:
    client, _, _ = daily
    empty = client.get(f"{BASE}/universe-days", headers=auth_headers())
    assert empty.status_code == 200 and empty.headers["cache-control"] == "no-store"
    assert empty.json()["coverage"] == {"first_day": None, "last_day": None, "days": 0}
    assert empty.json()["first_day_default"] is None and empty.json()["day"] is None

    from ai_trading.db.models import UniverseDay

    for offset, day in enumerate(sorted({d for d in (DAYS[0], DAYS[1])})):
        db_session.add(UniverseDay(day=day, symbols=["GAPPER", "FLAT"][: 2 - offset], created_at=NOW))
    db_session.commit()
    read = client.get(f"{BASE}/universe-days", params={"day": DAYS[0].isoformat()}, headers=auth_headers()).json()
    assert read["coverage"] == {"first_day": DAYS[0].isoformat(), "last_day": DAYS[1].isoformat(), "days": 2}
    assert read["day"] == {
        "day": DAYS[0].isoformat(),
        "recorded": True,
        "size": 2,
        "symbols": ["FLAT", "GAPPER"],  # read back sorted
        "note": "Practice universe · the 2 symbols the Desk scanned that morning, as recorded",
    }
    gap = client.get(f"{BASE}/universe-days", params={"day": "2026-03-02"}, headers=auth_headers()).json()["day"]
    assert gap["recorded"] is False and "before the Desk began recording" in gap["note"]
    assert client.get(f"{BASE}/universe-days", params={"day": "not-a-day"}, headers=auth_headers()).status_code == 422


def test_the_rescan_route_scans_at_the_day_clock_and_leaves_the_frozen_list_alone(daily, db_session) -> None:
    client, services, _ = daily
    plan_id = _start_plan(daily, db_session)["plan"]["id"]
    plan_mod.run_prep(db_session, services, plan_id)
    list_id = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers()).json()["day_list_id"]
    assert client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers()).json()["rescan"] is None
    early = client.post(f"{BASE}/day-lists/{list_id}/rescan", headers=auth_headers())
    assert early.status_code == 409
    assert early.json()["detail"]["problems"][0]["message"].startswith("Practice a name first")

    session = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers())
    to = et(DAYS[0], "10:00").tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")
    client.post(f"{BASE}/sessions/{session.json()['id']}/advance", json={"to": to}, headers=auth_headers())
    frozen = client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers()).json()
    scanned = client.post(f"{BASE}/day-lists/{list_id}/rescan", headers=auth_headers())
    assert scanned.status_code == 200, scanned.text
    body = scanned.json()
    assert body["rescan"]["seq"] == 1 and body["rescan"]["as_of"] == to
    assert body["rescan"]["data_through"] == "2026-09-28T13:45:00Z" and body["rescan"]["new_count"] == 0
    assert [(c["symbol"], c["new_since_list"]) for c in body["rescan"]["candidates"]] == [("GAPPER", False)]
    assert body["rescan"]["universe"]["footnote"] == body["universe"]["footnote"]
    for key in ("candidates", "universe", "columns", "watch", "data_through", "list_at"):
        assert body[key] == frozen[key]  # the frozen list is exactly what it was
    again = client.post(f"{BASE}/day-lists/{list_id}/rescan", headers=auth_headers())
    assert again.json()["rescan"]["seq"] == 1  # the clock has not moved: the same scan
    assert client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers()).json()["rescan"]["seq"] == 1

    other = auth_headers(OTHER_EMAIL)
    assert client.post(f"{BASE}/day-lists/{list_id}/rescan", headers=other).status_code == 404
    assert client.post(f"{BASE}/day-lists/{list_id}/end", headers=auth_headers()).status_code == 200
    closed = client.post(f"{BASE}/day-lists/{list_id}/rescan", headers=auth_headers())
    assert closed.status_code == 409
    assert closed.json()["detail"]["problems"][0]["message"] == "The day is over · scans are closed"
