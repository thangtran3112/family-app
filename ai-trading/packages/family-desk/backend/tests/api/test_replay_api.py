"""The Practice (replay) routes end to end on the R0 TSLA fixture day (02o §i): create, advance, marks, undo, end,
ownership, the plain 422 messages, and the no-lookahead property. Real Postgres (`scripts/test-db.sh`), no network:
`bars` and `trades` answer from `tests/fixtures/desk-replay/` through the same registry protocols."""

import random
from datetime import UTC, date, datetime
from typing import Any

import pandas as pd
import pytest
from fakes import fake_data_sources
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.api.app import app
from ai_trading.api.replay import get_services
from ai_trading.db.models import Alert, Delivery, Signal
from ai_trading.replay import fixture
from ai_trading.replay.data import History
from ai_trading.replay.session import Services
from ai_trading.replay.tape import NOT_LAST_SALE, Tape

OWNER = {"Cf-Access-Authenticated-User-Email": "owner@example.com"}
OTHER = {"Cf-Access-Authenticated-User-Email": "spouse@example.com"}
NOW = datetime(2026, 10, 24, 16, 0, tzinfo=UTC)
OPEN = pd.Timestamp("2026-09-25T13:30:00Z")  # 09:30 ET on the fixture day (EDT)
BASE = "/api/desk/replay"
SPEC: dict[str, Any] = {
    "schemaVersion": 1,
    "symbol": "TSLA",
    "day": "2026-09-25",
    "window": {"from": "09:30", "to": "10:30"},
    "session": "regular",
    "interval": "5m",
    "shares": 100,
    "armed": [],
    "plan": {"stopRequired": "yes", "signalOnly": "no", "maxLossUsd": 500, "maxTrades": 3},
    "hideDate": "no",
}


