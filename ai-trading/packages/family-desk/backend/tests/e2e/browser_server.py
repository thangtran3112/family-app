"""Serve the test-only Desk runtime for Playwright against disposable Postgres."""

import json
import os
import subprocess
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import server
import uvicorn
from clock import E2E_EMAIL, current_now, reset_now, set_now
from fastapi import Header, HTTPException
from pydantic import BaseModel
from seed import SEED_MODES
from seed import reset_database as reset_seeded_database
from server import SESSION_LIFECYCLE, app, install_e2e_runtime
from sqlalchemy.orm import Session

from ai_trading.db.models import FeedHealth, UniverseDay

# The Practice specs replay the one fixture day (`replay/fixture.py`); only this test-only runtime turns that on.
os.environ.setdefault("DESK_REPLAY_STUB", "1")

# The control routes below are plain `def`, so FastAPI runs them in its thread pool. `reset_database` blocks on a
# TRUNCATE until every other session is done; as `async def` it would hold the event loop, and a request whose
# session closes through the loop (a page navigated away mid-request) could then never finish: a deadlock.


def _verified(identity: str | None) -> None:
    if identity != E2E_EMAIL:
        raise HTTPException(status_code=401, detail="Missing verified identity")


def runtime(identity: str | None = Header(default=None, alias="Cf-Access-Authenticated-User-Email")):
    _verified(identity)
    return {
        "active_sessions": SESSION_LIFECYCLE.active,
        "closed_sessions": SESSION_LIFECYCLE.closed,
        "active_streams": server.STREAM_ACTIVE,
        "streams_closed": server.STREAMS_CLOSED,
    }


def reset_database(
    seed: str = "legacy",
    identity: str | None = Header(default=None, alias="Cf-Access-Authenticated-User-Email"),
):
    _verified(identity)
    if seed not in SEED_MODES:
        raise HTTPException(status_code=422, detail=f"seed must be one of {', '.join(SEED_MODES)}")
    reset_now()
    reset_seeded_database(os.environ["DESK_E2E_DATABASE_URL"], seed)
    with server.STREAM_LOCK:
        server.STREAM_ACTIVE = 0
        server.STREAMS_CLOSED = 0
    return {"status": "reset"}


class Scenario(BaseModel):
    """Move the frozen clock and the feeds' last good update for one browser scenario."""

    now: datetime | None = None  # a timezone-aware instant; omitted keeps the clock where it is
    feed_age_minutes: float | None = None  # how long before the clock both feeds last answered; omitted keeps them
    feed_state: str = "ok"


def scenario(
    body: Scenario,
    identity: str | None = Header(default=None, alias="Cf-Access-Authenticated-User-Email"),
):
    _verified(identity)
    if body.now is not None:
        try:
            set_now(body.now)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    if body.feed_age_minutes is not None:
        now = current_now()
        last_ok = now - timedelta(minutes=body.feed_age_minutes)
        with Session(app.state.e2e_engine) as db:
            for feed in ("bars_delayed", "scan"):
                row = db.get(FeedHealth, feed)
                if row is None:
                    db.add(FeedHealth(feed=feed, state=body.feed_state, last_ok_at=last_ok, updated_at=last_ok))
                else:
                    row.state, row.last_ok_at, row.updated_at = body.feed_state, last_ok, last_ok
            db.commit()
    return {"now": current_now().isoformat()}


class RecordedDay(BaseModel):
    day: date
    symbols: list[str]


class RecordedDays(BaseModel):
    """Mornings the Desk "recorded" its universe (`universe_days`), for the browser specs of the practice lists."""

    days: list[RecordedDay]


def record_universe_days(
    body: RecordedDays,
    identity: str | None = Header(default=None, alias="Cf-Access-Authenticated-User-Email"),
):
    _verified(identity)
    with Session(app.state.e2e_engine) as db:
        for item in body.days:
            row = db.get(UniverseDay, item.day)
            if row is None:
                db.add(UniverseDay(day=item.day, symbols=item.symbols, created_at=datetime.now(UTC)))
            else:
                row.symbols = item.symbols
        db.commit()
    return {"recorded": len(body.days)}


def engine_tick(identity: str | None = Header(default=None, alias="Cf-Access-Authenticated-User-Email")):
    _verified(identity)
    try:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("tick.py"))],
            env={
                "PATH": os.environ.get("PATH", ""),
                "DESK_E2E_DATABASE_URL": os.environ["DESK_E2E_DATABASE_URL"],
                "DESK_E2E_NOW": os.environ["DESK_E2E_NOW"],
            },
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        raise HTTPException(status_code=500, detail=error.stderr[-2000:]) from error
    return json.loads(result.stdout)


app.add_api_route("/api/desk/__e2e/runtime", runtime, methods=["GET"], include_in_schema=False)
app.add_api_route("/api/desk/__e2e/tick", engine_tick, methods=["POST"], include_in_schema=False)
app.add_api_route("/api/desk/__e2e/reset", reset_database, methods=["POST"], include_in_schema=False)
app.add_api_route("/api/desk/__e2e/scenario", scenario, methods=["POST"], include_in_schema=False)
app.add_api_route("/api/desk/__e2e/universe-days", record_universe_days, methods=["POST"], include_in_schema=False)
install_e2e_runtime()

if __name__ == "__main__":
    port = int(os.environ.get("DESK_E2E_API_PORT", "18044"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on")
