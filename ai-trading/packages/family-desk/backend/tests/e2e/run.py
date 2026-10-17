"""Run native proxy tests and real HTTP/engine tests in a disposable E2E database."""

import os
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from safety import admin_url
from seed import seed_database
from sqlalchemy import create_engine, text

BACKEND = Path(__file__).resolve().parents[2]
FRONTEND = BACKEND.parent / "frontend"
ALEMBIC_INI = BACKEND / "alembic.ini"


def _upgrade(database_url: str) -> None:
    config = Config(str(ALEMBIC_INI))
    config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    command.upgrade(config, "head")


def main() -> int:
    if not (FRONTEND / "out" / "index.html").is_file():
        raise RuntimeError("build the Desk static export before running E2E tests")
    admin = admin_url(os.environ["DESK_E2E_ADMIN_DATABASE_URL"])
    admin_engine = create_engine(admin.render_as_string(hide_password=False), isolation_level="AUTOCOMMIT")
    database = f"desk_e2e_{uuid.uuid4().hex[:12]}"
    created = False
    try:
        with admin_engine.connect() as connection:
            connection.execute(text(f'CREATE DATABASE "{database}"'))
        created = True
        database_url = admin.set(database=database).render_as_string(hide_password=False)
        os.environ["DESK_E2E_DATABASE_URL"] = database_url
        os.environ.setdefault("DESK_E2E_NOW", "2026-10-16T00:00:00+00:00")
        _upgrade(database_url)
        seed_database(database_url)

        import subprocess

        subprocess.run(["node", "--test", "e2e/proxy.test.mjs"], cwd=FRONTEND, check=True)
        return int(
            pytest.main(
                ["-q", "--override-ini=python_files=http_check.py", str(Path(__file__).with_name("http_check.py"))]
            )
        )
    finally:
        if created:
            with admin_engine.connect() as connection:
                connection.execute(text(f'DROP DATABASE "{database}" WITH (FORCE)'))
        admin_engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
