"""Shared FastAPI `TestClient` fixtures for `tests/api/*`: `get_session` overridden to the real,
per-test-truncated `db_session` fixture (`tests/conftest.py`, real Postgres via
`scripts/test-db.sh`), `get_data_sources` overridden to `fakes.fake_data_sources()` -- no live
network call anywhere in this directory.
"""

from collections.abc import Iterator

import pytest
from daily_world import SYMBOLS
from fakes import fake_data_sources
from fastapi.testclient import TestClient

from ai_trading.api.app import app
from ai_trading.api.auth import IDENTITY_HEADER, get_data_sources, get_session
from ai_trading.replay import plan as plan_mod

OWNER_EMAIL = "owner@example.com"
OTHER_EMAIL = "spouse@example.com"


def auth_headers(email: str = OWNER_EMAIL) -> dict[str, str]:
    return {IDENTITY_HEADER: email}


@pytest.fixture(autouse=True)
def desk_universe(monkeypatch: pytest.MonkeyPatch) -> None:
    """The three synthetic names are the Desk universe in these tests (see `tests/replay/conftest.py`)."""
    monkeypatch.setattr(plan_mod, "practice_universe", lambda db, user_id: (list(SYMBOLS), False))


@pytest.fixture
def client(db_session, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # Never let a real DESK_RUNTIME_DATABASE_URL leak into a test run: the app's lifespan would
    # otherwise try to build a real engine and start the background tick/dispatch loops.
    monkeypatch.delenv("DESK_RUNTIME_DATABASE_URL", raising=False)

    def override_get_session():
        # A generator (not a plain return) so FastAPI manages it the same way as the real
        # dependency -- the same `db_session` object for every request this test makes, truncated
        # fresh per test by `tests/conftest.py`'s own fixture.
        yield db_session

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_data_sources] = lambda: fake_data_sources()
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
