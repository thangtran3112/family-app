"""fundamental lane: accounts, holdings, covered-call scans, IV history, fundamentals, Desk AI verdicts

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-29

Additive (02n §d): ten new tables, nothing existing is touched, `downgrade()` drops them, children first. This is the
rest of the plan's `0004_fundamental_lane` after `0004` took the consensus tables and Practice took `0005` to `0011`,
so it chains on `0011`: `accounts`, `holding_imports`, `holding_lots`, `holding_trades` (the IBKR Flex import, whose
broker account number lives only in `accounts.external_id`), `covered_call_scans`, `iv_history`, `symbol_fundamentals`,
`ai_verdicts` and `ai_calls`. `ai_call_outcomes` and the backtest tables are not added (02n §d, §f).

The `desk_runtime` grants need no change: `zz-20-desk-roles.sh` grants CRUD on every table `desk_migrator` creates in
the `desk` schema, and USAGE on its id sequences, through `ALTER DEFAULT PRIVILEGES`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EMPTY_LIST = sa.text("'[]'::jsonb")
_EMPTY_OBJECT = sa.text("'{}'::jsonb")


def upgrade() -> None:
    op.create_table(
        "accounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("broker", sa.String(), nullable=False, server_default=sa.text("'ibkr'")),
        sa.Column("external_id", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False, server_default=sa.text("'taxable'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("type IN ('taxable', 'ira', 'roth')", name="ck_accounts_type"),
        sa.ForeignKeyConstraint(
            ["owner_user_id"], ["users.id"], name="fk_accounts_owner_user_id_users", ondelete="CASCADE"
        ),
        sa.UniqueConstraint("broker", "external_id", name="uq_accounts_broker_external_id"),
    )
    op.create_index("ix_accounts_owner_user_id", "accounts", ["owner_user_id"])

    op.create_table(
        "holding_imports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(), nullable=False, server_default=sa.text("'ibkr_flex'")),
        sa.Column("statement_date", sa.Date(), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lots", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("state", sa.String(), nullable=False, server_default=sa.text("'ok'")),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.CheckConstraint("source IN ('ibkr_flex')", name="ck_holding_imports_source"),
        sa.CheckConstraint("state IN ('running', 'ok', 'failed')", name="ck_holding_imports_state"),
        sa.CheckConstraint("lots >= 0", name="ck_holding_imports_lots"),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name="fk_holding_imports_account_id_accounts", ondelete="CASCADE"
        ),
        sa.UniqueConstraint("account_id", "statement_date", name="uq_holding_imports_account_id_statement_date"),
    )

    op.create_table(
        "holding_lots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("import_id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("asset_class", sa.String(), nullable=False),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("cost_per_share", sa.Float(), nullable=True),
        sa.Column("acquired", sa.Date(), nullable=True),
        sa.Column("option_right", sa.String(), nullable=True),
        sa.Column("strike", sa.Float(), nullable=True),
        sa.Column("expiry", sa.Date(), nullable=True),
        sa.Column("multiplier", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.CheckConstraint("quantity <> 0", name="ck_holding_lots_quantity"),
        sa.CheckConstraint("multiplier >= 1", name="ck_holding_lots_multiplier"),
        sa.CheckConstraint(
            "(asset_class = 'STK' AND option_right IS NULL AND strike IS NULL AND expiry IS NULL) OR "
            "(asset_class = 'OPT' AND option_right IN ('C', 'P') AND strike > 0 AND expiry IS NOT NULL)",
            name="ck_holding_lots_asset_class",
        ),
        sa.ForeignKeyConstraint(
            ["import_id"], ["holding_imports.id"], name="fk_holding_lots_import_id_holding_imports", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name="fk_holding_lots_account_id_accounts", ondelete="CASCADE"
        ),
    )
    op.create_index("ix_holding_lots_import_id", "holding_lots", ["import_id"])
    op.create_index("ix_holding_lots_account_id_symbol", "holding_lots", ["account_id", "symbol"])

    op.create_table(
        "holding_trades",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("external_ref", sa.String(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("option_right", sa.String(), nullable=False),
        sa.Column("strike", sa.Float(), nullable=False),
        sa.Column("expiry", sa.Date(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("price", sa.Float(), nullable=False),
        sa.Column("multiplier", sa.Integer(), nullable=False, server_default=sa.text("100")),
        sa.Column("commission", sa.Float(), nullable=True),
        sa.CheckConstraint("option_right IN ('C', 'P')", name="ck_holding_trades_option_right"),
        sa.CheckConstraint("strike > 0", name="ck_holding_trades_strike"),
        sa.CheckConstraint(
            "kind IN ('sell_to_open', 'buy_to_close', 'buy_to_open', 'sell_to_close', 'assignment', 'expiration')",
            name="ck_holding_trades_kind",
        ),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name="fk_holding_trades_account_id_accounts", ondelete="CASCADE"
        ),
        sa.UniqueConstraint("account_id", "external_ref", name="uq_holding_trades_account_id_external_ref"),
    )
    op.create_index("ix_holding_trades_account_id_trade_date", "holding_trades", ["account_id", "trade_date"])

    op.create_table(
        "covered_call_scans",
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("spot", sa.Float(), nullable=True),
        sa.Column("stamp", postgresql.JSONB(), nullable=False),
        sa.Column("iv_rank", sa.Float(), nullable=True),
        sa.Column("opportunity", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("candidates", postgresql.JSONB(), nullable=False, server_default=_EMPTY_LIST),
        sa.PrimaryKeyConstraint("account_id", "symbol", "run_at"),
        sa.CheckConstraint("iv_rank IS NULL OR iv_rank BETWEEN 0 AND 100", name="ck_covered_call_scans_iv_rank"),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name="fk_covered_call_scans_account_id_accounts", ondelete="CASCADE"
        ),
    )

    op.create_table(
        "iv_history",
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("iv30", sa.Float(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("quality", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "day"),
        sa.CheckConstraint("iv30 > 0", name="ck_iv_history_iv30"),
    )

    op.create_table(
        "symbol_fundamentals",
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("metrics", postgresql.JSONB(), nullable=False, server_default=_EMPTY_OBJECT),
        sa.PrimaryKeyConstraint("symbol"),
    )

    op.create_table(
        "ai_verdicts",
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("trading_day", sa.Date(), nullable=False),
        sa.Column("rating", sa.String(), nullable=False),
        sa.Column("target_low", sa.Float(), nullable=False),
        sa.Column("target_base", sa.Float(), nullable=False),
        sa.Column("target_high", sa.Float(), nullable=False),
        sa.Column("confidence", sa.Integer(), nullable=False),
        sa.Column("reasons", postgresql.JSONB(), nullable=False, server_default=_EMPTY_LIST),
        sa.Column("risks", postgresql.JSONB(), nullable=False, server_default=_EMPTY_LIST),
        sa.Column("changed", sa.Text(), nullable=True),
        sa.Column("votes", postgresql.JSONB(), nullable=False, server_default=_EMPTY_LIST),
        sa.Column("bull", sa.Text(), nullable=True),
        sa.Column("bear", sa.Text(), nullable=True),
        sa.Column("inputs", postgresql.JSONB(), nullable=False, server_default=_EMPTY_LIST),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=True),
        sa.Column("content_hash", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "trading_day"),
        sa.CheckConstraint(
            "target_low > 0 AND target_low <= target_base AND target_base <= target_high", name="ck_ai_verdicts_target"
        ),
        sa.CheckConstraint("confidence BETWEEN 0 AND 100", name="ck_ai_verdicts_confidence"),
    )

    op.create_table(
        "ai_calls",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("trading_day", sa.Date(), nullable=False),
        sa.Column("rating", sa.String(), nullable=False),
        sa.Column("prev_rating", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["symbol", "trading_day"],
            ["ai_verdicts.symbol", "ai_verdicts.trading_day"],
            name="fk_ai_calls_symbol_trading_day_ai_verdicts",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("symbol", "trading_day", name="uq_ai_calls_symbol_trading_day"),
    )


def downgrade() -> None:
    op.drop_table("ai_calls")
    op.drop_table("ai_verdicts")
    op.drop_table("symbol_fundamentals")
    op.drop_table("iv_history")
    op.drop_table("covered_call_scans")
    op.drop_table("holding_trades")
    op.drop_table("holding_lots")
    op.drop_table("holding_imports")
    op.drop_table("accounts")
