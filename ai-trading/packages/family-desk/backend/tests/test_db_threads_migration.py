"""0007's data step: one default thread per owner with a plan, their plans and day-list sessions linked, the old plan
fields lifted into the thread's plan, and the ledger backfilled with the same trades and rounding the journal uses.
Runs on its own database, migrated to 0006 first so there is old data to move."""

import json
import os
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path

import pandas as pd
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url

from ai_trading.replay import journal as journal_mod
from ai_trading.replay.model import Mark

_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"

NOW = datetime(2026, 10, 24, 16, 0, tzinfo=UTC)
DAY = date(2026, 9, 28)
OLD_SPEC = {
    "schemaVersion": 1,
    "firstDay": "2026-09-28",
    "sessions": 5,
    "hideDates": "no",
    "screen": {"filters": [{"id": 1}], "listAt": "09:00", "maxList": 20},
    "setup": {
        "window": {"from": "09:30", "to": "11:30"},
        "session": "regular",
        "interval": "5m",
        "shares": 100,
        "armed": [],
        "plan": {"stopRequired": "yes", "signalOnly": "no", "maxLossUsd": 200, "maxTrades": 4, "note": "First hour."},
    },
}


@pytest.fixture
def at_0006() -> Iterator[tuple[Engine, Config]]:
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
    command.upgrade(config, "0006")
    engine = create_engine(url)
    try:
        yield engine, config
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


def _jsonb(value: object) -> str:
    return json.dumps(value)


def _seed(conn) -> dict[str, int]:
    owner = conn.execute(text("INSERT INTO users (email) VALUES ('owner@example.com') RETURNING id")).scalar_one()
    other = conn.execute(text("INSERT INTO users (email) VALUES ('spouse@example.com') RETURNING id")).scalar_one()
    bare = conn.execute(text("INSERT INTO users (email) VALUES ('third@example.com') RETURNING id")).scalar_one()
    plan = conn.execute(
        text(
            "INSERT INTO practice_plans (owner_user_id, schema_version, spec, first_day, universe, prep, status, "
            "created_at, updated_at) VALUES (:o, 1, CAST(:spec AS jsonb), :d, CAST('{}' AS jsonb), "
            "CAST('{}' AS jsonb), 'active', :t, :t) RETURNING id"
        ),
        {"o": owner, "spec": _jsonb(OLD_SPEC), "d": DAY, "t": NOW},
    ).scalar_one()
    day_list = conn.execute(
        text(
            "INSERT INTO replay_day_lists (plan_id, owner_user_id, day, day_no, screen, list_at, data_through, "
            "universe, columns, candidates, watch, status, created_at, updated_at) VALUES (:p, :o, :d, 1, "
            "CAST('{}' AS jsonb), :t, :t, CAST('{}' AS jsonb), CAST('[]' AS jsonb), CAST('[]' AS jsonb), "
            "CAST('[]' AS jsonb), 'practicing', :t, :t) RETURNING id"
        ),
        {"p": plan, "o": owner, "d": DAY, "t": NOW},
    ).scalar_one()

    def session(user: int, symbol: str, list_id: int | None) -> int:
        return conn.execute(
            text(
                "INSERT INTO replay_sessions (owner_user_id, symbol, day, attempt, schema_version, spec, armed, "
                "signals, window_start, window_end, revealed_through, tape_feed, status, created_at, updated_at, "
                "day_list_id) VALUES (:o, :s, :d, 1, 1, CAST('{}' AS jsonb), CAST('[]' AS jsonb), "
                "CAST('[]' AS jsonb), :t, :t, :t, 'sip', 'active', :t, :t, :l) RETURNING id"
            ),
            {"o": user, "s": symbol, "d": DAY, "t": NOW, "l": list_id},
        ).scalar_one()

    ids = {
        "owner": owner,
        "other": other,
        "bare": bare,
        "plan": plan,
        "day_list": day_list,
        "day_session": session(owner, "TSLA", day_list),
        "standalone": session(owner, "NVDA", None),
        "other_standalone": session(other, "AMD", None),
    }
    # (kind, price, shares, stop, minute): a long that wins with a stop, a short that loses without one, an open long
    marks = [
        ("long_entry", 100.0, 50, 98.0, 0),
        ("long_exit", 101.234, None, None, 5),
        ("short_entry", 101.0, 30, None, 10),
        ("short_exit", 101.337, None, None, 12),
        ("long_entry", 100.5, 10, None, 20),
    ]
    for seq, (kind, price, shares, stop, minute) in enumerate(marks, start=1):
        conn.execute(
            text(
                "INSERT INTO practice_marks (session_id, seq, kind, at, price, shares, stop_price, source, created_at) "
                "VALUES (:s, :q, :k, :at, :p, :n, :st, 'her', :t)"
            ),
            {
                "s": ids["day_session"],
                "q": seq,
                "k": kind,
                "at": datetime(2026, 9, 28, 13, 30 + minute, tzinfo=UTC),
                "p": price,
                "n": shares,
                "st": stop,
                "t": NOW,
            },
        )
    conn.execute(  # a closed trade on the standalone session: it must NOT reach a ledger
        text(
            "INSERT INTO practice_marks (session_id, seq, kind, at, price, shares, source, created_at) VALUES "
            "(:s, 1, 'long_entry', :t, 10, 5, 'her', :t), (:s, 2, 'long_exit', :t, 11, NULL, 'her', :t)"
        ),
        {"s": ids["standalone"], "t": NOW},
    )
    return ids


