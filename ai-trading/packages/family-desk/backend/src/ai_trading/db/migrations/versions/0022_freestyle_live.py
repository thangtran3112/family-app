"""freestyle thread, live step: a name may be held by two threads at once

Revision ID: 0022
Revises: 0021
Create Date: 2026-11-03

ADR-0025, step 3 of the freestyle redesign. `0021` added the schema the freestyle thread needs and left, on purpose,
what only the code of this step makes safe. This revision is the one such change that needs DDL:

- `uq_replay_sessions_owner_user_id_symbol_day_active` allowed one active row per owner, symbol and DAY, which is the
  day-thread model (a session was a name x a day) and stops two threads of one user holding the same name on the same
  data day. A lane is one row per (thread, symbol) for the thread's life (`uq_replay_sessions_thread_id_symbol_active`,
  `0021`), so the old index narrows to standalone rows (`thread_id IS NULL`), the only ones it still guards.

Nothing else changes in the schema. `practice_threads.mode` keeps its values (the contract still says `day`) and
stored `practice_plans.spec` blocks stay as they were: the code reads only the keys `practice-block-v1` and
`practice-setup-v2` share. Both go with the contract migration, a later release.

`downgrade()` restores the wider index; it fails loudly (a unique violation) if two threads of one owner hold one
name on one day by then, which is correct: the older code cannot represent that.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX = "uq_replay_sessions_owner_user_id_symbol_day_active"


def upgrade() -> None:
    op.drop_index(_INDEX, table_name="replay_sessions")
    op.create_index(
        _INDEX,
        "replay_sessions",
        ["owner_user_id", "symbol", "day"],
        unique=True,
        postgresql_where=sa.text("status = 'active' AND thread_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX, table_name="replay_sessions")
    op.create_index(
        _INDEX,
        "replay_sessions",
        ["owner_user_id", "symbol", "day"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
