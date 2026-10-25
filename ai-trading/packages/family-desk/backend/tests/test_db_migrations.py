"""Alembic head against an empty database, and that it agrees with the models (no autogenerate
drift) -- a migration and a model quietly diverging is a real failure mode once more revisions
exist, so a single run of alembic's own `compare_metadata` catches it before that happens.
"""

from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from ai_trading.db.models import Base

PHASE_2A_TABLES = {"bars_1d", "bars_1h", "bars_1m", "futures_rolls"}
PHASE_3_TABLES = {
    "users",
    "watchlists",
    "watchlist_items",
    "strategies",
    "strategy_versions",
    "signals",
    "alerts",
    "deliveries",
}
# Alembic 0003 (technical desktop MVP, 02m §b2).
NEW_0003_TABLES = {
    "filter_strategies",
    "filter_strategy_versions",
    "filter_runs",
    "filter_matches",
    "universe_symbols",
    "symbol_metrics",
    "feed_health",
}
NEW_0003_COLUMNS = {
    "strategies": {"lane", "origin", "archived_at"},
    "watchlist_items": {"position"},
    "alerts": {"symbol", "strategy_id"},
}
# Alembic 0004 (replay practice, 02o c3).
NEW_0004_TABLES = {
    "replay_sessions",
    "practice_marks",
    "replay_notable_days",
    "replay_blobs",
}

_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


def _alembic_config(url: str) -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def test_migration_chain_has_a_single_head_at_0004() -> None:
    # No database needed: the script directory alone shows the chain. A second head (e.g. a
    # renumbering clash between two lanes) fails here before any upgrade runs.
    script = ScriptDirectory.from_config(_alembic_config("postgresql+psycopg://localhost/placeholder"))
    assert script.get_heads() == ["0004"]
    assert script.get_revision("0004").down_revision == "0003"


def test_head_matches_models(db_engine: Engine) -> None:
    assert (NEW_0003_TABLES | NEW_0004_TABLES) <= set(Base.metadata.tables)
    with db_engine.connect() as conn:
        context = MigrationContext.configure(conn)
        diff = compare_metadata(context, Base.metadata)
    assert diff == []


def test_tables_exist(db_engine: Engine) -> None:
    tables = set(inspect(db_engine).get_table_names())
    assert (PHASE_2A_TABLES | PHASE_3_TABLES | NEW_0003_TABLES | NEW_0004_TABLES) <= tables


def test_downgrade_minus_one_reverts_only_0004(db_engine: Engine) -> None:
    url = db_engine.url.render_as_string(hide_password=False)
    try:
        command.downgrade(_alembic_config(url), "-1")
        with db_engine.connect() as conn:
            inspector = inspect(db_engine)
            tables = set(inspector.get_table_names())
            assert tables.isdisjoint(NEW_0004_TABLES)
            assert (PHASE_2A_TABLES | PHASE_3_TABLES | NEW_0003_TABLES) <= tables
            for table, columns in NEW_0003_COLUMNS.items():
                names = {column["name"] for column in inspector.get_columns(table)}
                assert columns <= names, table
            unique_names = {constraint["name"] for constraint in inspector.get_unique_constraints("watchlists")}
            assert "uq_watchlists_user_id_name" in unique_names
            # Confirm the server is still the same database, not a reconnect artifact.
            conn.execute(text("SELECT 1"))
        # Re-upgrading brings the 0004 tables back, so the downgrade is reversible.
        command.upgrade(_alembic_config(url), "head")
        assert NEW_0004_TABLES <= set(inspect(db_engine).get_table_names())
    finally:
        # Every other test in this module/package expects `db_engine` at head.
        command.upgrade(_alembic_config(url), "head")


def test_downgrade_to_0001_drops_phase_3_tables_and_keeps_phase_2a(db_engine: Engine) -> None:
    url = db_engine.url.render_as_string(hide_password=False)
    try:
        command.downgrade(_alembic_config(url), "0001")
        with db_engine.connect() as conn:
            tables = set(inspect(db_engine).get_table_names())
            assert tables.isdisjoint(PHASE_3_TABLES | NEW_0003_TABLES | NEW_0004_TABLES)
            assert PHASE_2A_TABLES <= tables
            # Confirm the server is still the same database, not a reconnect artifact.
            conn.execute(text("SELECT 1"))
    finally:
        # Every other test in this module/package expects `db_engine` at head.
        command.upgrade(_alembic_config(url), "head")
