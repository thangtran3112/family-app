"""The swing-practice routes end to end (02p): the universe preview, swing thread creation, the calendar through
`POST /daily/next {"threadId"}`, the union day-list responses, the swing wire shapes of a session (stop pause, day
strip, daily block, holds), the holds and weeks reads, and that a day thread's responses are what they were. Real
Postgres (`scripts/test-db.sh`); the history is the synthetic swing world (`tests/swing_world.py`), no network. The
background prep is skipped in a test client (no session factory), so the tests run `plan.run_prep` themselves.

The walk: 12 stocks `S01`..`S12` from Mon 2026-09-14; `S02` gaps down 8% on session 7, `S03` splits 2-for-1 on
session 6.
"""

from datetime import date
from types import SimpleNamespace
from typing import Any

import pytest
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from daily_world import DAYS as DAILY_DAYS
from daily_world import make_services
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from swing_world import (
    DAYS,
    FIRST_DAY,
    GAP_DOWN_DAY,
    NOW,
    SYMBOLS,
    swing_services,
    swing_setup,
)

from ai_trading.api import replay as replay_api
from ai_trading.api.app import app
from ai_trading.api.replay import get_services
from ai_trading.api.schemas.replay import (
    AdvanceOut,
    DayListOut,
    FeedOut,
    MarkResultOut,
    MarkUndoOut,
    OpenNextOut,
    ReplaySessionOut,
)
from ai_trading.api.schemas.swing import (
    HoldsOut,
    SwingDayListOut,
    SwingOpenNextOut,
    SwingUniversePreviewOut,
    WeekOut,
    WeeksOut,
)
from ai_trading.api.schemas.threads import ThreadOut, ThreadSummaryOut
from ai_trading.cli.seed_technical import seed_user
from ai_trading.contracts.practice_thread import PracticeThreadV1
from ai_trading.core.calendar import et
from ai_trading.db.models import FilterStrategy, PracticePlan, User
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import swing as swing_mod