def test_default_thread_links_owner_rows_and_backfills_the_ledger_like_the_journal(at_0006) -> None:
    engine, config = at_0006
    with engine.begin() as conn:
        ids = _seed(conn)
    command.upgrade(config, "0007")

    with engine.connect() as conn:
        threads = conn.execute(text("SELECT * FROM practice_threads ORDER BY id")).mappings().all()
        assert [t["owner_user_id"] for t in threads] == [ids["owner"]]  # only owners with a plan
        thread = threads[0]
        assert (thread["mode"], thread["status"], float(thread["starting_balance"])) == ("day", "active", 50_000.0)
        assert thread["created_at"] == NOW and thread["closed_at"] is None
        assert (thread["stop_note_on_entry"], thread["trade_only_on_signal"]) == ("yes", "no")
        assert (thread["max_loss_usd"], thread["max_trades"], thread["plan_note"]) == (200, 4, "First hour.")

        linked = conn.execute(text("SELECT id, thread_id FROM replay_sessions ORDER BY id")).all()
        assert dict(linked) == {
            ids["day_session"]: thread["id"],
            ids["standalone"]: None,  # a standalone session never touches a balance
            ids["other_standalone"]: None,
        }
        assert conn.execute(text("SELECT thread_id FROM practice_plans")).scalar_one() == thread["id"]
        # The plan's own spec still carries the old fields: deprecated, not dropped.
        assert conn.execute(text("SELECT spec FROM practice_plans")).scalar_one()["setup"]["plan"]["maxTrades"] == 4

        rows = conn.execute(text("SELECT * FROM practice_ledger ORDER BY realized_at")).mappings().all()
        marks = conn.execute(
            text(
                "SELECT id, seq, kind, at, price, shares, stop_price, trade_no, source FROM practice_marks "
                "WHERE session_id = :s ORDER BY seq"
            ),
            {"s": ids["day_session"]},
        ).all()

    journal_marks = [
        Mark(
            id=i,
            seq=q,
            kind=k,
            at=pd.Timestamp(at),
            price=None if p is None else float(p),
            shares=n,
            stop_price=None if st is None else float(st),
            trade_no=tn,
            source=src,
        )
        for i, q, k, at, p, n, st, tn, src in marks
    ]
    closed, open_ = journal_mod.assemble(journal_marks)
    assert open_ is not None and len(closed) == len(rows) == 2  # the open long is not booked
    for trade, row in zip(closed, rows, strict=True):
        assert float(row["pnl_usd"]) == journal_mod._pnl(trade)
        assert (row["side"], row["shares"], row["symbol"], row["day"]) == (trade.side, trade.shares, "TSLA", DAY)
        expected_r = trade.r_of(trade.exit_price)
        assert (row["r"] is None) == (expected_r is None)
        if expected_r is not None:
            assert float(row["r"]) == round(expected_r, 2)
    assert row["session_id"] == ids["day_session"] and rows[0]["thread_id"] == thread["id"]


def test_downgrade_then_upgrade_recreates_the_default_thread(at_0006) -> None:
    engine, config = at_0006
    with engine.begin() as conn:
        _seed(conn)
    command.upgrade(config, "0007")
    command.downgrade(config, "0006")
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM practice_plans")).scalar_one() == 1  # old rows untouched
    command.upgrade(config, "0007")
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM practice_threads")).scalar_one() == 1
        assert conn.execute(text("SELECT COUNT(*) FROM practice_ledger")).scalar_one() == 2
