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


def test_desk_migrator_migration_leaves_all_tables_reachable_by_desk_runtime(
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
        "filter_strategies",
        "filter_strategy_versions",
        "filter_runs",
        "filter_matches",
        "universe_symbols",
        "symbol_metrics",
        "feed_health",
        "consensus_snapshots",
        "earnings_results",
        "analyst_targets",
        "replay_sessions",
        "practice_marks",
        "replay_notable_days",
        "replay_blobs",
        "practice_plans",
        "replay_day_lists",
        "universe_days",
        "practice_threads",
        "practice_ledger",
        "practice_holds",
        "practice_weeks",
        "replay_day_scans",
        "feedback_reports",
        "feedback_events",
        "feedback_attachments",
        "accounts",
        "holding_imports",
        "holding_lots",
        "holding_trades",
        "covered_call_scans",
        "iv_history",
        "symbol_fundamentals",
        "ai_verdicts",
        "ai_calls",
    }


def test_desk_runtime_can_use_the_fundamental_lane_tables(role_split_urls: RoleSplitUrls) -> None:
    # 0012's tables (and their id sequences) are reachable through the zz-20 script's default privileges, with no grant
    # change: an import, its lots and trades, a scan, an IV point, a fundamentals row and a verdict with its call, all
    # as the runtime role, then the account's delete cascading through the lot.
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.begin() as conn:
            user_id = conn.execute(
                text("INSERT INTO users (email) VALUES (:email) RETURNING id"),
                {"email": "fundamental-roles@example.test"},
            ).scalar_one()
            account_id = conn.execute(
                text(
                    "INSERT INTO accounts (owner_user_id, external_id, label, created_at) "
                    "VALUES (:u, 'ROLES-ACCOUNT', 'Account 1', now()) RETURNING id"
                ),
                {"u": user_id},
            ).scalar_one()
            import_id = conn.execute(
                text(
                    "INSERT INTO holding_imports (account_id, statement_date, imported_at) "
                    "VALUES (:a, '2026-10-28', now()) RETURNING id"
                ),
                {"a": account_id},
            ).scalar_one()
            conn.execute(
                text(
                    "INSERT INTO holding_lots (import_id, account_id, symbol, asset_class, quantity) "
                    "VALUES (:i, :a, 'ROLES', 'STK', 100)"
                ),
                {"i": import_id, "a": account_id},
            )
            conn.execute(
                text(
                    "INSERT INTO holding_trades (account_id, external_ref, symbol, option_right, strike, expiry, kind, "
                    "trade_date, quantity, price) VALUES (:a, 'T-1', 'ROLES', 'C', 10, '2026-11-20', 'sell_to_open', "
                    "'2026-10-28', -1, 0.5)"
                ),
                {"a": account_id},
            )
            conn.execute(
                text(
                    "INSERT INTO covered_call_scans (account_id, symbol, run_at, stamp) "
                    "VALUES (:a, 'ROLES', now(), '{}'::jsonb)"
                ),
                {"a": account_id},
            )
            conn.execute(
                text(
                    "INSERT INTO iv_history (symbol, day, iv30, source, quality) "
                    "VALUES ('ROLES', '2026-10-28', 0.3, 'fake', 'eod')"
                )
            )
            conn.execute(text("INSERT INTO symbol_fundamentals (symbol, as_of) VALUES ('ROLES', now())"))
            conn.execute(
                text(
                    "INSERT INTO ai_verdicts (symbol, trading_day, rating, target_low, target_base, target_high, "
                    "confidence, model, content_hash, created_at) "
                    "VALUES ('ROLES', '2026-10-28', 'buy', 1, 2, 3, 50, 'fake', '0', now())"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO ai_calls (symbol, trading_day, rating, created_at) "
                    "VALUES ('ROLES', '2026-10-28', 'buy', now())"
                )
            )
            conn.execute(text("UPDATE holding_imports SET lots = 1 WHERE id = :i"), {"i": import_id})
            conn.execute(text("DELETE FROM accounts WHERE id = :a"), {"a": account_id})
            conn.execute(text("DELETE FROM ai_verdicts WHERE symbol = 'ROLES'"))
            conn.execute(text("DELETE FROM iv_history WHERE symbol = 'ROLES'"))
            conn.execute(text("DELETE FROM symbol_fundamentals WHERE symbol = 'ROLES'"))
            remaining = conn.execute(
                text(
                    "SELECT (SELECT COUNT(*) FROM holding_lots) + (SELECT COUNT(*) FROM holding_trades) "
                    "+ (SELECT COUNT(*) FROM covered_call_scans) + (SELECT COUNT(*) FROM ai_calls) "
                    "+ (SELECT COUNT(*) FROM iv_history WHERE symbol = 'ROLES')"
                )
            ).scalar_one()
            assert remaining == 0
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
    finally:
        runtime_engine.dispose()