def iso(offset_seconds: float) -> str:
    return (OPEN + pd.Timedelta(seconds=offset_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_services(now: datetime = NOW) -> Services:
    sources = fixture.fixture_sources(fake_data_sources())
    return Services(history=History(sources, now=lambda: now), tape=Tape(sources, now=lambda: now), now=lambda: now)


@pytest.fixture
def replay(client: TestClient) -> TestClient:
    services = make_services()
    app.dependency_overrides[get_services] = lambda: services
    return client


def prints_up_to(t: pd.Timestamp) -> list[list[Any]]:
    """Independent of the service: the fixture's eligible prints at or before `t` (what a mark is priced at)."""
    rows = fixture._gz("prints-tsla-2026-09-25.json.gz")["rows"]
    limit = t.value // 1000
    return [r for r in rows if r[0] <= limit and not (set(r[4]) & NOT_LAST_SALE)]


def start(client: TestClient, **changes: Any) -> dict[str, Any]:
    response = client.post(f"{BASE}/sessions", json={**SPEC, **changes}, headers=OWNER)
    assert response.status_code == 200, response.text
    return response.json()


def advance(client: TestClient, session_id: int, seconds: float, **body: Any) -> dict[str, Any]:
    response = client.post(f"{BASE}/sessions/{session_id}/advance", json={"to": iso(seconds), **body}, headers=OWNER)
    assert response.status_code == 200, response.text
    return response.json()


def mark(client: TestClient, session_id: int, body: dict[str, Any]):
    return client.post(f"{BASE}/sessions/{session_id}/marks", json={"schemaVersion": 1, **body}, headers=OWNER)


# -- create and the plain 422 messages -----------------------------------------------------------------------


def test_create_starts_at_the_window_open_and_is_idempotent(replay: TestClient) -> None:
    first = start(replay)
    assert first["status"] == "active" and first["attempt"] == 1
    assert first["revealed_through"] == iso(0) and first["window_end"] == iso(3600)
    assert first["spec"]["window"] == {"from": "09:30", "to": "10:30"}
    assert first["tape_feed"] == "sip" and first["stamp"]["freshness"] == "replay"
    assert first["marks"] == [] and first["open_trade"] is None
    assert start(replay)["id"] == first["id"]  # a second POST returns the active one


def test_replay_again_after_end_is_a_new_attempt(replay: TestClient) -> None:
    first = start(replay)
    assert replay.post(f"{BASE}/sessions/{first['id']}/end", headers=OWNER).status_code == 200
    second = start(replay)
    assert second["attempt"] == 2 and second["id"] != first["id"] and second["revealed_through"] == iso(0)


@pytest.mark.parametrize(
    ("changes", "path", "message"),
    [
        ({"day": "2026-09-26"}, "day", "No trading on Sat 2026-09-26 · pick a weekday"),
        ({"day": "2026-12-01"}, "day", "This session isn't finished yet · replay opens at 4:15 PM ET"),
        ({"day": "2015-12-31"}, "day", "Replay goes back to Jan 4, 2016"),
        ({"symbol": "AAPL"}, "day", "No trades for AAPL on Fri 2026-09-25"),
        ({"window": {"from": "10:00", "to": "09:45"}}, "window", "window.from must be before window.to"),
        ({"window": {"from": "09:00", "to": "10:00"}}, "window", "a regular-session window must stay inside"),
        ({"shares": 0}, "shares", ""),
        ({"armed": [{"source": "alert_strategy", "id": 999}]}, "armed.0.id", "Strategy not found"),
    ],
)
def test_create_rejections_are_plain_422_problems(
    replay: TestClient, changes: dict[str, Any], path: str, message: str
) -> None:
    response = replay.post(f"{BASE}/sessions", json={**SPEC, **changes}, headers=OWNER)
    assert response.status_code == 422, response.text
    problems = response.json()["detail"]["problems"]
    assert any(p["path"] == path and message in p["message"] for p in problems), problems


def test_an_unfinished_day_names_the_time_replay_opens(client: TestClient) -> None:
    services = make_services(datetime(2026, 9, 25, 19, 0, tzinfo=UTC))  # 3:00 PM ET on the day itself
    app.dependency_overrides[get_services] = lambda: services
    response = client.post(f"{BASE}/sessions", json=SPEC, headers=OWNER)
    assert response.status_code == 422
    assert response.json()["detail"]["problems"][0]["message"] == (
        "This session isn't finished yet · replay opens at 4:15 PM ET"
    )


def test_requests_without_the_gateway_identity_are_401(replay: TestClient) -> None:
    assert replay.get(f"{BASE}/sessions").status_code == 401


# -- the playhead and no lookahead ---------------------------------------------------------------------------


def test_advance_reveals_only_what_the_playhead_passed(replay: TestClient) -> None:
    session = start(replay)
    delta = advance(replay, session["id"], 90)
    assert delta["revealed_through"] == iso(90) and delta["at_end"] is False
    assert delta["bars"] == []  # no 5-minute bar has closed yet
    assert delta["forming"]["t"] == iso(0) and delta["forming"]["c"] > 0  # one closed minute is in it
    rows = delta["prints"]["rows"]
    assert rows
    assert all(pd.Timestamp(row[0]) <= OPEN + pd.Timedelta(seconds=90) for row in rows)
    assert delta["prints"]["feed"] == "sip" and delta["last"]["price"] > 0
    later = advance(replay, session["id"], 330)  # passes the 09:35 bar close
    assert [b["t"] for b in later["bars"]] == [iso(0)]
    assert pd.Timestamp(later["bars"][0]["t"]) + pd.Timedelta(minutes=5) <= pd.Timestamp(later["revealed_through"])


def test_the_playhead_never_moves_back_and_clamps_to_the_window_end(replay: TestClient) -> None:
    session = start(replay)
    advance(replay, session["id"], 600)
    back = advance(replay, session["id"], 120)
    assert back["revealed_through"] == iso(600) and back["bars"] == [] and back["prints"]["rows"] == []
    past = advance(replay, session["id"], 99999)
    assert past["revealed_through"] == iso(3600) and past["at_end"] is True


def test_advance_needs_exactly_one_of_to_and_step(replay: TestClient) -> None:
    session = start(replay)
    both = replay.post(f"{BASE}/sessions/{session['id']}/advance", json={"to": iso(60), "step": "bar"}, headers=OWNER)
    none = replay.post(f"{BASE}/sessions/{session['id']}/advance", json={}, headers=OWNER)
    assert both.status_code == 422 and none.status_code == 422


def test_step_bar_goes_to_the_next_display_bar_close(replay: TestClient) -> None:
    session = start(replay)
    first = replay.post(f"{BASE}/sessions/{session['id']}/advance", json={"step": "bar"}, headers=OWNER).json()
    assert first["revealed_through"] == iso(300) and [b["t"] for b in first["bars"]] == [iso(0)]
    second = replay.post(f"{BASE}/sessions/{session['id']}/advance", json={"step": "bar"}, headers=OWNER).json()
    assert second["revealed_through"] == iso(600)


def test_step_next_signal_with_none_left_is_a_plain_422(replay: TestClient) -> None:
    session = start(replay)
    response = replay.post(f"{BASE}/sessions/{session['id']}/advance", json={"step": "next_signal"}, headers=OWNER)
    assert response.status_code == 422
    assert response.json()["detail"]["problems"][0]["message"] == "No more signals in this session"


def test_random_advances_never_leak_past_the_playhead(replay: TestClient) -> None:
    """The core guarantee: whatever order of steps, jumps and clamps, nothing returned is later than `to`,
    `revealed_through` never decreases, `feed` never exceeds it, and an active GET has no signal list."""
    rng = random.Random(7)
    session = start(replay)
    sid, through = session["id"], OPEN
    for _ in range(25):
        if rng.random() < 0.3:
            response = replay.post(f"{BASE}/sessions/{sid}/advance", json={"step": "bar"}, headers=OWNER)
        else:
            response = replay.post(
                f"{BASE}/sessions/{sid}/advance",
                json={
                    "to": iso(rng.choice([-30, 5, 20, 61, 180, 900, 5000]))
                    if rng.random() < 0.9
                    else iso(rng.randint(0, 3600))
                },
                headers=OWNER,
            )
        assert response.status_code == 200, response.text
        delta = response.json()
        now = pd.Timestamp(delta["revealed_through"])
        assert now >= through
        through = now
        assert all(pd.Timestamp(b["t"]) + pd.Timedelta(minutes=1) <= now for b in delta["bars"])
        assert all(pd.Timestamp(row[0]) <= now for row in delta["prints"]["rows"])
        assert all(pd.Timestamp(s["bar_close"]) <= now for s in delta["signals"])
        if delta["forming"]:
            assert pd.Timestamp(delta["forming"]["t"]) < now
        if delta["last"]:
            assert pd.Timestamp(delta["last"]["at"]) <= now
        feed = replay.get(f"{BASE}/sessions/{sid}/feed", headers=OWNER).json()
        assert pd.Timestamp(feed["revealed_through"]) == now
        assert all(pd.Timestamp(b["t"]) + pd.Timedelta(minutes=1) <= now for b in feed["bars"])
        assert all(pd.Timestamp(row[0]) <= now for row in feed["prints"]["rows"])
        state = replay.get(f"{BASE}/sessions/{sid}", headers=OWNER).json()
        assert "signals" not in state and pd.Timestamp(state["revealed_through"]) == now
        assert "would_fire" not in state


def test_feed_returns_lookback_plus_window_and_switches_interval(replay: TestClient) -> None:
    session = start(replay, interval="15m")
    advance(replay, session["id"], 1230)
    five = replay.get(f"{BASE}/sessions/{session['id']}/feed?interval=5m", headers=OWNER).json()
    fifteen = replay.get(f"{BASE}/sessions/{session['id']}/feed", headers=OWNER).json()
    assert five["interval"] == "5m" and fifteen["interval"] == "15m"
    assert five["window_start"] == iso(0)
    in_window = [b for b in five["bars"] if pd.Timestamp(b["t"]) >= OPEN]
    assert [b["t"] for b in in_window] == [iso(0), iso(300), iso(600), iso(900)]  # the 09:35..09:50 closes
    assert len(five["bars"]) > len(in_window)  # the warm-up lookback is there
    assert pd.Timestamp(five["bars"][-1]["t"]) + pd.Timedelta(minutes=5) <= OPEN + pd.Timedelta(seconds=1230)
    assert all(pd.Timestamp(row[0]) <= OPEN + pd.Timedelta(seconds=1230) for row in five["prints"]["rows"])


def test_the_served_spec_leaves_unset_plan_fields_out(replay: TestClient) -> None:
    session = start(replay)
    assert session["spec"]["plan"] == {"stopRequired": "yes", "signalOnly": "no", "maxLossUsd": 500, "maxTrades": 3}
    assert (
        replay.get(f"{BASE}/sessions/{session['id']}", headers=OWNER).json()["spec"]["plan"] == session["spec"]["plan"]
    )


def test_feed_honors_the_big_print_filter(replay: TestClient) -> None:
    sid = start(replay)["id"]
    advance(replay, sid, 60)
    everything = replay.get(f"{BASE}/sessions/{sid}/feed", headers=OWNER).json()["prints"]
    big = replay.get(f"{BASE}/sessions/{sid}/feed?min_notional=1000000000", headers=OWNER).json()["prints"]
    assert everything["rows"]
    assert big["rows"] == [] and big["shown"] == 0
    assert big["count"] == everything["count"] and big["volume"] == everything["volume"]


def test_size_filter_and_cap_keep_count_and_volume_whole(replay: TestClient) -> None:
    results = []
    for n, body in enumerate(({"max_prints": 2000}, {"max_prints": 5}, {"min_size": 100})):
        who = {"Cf-Access-Authenticated-User-Email": f"user{n}@example.com"}
        sid = replay.post(f"{BASE}/sessions", json=SPEC, headers=who).json()["id"]
        advance_as = replay.post(f"{BASE}/sessions/{sid}/advance", json={"to": iso(60), **body}, headers=who)
        results.append(advance_as.json()["prints"])
    everything, capped, filtered = results
    assert capped["shown"] == 5 and len(capped["rows"]) == 5 and capped["rows"] == everything["rows"][-5:]
    assert capped["count"] == everything["count"] == filtered["count"]
    assert capped["volume"] == everything["volume"] == filtered["volume"]
    assert filtered["rows"] and all(row[2] >= 100 for row in filtered["rows"])
    assert filtered["shown"] < everything["shown"]


# -- practice marks ------------------------------------------------------------------------------------------


def test_marks_are_stamped_at_the_playhead_and_priced_at_the_last_print(replay: TestClient) -> None:
    sid = start(replay)["id"]
    advance(replay, sid, 300)
    entered = mark(replay, sid, {"kind": "long_entry", "stopPrice": 1.0, "note": "ORB hold"})
    assert entered.status_code == 200, entered.text
    entry = entered.json()["mark"]
    expected = prints_up_to(OPEN + pd.Timedelta(seconds=300))[-1]
    assert entry["at"] == iso(300) and entry["price"] == expected[1]
    assert entry["shares"] == 100 and entry["trade_no"] == 1 and entry["source"] == "her" and entry["seq"] == 1
    assert entered.json()["open_trade"]["side"] == "long"

    advance(replay, sid, 480)
    exited = mark(replay, sid, {"kind": "long_exit"})
    assert exited.status_code == 200, exited.text
    exit_price = prints_up_to(OPEN + pd.Timedelta(seconds=480))[-1][1]
    pnl = round((exit_price - expected[1]) * 100, 2)
    journal = exited.json()["journal"]
    assert journal["totals"]["pnl_usd"] == pnl and journal["totals"]["trades"] == 1
    assert journal["trades"][0]["entry_price"] == expected[1] and journal["trades"][0]["exit_price"] == exit_price
    assert journal["trades"][0]["shares"] == 100 and journal["trades"][0]["on_signal"] is False
    assert exited.json()["open_trade"] is None


def test_mark_state_rules_answer_422(replay: TestClient) -> None:
    sid = start(replay)["id"]
    advance(replay, sid, 120)
    no_trade = mark(replay, sid, {"kind": "long_exit"})
    assert no_trade.status_code == 422
    assert no_trade.json()["detail"]["problems"][0] == {"path": "kind", "message": "No open practice trade to exit"}
    assert mark(replay, sid, {"kind": "stop", "stopPrice": 5.0}).status_code == 422  # no trade to stop
    assert mark(replay, sid, {"kind": "long_entry", "shares": 10}).status_code == 200
    again = mark(replay, sid, {"kind": "short_entry"})
    assert again.status_code == 422 and again.json()["detail"]["problems"][0]["path"] == "kind"  # one open trade
    wrong_exit = mark(replay, sid, {"kind": "short_exit"})
    assert wrong_exit.status_code == 422
    high_stop = mark(replay, sid, {"kind": "stop", "stopPrice": 999999.0})
    assert high_stop.status_code == 422
    assert high_stop.json()["detail"]["problems"][0]["path"] == "stopPrice"  # above a long's last price
    assert mark(replay, sid, {"kind": "stop", "stopPrice": 1.0}).status_code == 200
    assert mark(replay, sid, {"kind": "note", "note": "watching the tape"}).status_code == 200


def test_a_bad_mark_body_is_the_plain_problems_list(replay: TestClient) -> None:
    sid = start(replay)["id"]
    for body in (
        {"kind": "long_entry", "shares": 10001},
        {"kind": "long_exit", "shares": 10},
        {"kind": "stop"},
        {"kind": "limit_buy"},
        {"kind": "note", "note": ""},
    ):
        response = mark(replay, sid, body)
        assert response.status_code == 422 and response.json()["detail"]["problems"], body


def test_a_short_pays_entry_minus_exit(replay: TestClient) -> None:
    sid = start(replay)["id"]
    advance(replay, sid, 120)
    entry = mark(replay, sid, {"kind": "short_entry", "shares": 50}).json()["mark"]
    advance(replay, sid, 600)
    result = mark(replay, sid, {"kind": "short_exit"}).json()
    trade = result["journal"]["trades"][0]
    assert trade["side"] == "short" and trade["pnl_usd"] == round((entry["price"] - trade["exit_price"]) * 50, 2)


def test_undo_only_before_the_playhead_moves(replay: TestClient) -> None:
    sid = start(replay)["id"]
    advance(replay, sid, 120)
    placed = mark(replay, sid, {"kind": "long_entry"}).json()["mark"]
    undone = replay.delete(f"{BASE}/sessions/{sid}/marks/{placed['id']}", headers=OWNER)
    assert undone.status_code == 200 and undone.json()["open_trade"] is None
    assert replay.get(f"{BASE}/sessions/{sid}", headers=OWNER).json()["marks"] == []
    again = mark(replay, sid, {"kind": "long_entry"}).json()["mark"]
    advance(replay, sid, 180)
    late = replay.delete(f"{BASE}/sessions/{sid}/marks/{again['id']}", headers=OWNER)
    assert late.status_code == 409
    first = mark(replay, sid, {"kind": "note", "note": "a"}).json()["mark"]
    second = mark(replay, sid, {"kind": "note", "note": "b"}).json()["mark"]
    assert replay.delete(f"{BASE}/sessions/{sid}/marks/{first['id']}", headers=OWNER).status_code == 409  # not last
    assert replay.delete(f"{BASE}/sessions/{sid}/marks/{second['id']}", headers=OWNER).status_code == 200


def test_end_auto_exits_an_open_trade_and_unseals_the_journal(replay: TestClient) -> None:
    sid = start(replay)["id"]
    advance(replay, sid, 300)
    mark(replay, sid, {"kind": "long_entry", "stopPrice": 1.0})
    ended = replay.post(f"{BASE}/sessions/{sid}/end", headers=OWNER)
    assert ended.status_code == 200, ended.text
    body = ended.json()
    assert body["status"] == "ended" and body["revealed_through"] == iso(3600) and body["open_trade"] is None
    assert [m["source"] for m in body["marks"]] == ["her", "auto"] and body["marks"][1]["kind"] == "long_exit"
    assert body["journal"]["trades"][0]["exit_source"] == "auto"
    assert body["journal"]["totals"]["trades"] == 1 and body["ended_at"]
    assert replay.post(f"{BASE}/sessions/{sid}/end", headers=OWNER).json() == body  # idempotent
    assert mark(replay, sid, {"kind": "note", "note": "late"}).status_code == 422  # any mark needs an active session
    after = advance(replay, sid, 10)
    assert after["at_end"] is True and after["revealed_through"] == iso(3600)
    full = replay.get(f"{BASE}/sessions/{sid}/feed", headers=OWNER).json()
    assert full["revealed_through"] == iso(3600) and pd.Timestamp(full["bars"][-1]["t"]) == OPEN + pd.Timedelta(
        minutes=55
    )


def test_patch_takes_notes_and_a_rating_only(replay: TestClient) -> None:
    sid = start(replay)["id"]
    ok = replay.patch(f"{BASE}/sessions/{sid}", json={"notes": "chased the open", "rating": 3}, headers=OWNER)
    assert ok.status_code == 200 and ok.json()["notes"] == "chased the open" and ok.json()["rating"] == 3
    assert replay.patch(f"{BASE}/sessions/{sid}", json={"rating": 6}, headers=OWNER).status_code == 422
    kept = replay.patch(f"{BASE}/sessions/{sid}", json={"rating": 4}, headers=OWNER).json()
    assert kept["notes"] == "chased the open" and kept["rating"] == 4  # a key left out is left alone
    assert replay.patch(f"{BASE}/sessions/{sid}", json={"notes": None}, headers=OWNER).json()["notes"] is None


# -- ownership, lists, days, side effects --------------------------------------------------------------------


def test_another_user_gets_404_for_everything(replay: TestClient) -> None:
    sid = start(replay)["id"]
    mark_id = mark(replay, sid, {"kind": "note", "note": "mine"}).json()["mark"]["id"]
    for method, path, body in (
        ("get", f"/sessions/{sid}", None),
        ("get", f"/sessions/{sid}/feed", None),
        ("patch", f"/sessions/{sid}", {"rating": 2}),
        ("post", f"/sessions/{sid}/advance", {"to": iso(60)}),
        ("post", f"/sessions/{sid}/marks", {"schemaVersion": 1, "kind": "note", "note": "x"}),
        ("delete", f"/sessions/{sid}/marks/{mark_id}", None),
        ("post", f"/sessions/{sid}/end", None),
    ):
        response = replay.request(method.upper(), BASE + path, json=body, headers=OTHER)
        assert response.status_code == 404, (method, path, response.text)
    assert replay.get(f"{BASE}/sessions", headers=OTHER).json() == []


def test_sessions_list_has_the_resume_and_recent_fields(replay: TestClient) -> None:
    sid = start(replay)["id"]
    advance(replay, sid, 240)
    mark(replay, sid, {"kind": "long_entry"})
    advance(replay, sid, 300)
    mark(replay, sid, {"kind": "long_exit"})
    rows = replay.get(f"{BASE}/sessions?status=active", headers=OWNER).json()
    assert len(rows) == 1
    assert rows[0] | {"updated_at": None} == {
        "id": sid,
        "day_list_id": None,
        "thread_id": None,
        "symbol": "TSLA",
        "day": "2026-09-25",
        "attempt": 1,
        "status": "active",
        "hide_date": "no",
        "revealed_through": iso(300),
        "window_end": iso(3600),
        "trades": 1,
        "pnl_usd": rows[0]["pnl_usd"],
        "adherence_pct": None,
        "updated_at": None,
    }
    assert replay.get(f"{BASE}/sessions?status=ended", headers=OWNER).json() == []


def test_days_in_stub_mode_are_spoiler_free_and_count_attempts(
    replay: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(fixture.STUB_FLAG, "1")
    start(replay)
    response = replay.get(f"{BASE}/days?symbol=TSLA&limit=3", headers=OWNER)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["lookback_sessions"] == 252 and "TSLA" in body["symbols"]
    assert body["stamp"]["freshness"] == "replay"
    top = body["days"][0]
    assert set(top) == {"symbol", "day", "weekday", "rank", "rv_pct_rank", "gap_pct", "tags", "attempts"}
    assert top["rank"] == 1 and top["day"] == "2026-09-25" and top["weekday"] == "Fri" and top["attempts"] == 1
    assert len(body["days"]) == 3
    assert all(date.fromisoformat(d["day"]) < date(2026, 10, 24) for d in body["days"])


def test_a_session_writes_nothing_to_signals_alerts_or_the_outbox(replay: TestClient, db_session: Session) -> None:
    before = [db_session.execute(select(func.count()).select_from(t)).scalar_one() for t in (Signal, Alert, Delivery)]
    sid = start(replay)["id"]
    advance(replay, sid, 1800)
    mark(replay, sid, {"kind": "long_entry"})
    replay.post(f"{BASE}/sessions/{sid}/end", headers=OWNER)
    after = [db_session.execute(select(func.count()).select_from(t)).scalar_one() for t in (Signal, Alert, Delivery)]
    assert before == after


def test_responses_are_never_cached(replay: TestClient) -> None:
    assert replay.get(f"{BASE}/sessions", headers=OWNER).headers["Cache-Control"] == "no-store"


def test_history_is_fetched_once_and_then_served_from_the_blob_cache(replay: TestClient) -> None:
    services = make_services()
    app.dependency_overrides[get_services] = lambda: services
    start(replay)
    fetched = services.history.fetches
    assert fetched >= 2  # the run of sessions and the daily bars
    services2 = make_services()  # a fresh process: empty LRU, same database
    app.dependency_overrides[get_services] = lambda: services2
    replay.post(f"{BASE}/sessions", json=SPEC, headers=OTHER)
    assert services2.history.fetches == 0 and services2.tape.fetches == 0


# -- armed strategies: signals released by the playhead -------------------------------------------------------


def arm_vwap_reclaim(db: Session, email: str = "owner@example.com") -> int:
    from sqlalchemy import select as _select

    from ai_trading.alerts import service
    from ai_trading.db.models import User
    from ai_trading.library.catalog import alert_only_spec, load_catalog, load_template

    user = db.execute(_select(User).where(User.email == email)).scalar_one_or_none()
    if user is None:
        user = User(email=email, settings={})
        db.add(user)
        db.flush()
    entry = next(e for e in load_catalog().entries if e.id == "vwap-reclaim")
    spec = alert_only_spec(load_template(entry.file), name=entry.label).model_dump(
        mode="json", by_alias=True, exclude_none=True
    )
    spec["then"]["alert"]["frequency"] = "every_time"
    return service.create_strategy(db, user.id, spec, save_as="draft", now=NOW).row.id


def test_armed_signals_are_released_as_the_playhead_passes_each_bar_close(
    replay: TestClient, db_session: Session
) -> None:
    from ai_trading.db.models import Bar1m

    strategy_id = arm_vwap_reclaim(db_session)
    tables = (Signal, Alert, Delivery, Bar1m)
    before = [db_session.execute(select(func.count()).select_from(t)).scalar_one() for t in tables]
    full_day = {"window": {"from": "09:30", "to": "16:00"}}
    session = start(replay, armed=[{"source": "alert_strategy", "id": strategy_id}], **full_day)
    sid = session["id"]
    assert session["armed"] == [
        {
            "source": "alert_strategy",
            "id": strategy_id,
            "version_id": session["armed"][0]["version_id"],
            "name": "VWAP reclaim",
            "bias": "bullish",
            "fires_so_far": 0,
        }
    ]
    seen: list[dict[str, Any]] = []
    for _ in range(40):
        response = replay.post(f"{BASE}/sessions/{sid}/advance", json={"step": "next_signal"}, headers=OWNER)
        if response.status_code == 422:
            assert response.json()["detail"]["problems"][0]["message"] == "No more signals in this session"
            break
        delta = response.json()
        assert [s["bar_close"] for s in delta["signals"]] == [delta["revealed_through"]]  # released exactly at close
        seen += delta["signals"]
        state = replay.get(f"{BASE}/sessions/{sid}", headers=OWNER).json()
        assert state["armed"][0]["fires_so_far"] == len(seen)
        assert "signals" not in state
    assert len(seen) >= 3 and all(s["name"] == "VWAP reclaim" and s["source"] == "alert_strategy" for s in seen)
    ended = replay.post(f"{BASE}/sessions/{sid}/end", headers=OWNER).json()
    assert [row["name"] for row in ended["journal"]["signals_vs_trades"]] == ["VWAP reclaim"] * len(seen)
    assert ended["journal"]["signals_vs_trades"][0]["her"] == "no trade"
    # read-only evaluation: no signal, alert, delivery, and no stored 1-minute bar (02o §i side effects)
    assert before == [db_session.execute(select(func.count()).select_from(t)).scalar_one() for t in tables]


def test_a_signal_entry_is_scored_on_signal_and_the_strategy_snapshot_survives_edits(
    replay: TestClient, db_session: Session
) -> None:
    strategy_id = arm_vwap_reclaim(db_session)
    spec = {
        "armed": [{"source": "alert_strategy", "id": strategy_id}],
        "window": {"from": "09:30", "to": "16:00"},
        "plan": {"stopRequired": "no", "signalOnly": "yes"},
    }
    sid = start(replay, **spec)["id"]
    first = replay.post(f"{BASE}/sessions/{sid}/advance", json={"step": "next_signal"}, headers=OWNER).json()
    assert mark(replay, sid, {"kind": "long_entry"}).status_code == 200
    replay.post(
        f"{BASE}/sessions/{sid}/advance",
        json={"to": (pd.Timestamp(first["revealed_through"]) + pd.Timedelta(minutes=4)).isoformat()},
        headers=OWNER,
    )
    result = mark(replay, sid, {"kind": "long_exit"}).json()
    assert result["journal"]["trades"][0]["on_signal"] is True
    check = next(c for c in result["journal"]["adherence"]["checks"] if c["id"] == "on_signal")
    assert check["applicable"] and check["passed"] and check["detail"] == "1 of 1"
    assert result["journal"]["adherence"]["score_pct"] == 100


def test_arming_someone_elses_strategy_is_a_plain_422(replay: TestClient, db_session: Session) -> None:
    other_id = arm_vwap_reclaim(db_session, "spouse@example.com")
    response = replay.post(
        f"{BASE}/sessions", json={**SPEC, "armed": [{"source": "alert_strategy", "id": other_id}]}, headers=OWNER
    )
    assert response.status_code == 422 and response.json()["detail"]["problems"][0]["path"] == "armed.0.id"
