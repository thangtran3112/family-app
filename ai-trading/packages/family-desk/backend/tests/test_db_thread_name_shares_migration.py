"""0020's two columns on `practice_threads` and their data steps (D-069, D-042): every thread gets a name of its own
(mode and ET start day, "(2)" on a later one of that owner, mode and day), and a day thread's `shares` is lifted from
its newest plan that still carries a legacy `setup.shares`. Runs on its own database, migrated to 0019 first so there
is old data to move."""

import json
import os
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import IntegrityError

_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"

# 22:00 ET on Oct 15 is already Oct 16 in UTC: the name follows the ET day.
OCT_15_MORNING = datetime(2026, 10, 15, 14, 0, tzinfo=UTC)
OCT_15_EVENING = datetime(2026, 10, 15, 20, 0, tzinfo=UTC)
OCT_15_LATE = datetime(2026, 10, 16, 2, 0, tzinfo=UTC)
NOV_1 = datetime(2026, 11, 1, 15, 0, tzinfo=UTC)


@pytest.fixture
def at_0019() -> Iterator[tuple[Engine, Config]]:
    server_url = os.environ.get("DESK_TEST_DATABASE_URL")
    if not server_url:
        if os.environ.get("DESK_REQUIRE_DB") == "1":
            pytest.fail("DESK_TEST_DATABASE_URL is unset and DESK_REQUIRE_DB=1")
        pytest.skip("DESK_TEST_DATABASE_URL is not set")
    name = f"desk_test_{uuid.uuid4().hex[:12]}"
    admin = create_engine(server_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = make_url(server_url).set(database=name).render_as_string(hide_password=False)
    config = Config(str(_ALEMBIC_INI))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "0019")
    engine = create_engine(url)
    try:
        yield engine, config
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


def _thread(conn, owner: int, mode: str, created: datetime, status: str = "active") -> int:
    return conn.execute(
        text(
            "INSERT INTO practice_threads (owner_user_id, mode, starting_balance, stop_note_on_entry, "
            "trade_only_on_signal, status, created_at, updated_at, closed_at) VALUES (:o, :m, 50000, 'yes', 'no', "
            "CAST(:s AS text), :t, :t, CASE WHEN CAST(:s AS text) = 'closed' THEN CAST(:t AS timestamptz) END) "
            "RETURNING id"
        ),
        {"o": owner, "m": mode, "s": status, "t": created},
    ).scalar_one()


def _plan(conn, owner: int, thread: int, spec: dict, status: str = "archived") -> None:
    conn.execute(
        text(
            "INSERT INTO practice_plans (owner_user_id, thread_id, schema_version, spec, first_day, universe, prep, "
            "status, created_at, updated_at) VALUES (:o, :th, 1, CAST(:spec AS jsonb), :d, CAST('{}' AS jsonb), "
            "CAST('{}' AS jsonb), :s, :t, :t)"
        ),
        {"o": owner, "th": thread, "spec": json.dumps(spec), "d": date(2026, 9, 28), "s": status, "t": OCT_15_MORNING},
    )


def _seed(conn) -> dict[str, int]:
    owner = conn.execute(text("INSERT INTO users (email) VALUES ('owner@example.com') RETURNING id")).scalar_one()
    other = conn.execute(text("INSERT INTO users (email) VALUES ('spouse@example.com') RETURNING id")).scalar_one()
    ids = {
        "first": _thread(conn, owner, "day", OCT_15_MORNING),
        "second": _thread(conn, owner, "day", OCT_15_EVENING),
        "third": _thread(conn, owner, "day", OCT_15_LATE),
        "swing": _thread(conn, owner, "swing", OCT_15_MORNING),
        "closed": _thread(conn, owner, "day", NOV_1, status="closed"),
        "theirs": _thread(conn, other, "day", OCT_15_MORNING),
    }
    # first: an older plan with 100, then the newest with 200 (the newest wins); second: junk; third: no setup at all;
    # closed: zero (below the column's floor); theirs: past nine digits; swing: a day-only field, ignored.
    _plan(conn, owner, ids["first"], {"setup": {"shares": 100}})
    _plan(conn, owner, ids["first"], {"setup": {"shares": 200}}, status="active")
    _plan(conn, owner, ids["second"], {"setup": {"shares": "lots"}})
    _plan(conn, owner, ids["third"], {"firstDay": "2026-09-28"})
    _plan(conn, owner, ids["closed"], {"setup": {"shares": 0}})
    _plan(conn, other, ids["theirs"], {"setup": {"shares": 12345678901}})
    _plan(conn, owner, ids["swing"], {"setup": {"shares": 300}})
    return ids


def _read(conn) -> dict[int, tuple[str, int | None]]:
    return {
        row.id: (row.name, row.shares) for row in conn.execute(text("SELECT id, name, shares FROM practice_threads"))
    }


def test_every_thread_is_named_by_mode_and_et_day_and_a_day_threads_newest_legacy_size_is_lifted(at_0019) -> None:
    engine, config = at_0019
    with engine.begin() as conn:
        ids = _seed(conn)
    command.upgrade(config, "0020")
    with engine.begin() as conn:
        read = _read(conn)
    assert read[ids["first"]] == ("Day thread · Oct 15", 200)
    assert read[ids["second"]] == ("Day thread · Oct 15 (2)", None)  # a junk size is skipped, not an error
    assert read[ids["third"]] == ("Day thread · Oct 15 (3)", None)  # 22:00 ET is still Oct 15 (Oct 16 in UTC)
    assert read[ids["swing"]] == ("Swing thread · Oct 15", None)  # a swing thread never takes a size
    assert read[ids["closed"]] == ("Day thread · Nov 1", None)  # below the floor: left empty, not lifted as 0
    assert read[ids["theirs"]] == ("Day thread · Oct 15", None)  # another owner counts from the start again
    assert len({name for name, _ in read.values()}) == 5  # the five of one owner's mode and day apart read apart


def test_the_new_columns_are_enforced_and_the_migration_reverses(at_0019) -> None:
    engine, config = at_0019
    with engine.begin() as conn:
        owner = conn.execute(text("INSERT INTO users (email) VALUES ('owner@example.com') RETURNING id")).scalar_one()
    command.upgrade(config, "0020")
    insert = (
        "INSERT INTO practice_threads (owner_user_id, mode, starting_balance, stop_note_on_entry, "
        "trade_only_on_signal, status, created_at, updated_at{cols}) VALUES (:o, 'day', 50000, 'yes', 'no', "
        "'active', now(), now(){vals})"
    )
    with pytest.raises(IntegrityError), engine.begin() as conn:  # a thread without a name
        conn.execute(text(insert.format(cols="", vals="")), {"o": owner})
    with pytest.raises(IntegrityError), engine.begin() as conn:  # a size of 0
        conn.execute(text(insert.format(cols=", name, shares", vals=", 'A', 0")), {"o": owner})
    with engine.begin() as conn:  # a size left out is fine
        conn.execute(text(insert.format(cols=", name", vals=", 'A'")), {"o": owner})
    command.downgrade(config, "0019")
    with engine.begin() as conn:
        columns = {
            row[0]
            for row in conn.execute(
                text("SELECT column_name FROM information_schema.columns WHERE table_name = 'practice_threads'")
            )
        }
    assert "name" not in columns and "shares" not in columns
    command.upgrade(config, "0020")  # and it applies again over the surviving row
    with engine.begin() as conn:
        assert _read(conn) and all(name for name, _ in _read(conn).values())
