"""users, watchlists, watchlist_items, strategies, strategy_versions, signals, alerts, deliveries

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=True),
        sa.Column("telegram_chat_id", sa.String(), nullable=True),
        sa.Column("settings", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )

    op.create_table(
        "watchlists",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("horizon", sa.String(), nullable=False),
        # CASCADE (integration fix, PROTO-BRIEF.md ruling): deleting a user deletes their watchlists.
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_watchlists_user_id_users", ondelete="CASCADE"),
    )

    op.create_table(
        "watchlist_items",
        sa.Column("watchlist_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("asset_type", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("watchlist_id", "symbol"),
        # CASCADE (integration fix): deleting a watchlist deletes its items.
        sa.ForeignKeyConstraint(
            ["watchlist_id"],
            ["watchlists.id"],
            name="fk_watchlist_items_watchlist_id_watchlists",
            ondelete="CASCADE",
        ),
    )

    op.create_table(
        "strategies",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("stage", sa.String(), nullable=False, server_default=sa.text("'draft'")),
        # No FK: strategy_versions.strategy_id FKs back to this table, so a FK here would be
        # circular. Application code enforces the reference (db/models.py's own note).
        sa.Column("current_version_id", sa.Integer(), nullable=True),
        sa.Column("paused_reason", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], name="fk_strategies_owner_user_id_users"),
    )
    op.create_index("ix_strategies_current_version_id", "strategies", ["current_version_id"])

    op.create_table(
        "strategy_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("strategy_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("spec", postgresql.JSONB(), nullable=False),
        sa.Column("change_note", sa.String(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        # RESTRICT (integration fix): a strategy with any version can't be deleted out from under it.
        sa.ForeignKeyConstraint(
            ["strategy_id"],
            ["strategies.id"],
            name="fk_strategy_versions_strategy_id_strategies",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], name="fk_strategy_versions_created_by_users"),
        sa.UniqueConstraint("strategy_id", "version", name="uq_strategy_versions_strategy_id_version"),
    )

    op.create_table(
        "signals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("strategy_version_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("bar_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("evidence", postgresql.JSONB(), nullable=False),
        sa.Column("data_quality", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        # RESTRICT (integration fix): a strategy version with any recorded signal can't be deleted.
        sa.ForeignKeyConstraint(
            ["strategy_version_id"],
            ["strategy_versions.id"],
            name="fk_signals_strategy_version_id_strategy_versions",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint(
            "strategy_version_id", "symbol", "bar_time", name="uq_signals_strategy_version_id_symbol_bar_time"
        ),
    )

    op.create_table(
        "alerts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("signal_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("severity", sa.String(), nullable=False),
        sa.Column("dedupe_key", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("body", sa.String(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_alerts_user_id_users"),
        sa.ForeignKeyConstraint(["signal_id"], ["signals.id"], name="fk_alerts_signal_id_signals"),
    )
    op.create_index("ix_alerts_dedupe_key", "alerts", ["dedupe_key"])

    op.create_table(
        "deliveries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("alert_id", sa.Integer(), nullable=False),
        sa.Column("channel", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.String(), nullable=True),
        # CASCADE (integration fix): deleting an alert deletes its per-channel delivery rows.
        sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"], name="fk_deliveries_alert_id_alerts", ondelete="CASCADE"),
    )


def downgrade() -> None:
    op.drop_table("deliveries")
    op.drop_index("ix_alerts_dedupe_key", table_name="alerts")
    op.drop_table("alerts")
    op.drop_table("signals")
    op.drop_table("strategy_versions")
    op.drop_index("ix_strategies_current_version_id", table_name="strategies")
    op.drop_table("strategies")
    op.drop_table("watchlist_items")
    op.drop_table("watchlists")
    op.drop_table("users")
