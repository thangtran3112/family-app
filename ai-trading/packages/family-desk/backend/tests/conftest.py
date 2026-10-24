"""Real-Postgres test fixtures (Lane P4, `scripts/test-db.sh`).

`DESK_TEST_DATABASE_URL` names a Postgres *server* (its admin/maintenance database, usually
`postgres`), not a database to test against directly. `db_engine` creates a uniquely named database
on that server, migrates it to Alembic head, hands back an engine on it, and drops the database
again at the end of the session. Every test that needs Postgres depends on `db_engine` (or the
convenience `db_session`), so with no URL set they are skipped by pytest's fixture-not-available
path below -- unless `DESK_REQUIRE_DB=1`, which turns that into a hard failure instead.
"""

import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session, sessionmaker

_URL_VAR = "DESK_TEST_DATABASE_URL"
_REQUIRE_VAR = "DESK_REQUIRE_DB"
_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"

_TABLES = (
    "filter_matches",
    "filter_runs",
    "filter_strategy_versions",
    "filter_strategies",
    "universe_symbols",
    "symbol_metrics",
    "feed_health",
    "bars_1d",
    "bars_1h",
    "bars_1m",
    "futures_rolls",
    "users",
    "watchlists",
    "watchlist_items",
    "strategies",
    "strategy_versions",
    "signals",
    "alerts",
    "deliveries",
)


def _alembic_config(url: str) -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


@pytest.fixture(scope="session")
def db_engine() -> Iterator[Engine]:
    server_url = os.environ.get(_URL_VAR)
    if not server_url:
        if os.environ.get(_REQUIRE_VAR) == "1":
            pytest.fail(f"{_URL_VAR} is unset and {_REQUIRE_VAR}=1")
        pytest.skip(f"{_URL_VAR} is not set")

    db_name = f"desk_test_{uuid.uuid4().hex[:12]}"
    admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin_engine.dispose()

    db_url = make_url(server_url).set(database=db_name)
    # `str(URL)`/`URL.__repr__` mask the password (`"***"`) by design; alembic only accepts a
    # string, so build it with the real password explicitly instead of masking our own write.
    db_url_str = db_url.render_as_string(hide_password=False)
    command.upgrade(_alembic_config(db_url_str), "head")

    engine = create_engine(db_url_str)
    try:
        yield engine
    finally:
        engine.dispose()
        admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
        with admin_engine.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{db_name}" WITH (FORCE)'))
        admin_engine.dispose()


@pytest.fixture
def db_session(db_engine: Engine) -> Iterator[Session]:
    """A session on a freshly truncated database, so tests can't see each other's rows."""
    with db_engine.begin() as conn:
        # CASCADE: several of `_TABLES` FK each other (users -> ... -> deliveries); plain TRUNCATE
        # on a table another listed table still references raises regardless of row content or
        # loop order, since Postgres checks the constraint's existence, not current row counts.
        for table in _TABLES:
            conn.execute(text(f'TRUNCATE TABLE "{table}" CASCADE'))
    factory = sessionmaker(db_engine, expire_on_commit=False)
    with factory() as session:
        yield session
        session.rollback()
