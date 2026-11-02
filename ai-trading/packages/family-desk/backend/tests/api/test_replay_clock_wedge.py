"""A thread clock that runs must not be able to wedge the API (the 45-minute Cloudflare 524 on every `/api/desk/*`
route, with 500s on the clock resume and the chart's advance).

Every request here gets its own real session, as in production: the other API tests share one `db_session`, so no
request there can ever wait on another's row lock. Real Postgres (`scripts/test-db.sh`); history from
`tests/daily_world.py`.

The incident: a running clock makes every read of its day take the day list's row lock (`settle_day`), and the request
keeps that lock until FastAPI closes its session, which is AFTER its background tasks. A re-scan started on a running
day is such a task, and it needs the same lock: request and task waited on each other for ever, every poll of the thread
queued behind them, and the pooled connections (15) and worker threads ran out for all routes."""

import asyncio
import time
from collections.abc import Iterator
from datetime import timedelta

import httpx
import pytest
from conftest import OWNER_EMAIL, auth_headers
from daily_world import DAYS, NOW, make_services
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import sessionmaker
from test_replay_threads_api import BASE, _day_one

from ai_trading.api.app import app
from ai_trading.api.auth import get_session
from ai_trading.api.replay import get_services
from ai_trading.cli.seed_technical import seed_user
from ai_trading.core.calendar import et
from ai_trading.db.engine import make_engine, make_session_factory, session_scope
from ai_trading.db.models import User


@pytest.fixture
def world(client: TestClient, db_session):
    services = make_services()
    app.dependency_overrides[get_services] = lambda: services
    client.get(f"{BASE}/daily", headers=auth_headers())  # creates the user
    user_id = db_session.execute(select(User.id).where(User.email == OWNER_EMAIL)).scalar_one()
    seed_user(db_session, user_id, now=NOW)
    db_session.commit()
    return client, services, user_id


def _running_day(world, db_session):
    """A day-thread day with GAPPER open and its clock playing; the wall clock then moves 5 s on. Returns the thread's
    clock URL, the day list id and the list of wall times (so a test can move it)."""
    client, services, _ = world
    wall = [NOW]
    services.wall = lambda: wall[0]
    list_id = _day_one(world, db_session)
    tid = client.get(f"{BASE}/daily", headers=auth_headers()).json()["thread"]["thread"]["id"]
    client.post(f"{BASE}/day-lists/{list_id}/sessions", json={"symbol": "GAPPER"}, headers=auth_headers())
    url = f"{BASE}/threads/{tid}/clock"
    client.post(url, json={"to": et(DAYS[0], "10:00").isoformat()}, headers=auth_headers())
    assert client.post(url, json={"running": True}, headers=auth_headers()).json()["state"] == "running"
    db_session.commit()
    wall[0] += timedelta(seconds=5)
    return url, list_id


@pytest.fixture
def per_request_sessions(db_engine, request) -> Iterator[sessionmaker]:
    """The app on its own engine and one session per request (what `get_session` really does), plus the factory the
    background jobs read from `app.state`. Lock bounds are the test's (`@pytest.mark.parametrize` indirect)."""
    bounds = getattr(request, "param", {})
    engine = make_engine(db_engine.url.render_as_string(hide_password=False), **bounds)
    factory = make_session_factory(engine)

    def one_session():
        with session_scope(factory) as session:
            yield session

    app.state.session_factory = factory
    app.dependency_overrides[get_session] = one_session
    yield factory
    del app.state.session_factory
    engine.dispose()


def _in_flight(db_engine) -> list[tuple]:
    with db_engine.connect() as conn:
        return list(
            conn.execute(
                text(
                    "SELECT state, wait_event_type FROM pg_stat_activity "
                    "WHERE datname = current_database() AND pid <> pg_backend_pid() "
                    "AND (state = 'idle in transaction' OR wait_event_type = 'Lock')"
                )
            )
        )


def test_a_rescan_on_a_running_clock_does_not_outlive_its_request(world, db_session, db_engine, per_request_sessions):
    url, list_id = _running_day(world, db_session)

    async def rescan_then_poll():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://desk", headers=auth_headers(), timeout=60
        ) as client:
            started = await asyncio.wait_for(client.post(f"{BASE}/day-lists/{list_id}/rescan"), 20)
            polled = await asyncio.wait_for(client.get(url), 20)  # the thread's clock is not locked out meanwhile
            return started, polled

    started, polled = asyncio.run(rescan_then_poll())
    assert started.status_code == 200 and polled.status_code == 200 and polled.json()["state"] == "running"

    # The background re-scan ran to its end on its own session: it was never waiting for the request's lock.
    deadline = time.monotonic() + 20
    state = None
    while time.monotonic() < deadline:
        with per_request_sessions() as session:
            state = session.execute(
                text("SELECT rescan_job->>'state' FROM replay_day_lists WHERE id = :id"), {"id": list_id}
            ).scalar_one()
        if state in ("done", "failed"):
            break
        time.sleep(0.1)
    assert state == "done"
    assert _in_flight(db_engine) == []  # nobody left idle in a transaction or waiting on a lock


@pytest.mark.parametrize("per_request_sessions", [{"lock_timeout_ms": 500}], indirect=True)
def test_a_lock_nobody_releases_fails_the_polls_fast_and_leaves_other_routes_alone(
    world, db_session, db_engine, per_request_sessions
):
    url, list_id = _running_day(world, db_session)
    holder = db_engine.connect()  # the wedge: a session that locked the day list and never ended its transaction
    holder.execute(text("SELECT id FROM replay_day_lists WHERE id = :id FOR UPDATE"), {"id": list_id})

    async def polls_and_a_stranger():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://desk", headers=auth_headers(), timeout=60
        ) as client:
            # More polls than the pool has connections (5 + 10): unbounded, they would take every one and every thread.
            polls = [asyncio.ensure_future(client.get(url)) for _ in range(20)]
            try:
                await asyncio.sleep(0.2)
                started = time.monotonic()
                other = await asyncio.wait_for(client.get(f"{BASE}/threads"), 20)
                answered = await asyncio.wait_for(asyncio.gather(*polls), 30)
                return other, answered, time.monotonic() - started
            finally:
                holder.rollback()  # so a failure here ends the test, not hangs it on the threads waiting for this lock
                holder.close()

    other, answered, took = asyncio.run(polls_and_a_stranger())
    assert other.status_code == 200  # a route that never touches the locked row is not held up by it
    assert {r.status_code for r in answered} == {503}  # a plain "busy · try again", not a 500 and not a hang
    assert all(r.headers["retry-after"] == "2" for r in answered)
    assert took < 15
