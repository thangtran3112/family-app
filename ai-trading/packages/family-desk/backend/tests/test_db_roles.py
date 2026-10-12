"""Shared-cluster role split (owner decision 2026-10-12, D-e): `zz-20-desk-roles.sh` creates
`desk_migrator` (owns the schema, runs Alembic) and `desk_runtime` (CRUD only, no CREATE/DROP) the
same way `infrastructure/vps/steps/30-postgres.sh` applies it on the real shared cluster. This
proves the migration and the runtime grants work under the cluster's real role split, not just the
test superuser `db_engine` otherwise connects as. Needs a real Postgres (`scripts/test-db.sh`).

Test passwords below are throwaway fixtures for a disposable container, never a real secret
(AGENTS.md).
"""

import os
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import NamedTuple

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ProgrammingError

_URL_VAR = "DESK_TEST_DATABASE_URL"
_REQUIRE_VAR = "DESK_REQUIRE_DB"
_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"
_ROLE_SCRIPT = Path(__file__).resolve().parents[1] / "docker" / "postgres" / "zz-20-desk-roles.sh"

_MIGRATOR_PASSWORD = "desk-migrator-test-fixture-pw"  # pragma: allowlist secret -- test-only, throwaway
_RUNTIME_PASSWORD = "desk-runtime-test-fixture-pw"  # pragma: allowlist secret -- test-only, throwaway


def _alembic_config(url: str) -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


class RoleSplitUrls(NamedTuple):
    migrator_url: str
    runtime_url: str


@pytest.fixture(scope="module")
def role_split_urls() -> Iterator[RoleSplitUrls]:
    server_url = os.environ.get(_URL_VAR)
    if not server_url:
        if os.environ.get(_REQUIRE_VAR) == "1":
            pytest.fail(f"{_URL_VAR} is unset and {_REQUIRE_VAR}=1")
        pytest.skip(f"{_URL_VAR} is not set")

    admin = make_url(server_url)
    db_name = f"desk_roles_{uuid.uuid4().hex[:12]}"

    admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin_engine.dispose()

    env = os.environ.copy()
    env.update(
        {
            "POSTGRES_USER": admin.username or "postgres",
            "POSTGRES_DB": db_name,
            "DESK_MIGRATOR_DB_PASSWORD": _MIGRATOR_PASSWORD,
            "DESK_RUNTIME_DB_PASSWORD": _RUNTIME_PASSWORD,
            "PGPASSWORD": admin.password or "",
            "PGHOST": admin.host or "127.0.0.1",
            "PGPORT": str(admin.port or 5432),
        }
    )
    subprocess.run(["bash", str(_ROLE_SCRIPT)], env=env, check=True, capture_output=True, text=True)

    migrator_url = admin.set(username="desk_migrator", password=_MIGRATOR_PASSWORD, database=db_name).render_as_string(
        hide_password=False
    )
    runtime_url = admin.set(username="desk_runtime", password=_RUNTIME_PASSWORD, database=db_name).render_as_string(
        hide_password=False
    )

    # Run exactly as the cluster would: connected as desk_migrator, not the test superuser.
    command.upgrade(_alembic_config(migrator_url), "head")

    try:
        yield RoleSplitUrls(migrator_url=migrator_url, runtime_url=runtime_url)
    finally:
        admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
        with admin_engine.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{db_name}" WITH (FORCE)'))
        admin_engine.dispose()


def test_desk_migrator_migration_leaves_all_twelve_tables_reachable_by_desk_runtime(
    role_split_urls: RoleSplitUrls,
) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.connect() as conn:
            tables = {row[0] for row in conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = 'desk'"))}
    finally:
        runtime_engine.dispose()
    assert tables == {
        "alembic_version",
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
    }


def test_desk_runtime_can_select_insert_update_delete(role_split_urls: RoleSplitUrls) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.begin() as conn:
            user_id = conn.execute(
                text("INSERT INTO users (email) VALUES (:email) RETURNING id"), {"email": "runtime@example.test"}
            ).scalar_one()
            conn.execute(
                text("UPDATE users SET display_name = :name WHERE id = :id"), {"name": "Runtime", "id": user_id}
            )
            fetched = conn.execute(text("SELECT display_name FROM users WHERE id = :id"), {"id": user_id}).scalar_one()
            assert fetched == "Runtime"
            conn.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            remaining = conn.execute(text("SELECT COUNT(*) FROM users WHERE id = :id"), {"id": user_id}).scalar_one()
            assert remaining == 0
    finally:
        runtime_engine.dispose()


def test_desk_runtime_cannot_create_a_table(role_split_urls: RoleSplitUrls) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with pytest.raises(ProgrammingError, match="permission denied"):
            with runtime_engine.begin() as conn:
                conn.execute(text("CREATE TABLE sneaky (id int)"))
    finally:
        runtime_engine.dispose()


def test_desk_runtime_cannot_drop_a_table(role_split_urls: RoleSplitUrls) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with pytest.raises(ProgrammingError, match="permission denied|must be owner"):
            with runtime_engine.begin() as conn:
                conn.execute(text("DROP TABLE users"))
    finally:
        runtime_engine.dispose()
