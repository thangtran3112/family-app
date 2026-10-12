"""`/healthz` readiness probe (Step 0 integration fix, flagged by INTEGRATION-REPORT.md §6.3): a
real `SELECT 1` against the Desk database with a 1-second connect timeout. 200 `{"status": "ok"}`
on success; 503 `{"status": "unavailable"}` on any failure -- the real error text and the database
URL are never returned (AGENTS.md: no VPS address or credential in any response this process
writes)."""

from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from ai_trading.api.app import app

# Nothing listens here; a short connect_timeout makes the failure fast and deterministic, no real
# network wait and no real Postgres needed for these two tests.
_BAD_URL = "postgresql+psycopg://baduser:badpass@127.0.0.1:1/nonexistent"


def _bad_engine():
    return create_engine(_BAD_URL, connect_args={"connect_timeout": 1})


def test_healthz_returns_200_ok_when_the_database_answers(db_engine):
    app.state.health_engine = db_engine
    try:
        with TestClient(app) as client:
            response = client.get("/healthz")
    finally:
        del app.state.health_engine

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_healthz_returns_503_unavailable_when_the_database_cannot_be_reached():
    bad_engine = _bad_engine()
    app.state.health_engine = bad_engine
    try:
        with TestClient(app) as client:
            response = client.get("/healthz")
    finally:
        del app.state.health_engine
        bad_engine.dispose()

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}


def test_healthz_503_body_never_contains_the_database_url_credentials_or_an_error_message():
    bad_engine = _bad_engine()
    app.state.health_engine = bad_engine
    try:
        with TestClient(app) as client:
            response = client.get("/healthz")
    finally:
        del app.state.health_engine
        bad_engine.dispose()

    body_text = response.text
    assert response.json() == {"status": "unavailable"}
    for secret_shaped_fragment in ("baduser", "badpass", "127.0.0.1", "nonexistent", "psycopg", "OperationalError"):
        assert secret_shaped_fragment not in body_text


def test_healthz_returns_503_when_no_database_is_configured_at_all():
    assert not hasattr(app.state, "health_engine")  # no lifespan ran in this bare-module test

    with TestClient(app) as client:
        response = client.get("/healthz")

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