def test_desk_runtime_can_use_the_feedback_tables(role_split_urls: RoleSplitUrls) -> None:
    # 0010's tables (and their id sequences) are reachable through the zz-20 script's default privileges, with no grant
    # change: filing, a status change, a screenshot and the staging sweep's DELETE, all as the runtime role.
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.begin() as conn:
            user_id = conn.execute(
                text("INSERT INTO users (email) VALUES (:email) RETURNING id"), {"email": "feedback-roles@example.test"}
            ).scalar_one()
            report_id = conn.execute(
                text(
                    "INSERT INTO feedback_reports (user_id, kind, severity, title, body, screen, route, app_version, "
                    "captured_at, status, created_at, updated_at) VALUES (:u, 'bug', 'P2', 't', 'b', 's', '/', 'dev', "
                    "now(), 'open', now(), now()) RETURNING id"
                ),
                {"u": user_id},
            ).scalar_one()
            conn.execute(
                text(
                    "INSERT INTO feedback_events (report_id, at, actor, from_status, to_status) "
                    "VALUES (:r, now(), 'user', NULL, 'open')"
                ),
                {"r": report_id},
            )
            conn.execute(
                text(
                    "INSERT INTO feedback_attachments (report_id, user_id, filename, content_type, size_bytes, sha256, "
                    "payload, created_at) VALUES (NULL, :u, 'a.png', 'image/png', 2, '0', :p, now())"
                ),
                {"u": user_id, "p": b"\x89P"},
            )
            conn.execute(
                text("UPDATE feedback_reports SET status = 'fixed', fix_ref = '1a2b3c4' WHERE id = :r"),
                {"r": report_id},
            )
            conn.execute(text("SELECT id FROM users WHERE id = :u FOR UPDATE"), {"u": user_id})  # the staging lock
            conn.execute(
                text("DELETE FROM feedback_attachments WHERE report_id IS NULL AND user_id = :u"), {"u": user_id}
            )
            conn.execute(text("DELETE FROM feedback_reports WHERE id = :r"), {"r": report_id})
            remaining = conn.execute(
                text(
                    "SELECT (SELECT COUNT(*) FROM feedback_reports WHERE id = :r) "
                    "+ (SELECT COUNT(*) FROM feedback_events WHERE report_id = :r) "
                    "+ (SELECT COUNT(*) FROM feedback_attachments WHERE user_id = :u)"
                ),
                {"r": report_id, "u": user_id},
            ).scalar_one()
            assert remaining == 0
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
    finally:
        runtime_engine.dispose()


