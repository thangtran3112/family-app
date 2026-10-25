"""consensus history: consensus_snapshots, earnings_results, analyst_targets

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-24

Additive (02n §d): three new tables, nothing existing is touched, `downgrade()` drops them. Taken out of the
plan's `0004_fundamental_lane` so the daily snapshot job can start accumulating revision history now; the rest of
that migration (holdings, covered calls, AI verdicts, ...) chains on this one. The `desk_runtime` grants need no
change: `zz-20-desk-roles.sh` grants CRUD on every table `desk_migrator` creates in the `desk` schema.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "consensus_snapshots",
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("period_kind", sa.String(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("snapshot_date", sa.Date(), nullable=False),
        sa.Column("fiscal_year", sa.Integer(), nullable=True),
        sa.Column("fiscal_quarter", sa.Integer(), nullable=True),
        sa.Column("eps_mean", sa.Float(), nullable=True),
        sa.Column("eps_high", sa.Float(), nullable=True),
        sa.Column("eps_low", sa.Float(), nullable=True),
        sa.Column("analyst_count", sa.Integer(), nullable=True),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("quality", sa.String(), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "period_kind", "period_end", "snapshot_date"),
    )
    op.create_table(
        "earnings_results",
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("fiscal_year", sa.Integer(), nullable=True),
        sa.Column("fiscal_quarter", sa.Integer(), nullable=True),
        sa.Column("report_date", sa.Date(), nullable=True),
        sa.Column("report_time", sa.String(), nullable=True),
        sa.Column("eps_estimate", sa.Float(), nullable=True),
        sa.Column("eps_actual", sa.Float(), nullable=True),
        sa.Column("surprise", sa.Float(), nullable=True),
        sa.Column("surprise_percent", sa.Float(), nullable=True),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("quality", sa.String(), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "period_end"),
    )
    op.create_table(
        "analyst_targets",
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("snapshot_date", sa.Date(), nullable=False),
        sa.Column("target_mean", sa.Float(), nullable=True),
        sa.Column("target_median", sa.Float(), nullable=True),
        sa.Column("target_high", sa.Float(), nullable=True),
        sa.Column("target_low", sa.Float(), nullable=True),
        sa.Column("strong_buy", sa.Integer(), nullable=True),
        sa.Column("buy", sa.Integer(), nullable=True),
        sa.Column("hold", sa.Integer(), nullable=True),
        sa.Column("sell", sa.Integer(), nullable=True),
        sa.Column("strong_sell", sa.Integer(), nullable=True),
        sa.Column("period", sa.Date(), nullable=True),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("quality", sa.String(), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "snapshot_date"),
    )


def downgrade() -> None:
    op.drop_table("analyst_targets")
    op.drop_table("earnings_results")
    op.drop_table("consensus_snapshots")
