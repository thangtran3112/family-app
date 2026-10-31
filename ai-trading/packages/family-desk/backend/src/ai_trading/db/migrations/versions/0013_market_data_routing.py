"""market data routing: the family-scoped provider preference the Settings card writes

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-31

Additive (02t §3.5, ruling 12): one new table, `market_data_routing`, one row per data class, and nothing
existing is touched. It is the Desk's own record of the family-wide preference so a restarted bridge is
re-synced by `jobs/bridge_routing.py` without waiting for anyone to open Settings; the bridge's cached copy
stays the runtime truth. `preferred` NULL means "no preference" (the ladder's first rung answers) and
`version` is the Desk's routing version last sent, per row, read as the family's version by its maximum.

The `desk_runtime` grants need no change: `zz-20-desk-roles.sh` grants CRUD on every table `desk_migrator`
creates in the `desk` schema through `ALTER DEFAULT PRIVILEGES`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "market_data_routing",
        sa.Column("data_class", sa.String(), primary_key=True),
        sa.Column("preferred", sa.String(), nullable=True),
        sa.Column("version", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("updated_by", sa.String(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("market_data_routing")
