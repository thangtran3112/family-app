"""technical desktop MVP: screener filters, universe, metrics, feed health, alert and strategy columns

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-24

Additive (02m §b2): no table is rewritten. Column adds carry server defaults, so existing rows and
code that does not know the new columns keep working. `downgrade()` reverses every step.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # -- strategies: lane, origin, archived_at ---------------------------------------------------
    op.add_column("strategies", sa.Column("lane", sa.String(), nullable=False, server_default=sa.text("'technical'")))
    op.add_column("strategies", sa.Column("origin", sa.String(), nullable=False, server_default=sa.text("'user'")))
    op.add_column("strategies", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))

    # -- watchlists: unique (user_id, name). Existing duplicates are renamed first ("Name (2)", ...). --
    op.execute(
        """
        UPDATE watchlists AS w
        SET name = w.name || ' (' || d.rn || ')'
        FROM (
            SELECT id, row_number() OVER (PARTITION BY user_id, name ORDER BY id) AS rn
            FROM watchlists
        ) AS d
        WHERE w.id = d.id AND d.rn > 1
        """
    )
    op.create_unique_constraint("uq_watchlists_user_id_name", "watchlists", ["user_id", "name"])

    # -- watchlist_items.position, backfilled by symbol order within each list ----------------------
    op.add_column("watchlist_items", sa.Column("position", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.execute(
        """
        UPDATE watchlist_items AS i
        SET position = o.pos
        FROM (
            SELECT watchlist_id, symbol,
                   row_number() OVER (PARTITION BY watchlist_id ORDER BY symbol) - 1 AS pos
            FROM watchlist_items
        ) AS o
        WHERE i.watchlist_id = o.watchlist_id AND i.symbol = o.symbol
        """
    )

    # -- filter strategies ------------------------------------------------------------------------
    op.create_table(
        "filter_strategies",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("seed_key", sa.String(), nullable=True),
        # No FK, like strategies.current_version_id: the versions table FKs back to this one.
        sa.Column("current_version_id", sa.Integer(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_user_id"], ["users.id"], name="fk_filter_strategies_owner_user_id_users", ondelete="CASCADE"
        ),
    )
    op.create_index(
        "uq_filter_strategies_owner_user_id_name_live",
        "filter_strategies",
        ["owner_user_id", "name"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL"),
    )

    op.create_table(
        "filter_strategy_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("filter_strategy_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("spec", postgresql.JSONB(), nullable=False),
        sa.Column("change_note", sa.String(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["filter_strategy_id"],
            ["filter_strategies.id"],
            name="fk_filter_versions_filter_strategy_id_filter_strategies",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], name="fk_filter_versions_created_by_users"),
        sa.UniqueConstraint("filter_strategy_id", "version", name="uq_filter_versions_filter_strategy_id_version"),
    )

    op.create_table(
        "filter_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("filter_strategy_version_id", sa.Integer(), nullable=False),
        sa.Column("run_on", sa.String(), nullable=False),
        sa.Column("session", sa.String(), nullable=False),
        sa.Column("evaluation_point", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scanned", sa.Integer(), nullable=False),
        sa.Column("no_data", sa.Integer(), nullable=False),
        sa.Column("matches_total", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("quality", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["filter_strategy_version_id"],
            ["filter_strategy_versions.id"],
            name="fk_filter_runs_version_id_filter_strategy_versions",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint(
            "filter_strategy_version_id",
            "run_on",
            "session",
            "evaluation_point",
            name="uq_filter_runs_version_run_on_session_evaluation_point",
        ),
    )

    op.create_table(
        "filter_matches",
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column("rank_value", sa.Float(), nullable=False),
        sa.Column("matched_since", sa.DateTime(timezone=True), nullable=False),
        sa.Column("operands", postgresql.JSONB(), nullable=False),
        sa.Column("columns", postgresql.JSONB(), nullable=False),
        sa.PrimaryKeyConstraint("run_id", "symbol"),
        sa.ForeignKeyConstraint(
            ["run_id"], ["filter_runs.id"], name="fk_filter_matches_run_id_filter_runs", ondelete="CASCADE"
        ),
    )
    op.create_index("ix_filter_matches_run_id_rank", "filter_matches", ["run_id", "rank"])

    # -- universe, metrics, feed health -------------------------------------------------------------
    op.create_table(
        "universe_symbols",
        sa.Column("symbol", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("asset_type", sa.String(), nullable=False),
        sa.Column("exchange", sa.String(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("passed_floor", sa.Boolean(), nullable=False),
        sa.Column("floor_reason", postgresql.JSONB(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "symbol_metrics",
        sa.Column("symbol", sa.String(), primary_key=True),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("quality", sa.String(), nullable=False),
        sa.Column("metrics", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_symbol_metrics_as_of", "symbol_metrics", ["as_of"])

    op.create_table(
        "feed_health",
        sa.Column("feed", sa.String(), primary_key=True),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("last_ok_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("detail", sa.String(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # -- alerts: symbol and strategy_id, so the inbox and the log skip a three-hop join -------------
    op.add_column("alerts", sa.Column("symbol", sa.String(), nullable=True))
    op.add_column("alerts", sa.Column("strategy_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_alerts_strategy_id_strategies", "alerts", "strategies", ["strategy_id"], ["id"])
    op.create_index("ix_alerts_symbol", "alerts", ["symbol"])
    op.create_index("ix_alerts_strategy_id", "alerts", ["strategy_id"])


def downgrade() -> None:
    op.drop_index("ix_alerts_strategy_id", table_name="alerts")
    op.drop_index("ix_alerts_symbol", table_name="alerts")
    op.drop_constraint("fk_alerts_strategy_id_strategies", "alerts", type_="foreignkey")
    op.drop_column("alerts", "strategy_id")
    op.drop_column("alerts", "symbol")

    op.drop_table("feed_health")
    op.drop_index("ix_symbol_metrics_as_of", table_name="symbol_metrics")
    op.drop_table("symbol_metrics")
    op.drop_table("universe_symbols")

    op.drop_index("ix_filter_matches_run_id_rank", table_name="filter_matches")
    op.drop_table("filter_matches")
    op.drop_table("filter_runs")
    op.drop_table("filter_strategy_versions")
    op.drop_index("uq_filter_strategies_owner_user_id_name_live", table_name="filter_strategies")
    op.drop_table("filter_strategies")

    # The numeric suffixes added to duplicate watchlist names are not undone: the original
    # duplicates cannot be told apart from names a user chose, and the old schema allows both.
    op.drop_column("watchlist_items", "position")
    op.drop_constraint("uq_watchlists_user_id_name", "watchlists", type_="unique")

    op.drop_column("strategies", "archived_at")
    op.drop_column("strategies", "origin")
    op.drop_column("strategies", "lane")
