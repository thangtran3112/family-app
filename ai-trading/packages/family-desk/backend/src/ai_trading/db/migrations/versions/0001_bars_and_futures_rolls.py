"""bars_1d, bars_1h, bars_1m, futures_rolls

Revision ID: 0001
Revises:
Create Date: 2026-10-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _bar_columns() -> list[sa.Column]:
    # A fresh list of `Column` objects per call: a `Column` binds to one `Table`, so the same
    # instances can't be passed to three `op.create_table` calls.
    return [
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("open", sa.Float(), nullable=False),
        sa.Column("high", sa.Float(), nullable=False),
        sa.Column("low", sa.Float(), nullable=False),
        sa.Column("close", sa.Float(), nullable=False),
        sa.Column("volume", sa.Float(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "bars_1d",
        *_bar_columns(),
        sa.Column("day", sa.Date(), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "day"),
    )
    op.create_table(
        "bars_1h",
        *_bar_columns(),
        sa.Column("bar_start", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "bar_start"),
    )
    op.create_table(
        "bars_1m",
        *_bar_columns(),
        sa.Column("bar_start", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "bar_start"),
    )
    op.create_table(
        "futures_rolls",
        sa.Column("product", sa.String(), nullable=False),
        sa.Column("contract_month", sa.Date(), nullable=False),
        sa.Column("contract_symbol", sa.String(), nullable=False),
        sa.Column("active_from", sa.Date(), nullable=False),
        sa.Column("active_until", sa.Date(), nullable=False),
        sa.PrimaryKeyConstraint("product", "contract_month"),
    )


def downgrade() -> None:
    op.drop_table("futures_rolls")
    op.drop_table("bars_1m")
    op.drop_table("bars_1h")
    op.drop_table("bars_1d")
