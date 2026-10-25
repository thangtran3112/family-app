"""replay switch and re-scan: replay_sessions.away, replay_day_scans

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-25

Additive (02o-b2): one new column on `replay_sessions` and one new table; no existing row changes.

`replay_sessions.away` lists the spans of the day in which she was not on that name (`[from, to]` ISO pairs): the
catch-up after a switch, and the morning before she first joined it. A signal that fired strictly inside a span was
never in front of her, and the journal does not score it. Existing rows get `[]`, which is what they were (one name a
day, started at the window start).

`replay_day_scans` holds a re-scan of the day's filters at the day clock. The frozen list in `replay_day_lists` is never
touched by a re-scan; each scan is its own row. `downgrade()` reverses both.
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
    op.add_column(
        "replay_sessions",
        sa.Column("away", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
    )
    op.create_table(
        "replay_day_scans",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("day_list_id", sa.Integer(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("data_through", sa.DateTime(timezone=True), nullable=False),
        sa.Column("universe", postgresql.JSONB(), nullable=False),
        sa.Column("columns", postgresql.JSONB(), nullable=False),
        sa.Column("candidates", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["day_list_id"],
            ["replay_day_lists.id"],
            name="fk_replay_day_scans_day_list_id_replay_day_lists",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("day_list_id", "seq", name="uq_replay_day_scans_day_list_id_seq"),
    )


def downgrade() -> None:
    op.drop_table("replay_day_scans")
    op.drop_column("replay_sessions", "away")
