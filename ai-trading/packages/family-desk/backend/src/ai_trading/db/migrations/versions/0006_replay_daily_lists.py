"""replay daily lists: practice_plans, replay_day_lists, replay_sessions.day_list_id, universe_days

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-24

Additive (02o-b v1): one new column on `replay_sessions` and three new tables; no existing row changes. `downgrade()`
reverses it, children before parents.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # -- practice_plans: the saved daily-list setup and its cursor (one active plan per user) --------
    op.create_table(
        "practice_plans",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("spec", postgresql.JSONB(), nullable=False),  # PracticeBlockV1: filters, listAt, maxList, setup
        sa.Column("first_day", sa.Date(), nullable=False),
        # {source, symbols, frozen_at}: the Desk set at creation, so every day of the plan scans the same base.
        sa.Column("universe", postgresql.JSONB(), nullable=False),
        # {state: queued|running|done|failed, done, total, failed: {symbol: error class}, updated_at}.
        sa.Column("prep", postgresql.JSONB(), nullable=False),
        sa.Column("day_cursor", sa.Date(), nullable=True),  # the newest day whose list was opened
        sa.Column("days_opened", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('active', 'archived')", name="ck_practice_plans_status"),
        sa.ForeignKeyConstraint(
            ["owner_user_id"], ["users.id"], name="fk_practice_plans_owner_user_id_users", ondelete="CASCADE"
        ),
    )
    op.create_index(
        "uq_practice_plans_owner_user_id_active",
        "practice_plans",
        ["owner_user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )

    # -- replay_day_lists: the frozen candidate list of one practice day, its stars, day clock, review ---
    op.create_table(
        "replay_day_lists",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("plan_id", sa.Integer(), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("day_no", sa.Integer(), nullable=False),
        sa.Column("screen", postgresql.JSONB(), nullable=False),  # filters with version_id and name, listAt, maxList
        sa.Column("list_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("data_through", sa.DateTime(timezone=True), nullable=False),
        sa.Column("universe", postgresql.JSONB(), nullable=False),  # the universe line: source, counts, labels
        sa.Column("columns", postgresql.JSONB(), nullable=False),
        sa.Column("candidates", postgresql.JSONB(), nullable=False),
        sa.Column("watch", postgresql.JSONB(), nullable=False),  # [{symbol, starred_clock}]
        sa.Column("revealed_through", sa.DateTime(timezone=True), nullable=True),  # the day clock
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("journal", postgresql.JSONB(), nullable=True),
        sa.Column("review", postgresql.JSONB(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("rating", sa.SmallInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('listed', 'practicing', 'ended')", name="ck_replay_day_lists_status"),
        sa.CheckConstraint("rating IS NULL OR rating BETWEEN 1 AND 5", name="ck_replay_day_lists_rating"),
        sa.ForeignKeyConstraint(
            ["plan_id"], ["practice_plans.id"], name="fk_replay_day_lists_plan_id_practice_plans", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["owner_user_id"], ["users.id"], name="fk_replay_day_lists_owner_user_id_users", ondelete="CASCADE"
        ),
        sa.UniqueConstraint("plan_id", "day", name="uq_replay_day_lists_plan_id_day"),
    )
    op.create_index("ix_replay_day_lists_owner_user_id_day", "replay_day_lists", ["owner_user_id", "day"])

    # -- replay_sessions.day_list_id: null for a standalone session --------------------------------------
    op.add_column("replay_sessions", sa.Column("day_list_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_replay_sessions_day_list_id_replay_day_lists",
        "replay_sessions",
        "replay_day_lists",
        ["day_list_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_replay_sessions_day_list_id", "replay_sessions", ["day_list_id"])

    # -- universe_days: the symbols the live premarket pass scanned that morning (write-only in v1) ----
    op.create_table(
        "universe_days",
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("symbols", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("universe_days")
    op.drop_index("ix_replay_sessions_day_list_id", table_name="replay_sessions")
    op.drop_constraint("fk_replay_sessions_day_list_id_replay_day_lists", "replay_sessions", type_="foreignkey")
    op.drop_column("replay_sessions", "day_list_id")
    op.drop_index("ix_replay_day_lists_owner_user_id_day", table_name="replay_day_lists")
    op.drop_table("replay_day_lists")
    op.drop_index("uq_practice_plans_owner_user_id_active", table_name="practice_plans")
    op.drop_table("practice_plans")
