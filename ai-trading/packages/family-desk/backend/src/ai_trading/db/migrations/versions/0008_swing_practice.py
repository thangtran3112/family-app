"""swing practice: practice_holds, practice_weeks, practice_ledger.hold_id, one active plan per thread

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-25

Additive (02p f4, rulings R3, R5, R9): two new tables, one new nullable column on `practice_ledger`, and two relaxed
constraints; no existing column drops and no data step. A swing hold that auto-exits at a close has no session and no
mark, so the ledger's `session_id` and `mark_id` become nullable, with a CHECK that a row still names its hold or both
of its ids (a day-trade row keeps both). `practice_plans` swaps its per-owner "one active plan" index for a per-thread
one, so a day thread and a swing thread can each hold an active plan at the same time.

`downgrade()` reverses the schema, children before parents, and must succeed on a database that holds swing data:
it archives the active plan of every swing thread (otherwise the per-owner unique index could not come back) and deletes
the ledger rows that carry a `hold_id` (their NOT NULL columns return). The swing threads, their sessions, day lists,
and marks stay: the 0007 schema accepts them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # -- practice_holds: a multi-day practice hold, open until she (or a close) exits it ------------------
    op.create_table(
        "practice_holds",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("thread_id", sa.Integer(), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("side", sa.String(), nullable=False),
        sa.Column("shares", sa.Integer(), nullable=False),
        sa.Column("entry_day", sa.Date(), nullable=False),
        sa.Column("entry_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("entry_price", sa.Numeric(18, 6), nullable=False),
        # The entry session and mark go null when the session is deleted: the hold outlives the day it began on.
        sa.Column("entry_session_id", sa.Integer(), nullable=True),
        sa.Column("entry_mark_id", sa.Integer(), nullable=True),
        sa.Column("stop_at_entry", sa.Numeric(18, 6), nullable=True),
        sa.Column("stop_price", sa.Numeric(18, 6), nullable=True),
        sa.Column("stop_hit_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("exit_day", sa.Date(), nullable=True),
        sa.Column("exit_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("exit_price", sa.Numeric(18, 6), nullable=True),
        sa.Column("exit_session_id", sa.Integer(), nullable=True),
        sa.Column("exit_mark_id", sa.Integer(), nullable=True),
        sa.Column("exit_source", sa.String(), nullable=True),
        sa.Column("last_close", sa.Numeric(18, 6), nullable=True),
        sa.Column("last_close_day", sa.Date(), nullable=True),
        sa.Column("splits", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("side IN ('long', 'short')", name="ck_practice_holds_side"),
        sa.CheckConstraint("status IN ('open', 'closed')", name="ck_practice_holds_status"),
        sa.CheckConstraint(
            "exit_source IS NULL OR exit_source IN ('her', 'auto')", name="ck_practice_holds_exit_source"
        ),
        sa.CheckConstraint("shares >= 1", name="ck_practice_holds_shares"),
        sa.CheckConstraint(
            "(status = 'closed') = (exit_day IS NOT NULL AND exit_price IS NOT NULL AND exit_source IS NOT NULL)",
            name="ck_practice_holds_closed_fields",
        ),
        sa.ForeignKeyConstraint(
            ["thread_id"],
            ["practice_threads.id"],
            name="fk_practice_holds_thread_id_practice_threads",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["owner_user_id"], ["users.id"], name="fk_practice_holds_owner_user_id_users", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["entry_session_id"],
            ["replay_sessions.id"],
            name="fk_practice_holds_entry_session_id_replay_sessions",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["entry_mark_id"],
            ["practice_marks.id"],
            name="fk_practice_holds_entry_mark_id_practice_marks",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["exit_session_id"],
            ["replay_sessions.id"],
            name="fk_practice_holds_exit_session_id_replay_sessions",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["exit_mark_id"],
            ["practice_marks.id"],
            name="fk_practice_holds_exit_mark_id_practice_marks",
            ondelete="SET NULL",
        ),
    )
    # One open hold per symbol in a thread; a closed hold of the same symbol, or an open one in another thread, is fine.
    op.create_index(
        "uq_practice_holds_thread_id_symbol_open",
        "practice_holds",
        ["thread_id", "symbol"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
    )
    op.create_index("ix_practice_holds_thread_id_status", "practice_holds", ["thread_id", "status"])

    # -- practice_weeks: one row per trading week of a swing thread, with its review and her notes ----------
    op.create_table(
        "practice_weeks",
        sa.Column("thread_id", sa.Integer(), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("week_no", sa.Integer(), nullable=False),
        sa.Column("first_day", sa.Date(), nullable=False),
        sa.Column("last_day", sa.Date(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("review", postgresql.JSONB(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("rating", sa.SmallInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("thread_id", "week_no"),
        sa.CheckConstraint("status IN ('open', 'closed')", name="ck_practice_weeks_status"),
        sa.CheckConstraint("rating IS NULL OR rating BETWEEN 1 AND 5", name="ck_practice_weeks_rating"),
        sa.CheckConstraint("(status = 'closed') = (closed_at IS NOT NULL)", name="ck_practice_weeks_closed_at"),
        sa.ForeignKeyConstraint(
            ["thread_id"],
            ["practice_threads.id"],
            name="fk_practice_weeks_thread_id_practice_threads",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["owner_user_id"], ["users.id"], name="fk_practice_weeks_owner_user_id_users", ondelete="CASCADE"
        ),
    )

    # -- practice_ledger: a swing row names its hold, and may have no session or mark (an auto exit at a close) --
    op.add_column("practice_ledger", sa.Column("hold_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_practice_ledger_hold_id_practice_holds",
        "practice_ledger",
        "practice_holds",
        ["hold_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_practice_ledger_hold_id", "practice_ledger", ["hold_id"])
    op.create_index(
        "uq_practice_ledger_hold_id",
        "practice_ledger",
        ["hold_id"],
        unique=True,
        postgresql_where=sa.text("hold_id IS NOT NULL"),
    )
    op.alter_column("practice_ledger", "session_id", existing_type=sa.Integer(), nullable=True)
    op.alter_column("practice_ledger", "mark_id", existing_type=sa.Integer(), nullable=True)
    op.create_check_constraint(
        "ck_practice_ledger_source",
        "practice_ledger",
        "hold_id IS NOT NULL OR (session_id IS NOT NULL AND mark_id IS NOT NULL)",
    )

    # -- practice_plans: one active plan per thread instead of per owner (a day and a swing thread run together) --
    op.drop_index("uq_practice_plans_owner_user_id_active", table_name="practice_plans")
    op.create_index(
        "uq_practice_plans_thread_id_active",
        "practice_plans",
        ["thread_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    # A swing thread's active plan would clash with its owner's day-thread plan under the per-owner index.
    op.execute(
        "UPDATE practice_plans SET status = 'archived', updated_at = now() WHERE status = 'active' "
        "AND thread_id IN (SELECT id FROM practice_threads WHERE mode = 'swing')"
    )
    op.drop_index("uq_practice_plans_thread_id_active", table_name="practice_plans")
    op.create_index(
        "uq_practice_plans_owner_user_id_active",
        "practice_plans",
        ["owner_user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )

    # Swing ledger rows may lack a session and a mark, so they go before the columns turn NOT NULL again.
    op.execute("DELETE FROM practice_ledger WHERE hold_id IS NOT NULL")
    op.drop_constraint("ck_practice_ledger_source", "practice_ledger", type_="check")
    op.alter_column("practice_ledger", "mark_id", existing_type=sa.Integer(), nullable=False)
    op.alter_column("practice_ledger", "session_id", existing_type=sa.Integer(), nullable=False)
    op.drop_index("uq_practice_ledger_hold_id", table_name="practice_ledger")
    op.drop_index("ix_practice_ledger_hold_id", table_name="practice_ledger")
    op.drop_constraint("fk_practice_ledger_hold_id_practice_holds", "practice_ledger", type_="foreignkey")
    op.drop_column("practice_ledger", "hold_id")

    op.drop_table("practice_weeks")
    op.drop_index("ix_practice_holds_thread_id_status", table_name="practice_holds")
    op.drop_index("uq_practice_holds_thread_id_symbol_open", table_name="practice_holds")
    op.drop_table("practice_holds")
