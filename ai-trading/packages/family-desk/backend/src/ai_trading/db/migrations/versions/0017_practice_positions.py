"""practice positions: practice_marks.position_before, practice_holds.part_exit

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-01

Additive: two columns, a default for every existing row, nothing backfilled, no row changes meaning.

The Practice replay holds ONE average-cost position per name (ADR-0016, "One position per name, many fills"): a Buy or
Sell mark is a fill against the name's position, so a name takes any number of fills (scale in, sell part, flip) and
the position is the weighted result. The day's journal is computed from marks and needs no column. A swing thread keeps
its position in `practice_holds`, whose partial unique index (one OPEN hold per symbol in a thread) therefore stays: it
is now the model's invariant, the backstop against two racing first entries, not a limit on how much she may hold.
Two columns carry what the swing rows could not say before.

- `practice_marks.position_before` (JSONB, null): an entry mark that added to an open hold records the hold as it stood
  (`shares`, `entry_price`, `stop_at_entry`, `stop_price`). A weighted average cannot be un-averaged to the digit, so an
  undo restores this instead of recomputing it.
- `practice_holds.part_exit` (boolean, default false): true on a closed row that is only the slice a partial exit
  closed; the position is still open in another row. A slice is a realized trade for the ledger and the review's P/L,
  but it is not a hold opened: the day summary's entries and `max_open_seen` count from the other rows.

`downgrade()` drops both columns. The schema stays valid, but a session that already holds scale-ins or partial exits
would be read by the previous journal as one entry per position, so downgrade only before the feature has been used.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("practice_marks", sa.Column("position_before", postgresql.JSONB(), nullable=True))
    op.add_column(
        "practice_holds", sa.Column("part_exit", sa.Boolean(), nullable=False, server_default=sa.text("false"))
    )


def downgrade() -> None:
    op.drop_column("practice_holds", "part_exit")
    op.drop_column("practice_marks", "position_before")
