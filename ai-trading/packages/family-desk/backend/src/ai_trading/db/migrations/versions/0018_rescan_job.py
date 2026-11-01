"""re-scan progress: replay_day_lists.rescan_job

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-01

Additive: one nullable JSONB column, nothing backfilled, no row changes meaning.

A re-scan at the day clock now runs in the background (like a plan's data prep) and repopulates the day list when it
finishes, so the day list row carries the job the screen polls: `state` (running, done, failed), the day clock `as_of`
it runs at, symbols read (`done` of `total`), a `run` token and the times it started and last reported.
`replay_day_scans` is unchanged: each finished scan is still a row, labelled with its clock, the history behind the
list.

`downgrade()` drops the column. A scan in flight is lost; the list rows and scan rows stay valid.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("replay_day_lists", sa.Column("rescan_job", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("replay_day_lists", "rescan_job")