def test_desk_runtime_can_select_insert_update_delete_replay_tables(role_split_urls: RoleSplitUrls) -> None:
    # 0005's tables get their grants from the zz-20 script's ALTER DEFAULT PRIVILEGES (migrator-created
    # tables), not from a per-table GRANT, so this test is what proves they are actually reachable.
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.begin() as conn:
            user_id = conn.execute(
                text("INSERT INTO users (email) VALUES (:email) RETURNING id"), {"email": "replay-roles@example.test"}
            ).scalar_one()
            session_id = conn.execute(
                text(
                    "INSERT INTO replay_sessions (owner_user_id, symbol, day, attempt, schema_version, spec, armed, "
                    "signals, window_start, window_end, revealed_through, tape_feed, status, created_at, updated_at) "
                    "VALUES (:u, 'ROLES', '2026-10-23', 1, 1, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now(), "
                    "now(), 'sip', 'active', now(), now()) RETURNING id"
                ),
                {"u": user_id},
            ).scalar_one()
            conn.execute(
                text(
                    "INSERT INTO practice_marks (session_id, seq, kind, at, price, source, created_at) "
                    "VALUES (:s, 1, 'long_entry', now(), 10.25, 'her', now())"
                ),
                {"s": session_id},
            )
            conn.execute(
                text("UPDATE replay_sessions SET status = 'ended', ended_at = now(), rating = 4 WHERE id = :s"),
                {"s": session_id},
            )
            status = conn.execute(
                text("SELECT status FROM replay_sessions WHERE id = :s"), {"s": session_id}
            ).scalar_one()
            assert status == "ended"
            conn.execute(
                text(
                    "INSERT INTO replay_notable_days (symbol, day, rv, rv_pct_rank, tags, computed_at) "
                    "VALUES ('ROLES', '2026-10-23', 1.5, 0.9, '[]'::jsonb, now())"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO replay_blobs (kind, symbol, day, feed, payload, row_count, raw_bytes, created_at) "
                    "VALUES ('bars1m', 'ROLES', '2026-10-23', 'sip', :payload, 0, 0, now())"
                ),
                {"payload": b"\x00\x01"},
            )
            # Deleting the user cascades through the sessions to their marks.
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
            conn.execute(text("DELETE FROM replay_notable_days WHERE symbol = 'ROLES'"))
            conn.execute(text("DELETE FROM replay_blobs WHERE symbol = 'ROLES'"))
            remaining = conn.execute(
                text(
                    "SELECT (SELECT COUNT(*) FROM practice_marks WHERE session_id = :s) "
                    "+ (SELECT COUNT(*) FROM replay_sessions WHERE id = :s) "
                    "+ (SELECT COUNT(*) FROM replay_notable_days WHERE symbol = 'ROLES') "
                    "+ (SELECT COUNT(*) FROM replay_blobs WHERE symbol = 'ROLES')"
                ),
                {"s": session_id},
            ).scalar_one()
            assert remaining == 0
    finally:
        runtime_engine.dispose()


def test_desk_runtime_can_use_the_daily_list_tables(role_split_urls: RoleSplitUrls) -> None:
    # 0006's tables, like 0005's, are reachable through the zz-20 script's default privileges.
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.begin() as conn:
            user_id = conn.execute(
                text("INSERT INTO users (email) VALUES (:email) RETURNING id"), {"email": "daily-roles@example.test"}
            ).scalar_one()
            plan_id = conn.execute(
                text(
                    "INSERT INTO practice_plans (owner_user_id, schema_version, spec, first_day, universe, prep, "
                    "status, created_at, updated_at) VALUES (:u, 1, '{}'::jsonb, '2026-03-02', '{}'::jsonb, "
                    "'{}'::jsonb, 'active', now(), now()) RETURNING id"
                ),
                {"u": user_id},
            ).scalar_one()
            list_id = conn.execute(
                text(
                    "INSERT INTO replay_day_lists (plan_id, owner_user_id, day, day_no, screen, list_at, "
                    "data_through, universe, columns, candidates, watch, status, created_at, updated_at) "
                    "VALUES (:p, :u, '2026-03-02', 1, '{}'::jsonb, now(), now(), '{}'::jsonb, '[]'::jsonb, "
                    "'[]'::jsonb, '[]'::jsonb, 'listed', now(), now()) RETURNING id"
                ),
                {"p": plan_id, "u": user_id},
            ).scalar_one()
            conn.execute(
                text("UPDATE replay_day_lists SET status = 'ended', ended_at = now(), rating = 3 WHERE id = :l"),
                {"l": list_id},
            )
            conn.execute(
                text("INSERT INTO universe_days (day, symbols, created_at) VALUES ('1999-01-04', '[]'::jsonb, now())")
            )
            conn.execute(text("DELETE FROM universe_days WHERE day = '1999-01-04'"))
            # Deleting the user cascades through the plan to its day lists.
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
            remaining = conn.execute(
                text(
                    "SELECT (SELECT COUNT(*) FROM practice_plans WHERE id = :p) "
                    "+ (SELECT COUNT(*) FROM replay_day_lists WHERE id = :l)"
                ),
                {"p": plan_id, "l": list_id},
            ).scalar_one()
            assert remaining == 0
    finally:
        runtime_engine.dispose()


