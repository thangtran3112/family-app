"""Run native proxy tests, the Playwright suite and the real HTTP/engine checks, each in a disposable E2E database.

    uv run python tests/e2e/run.py                                  # everything (CI)
    uv run python tests/e2e/run.py --browser -- --project=desktop-1440 e2e/desk/shell.spec.ts

`--browser` runs only Playwright; whatever follows `--` goes to `playwright test`. Needs the static export
(`pnpm build`) and `DESK_E2E_ADMIN_DATABASE_URL`, a loopback Postgres maintenance database."""

import argparse
import os
import subprocess
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


def _run_in_database(admin_engine, admin, command) -> int:
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
        return command()
    finally:
        os.environ.pop("DESK_E2E_DATABASE_URL", None)
        if created:
            with admin_engine.connect() as connection:
                connection.execute(text(f'DROP DATABASE "{database}" WITH (FORCE)'))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--browser", action="store_true", help="run only the Playwright suite")
    parser.add_argument("playwright_args", nargs="*", help="after `--`: passed to `playwright test`")
    args = parser.parse_args(argv)
    if not (FRONTEND / "out" / "index.html").is_file():
        raise RuntimeError("build the Desk static export before running E2E tests")
    admin = admin_url(os.environ["DESK_E2E_ADMIN_DATABASE_URL"])
    admin_engine = create_engine(admin.render_as_string(hide_password=False), isolation_level="AUTOCOMMIT")
    try:
        if not args.browser:
            subprocess.run(["node", "--test", "e2e/proxy.test.mjs"], cwd=FRONTEND, check=True)

        def browser_suite() -> int:
            command = ["pnpm", "exec", "playwright", "test", *args.playwright_args]
            return subprocess.run(command, cwd=FRONTEND, env=os.environ.copy()).returncode

        browser_result = _run_in_database(admin_engine, admin, browser_suite)
        if browser_result or args.browser:
            return browser_result

        for check in ("http_check.py", "technical_check.py"):
            result = _run_in_database(
                admin_engine,
                admin,
                lambda check=check: int(pytest.main(["-q", str(Path(__file__).with_name(check))])),
            )
            if result:
                return result
        return 0
    finally:
        admin_engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
