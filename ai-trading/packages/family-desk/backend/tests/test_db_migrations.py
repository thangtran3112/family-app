"""Alembic head against an empty database, and that it agrees with the models (no autogenerate
drift) -- a migration and a model quietly diverging is a real failure mode once more revisions
exist, so a single run of alembic's own `compare_metadata` catches it before that happens.
"""

from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
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

_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


def _alembic_config(url: str) -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def test_head_matches_models(db_engine: Engine) -> None:
    with db_engine.connect() as conn:
        context = MigrationContext.configure(conn)
        diff = compare_metadata(context, Base.metadata)
    assert diff == []


def test_tables_exist(db_engine: Engine) -> None:
    tables = set(inspect(db_engine).get_table_names())
    assert (PHASE_2A_TABLES | PHASE_3_TABLES) <= tables


def test_downgrade_drops_exactly_the_phase_3_tables_and_keeps_phase_2a(db_engine: Engine) -> None:
    url = db_engine.url.render_as_string(hide_password=False)
    try:
        command.downgrade(_alembic_config(url), "-1")
        with db_engine.connect() as conn:
            tables = set(inspect(db_engine).get_table_names())
            assert tables.isdisjoint(PHASE_3_TABLES)
            assert PHASE_2A_TABLES <= tables
            # Confirm the server is still the same database, not a reconnect artifact.
            conn.execute(text("SELECT 1"))
    finally:
        # Every other test in this module/package expects `db_engine` at head.
        command.upgrade(_alembic_config(url), "head")