def test_desk_runtime_can_use_the_swing_tables(role_split_urls: RoleSplitUrls) -> None:
    # 0008's tables, like 0005-0007's, are reachable through the zz-20 script's default privileges (tables and the
    # `practice_holds` id sequence), so this round trip is what proves it.
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.begin() as conn:
            user_id = conn.execute(
                text("INSERT INTO users (email) VALUES (:email) RETURNING id"), {"email": "swing-roles@example.test"}
            ).scalar_one()
            thread_id = conn.execute(
                text(
                    "INSERT INTO practice_threads (owner_user_id, mode, starting_balance, stop_note_on_entry, "
                    "trade_only_on_signal, status, created_at, updated_at) VALUES (:u, 'swing', 50000, 'yes', 'no', "
                    "'active', now(), now()) RETURNING id"
                ),
                {"u": user_id},
            ).scalar_one()
            hold_id = conn.execute(
                text(
                    "INSERT INTO practice_holds (thread_id, owner_user_id, symbol, side, shares, entry_day, entry_at, "
                    "entry_price, status, created_at, updated_at) VALUES (:t, :u, 'ROLES', 'long', 10, '2026-10-19', "
                    "now(), 10.25, 'open', now(), now()) RETURNING id"
                ),
                {"t": thread_id, "u": user_id},
            ).scalar_one()
            conn.execute(
                text(
                    "UPDATE practice_holds SET status = 'closed', exit_day = '2026-10-21', exit_at = now(), "
                    "exit_price = 11.5, exit_source = 'auto' WHERE id = :h"
                ),
                {"h": hold_id},
            )
            # A swing ledger row: its hold, no session, no mark.
            conn.execute(
                text(
                    "INSERT INTO practice_ledger (thread_id, hold_id, day, symbol, side, shares, entry_price, "
                    "exit_price, pnl_usd, realized_at, created_at) VALUES (:t, :h, '2026-10-21', 'ROLES', 'long', 10, "
                    "10.25, 11.5, 12.5, now(), now())"
                ),
                {"t": thread_id, "h": hold_id},
            )
            conn.execute(
                text(
                    "INSERT INTO practice_weeks (thread_id, owner_user_id, week_no, first_day, last_day, status, "
                    "created_at) VALUES (:t, :u, 1, '2026-10-19', '2026-10-23', 'open', now())"
                ),
                {"t": thread_id, "u": user_id},
            )
            conn.execute(
                text(
                    "UPDATE practice_weeks SET status = 'closed', closed_at = now(), rating = 4, "
                    "review = '{}'::jsonb WHERE thread_id = :t AND week_no = 1"
                ),
                {"t": thread_id},
            )
            rating = conn.execute(
                text("SELECT rating FROM practice_weeks WHERE thread_id = :t AND week_no = 1"), {"t": thread_id}
            ).scalar_one()
            assert rating == 4
            # Deleting the user cascades through the thread to its holds, weeks, and the hold-keyed ledger row.
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
            remaining = conn.execute(
                text(
                    "SELECT (SELECT COUNT(*) FROM practice_holds WHERE id = :h) "
                    "+ (SELECT COUNT(*) FROM practice_weeks WHERE thread_id = :t) "
                    "+ (SELECT COUNT(*) FROM practice_ledger WHERE thread_id = :t)"
                ),
                {"h": hold_id, "t": thread_id},
            ).scalar_one()
            assert remaining == 0
    finally:
        runtime_engine.dispose()


