"""thread clock: replay_day_lists.clock_running, clock_speed, clock_anchor_at, clock_pause

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-01

Additive: four columns, a default for every existing row, nothing backfilled, no row changes meaning.

A day-trade thread's time is one clock, `replay_day_lists.revealed_through`, and until now only a browser moved it
(ADR-0017). ADR-0018 moves the *motion* to the server so it survives navigation and logout: the clock is stored as
"running at `clock_speed` x wall time since `clock_anchor_at`" and settled lazily whenever it is read (no worker).

- `clock_running` (boolean NOT NULL, false): the clock is playing. Every existing day reads paused, as it was.
- `clock_speed` (smallint NOT NULL, 1; 1, 2, 5 or 10): market seconds per wall second while running.
- `clock_anchor_at` (timestamptz, null): the wall instant `revealed_through` was last true; null while paused.
- `clock_pause` (jsonb, null): why a clock that was running stopped (`{"kind": "stop", ...}` a crossed stop, or
  `{"kind": "close"}` the window end), so she can be told when she comes back. Null otherwise.

`downgrade()` drops the four columns; a running clock simply stops where it stood.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "replay_day_lists", sa.Column("clock_running", sa.Boolean(), nullable=False, server_default=sa.text("false"))
    )
    op.add_column(
        "replay_day_lists", sa.Column("clock_speed", sa.SmallInteger(), nullable=False, server_default=sa.text("1"))
    )
    op.add_column("replay_day_lists", sa.Column("clock_anchor_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("replay_day_lists", sa.Column("clock_pause", postgresql.JSONB(), nullable=True))
    op.create_check_constraint("ck_replay_day_lists_clock_speed", "replay_day_lists", "clock_speed IN (1, 2, 5, 10)")


def downgrade() -> None:
    op.drop_constraint("ck_replay_day_lists_clock_speed", "replay_day_lists", type_="check")
    op.drop_column("replay_day_lists", "clock_pause")
    op.drop_column("replay_day_lists", "clock_anchor_at")
    op.drop_column("replay_day_lists", "clock_speed")
    op.drop_column("replay_day_lists", "clock_running")
