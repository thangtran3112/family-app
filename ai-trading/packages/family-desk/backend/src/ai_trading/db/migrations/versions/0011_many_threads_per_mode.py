"""several active practice threads per owner and mode

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-26

Drops `uq_practice_threads_owner_user_id_mode_active`, the unique index that allowed one active thread per owner and
mode, so a family member can run several day threads and several swing threads side by side. Each thread already owns
its plan (`uq_practice_plans_thread_id_active`), ledger and holds, so nothing else changes and there is no data step.
`ix_practice_threads_owner_user_id` (0007) still serves the owner lookups.

`downgrade()` must succeed on a database that holds several active threads of a mode: it closes every active thread
but the newest of each (owner, mode), archives the plans of the ones it closed, and puts the index back.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLDER_ACTIVE = (
    "SELECT t.id FROM practice_threads t WHERE t.status = 'active' AND EXISTS ("
    "SELECT 1 FROM practice_threads n WHERE n.owner_user_id = t.owner_user_id AND n.mode = t.mode "
    "AND n.status = 'active' AND (n.created_at, n.id) > (t.created_at, t.id))"
)


def upgrade() -> None:
    op.drop_index("uq_practice_threads_owner_user_id_mode_active", table_name="practice_threads")


def downgrade() -> None:
    op.execute(
        f"UPDATE practice_plans SET status = 'archived', updated_at = now() WHERE status = 'active' "
        f"AND thread_id IN ({_OLDER_ACTIVE})"
    )
    op.execute(
        f"UPDATE practice_threads SET status = 'closed', closed_at = now(), updated_at = now() "
        f"WHERE id IN ({_OLDER_ACTIVE})"
    )
    op.create_index(
        "uq_practice_threads_owner_user_id_mode_active",
        "practice_threads",
        ["owner_user_id", "mode"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
