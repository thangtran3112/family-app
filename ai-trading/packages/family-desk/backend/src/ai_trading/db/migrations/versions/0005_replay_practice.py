"""replay practice: replay_sessions, practice_marks, replay_notable_days, replay_blobs

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-24

Additive (02o c3): no existing table is changed. `downgrade()` drops every table this revision
creates, children before parents.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # -- replay_sessions: one row per (symbol, day, attempt); at most one active session per day ----
    op.create_table(
        "replay_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("spec", postgresql.JSONB(), nullable=False),
        sa.Column("armed", postgresql.JSONB(), nullable=False),
        # The would-fire list. The API never serves it past `revealed_through`.
        sa.Column("signals", postgresql.JSONB(), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revealed_through", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tape_feed", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("journal", postgresql.JSONB(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("rating", sa.SmallInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('active', 'ended')", name="ck_replay_sessions_status"),
        sa.CheckConstraint("rating IS NULL OR rating BETWEEN 1 AND 5", name="ck_replay_sessions_rating"),
        # CASCADE (02o c3): deleting a user deletes their replay sessions and, through them, marks.
        sa.ForeignKeyConstraint(
            ["owner_user_id"],
            ["users.id"],
            name="fk_replay_sessions_owner_user_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "owner_user_id", "symbol", "day", "attempt", name="uq_replay_sessions_owner_user_id_symbol_day_attempt"
        ),
    )
    op.create_index(
        "ix_replay_sessions_owner_user_id_updated_at",
        "replay_sessions",
        ["owner_user_id", sa.text("updated_at DESC")],
    )
    op.create_index(
        "uq_replay_sessions_owner_user_id_symbol_day_active",
        "replay_sessions",
        ["owner_user_id", "symbol", "day"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )

    # -- practice_marks: her marks and the auto-recorded ones, ordered by seq within a session -----
    op.create_table(
        "practice_marks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        # A note carries no price, so price is nullable.
        sa.Column("price", sa.Numeric(18, 6), nullable=True),
        sa.Column("shares", sa.Integer(), nullable=True),
        sa.Column("stop_price", sa.Numeric(18, 6), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("trade_no", sa.Integer(), nullable=True),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "kind IN ('long_entry', 'short_entry', 'long_exit', 'short_exit', 'stop', 'note')",
            name="ck_practice_marks_kind",
        ),
        sa.CheckConstraint("source IN ('her', 'auto')", name="ck_practice_marks_source"),
        # CASCADE (02o c3): deleting a session deletes its marks.
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["replay_sessions.id"],
            name="fk_practice_marks_session_id_replay_sessions",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("session_id", "seq", name="uq_practice_marks_session_id_seq"),
    )

    # -- replay_notable_days: the per-symbol-day scan results the replay picker reads ----------------
    op.create_table(
        "replay_notable_days",
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("rv", sa.Float(), nullable=False),
        sa.Column("rv_pct_rank", sa.Float(), nullable=False),
        sa.Column("gap_pct", sa.Float(), nullable=True),
        sa.Column("rvol", sa.Float(), nullable=True),
        sa.Column("tags", postgresql.JSONB(), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "day"),
    )

    # -- replay_blobs: compressed history cache (bars1m, bars1d, tape). `part` is '' except for tape
    # chunks, where it is the 30-minute chunk start as ET 'HHMM'. -------------------------------------
    op.create_table(
        "replay_blobs",
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("part", sa.String(), nullable=False, server_default=sa.text("''")),
        sa.Column("feed", sa.String(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("row_count", sa.Integer(), nullable=False),
        sa.Column("raw_bytes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("kind", "symbol", "day", "part", "feed"),
    )


def downgrade() -> None:
    op.drop_table("replay_blobs")
    op.drop_table("replay_notable_days")
    op.drop_table("practice_marks")

    op.drop_index("uq_replay_sessions_owner_user_id_symbol_day_active", table_name="replay_sessions")
    op.drop_index("ix_replay_sessions_owner_user_id_updated_at", table_name="replay_sessions")
    op.drop_table("replay_sessions")
