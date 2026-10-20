"""Serve the test-only Desk runtime for Playwright against disposable Postgres."""

import json
import os
import subprocess
import sys
from pathlib import Path

import server
import uvicorn
from clock import E2E_EMAIL
from fastapi import Header, HTTPException
from seed import seed_database
from server import SESSION_LIFECYCLE, app, install_e2e_runtime
from sqlalchemy import text

from ai_trading.db.models import Base


def _verified(identity: str | None) -> None:
    if identity != E2E_EMAIL:
        raise HTTPException(status_code=401, detail="Missing verified identity")


async def runtime(identity: str | None = Header(default=None, alias="Cf-Access-Authenticated-User-Email")):
    _verified(identity)
    return {
        "active_sessions": SESSION_LIFECYCLE.active,
        "closed_sessions": SESSION_LIFECYCLE.closed,
        "active_streams": server.STREAM_ACTIVE,
        "streams_closed": server.STREAMS_CLOSED,
    }


async def reset_database(identity: str | None = Header(default=None, alias="Cf-Access-Authenticated-User-Email")):
    _verified(identity)
    tables = ", ".join(f'"{table.name}"' for table in reversed(Base.metadata.sorted_tables))
    with app.state.e2e_engine.begin() as connection:
        connection.execute(text(f"TRUNCATE TABLE {tables} RESTART IDENTITY CASCADE"))
    seed_database(os.environ["DESK_E2E_DATABASE_URL"])
    with server.STREAM_LOCK:
        server.STREAM_ACTIVE = 0
        server.STREAMS_CLOSED = 0
    return {"status": "reset"}


async def engine_tick(identity: str | None = Header(default=None, alias="Cf-Access-Authenticated-User-Email")):
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
install_e2e_runtime()

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=18044, log_level="warning", lifespan="on")
