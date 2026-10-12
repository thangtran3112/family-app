"""Alembic head against an empty database, and that it agrees with the models (no autogenerate
drift) -- a migration and a model quietly diverging is a real failure mode once more revisions
exist, so a single run of alembic's own `compare_metadata` catches it before that happens.
"""

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy.engine import Engine

from ai_trading.db.models import Base


def test_head_matches_models(db_engine: Engine) -> None:
    with db_engine.connect() as conn:
        context = MigrationContext.configure(conn)
        diff = compare_metadata(context, Base.metadata)
    assert diff == []


def test_tables_exist(db_engine: Engine) -> None:
    from sqlalchemy import inspect

    tables = set(inspect(db_engine).get_table_names())
    assert {"bars_1d", "bars_1h", "bars_1m", "futures_rolls"} <= tables
