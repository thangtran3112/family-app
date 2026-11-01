"""several open practice positions in a day: replay_sessions.stop_hit_at, practice_marks.day_pnl_usd

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-01

Additive and nullable; no existing row changes and nothing is backfilled. A day holds one open trade per name, up to
five at once, so no table is needed: the open trades are the open trades of the day list's sessions.

`replay_sessions.stop_hit_at` is when play last paused on the session's open trade because its stop was crossed (one
open trade per session, so one flag). A new entry, stop note or exit clears it.

`practice_marks.day_pnl_usd` is the day's P/L (realized plus every open trade marked at the day clock) when an entry
was placed: the basis the max-loss rule scores, written on entry marks only. An old row reads null, and the journal
falls back to the realized-only rule it always used for those. `downgrade()` drops both columns.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("replay_sessions", sa.Column("stop_hit_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("practice_marks", sa.Column("day_pnl_usd", sa.Numeric(18, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("practice_marks", "day_pnl_usd")
    op.drop_column("replay_sessions", "stop_hit_at")