def test_desk_runtime_can_select_insert_update_delete_technical_mvp_tables(role_split_urls: RoleSplitUrls) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.begin() as conn:
            conn.execute(text("INSERT INTO feed_health (feed, state, updated_at) VALUES ('roles-test', 'ok', now())"))
            conn.execute(text("UPDATE feed_health SET state = 'degraded' WHERE feed = 'roles-test'"))
            state = conn.execute(text("SELECT state FROM feed_health WHERE feed = 'roles-test'")).scalar_one()
            assert state == "degraded"
            conn.execute(text("DELETE FROM feed_health WHERE feed = 'roles-test'"))

            conn.execute(
                text(
                    "INSERT INTO universe_symbols (symbol, name, asset_type, exchange, active, passed_floor, "
                    "floor_reason, updated_at) "
                    "VALUES ('ROLES', 'Roles Test', 'stock', 'NASDAQ', true, true, NULL, now())"
                )
            )
            conn.execute(text("UPDATE universe_symbols SET passed_floor = false WHERE symbol = 'ROLES'"))
            passed = conn.execute(text("SELECT passed_floor FROM universe_symbols WHERE symbol = 'ROLES'")).scalar_one()
            assert passed is False
            conn.execute(text("DELETE FROM universe_symbols WHERE symbol = 'ROLES'"))

            conn.execute(
                text(
                    "INSERT INTO symbol_metrics (symbol, as_of, source, quality, metrics) "
                    "VALUES ('ROLES', now(), 'bars_delayed', 'delayed-15m', '{}'::jsonb)"
                )
            )
            conn.execute(text("UPDATE symbol_metrics SET quality = 'eod' WHERE symbol = 'ROLES'"))
            quality = conn.execute(text("SELECT quality FROM symbol_metrics WHERE symbol = 'ROLES'")).scalar_one()
            assert quality == "eod"
            conn.execute(text("DELETE FROM symbol_metrics WHERE symbol = 'ROLES'"))

            # Each DELETE above left nothing behind; the begin() block commits only if every step passed.
            remaining = conn.execute(
                text(
                    "SELECT (SELECT COUNT(*) FROM feed_health WHERE feed = 'roles-test') "
                    "+ (SELECT COUNT(*) FROM universe_symbols WHERE symbol = 'ROLES') "
                    "+ (SELECT COUNT(*) FROM symbol_metrics WHERE symbol = 'ROLES')"
                )
            ).scalar_one()
            assert remaining == 0
    finally:
        runtime_engine.dispose()


def test_desk_runtime_can_write_the_consensus_history_tables(role_split_urls: RoleSplitUrls) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO analyst_targets (symbol, snapshot_date, provider, quality, as_of, captured_at) "
                    "VALUES ('ROLES', '2026-10-06', 'fake', 'eod', now(), now())"
                )
            )
            conn.execute(text("UPDATE analyst_targets SET target_mean = 1.5 WHERE symbol = 'ROLES'"))
            mean = conn.execute(text("SELECT target_mean FROM analyst_targets WHERE symbol = 'ROLES'")).scalar_one()
            assert mean == 1.5
            conn.execute(text("DELETE FROM analyst_targets WHERE symbol = 'ROLES'"))
    finally:
        runtime_engine.dispose()


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