BASE = "/api/desk/replay"
PLAN = {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"}
DAY_CREATE = {"schemaVersion": 1, "mode": "day", "plan": PLAN}


def _swing_body(**swing: Any) -> dict[str, Any]:
    return {"schemaVersion": 1, "mode": "swing", "startingBalance": 50_000, "plan": PLAN, "swing": swing_setup(**swing)}


def _problems(response) -> list[dict[str, str]]:
    return response.json()["detail"]["problems"]


def _utc(day: date, hhmm: str) -> str:
    return et(day, hhmm).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture
def world(client: TestClient, db_session, monkeypatch):
    """The signed-in owner (seeded watchlists and filters) and the swing services under the app. A test client has no
    background tasks: another test module may leave a session factory on `app.state`, which would run them for real."""
    monkeypatch.setattr(app.state, "session_factory", None, raising=False)
    services = swing_services()
    app.dependency_overrides[get_services] = lambda: services
    client.get(f"{BASE}/daily", headers=auth_headers())  # creates the user
    user_id = db_session.execute(select(User.id).where(User.email == OWNER_EMAIL)).scalar_one()
    seed_user(db_session, user_id, now=NOW)
    db_session.commit()
    return client, services, user_id


def _create(client, **swing: Any):
    return client.post(f"{BASE}/threads", json=_swing_body(**swing), headers=auth_headers())


def _thread(world, db_session, **swing: Any) -> int:
    """A swing thread through the route, its prep run to the end (the test client has no background tasks)."""
    client, services, _ = world
    created = _create(client, **swing)
    assert created.status_code == 200, created.text
    plan = db_session.execute(select(PracticePlan).order_by(PracticePlan.id.desc())).scalars().first()
    plan_mod.run_prep(db_session, services, plan.id)
    return created.json()["thread"]["id"]


def _next(client, thread_id: int, headers=None):
    return client.post(f"{BASE}/daily/next", json={"threadId": thread_id}, headers=headers or auth_headers())


def _open_day(client, thread_id: int) -> int:
    opened = _next(client, thread_id)
    assert opened.status_code == 200, opened.text
    day_list_id = opened.json()["day_list_id"]
    assert day_list_id is not None
    return day_list_id


def _end(client, day_list_id: int):
    ended = client.post(f"{BASE}/day-lists/{day_list_id}/end", headers=auth_headers())
    assert ended.status_code == 200, ended.text
    return ended.json()


def _pass_days(client, thread_id: int, count: int) -> int:
    """Pass `count` days; returns the id of the last list."""
    last = 0
    for _ in range(count):
        last = _open_day(client, thread_id)
        _end(client, last)
    return last


def _session(client, day_list_id: int, symbol: str) -> int:
    started = client.post(f"{BASE}/day-lists/{day_list_id}/sessions", json={"symbol": symbol}, headers=auth_headers())
    assert started.status_code == 200, started.text
    return started.json()["id"]


def _advance(client, session_id: int, day: date, hhmm: str):
    return client.post(f"{BASE}/sessions/{session_id}/advance", json={"to": _utc(day, hhmm)}, headers=auth_headers())


def _mark(client, session_id: int, kind: str, **extra: Any):
    body = {"schemaVersion": 1, "kind": kind, **extra}
    return client.post(f"{BASE}/sessions/{session_id}/marks", json=body, headers=auth_headers())


def _intraday_filter(db_session, user_id: int) -> int:
    return db_session.execute(
        select(FilterStrategy.id).where(FilterStrategy.owner_user_id == user_id, FilterStrategy.name == "Gap up")
    ).scalar_one()


# -- the universe preview -------------------------------------------------------------------------------------------


def _preview(client, **body: Any):
    request = {
        "first_day": FIRST_DAY.isoformat(),
        "sessions": 15,
        "fill": "none",
        "add": list(SYMBOLS),
        "target": 10,
        **body,
    }
    return client.post(f"{BASE}/threads/swing-universe", json=request, headers=auth_headers())


def test_the_preview_is_the_table_with_its_label_and_writes_no_thread(world, db_session) -> None:
    client, _, _ = world
    response = _preview(client)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    out = SwingUniversePreviewOut.model_validate(response.json())
    assert (out.state, out.pending_symbols, out.prep.done, out.prep.total) == ("ready", 0, 12, 12)
    assert [row.symbol for row in out.rows] == SYMBOLS[:10] and {row.source for row in out.rows} == {"manual"}
    assert out.counts.model_dump() == {"watchlist": 0, "manual": 10, "filter": 0, "liquidity": 0, "total": 10}
    assert out.label == out.survivorship and "10 symbols" in out.label and "survivors" in out.label
    assert out.basis_day < FIRST_DAY and out.excluded == []
    assert client.get(f"{BASE}/threads", headers=auth_headers()).json() == []  # a preview saves nothing


def test_a_preview_with_data_still_to_fetch_is_preparing_and_starts_the_pool_prep(
    world, db_session, monkeypatch
) -> None:
    client, services, user_id = world
    monkeypatch.setattr(swing_mod, "PREVIEW_BUDGET_S", 0.0)  # no time to fetch anything: everything is pending
    started: list[Any] = []
    monkeypatch.setattr(replay_api, "_pool_prep_in_background", lambda *args: started.append(args))
    response = _preview(client)
    assert response.status_code == 200
    assert not db_session.in_transaction()  # committed before the background prep, which reads the same cache
    out = SwingUniversePreviewOut.model_validate(response.json())
    assert (out.state, out.rows, out.pending_symbols, out.prep.done) == ("preparing", [], 12, 0)
    (_app, svc, user, req, symbols) = started[0]
    assert (svc, user, symbols) == (services, user_id, SYMBOLS) and req.first_day == FIRST_DAY and req.target == 10

    monkeypatch.undo()  # the prep ran: the same request is a ready table
    assert SwingUniversePreviewOut.model_validate(_preview(client).json()).state == "ready"


def test_the_pool_prep_skips_what_is_already_being_fetched_and_never_raises(world, db_session, monkeypatch) -> None:
    client, services, user_id = world
    factory = sessionmaker(db_session.get_bind(), expire_on_commit=False)
    fake_app = SimpleNamespace(state=SimpleNamespace(session_factory=factory))
    req = swing_mod.PreviewRequest(first_day=FIRST_DAY, sessions=15, add=tuple(SYMBOLS), fill="none", target=10)
    fetched: list[list[str]] = []
    monkeypatch.setattr(swing_mod, "pool_prep", lambda db, svc, user, request, symbols: fetched.append(list(symbols)))

    replay_api._PREPARING.add((user_id, "S01"))
    replay_api._pool_prep_in_background(fake_app, services, user_id, req, ["S01", "S02"])
    assert fetched == [["S02"]]  # S01 is being fetched by another call
    assert replay_api._PREPARING == {(user_id, "S01")}  # and this call released only what it took
    replay_api._PREPARING.clear()

    def boom(*_args):
        raise RuntimeError("provider down")

    monkeypatch.setattr(swing_mod, "pool_prep", boom)
    replay_api._pool_prep_in_background(fake_app, services, user_id, req, ["S03"])  # logged, not raised
    assert replay_api._PREPARING == set()
    replay_api._pool_prep_in_background(SimpleNamespace(state=SimpleNamespace()), services, user_id, req, ["S04"])


def test_preview_rejections_are_plain_problems(world, db_session) -> None:
    client, _, user_id = world
    intraday = _preview(client, filter_ids=[_intraday_filter(db_session, user_id)])
    assert intraday.status_code == 422
    assert _problems(intraday) == [{"path": "filter_ids.0", "message": swing_mod.DAILY_ONLY}]
    foreign = _preview(client, watchlist_ids=[999_999])
    assert foreign.status_code == 422 and _problems(foreign)[0]["path"] == "watchlist_ids.0"
    pattern = _preview(client, add=["/ES"])
    assert pattern.status_code == 422 and _problems(pattern) == [
        {"path": "add.0", "message": "/ES is not a stock symbol"}
    ]
    future = _preview(client, first_day="2099-01-04")
    assert future.status_code == 422 and _problems(future)[0]["path"] == "first_day"


@pytest.mark.parametrize(
    "bad",
    [
        {"sessions": 14},
        {"sessions": 24},
        {"target": 9},
        {"target": 51},
        {"filter_ids": [1, 2, 3, 4]},
        {"fill": "everything"},
        {"watchlist_ids": list(range(1, 22))},
        {"add": ["AAPL"] * 51},
    ],
)
def test_preview_bounds_every_field_of_the_request(world, bad) -> None:
    client, _, _ = world
    assert _preview(client, **bad).status_code == 422
    stray = client.post(f"{BASE}/threads/swing-universe", json={"first_day": "2026-09-14"}, headers=auth_headers())
    assert stray.status_code == 422  # sessions is required


# -- creating a swing thread ----------------------------------------------------------------------------------------


def test_a_swing_thread_is_created_with_its_setup_echoed_and_its_state(world, db_session, monkeypatch) -> None:
    client, _, _ = world
    visible: list[tuple[int, bool]] = []

    def prep(_app, _svc, plan_id: int) -> None:  # the background task runs on its own session: can it see the plan?
        with Session(db_session.get_bind()) as other:
            visible.append((plan_id, other.get(PracticePlan, plan_id) is not None))

    monkeypatch.setattr(replay_api, "_prep_in_background", prep)
    created = _create(client)
    assert created.status_code == 200 and created.headers["cache-control"] == "no-store"
    plan_id = db_session.execute(select(PracticePlan.id)).scalar_one()
    assert visible == [(plan_id, True)]  # committed before the prep starts, and started once
    body = created.json()
    out = ThreadOut.model_validate(body)
    thread = PracticeThreadV1.model_validate(body["thread"])  # the contract the web app parses it with
    assert thread.mode == "swing" and thread.swing is not None and thread.stats.balance == 50_000
    assert body["thread"]["swing"] == swing_setup()  # the setup as authored, frozen with the thread
    state = out.swing
    assert state is not None
    assert (state.day_no, state.days, state.days_ended, state.week_no, state.holds_open) == (1, 15, 0, 1, 0)
    assert (state.free_cash_usd, state.equity_usd, state.equity_series, state.next) == (50_000, 50_000, [], "day")
    assert body["today"] is None and body["curve"] == [{"n": 0, "day": None, "balance": 50_000.0}]
    assert "Simulated" in body["label"]

    tid = thread.id
    again = client.get(f"{BASE}/threads/{tid}", headers=auth_headers())
    assert again.json() == body
    listed = client.get(f"{BASE}/threads", headers=auth_headers()).json()
    row = ThreadSummaryOut.model_validate(listed[0])
    assert row.swing == state and row.thread.swing is not None and "daily" not in listed[0]


def test_several_active_swing_threads_and_a_day_thread_run_side_by_side(world) -> None:
    client, _, _ = world
    assert _create(client).status_code == 200
    assert _create(client).status_code == 200  # a second swing thread is allowed
    day = client.post(f"{BASE}/threads", json=DAY_CREATE, headers=auth_headers())
    assert day.status_code == 200 and day.json().get("swing") is None and "swing" not in day.json()["thread"]
    listed = client.get(f"{BASE}/threads", headers=auth_headers()).json()
    assert sorted(row["thread"]["mode"] for row in listed) == ["day", "swing", "swing"]
    assert [row.get("swing") is not None for row in listed if row["thread"]["mode"] == "day"] == [False]


def test_the_daily_card_of_a_swing_thread_has_its_thread_and_no_day_plan(world) -> None:
    client, _, _ = world
    swing_id = _create(client).json()["thread"]["id"]
    day_id = client.post(f"{BASE}/threads", json=DAY_CREATE, headers=auth_headers()).json()["thread"]["id"]
    card = client.get(f"{BASE}/daily", params={"threadId": swing_id}, headers=auth_headers())
    assert card.status_code == 200 and card.json()["plan"] is None
    assert card.json()["thread"]["thread"]["id"] == swing_id and card.json()["thread"]["thread"]["mode"] == "swing"
    unnamed = client.get(f"{BASE}/daily", headers=auth_headers()).json()  # no threadId: the day thread, as before
    assert unnamed["thread"]["thread"]["id"] == day_id


def test_swing_create_rejections_are_plain_problems(world, db_session) -> None:
    client, _, _ = world
    missing = client.post(f"{BASE}/threads", json={**_swing_body(), "swing": None}, headers=auth_headers())
    bare = {k: v for k, v in _swing_body().items() if k != "swing"}
    no_block = client.post(f"{BASE}/threads", json=bare, headers=auth_headers())
    assert no_block.status_code == 422 and _problems(no_block)[0]["path"] == "swing"
    assert missing.status_code == 422
    few = _create(client, universe=[{"symbol": s, "source": "manual"} for s in SYMBOLS[:9]])
    assert few.status_code == 422
    future = _create(client, firstDay="2099-01-04")
    assert future.status_code == 422 and _problems(future)[0]["path"] == "swing.firstDay"
    unknown = _create(client, universe=[{"symbol": s, "source": "manual"} for s in [*SYMBOLS[:9], "NOPE"]])
    assert unknown.status_code == 422
    assert _problems(unknown) == [
        {"path": "swing.universe.9.symbol", "message": "NOPE has not enough price history for this whole range"}
    ]
    rich = client.post(
        f"{BASE}/threads",
        json={**_swing_body(), "startingBalance": 1000, "plan": {**PLAN, "maxLossUsd": 5000}},
        headers=auth_headers(),
    )
    assert rich.status_code == 422 and _problems(rich)[0]["path"] == "plan.maxLossUsd"
    intraday = _create(client, armed=[{"source": "filter", "id": _intraday_filter(db_session, world[2])}])
    assert intraday.status_code == 422
    assert _problems(intraday) == [{"path": "swing.armed.0.id", "message": swing_mod.DAILY_ONLY}]
    assert client.get(f"{BASE}/threads", headers=auth_headers()).json() == []  # nothing was written


# -- the calendar: POST /daily/next with a thread id alone ----------------------------------------------------------


def test_a_thread_id_alone_continues_a_swing_calendar(world, db_session, monkeypatch) -> None:
    client, services, _ = world
    tid = _create(client).json()["thread"]["id"]
    waiting = _next(client, tid)
    assert waiting.status_code == 200 and waiting.headers["cache-control"] == "no-store"
    out = SwingOpenNextOut.model_validate(waiting.json())
    assert out.kind == "swing" and out.day_list_id is None
    assert (out.plan.mode, out.plan.sessions, out.plan.next_day_no, out.plan.next_weekday) == ("swing", 15, 1, "Mon")
    assert (out.plan.prep.state, out.plan.finished, out.plan.current) == ("running", False, None)
    assert "spec" not in waiting.json()["plan"]  # no dates, no day-plan fields: the frozen setup is in `thread.swing`

    # a prep that stopped reporting is restarted by the next open (the background task is a recorder here)
    restarted: list[int] = []
    monkeypatch.setattr(replay_api, "_prep_in_background", lambda _app, _svc, plan_id: restarted.append(plan_id))
    plan = db_session.execute(select(PracticePlan)).scalar_one()
    plan.prep = {**plan.prep, "updated_at": "2026-10-20T00:00:00+00:00"}
    db_session.commit()
    assert _next(client, tid).json()["day_list_id"] is None and restarted == [plan.id]

    plan_mod.run_prep(db_session, services, plan.id)
    opened = _next(client, tid)
    day_one = SwingOpenNextOut.model_validate(opened.json())
    assert day_one.day_list_id is not None and day_one.plan.prep.state == "done"
    assert (day_one.plan.current.day_no, day_one.plan.current.status) == (1, "listed")  # type: ignore[union-attr]
    assert _next(client, tid).json()["day_list_id"] == day_one.day_list_id  # continue, never a second Day 1
    assert len(restarted) == 1  # a ready plan starts nothing

    _end(client, day_one.day_list_id)
    second = SwingOpenNextOut.model_validate(_next(client, tid).json())
    assert second.day_list_id != day_one.day_list_id and second.plan.current.day_no == 2  # type: ignore[union-attr]


def test_a_thread_id_alone_is_checked_before_anything_else(world) -> None:
    client, _, _ = world
    swing_id = _create(client).json()["thread"]["id"]
    day_id = client.post(f"{BASE}/threads", json=DAY_CREATE, headers=auth_headers()).json()["thread"]["id"]
    needs_plan = {"path": "threadId", "message": "Send threadId, a whole number"}
    day = _next(client, day_id)  # a day thread continues its own plan; it has none yet
    assert day.status_code == 409 and _problems(day)[0]["message"] == "Start a daily practice plan first"
    for bad in (True, "7", 1.5, [1]):
        stray = client.post(f"{BASE}/daily/next", json={"threadId": bad}, headers=auth_headers())
        assert stray.status_code == 422 and _problems(stray) == [needs_plan]
    assert _next(client, 99_999).status_code == 404
    assert _next(client, swing_id, auth_headers(OTHER_EMAIL)).status_code == 404  # never confirms a stranger's thread
    extra = client.post(f"{BASE}/daily/next", json={"threadId": swing_id, "x": 1}, headers=auth_headers())
    assert extra.status_code == 422
    plan_for_swing = client.post(f"{BASE}/daily/next", json={"plan": {}, "threadId": swing_id}, headers=auth_headers())
    assert plan_for_swing.status_code == 422  # a daily plan never binds to a swing thread


def test_a_closed_swing_thread_does_not_open_a_day(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    assert client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers()).status_code == 200
    closed = _next(client, tid)
    assert closed.status_code == 409 and "closed" in _problems(closed)[0]["message"]


# -- the swing board and the union day-list responses ---------------------------------------------------------------


def test_the_day_list_routes_serve_the_swing_board(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    list_id = _open_day(client, tid)
    got = client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers())
    assert got.status_code == 200 and got.headers["cache-control"] == "no-store"
    board = SwingDayListOut.model_validate(got.json())
    assert got.json()["kind"] == "swing" and board.status == "listed" and board.clock is None
    assert (board.day_no, board.of, board.week_no, board.weekday) == (1, 15, 1, "Mon")
    assert [row.symbol for row in board.candidates] != [] and len(board.candidates) == 12
    assert {row.source for row in board.candidates} == {"watchlist", "manual", "filter", "liquidity"}
    assert board.candidates[0].prior_close is not None and board.holds == [] and board.sessions == []
    assert board.free_cash_usd == 50_000 and board.journal is None and board.peek is None
    assert board.universe.size == 12 and "12 symbols" in board.label and board.label == board.universe.label
    assert [c.key for c in board.columns][0] == "source"
    assert board.thread is not None and (board.thread.mode, board.thread.day_no, board.thread.days) == ("swing", 1, 15)
    assert (board.thread.equity_usd, board.thread.free_cash_usd, board.thread.week_no) == (50_000, 50_000, 1)
    assert board.plan.current is not None and board.plan.current.id == list_id

    peeked = client.get(f"{BASE}/day-lists/{list_id}?peek=S01", headers=auth_headers())
    peek = SwingDayListOut.model_validate(peeked.json()).peek
    assert peek is not None and peek.symbol == "S01" and 0 < len(peek.daily) <= 120
    assert peek.daily[-1].t < FIRST_DAY and peek.levels.prior_close == peek.daily[-1].c  # nothing of the day itself
    away = client.get(f"{BASE}/day-lists/{list_id}?peek=AAPL", headers=auth_headers())
    assert away.status_code == 422 and _problems(away)[0]["path"] == "peek"

    starred = client.patch(f"{BASE}/day-lists/{list_id}", json={"watch": ["S04", "S05"]}, headers=auth_headers())
    assert starred.status_code == 200 and starred.json()["kind"] == "swing"
    assert [w.symbol for w in SwingDayListOut.model_validate(starred.json()).watch] == ["S04", "S05"]
    noted = client.patch(f"{BASE}/day-lists/{list_id}", json={"notes": "wait", "rating": 4}, headers=auth_headers())
    assert (noted.json()["notes"], noted.json()["rating"]) == ("wait", 4)
    off_board = client.patch(f"{BASE}/day-lists/{list_id}", json={"watch": ["AAPL"]}, headers=auth_headers())
    assert off_board.status_code == 422

    other = auth_headers(OTHER_EMAIL)
    url = f"{BASE}/day-lists/{list_id}"
    assert client.get(url, headers=other).status_code == 404
    assert client.patch(url, json={"notes": "x"}, headers=other).status_code == 404
    assert client.post(f"{url}/end", headers=other).status_code == 404
    assert client.post(f"{url}/sessions", json={"symbol": "S04"}, headers=other).status_code == 404


def test_a_swing_day_takes_several_names_and_ends_with_its_summary(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    list_id = _open_day(client, tid)
    unstarred = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "S04"}, headers=auth_headers())
    assert unstarred.status_code == 422 and _problems(unstarred)[0]["path"] == "symbol"  # focus names and holds only
    client.patch(f"{BASE}/day-lists/{list_id}", json={"watch": ["S04", "S05"]}, headers=auth_headers())
    first, second = _session(client, list_id, "S04"), _session(client, list_id, "S05")
    assert first != second  # a swing day allows several names on its shared clock
    started = client.get(f"{BASE}/sessions/{first}", headers=auth_headers())
    session = ReplaySessionOut.model_validate(started.json())
    assert session.tape_feed == "off" and session.spec.hideDate == "yes" and session.thread is not None
    assert session.thread.mode == "swing" and session.thread.equity_usd == 50_000
    assert session.open_trade is None and session.journal.adherence.hint == "Scored weekly"

    ended = _end(client, list_id)
    out = SwingDayListOut.model_validate(ended)
    assert out.status == "ended" and out.journal is not None and out.journal.passed == "no"
    assert (out.journal.entries, out.journal.exits, out.journal.holds, out.journal.stop_hits) == (0, 0, [], [])
    assert out.journal.equity_usd == 50_000 and out.clock is not None
    assert {s.status for s in out.sessions} == {"ended"}
    again = client.post(f"{BASE}/day-lists/{list_id}/end", headers=auth_headers())
    assert again.json() == ended  # idempotent

    nothing_left = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "S04"}, headers=auth_headers())
    assert nothing_left.status_code == 409


