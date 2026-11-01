"""practice working orders: replay_sessions.orders

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-01

Additive: one JSONB column, `'[]'` for every existing row, so nothing is backfilled and no row changes meaning.

`replay_sessions.orders` is the session's list of practice orders that were not filled at once: a limit, stop or
stop-limit entry waits on the tape (`replay/orders.py`), and the list keeps it after it fills or is cancelled so the
workspace can show what happened. Each item is `{id, side, type, shares, limit, trigger, status, placed_at,
triggered_at, closed_at, fill_price, mark_id, reason}`. A fill is also an ordinary entry mark in `practice_marks`
(`mark_id`), so the journal, the ledger and the holds read it like any other entry. It lives on the session row, under
the row lock every playhead move and mark already takes, so no second table or lock order is introduced.

`downgrade()` drops the column (working orders are session state, not a record the journal reads).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "replay_sessions",
        sa.Column("orders", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
    )


def downgrade() -> None:
    op.drop_column("replay_sessions", "orders")
