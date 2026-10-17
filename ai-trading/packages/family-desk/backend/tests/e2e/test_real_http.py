import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from clock import E2E_EMAIL, E2E_NOW
from server import SESSION_LIFECYCLE, STREAM_CLOSED, app, install_e2e_runtime
from sqlalchemy import select

from ai_trading.db.models import StrategyVersion

BACKEND = Path(__file__).resolve().parents[2]
FRONTEND = BACKEND.parent / "frontend"
PROXY_SCRIPT = FRONTEND / "e2e" / "proxy.mjs"
IDENTITY_HEADER = "Cf-Access-Authenticated-User-Email"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_for(check, process=None, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise AssertionError(f"test service exited with {process.returncode}")
        if check():
            return
        time.sleep(0.025)
    raise AssertionError("test service did not become ready")


@pytest.fixture(scope="module")
def real_servers():
    restore_runtime = install_e2e_runtime()
    api_port, proxy_port = _free_port(), _free_port()
    api_origin = f"http://127.0.0.1:{api_port}"
    proxy_origin = f"http://127.0.0.1:{proxy_port}"
    api_server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=api_port, log_level="error", lifespan="on"))
    api_thread = threading.Thread(target=api_server.run, name="desk-e2e-api", daemon=True)
    proxy_env = {
        "PATH": os.environ.get("PATH", ""),
        "DESK_E2E_API_ORIGIN": api_origin,
        "DESK_E2E_PROXY_PORT": str(proxy_port),
        "DESK_E2E_STATIC_ROOT": str(FRONTEND / "out"),
    }
    proxy = None
    try:
        api_thread.start()
        proxy = subprocess.Popen(["node", str(PROXY_SCRIPT)], cwd=FRONTEND, env=proxy_env, stdout=subprocess.DEVNULL)
        _wait_for(lambda: api_server.started)
        with httpx.Client(timeout=1) as client:
            _wait_for(lambda: client.get(f"{proxy_origin}/").status_code == 200, process=proxy)
        yield api_origin, proxy_origin
    finally:
        if proxy is not None:
            proxy.terminate()
            try:
                proxy.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait(timeout=3)
        api_server.should_exit = True
        api_thread.join(timeout=5)
        restore_runtime()


def test_real_api_proxy_database_engine_and_sse_lifecycle(real_servers):
    api_origin, proxy_origin = real_servers
    with httpx.Client(timeout=10) as client:
        ready = client.get(f"{api_origin}/healthz")
        assert ready.status_code == 200
        assert ready.json() == {"status": "ok"}

        before_closed = SESSION_LIFECYCLE.closed
        denied = client.get(
            f"{proxy_origin}/api/desk/bars/NVDA?interval=1m&days=30",
            headers={IDENTITY_HEADER: "forged@example.test", "X-Verified-Email": "forged@example.test"},
        )
        assert denied.status_code == 401
        assert "forged@example.test" not in denied.text
        assert SESSION_LIFECYCLE.wait_for_closed(before_closed + 1, timeout=2)

        session = {"cookie": "desk_e2e_session=1", IDENTITY_HEADER: "forged@example.test"}
        bars = client.get(f"{proxy_origin}/api/desk/bars/NVDA?interval=1m&days=30", headers=session)
        assert bars.status_code == 200
        assert bars.json()["symbol"] == "NVDA"
        assert bars.json()["quality"] == "delayed-15m"
        assert len(bars.json()["bars"]) > 60
        assert E2E_EMAIL not in bars.text

        future = client.get(f"{proxy_origin}/api/desk/bars/%2FES?interval=1m&days=30", headers=session)
        assert future.status_code == 200
        assert future.json()["symbol"] == "/ES"
        assert len(future.json()["bars"]) > 60

        missing = client.get(f"{proxy_origin}/api/desk/no-such-route", headers=session)
        assert missing.status_code == 404
        assert missing.headers["content-type"].startswith("application/json")
        assert "static 404" not in missing.text

        STREAM_CLOSED.clear()
        with client.stream(
            "GET", f"{proxy_origin}/api/desk/quotes/NVDA", headers={"cookie": "desk_e2e_session=1"}
        ) as stream:
            assert stream.status_code == 200
            lines = iter(stream.iter_lines())
            assert next(lines) == "event: quote"
            quote = json.loads(next(lines).removeprefix("data: "))
            assert quote["symbol"] == "NVDA"
            assert quote["quality"] == "delayed-15m"
            assert quote["as_of"] == "2026-10-15T19:58:00+00:00"
        assert STREAM_CLOSED.wait(3), "closing HTTP stream did not cancel quote generator"
        assert SESSION_LIFECYCLE.active == 0

        empty_alerts = client.get(f"{proxy_origin}/api/desk/alerts", headers=session)
        assert empty_alerts.status_code == 200
        assert empty_alerts.json() == []

        template = json.loads((BACKEND.parent / "contracts/templates/vwap-reclaim.json").read_text())
        created = client.post(f"{proxy_origin}/api/desk/strategies", headers=session, json={"name": "E2E VWAP reclaim"})
        assert created.status_code == 201
        strategy = created.json()
        assert strategy["stage"] == "draft"

        version = client.post(
            f"{proxy_origin}/api/desk/strategies/{strategy['id']}/versions", headers=session, json={"spec": template}
        )
        assert version.status_code == 201
        with app.state.session_factory() as db:
            saved_version = db.scalar(select(StrategyVersion).where(StrategyVersion.id == version.json()["id"]))
            assert saved_version is not None and saved_version.created_at <= E2E_NOW

        promoted = client.put(
            f"{proxy_origin}/api/desk/strategies/{strategy['id']}/stage",
            headers=session,
            json={"stage": "alert_only"},
        )
        assert promoted.status_code == 200
        assert promoted.json()["stage"] == "alert_only"

        result = subprocess.run(
            [sys.executable, "tests/e2e/tick.py"],
            cwd=BACKEND,
            env={
                "PATH": os.environ.get("PATH", ""),
                "DESK_E2E_DATABASE_URL": os.environ["DESK_E2E_DATABASE_URL"],
                "DESK_E2E_NOW": os.environ.get("DESK_E2E_NOW", "2026-10-16T00:00:00+00:00"),
            },
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        tick_result = json.loads(result.stdout)
        assert tick_result["first"]["new_signals"] == 1
        assert tick_result["second"]["new_signals"] == 0

        alerts = client.get(f"{proxy_origin}/api/desk/alerts", headers=session)
        assert alerts.status_code == 200
        assert len(alerts.json()) == 1
        assert "NVDA" in alerts.json()[0]["body"]