def test_a_passed_day_is_a_summary_with_no_session(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    list_id = _open_day(client, tid)
    passed = SwingDayListOut.model_validate(_end(client, list_id))
    assert passed.status == "ended" and passed.sessions == [] and passed.journal is not None
    assert (passed.journal.passed, passed.journal.realized_usd, passed.journal.equity_change_usd) == ("yes", 0, 0)
    state = ThreadOut.model_validate(client.get(f"{BASE}/threads/{tid}", headers=auth_headers()).json()).swing
    assert state is not None and (state.days_ended, state.day_no, state.next) == (1, 2, "day")
    assert [(p.day_no, p.weekday, p.equity_usd) for p in state.equity_series] == [(1, "Mon", 50_000)]


# -- the wire shapes of a swing session -----------------------------------------------------------------------------


def test_a_swing_session_carries_the_strip_the_daily_block_and_its_hold(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    list_id = _open_day(client, tid)
    client.patch(f"{BASE}/day-lists/{list_id}", json={"watch": ["S04", "S05"]}, headers=auth_headers())
    sid = _session(client, list_id, "S04")

    before = AdvanceOut.model_validate(_advance(client, sid, FIRST_DAY, "09:30").json())
    assert before.paused is None and before.daily_forming is None and before.last is None
    assert [(r.symbol, r.source, r.last, r.hold) for r in before.strip or []] == [
        ("S04", "focus", None, None),
        ("S05", "focus", None, None),
    ]

    advanced = _advance(client, sid, FIRST_DAY, "10:00")
    assert advanced.status_code == 200
    out = AdvanceOut.model_validate(advanced.json())
    assert out.paused is None and out.open_trade is None
    assert out.daily_forming is not None and out.daily_forming.t == FIRST_DAY and out.daily_forming.v > 0
    assert out.prints.feed == "off" and out.prints.rows == [] and out.last is not None
    assert [r.symbol for r in out.strip or []] == ["S04", "S05"] and all(r.last for r in out.strip or [])
    assert out.strip[0].chg_pct is not None and out.strip[0].chg_pct > 0  # type: ignore[index]

    feed = FeedOut.model_validate(client.get(f"{BASE}/sessions/{sid}/feed", headers=auth_headers()).json())
    assert feed.daily is not None and 0 < len(feed.daily.bars) <= 120 and feed.daily.holds == []
    assert feed.daily.bars[-1].t < FIRST_DAY  # the rebased bars end at the prior close
    assert feed.daily.forming == out.daily_forming  # the same candle, from the same revealed bars
    assert [r.symbol for r in feed.strip or []] == ["S04", "S05"]

    entry = _mark(client, sid, "long_entry", shares=100, stopPrice=75)
    assert entry.status_code == 200, entry.text
    placed = MarkResultOut.model_validate(entry.json())
    hold = placed.hold
    assert hold is not None and (hold.symbol, hold.side, hold.shares, hold.status) == ("S04", "long", 100, "open")
    assert (hold.entry_day_no, hold.entry_weekday, hold.days_held, hold.stop_price) == (1, "Mon", 1, 75)
    assert (hold.stop_hit, hold.price_basis, hold.exit_source, hold.pnl_usd) == ("no", "last", None, None)
    assert placed.mark.trade_no == hold.id and placed.open_trade is not None
    assert (placed.open_trade.opened_day_no, placed.open_trade.days_held, placed.open_trade.gap_usd) == (1, 1, None)
    assert placed.open_trade.price_basis == "last" and placed.open_trade.trade_no == hold.id
    assert placed.thread is not None and placed.thread.free_cash_usd is not None
    assert placed.thread.free_cash_usd < 50_000  # the open notional is held back

    strip = AdvanceOut.model_validate(_advance(client, sid, FIRST_DAY, "10:05").json()).strip or []
    assert [(r.symbol, r.source) for r in strip] == [("S04", "hold"), ("S05", "focus")]  # holds first
    assert strip[0].hold is not None and strip[0].hold.stopped == "no" and strip[0].hold.stop_distance_pct
    assert strip[0].hold.shares == 100 and strip[0].hold.stop_price == 75

    undone = client.delete(f"{BASE}/sessions/{sid}/marks/{placed.mark.id}", headers=auth_headers())
    assert undone.status_code == 409  # the clock moved since: sealed
    second = _mark(client, sid, "long_exit")
    closed = MarkResultOut.model_validate(second.json())
    assert closed.hold is not None and closed.hold.status == "closed" and closed.hold.exit_source == "her"
    assert closed.hold.pnl_usd is not None and closed.hold.exit_day_no == 1 and closed.open_trade is None
    undo = MarkUndoOut.model_validate(
        client.delete(f"{BASE}/sessions/{sid}/marks/{closed.mark.id}", headers=auth_headers()).json()
    )
    assert undo.hold is not None and undo.hold.status == "open" and undo.open_trade is not None
    nothing = _mark(client, sid, "long_entry", shares=100)
    assert nothing.status_code == 422  # one open hold per name
    assert "Close your open S04 practice hold first" in _problems(nothing)[0]["message"]


def test_a_stop_gapped_through_pauses_the_walk_and_the_hold_exits_on_her_mark(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    _pass_days(client, tid, 5)  # week 1
    list_six = _open_day(client, tid)
    client.patch(f"{BASE}/day-lists/{list_six}", json={"watch": ["S02"]}, headers=auth_headers())
    sid = _session(client, list_six, "S02")
    _advance(client, sid, DAYS[5], "10:00")
    entry = MarkResultOut.model_validate(_mark(client, sid, "long_entry", shares=100, stopPrice=86).json())
    assert entry.hold is not None and entry.hold.stop_price == 86
    ended = SwingDayListOut.model_validate(_end(client, list_six))
    assert (
        ended.journal is not None and ended.journal.entries == 1 and [h.symbol for h in ended.journal.holds] == ["S02"]
    )
    carried = ended.journal.holds[0]
    assert carried.status == "open" and carried.price_basis == "last" and carried.unrealized_usd is not None

    holds = HoldsOut.model_validate(
        client.get(f"{BASE}/threads/{tid}/holds?status=open", headers=auth_headers()).json()
    )
    assert holds.as_of_day_no == 6 and [h.symbol for h in holds.holds] == ["S02"]
    assert holds.holds[0].price_basis == "prior_close" and holds.holds[0].last_close is not None
    assert "Simulated" in holds.label

    list_seven = _open_day(client, tid)
    assert GAP_DOWN_DAY == DAYS[6]
    board = SwingDayListOut.model_validate(client.get(f"{BASE}/day-lists/{list_seven}", headers=auth_headers()).json())
    assert [(h.symbol, h.days_held, h.price_basis) for h in board.holds] == [("S02", 1, "prior_close")]
    sid = _session(client, list_seven, "S02")  # a hold is a name she can practise without a star
    stopped = AdvanceOut.model_validate(_advance(client, sid, GAP_DOWN_DAY, "10:00").json())
    pause = stopped.paused
    assert pause is not None and (pause.symbol, pause.stop_price, pause.kind, pause.also) == ("S02", 86, "gap", [])
    assert pause.price < pause.stop_price
    assert stopped.revealed_through == pause.at and stopped.revealed_through < _at(GAP_DOWN_DAY, "10:00")
    assert stopped.open_trade is not None and stopped.open_trade.opened_day_no == 6
    assert (
        stopped.open_trade.days_held == 2 and stopped.open_trade.gap_usd is not None and stopped.open_trade.gap_usd < 0
    )
    assert stopped.strip is not None and stopped.strip[0].hold is not None and stopped.strip[0].hold.stopped == "yes"
    assert stopped.strip[0].hold.stop_distance_pct is not None and stopped.strip[0].hold.stop_distance_pct < 0

    feed = FeedOut.model_validate(client.get(f"{BASE}/sessions/{sid}/feed", headers=auth_headers()).json())
    assert feed.daily is not None and [(h.entry_t, h.side, h.stop_price) for h in feed.daily.holds] == [
        (DAYS[5], "long", 86)
    ]
    closed = MarkResultOut.model_validate(_mark(client, sid, "long_exit").json())  # she answers the pause
    assert closed.hold is not None and closed.hold.status == "closed" and closed.hold.pnl_usd < 0  # type: ignore[operator]
    assert closed.hold.days_held == 2 and closed.thread is not None

    day = SwingDayListOut.model_validate(_end(client, list_seven))
    assert day.journal is not None and (day.journal.exits, day.journal.passed) == (1, "no")
    assert [(h.symbol, h.watched) for h in day.journal.stop_hits] == [("S02", "yes")]
    assert day.journal.realized_usd < 0 and day.journal.gap_usd < 0 and day.journal.holds[0].status == "closed"
    ledger = client.get(f"{BASE}/threads/{tid}/ledger", headers=auth_headers()).json()
    assert ledger["total"] == 1 and ledger["entries"][0]["holdId"] == closed.hold.id  # credited when the day ended
    closed_holds = HoldsOut.model_validate(
        client.get(f"{BASE}/threads/{tid}/holds?status=closed", headers=auth_headers()).json()
    )
    assert [h.id for h in closed_holds.holds] == [closed.hold.id] and closed_holds.as_of_day_no == 7
    open_holds = client.get(f"{BASE}/threads/{tid}/holds?status=open", headers=auth_headers()).json()
    assert open_holds["holds"] == []
    assert len(client.get(f"{BASE}/threads/{tid}/holds", headers=auth_headers()).json()["holds"]) == 1  # all


def _at(day: date, hhmm: str):
    return et(day, hhmm).to_pydatetime()


# -- weeks and the weekly review ------------------------------------------------------------------------------------


def test_weeks_serve_week_to_date_then_the_frozen_review_and_take_notes(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    _pass_days(client, tid, 4)
    rows = WeeksOut.model_validate(client.get(f"{BASE}/threads/{tid}/weeks", headers=auth_headers()).json())
    assert [(w.week_no, w.label, w.days, w.first_day_no, w.last_day_no, w.status) for w in rows.weeks] == [
        (1, "Week 1", 5, 1, 5, "open")
    ]
    assert rows.weeks[0].realized_usd is None and "Simulated" in rows.label  # an open week has no frozen figures

    to_date = client.get(f"{BASE}/threads/{tid}/weeks/1", headers=auth_headers())
    assert to_date.status_code == 200 and to_date.headers["cache-control"] == "no-store"
    week = WeekOut.model_validate(to_date.json())
    assert (week.to_date, week.status, week.label) == ("yes", "open", "Week 1 · 4 of 5 days")
    assert [d.day_no for d in week.review.days] == [1, 2, 3, 4] and {d.watched for d in week.review.days} == {"no"}
    assert week.review.tiles.realized_usd == 0 and week.review.holds == []
    assert week.review.adherence.score_pct is not None and week.review.adherence.checks
    assert len(week.review.heat) == 12 and week.review.lines == [] or isinstance(week.review.lines, list)
    assert "12 symbols" in week.universe_label and "Dividends" in week.footnote and week.notes is None

    _pass_days(client, tid, 1)  # the fifth day closes the week
    closed = WeekOut.model_validate(client.get(f"{BASE}/threads/{tid}/weeks/1", headers=auth_headers()).json())
    assert (closed.to_date, closed.status, closed.label) == ("no", "closed", "Week 1")
    assert [d.day_no for d in closed.review.days] == [1, 2, 3, 4, 5]
    frozen = WeeksOut.model_validate(client.get(f"{BASE}/threads/{tid}/weeks", headers=auth_headers()).json())
    assert frozen.weeks[0].status == "closed" and frozen.weeks[0].realized_usd == 0
    assert frozen.weeks[0].equity_change_usd == 0 and frozen.weeks[0].adherence_pct is not None
    assert (
        "week"
        in client.get(f"{BASE}/threads/{tid}/weeks/2", headers=auth_headers()).json()["detail"]["problems"][0]["path"]
    )

    patched = client.patch(
        f"{BASE}/threads/{tid}/weeks/1", json={"notes": "Stayed patient.", "rating": 4}, headers=auth_headers()
    )
    assert patched.status_code == 200 and patched.headers["cache-control"] == "no-store"
    body = WeekOut.model_validate(patched.json())
    assert (body.notes, body.rating, body.review) == ("Stayed patient.", 4, closed.review)
    only_rating = client.patch(f"{BASE}/threads/{tid}/weeks/1", json={"rating": 2}, headers=auth_headers()).json()
    assert (only_rating["notes"], only_rating["rating"]) == ("Stayed patient.", 2)  # a key left out is left alone
    cleared = client.patch(f"{BASE}/threads/{tid}/weeks/1", json={"notes": None}, headers=auth_headers()).json()
    assert (cleared["notes"], cleared["rating"]) == (None, 2)
    for bad in ({"rating": 9}, {"rating": 0}, {"notes": "x" * 2001}):
        assert client.patch(f"{BASE}/threads/{tid}/weeks/1", json=bad, headers=auth_headers()).status_code == 422
    assert client.get(f"{BASE}/threads/{tid}/weeks/1", headers=auth_headers()).json()["rating"] == 2


def test_a_week_that_has_not_started_or_has_no_finished_day_is_a_404(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    missing = client.get(f"{BASE}/threads/{tid}/weeks/1", headers=auth_headers())
    assert missing.status_code == 404
    assert _problems(missing) == [{"path": "week", "message": "Week 1 has not started yet"}]
    assert client.get(f"{BASE}/threads/{tid}/weeks", headers=auth_headers()).json()["weeks"] == []
    _open_day(client, tid)  # the week row exists, nothing in it has ended
    empty = client.get(f"{BASE}/threads/{tid}/weeks/1", headers=auth_headers())
    assert empty.status_code == 404 and "no finished day yet" in _problems(empty)[0]["message"]
    note = client.patch(f"{BASE}/threads/{tid}/weeks/1", json={"notes": "early"}, headers=auth_headers())
    assert note.status_code == 404
    unknown = client.patch(f"{BASE}/threads/{tid}/weeks/7", json={"notes": "x"}, headers=auth_headers())
    assert unknown.status_code == 404
    assert client.get(f"{BASE}/threads/{tid}/weeks/0", headers=auth_headers()).status_code == 404


def test_holds_and_weeks_belong_to_a_swing_thread_of_hers(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    _pass_days(client, tid, 1)
    day_tid = client.post(f"{BASE}/threads", json=DAY_CREATE, headers=auth_headers()).json()["thread"]["id"]
    other = auth_headers(OTHER_EMAIL)
    routes = (
        ("get", "/holds", None),
        ("get", "/weeks", None),
        ("get", "/weeks/1", None),
        ("patch", "/weeks/1", {"notes": "x"}),
    )
    for method, tail, body in routes:
        kwargs: dict[str, Any] = {} if body is None else {"json": body}
        stranger = getattr(client, method)(f"{BASE}/threads/{tid}{tail}", headers=other, **kwargs)
        assert stranger.status_code == 404 and stranger.json() == {"detail": "practice thread not found"}
        nobody = getattr(client, method)(f"{BASE}/threads/99999{tail}", headers=auth_headers(), **kwargs)
        assert nobody.status_code == 404 and nobody.json() == {"detail": "practice thread not found"}
        day = getattr(client, method)(f"{BASE}/threads/{day_tid}{tail}", headers=auth_headers(), **kwargs)
        assert day.status_code == 404 and day.json() == {"detail": "swing threads only"}
    assert client.get(f"{BASE}/threads/{tid}/holds?status=pending", headers=auth_headers()).status_code == 422


def test_every_new_route_says_no_store(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    _pass_days(client, tid, 1)
    answers = [
        _preview(client),
        client.get(f"{BASE}/threads/{tid}/holds", headers=auth_headers()),
        client.get(f"{BASE}/threads/{tid}/weeks", headers=auth_headers()),
        client.get(f"{BASE}/threads/{tid}/weeks/1", headers=auth_headers()),
        client.patch(f"{BASE}/threads/{tid}/weeks/1", json={"rating": 3}, headers=auth_headers()),
        _next(client, tid),
    ]
    assert [a.headers["cache-control"] for a in answers] == ["no-store"] * len(answers)


def test_closing_a_swing_thread_early_stores_the_partial_weeks_review(world, db_session) -> None:
    client, _, _ = world
    tid = _thread(world, db_session)
    _pass_days(client, tid, 2)
    open_list = _open_day(client, tid)
    blocked = client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers())
    assert blocked.status_code == 409  # a day is under way: end it first
    _end(client, open_list)

    closed = client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers())
    assert closed.status_code == 200
    out = ThreadOut.model_validate(closed.json())
    assert out.thread.status == "closed" and out.swing is not None and out.swing.next == "finished"
    weeks = WeeksOut.model_validate(client.get(f"{BASE}/threads/{tid}/weeks", headers=auth_headers()).json())
    assert [(w.status, w.days, w.label) for w in weeks.weeks] == [("closed", 3, "Week 1 · 3 of 5 days")]
    assert weeks.weeks[0].equity_change_usd == 0 and weeks.weeks[0].adherence_pct is not None  # the review was stored
    assert client.post(f"{BASE}/threads/{tid}/close", headers=auth_headers()).json() == closed.json()  # idempotent
    after = _next(client, tid)
    assert after.status_code == 409


# -- a day thread is what it was ------------------------------------------------------------------------------------


def test_a_day_threads_responses_carry_no_swing_shapes(client: TestClient, db_session, monkeypatch) -> None:
    from test_replay_daily_api import _plan_body, _start_plan

    monkeypatch.setattr(app.state, "session_factory", None, raising=False)

    services = make_services()
    app.dependency_overrides[get_services] = lambda: services
    client.get(f"{BASE}/daily", headers=auth_headers())
    user_id = db_session.execute(select(User.id).where(User.email == OWNER_EMAIL)).scalar_one()
    seed_user(db_session, user_id, now=NOW)
    db_session.commit()
    assert client.post(f"{BASE}/threads", json=DAY_CREATE, headers=auth_headers()).status_code == 200
    started = _start_plan((client, services, user_id), db_session)
    plan_mod.run_prep(db_session, services, started["plan"]["id"])
    opened = client.post(f"{BASE}/daily/next", json={}, headers=auth_headers())
    assert "kind" not in opened.json() and OpenNextOut.model_validate(opened.json()).day_list_id is not None
    list_id = opened.json()["day_list_id"]
    listed = client.get(f"{BASE}/day-lists/{list_id}", headers=auth_headers())
    assert "kind" not in listed.json() and DayListOut.model_validate(listed.json()).status == "listed"

    sid = client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers()).json()[
        "id"
    ]
    to = _utc(DAILY_DAYS[0], "10:00")
    advanced = client.post(f"{BASE}/sessions/{sid}/advance", json={"to": to}, headers=auth_headers())
    out = AdvanceOut.model_validate(advanced.json())
    assert (out.paused, out.strip, out.daily_forming) == (None, None, None)
    assert {"paused", "strip", "daily_forming"}.isdisjoint(advanced.json())  # left out, not null
    feed_json = client.get(f"{BASE}/sessions/{sid}/feed", headers=auth_headers()).json()
    feed = FeedOut.model_validate(feed_json)
    assert (feed.daily, feed.strip, feed.paused) == (None, None, None)
    assert {"paused", "strip", "daily_forming", "daily"}.isdisjoint(feed_json)
    state_json = client.get(f"{BASE}/sessions/{sid}", headers=auth_headers()).json()
    state = ReplaySessionOut.model_validate(state_json)
    assert state.tape_feed in ("sip", "iex") and state.thread is not None and state.thread.mode == "day"
    assert set(state_json["thread"]) == {"id", "mode", "status", "balance", "today_pnl_usd", "label"}
    entry = _mark(client, sid, "long_entry").json()
    entered = MarkResultOut.model_validate(entry)
    assert entered.hold is None and entered.open_trade is not None and "hold" not in entry
    assert set(entry["open_trade"]) == {
        "trade_no",
        "side",
        "shares",
        "entry_price",
        "entry_at",
        "stop_price",
        "last_price",
        "unrealized_usd",
        "r",
    }  # fmt: skip  (a day trade says when it was entered; a swing hold leaves entry_at out)
    undo_json = client.delete(f"{BASE}/sessions/{sid}/marks/{entered.mark.id}", headers=auth_headers()).json()
    assert MarkUndoOut.model_validate(undo_json).hold is None and "hold" not in undo_json
    thread = client.get(f"{BASE}/threads", headers=auth_headers()).json()[0]
    assert "swing" not in thread and "swing" not in thread["thread"]
    future = client.post(
        f"{BASE}/daily/next",
        json={"plan": {**_plan_body(db_session, user_id), "firstDay": "2099-01-04"}},
        headers=auth_headers(),
    )
    assert future.status_code == 422 and _problems(future)[0]["path"] == "firstDay"  # no calendar crash
