"""practice threads: practice_threads, practice_ledger, replay_sessions.thread_id, practice_plans.thread_id

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-25

Additive (02r): two new tables and one nullable column on each of `replay_sessions` and `practice_plans`; no existing
column changes or drops (the old plan fields stay inside `practice_plans.spec`, deprecated and never read).

A data step then gives every owner who has a practice plan ONE default active thread (SIMULATED $50,000, mode day, the
risk plan lifted from the owner's active plan, else their latest) and links the owner's plans and day-list sessions to
it. Standalone sessions (no day list) stay unlinked: they never touch a balance. The ledger is backfilled with every
realized trade of the linked sessions, paired from the marks the way `replay/journal.py` pairs them (same rounding), so
the default thread's balance already agrees with the journals. `downgrade()` reverses the schema, children before
parents; the default threads and ledger rows go with their tables and the data step recreates them on the next upgrade.
Before the thread tables go, the thread's risk plan is written back into the `spec` of every plan saved after 0007
(which has no `setup.plan` or `setup.shares`), so the code of 0006 can still read those plans.
"""

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFAULT_STARTING_BALANCE = 50_000
ENTRY_KINDS = ("long_entry", "short_entry")
EXIT_KINDS = ("long_exit", "short_exit")


def upgrade() -> None:
    # -- practice_threads: the paper account and its risk plan (one active per owner and mode) -----------
    op.create_table(
        "practice_threads",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("starting_balance", sa.Numeric(14, 2), nullable=False),
        sa.Column("stop_note_on_entry", sa.String(), nullable=False),
        sa.Column("trade_only_on_signal", sa.String(), nullable=False),
        sa.Column("max_loss_usd", sa.Integer(), nullable=True),
        sa.Column("max_trades", sa.Integer(), nullable=True),
        sa.Column("plan_note", sa.Text(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("mode IN ('day', 'swing')", name="ck_practice_threads_mode"),
        sa.CheckConstraint("status IN ('active', 'closed')", name="ck_practice_threads_status"),
        sa.CheckConstraint("starting_balance BETWEEN 1000 AND 10000000", name="ck_practice_threads_starting_balance"),
        sa.CheckConstraint("stop_note_on_entry IN ('yes', 'no')", name="ck_practice_threads_stop_note_on_entry"),
        sa.CheckConstraint("trade_only_on_signal IN ('yes', 'no')", name="ck_practice_threads_trade_only_on_signal"),
        sa.CheckConstraint(
            "max_loss_usd IS NULL OR max_loss_usd BETWEEN 1 AND 100000", name="ck_practice_threads_max_loss"
        ),
        sa.CheckConstraint("max_trades IS NULL OR max_trades BETWEEN 1 AND 50", name="ck_practice_threads_max_trades"),
        sa.CheckConstraint("(status = 'closed') = (closed_at IS NOT NULL)", name="ck_practice_threads_closed_at"),
        sa.ForeignKeyConstraint(
            ["owner_user_id"], ["users.id"], name="fk_practice_threads_owner_user_id_users", ondelete="CASCADE"
        ),
    )
    op.create_index("ix_practice_threads_owner_user_id", "practice_threads", ["owner_user_id"])
    op.create_index(
        "uq_practice_threads_owner_user_id_mode_active",
        "practice_threads",
        ["owner_user_id", "mode"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )

    # -- practice_ledger: one row per realized trade, keyed by its exit mark ------------------------------
    op.create_table(
        "practice_ledger",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("thread_id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("mark_id", sa.Integer(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("side", sa.String(), nullable=False),
        sa.Column("shares", sa.Integer(), nullable=False),
        sa.Column("entry_price", sa.Numeric(18, 6), nullable=False),
        sa.Column("exit_price", sa.Numeric(18, 6), nullable=False),
        sa.Column("pnl_usd", sa.Numeric(14, 2), nullable=False),
        sa.Column("r", sa.Numeric(12, 2), nullable=True),
        sa.Column("realized_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("side IN ('long', 'short')", name="ck_practice_ledger_side"),
        sa.ForeignKeyConstraint(
            ["thread_id"],
            ["practice_threads.id"],
            name="fk_practice_ledger_thread_id_practice_threads",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["replay_sessions.id"],
            name="fk_practice_ledger_session_id_replay_sessions",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["mark_id"], ["practice_marks.id"], name="fk_practice_ledger_mark_id_practice_marks", ondelete="CASCADE"
        ),
        sa.UniqueConstraint("mark_id", name="uq_practice_ledger_mark_id"),
    )
    op.create_index("ix_practice_ledger_thread_id_day", "practice_ledger", ["thread_id", "day"])
    op.create_index("ix_practice_ledger_session_id", "practice_ledger", ["session_id"])

    # -- thread_id on the two tables that bind to a thread (null for standalone sessions and legacy rows) ---
    for table in ("replay_sessions", "practice_plans"):
        op.add_column(table, sa.Column("thread_id", sa.Integer(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_thread_id_practice_threads",
            table,
            "practice_threads",
            ["thread_id"],
            ["id"],
            ondelete="CASCADE",
        )
        op.create_index(f"ix_{table}_thread_id", table, ["thread_id"])

    _default_threads(op.get_bind())


def downgrade() -> None:
    _restore_plan_fields(op.get_bind())
    for table in ("practice_plans", "replay_sessions"):
        op.drop_index(f"ix_{table}_thread_id", table_name=table)
        op.drop_constraint(f"fk_{table}_thread_id_practice_threads", table, type_="foreignkey")
        op.drop_column(table, "thread_id")
    op.drop_index("ix_practice_ledger_session_id", table_name="practice_ledger")
    op.drop_index("ix_practice_ledger_thread_id_day", table_name="practice_ledger")
    op.drop_table("practice_ledger")
    op.drop_index("uq_practice_threads_owner_user_id_mode_active", table_name="practice_threads")
    op.drop_index("ix_practice_threads_owner_user_id", table_name="practice_threads")
    op.drop_table("practice_threads")


# -- the data step -------------------------------------------------------------------------------------------


def _restore_plan_fields(bind: sa.Connection) -> None:
    """Give every plan saved after 0007 the old `setup.plan` and `setup.shares` again, from its thread's plan (and the
    default 100 shares), so a rollback to the 0006 code reads it. A plan that still carries them is left alone."""
    rows = bind.execute(
        sa.text(
            "SELECT p.id, p.spec, t.stop_note_on_entry, t.trade_only_on_signal, t.max_loss_usd, t.max_trades, "
            "t.plan_note FROM practice_plans p JOIN practice_threads t ON t.id = p.thread_id"
        )
    ).all()
    for plan_id, spec, stop, signal, max_loss, max_trades, note in rows:
        setup = spec.get("setup") or {}
        if "plan" in setup and "shares" in setup:
            continue
        plan: dict[str, Any] = {"stopRequired": stop, "signalOnly": signal}
        for key, value in (("maxLossUsd", max_loss), ("maxTrades", max_trades), ("note", note)):
            if value is not None:
                plan[key] = value
        restored = {**spec, "setup": {**setup, "shares": setup.get("shares", 100), "plan": setup.get("plan", plan)}}
        bind.execute(
            sa.text("UPDATE practice_plans SET spec = CAST(:spec AS jsonb) WHERE id = :id"),
            {"spec": json.dumps(restored), "id": plan_id},
        )


def _plan_fields(spec: dict[str, Any]) -> dict[str, Any]:
    """The thread's risk plan from a plan spec saved before 0007 (`setup.plan`); anything off-contract is dropped."""
    old = (spec.get("setup") or {}).get("plan") or {}
    max_loss, max_trades, note = old.get("maxLossUsd"), old.get("maxTrades"), old.get("note")
    return {
        "stop": "yes" if old.get("stopRequired") == "yes" else "no",
        "signal": "yes" if old.get("signalOnly") == "yes" else "no",
        "max_loss": max_loss if isinstance(max_loss, int) and 1 <= max_loss <= 100_000 else None,
        "max_trades": max_trades if isinstance(max_trades, int) and 1 <= max_trades <= 50 else None,
        "note": note if isinstance(note, str) and 1 <= len(note) <= 500 else None,
    }


def _default_threads(bind: sa.Connection) -> None:
    now = datetime.now(UTC)
    owners = bind.execute(sa.text("SELECT DISTINCT owner_user_id FROM practice_plans ORDER BY owner_user_id")).scalars()
    for owner in list(owners):
        plan = bind.execute(
            sa.text(
                "SELECT spec FROM practice_plans WHERE owner_user_id = :owner "
                "ORDER BY (status = 'active') DESC, id DESC LIMIT 1"
            ),
            {"owner": owner},
        ).scalar_one()
        first = bind.execute(
            sa.text("SELECT MIN(created_at) FROM practice_plans WHERE owner_user_id = :owner"), {"owner": owner}
        ).scalar_one()
        fields = _plan_fields(plan)
        thread_id = bind.execute(
            sa.text(
                "INSERT INTO practice_threads (owner_user_id, mode, starting_balance, stop_note_on_entry, "
                "trade_only_on_signal, max_loss_usd, max_trades, plan_note, status, created_at, updated_at) "
                "VALUES (:owner, 'day', :balance, :stop, :signal, :max_loss, :max_trades, :note, 'active', :at, :now) "
                "RETURNING id"
            ),
            {**fields, "owner": owner, "balance": DEFAULT_STARTING_BALANCE, "at": first or now, "now": now},
        ).scalar_one()
        bind.execute(
            sa.text("UPDATE practice_plans SET thread_id = :thread WHERE owner_user_id = :owner"),
            {"thread": thread_id, "owner": owner},
        )
        bind.execute(
            sa.text(
                "UPDATE replay_sessions SET thread_id = :thread "
                "WHERE owner_user_id = :owner AND day_list_id IS NOT NULL"
            ),
            {"thread": thread_id, "owner": owner},
        )
        _backfill_ledger(bind, thread_id, now)


def _backfill_ledger(bind: sa.Connection, thread_id: int, now: datetime) -> None:
    sessions = bind.execute(
        sa.text("SELECT id, day, symbol FROM replay_sessions WHERE thread_id = :thread ORDER BY id"),
        {"thread": thread_id},
    ).all()
    for session_id, day, symbol in sessions:
        marks = bind.execute(
            sa.text(
                "SELECT id, kind, at, price, shares, stop_price FROM practice_marks WHERE session_id = :session "
                "ORDER BY seq"
            ),
            {"session": session_id},
        ).all()
        entry: Any = None
        for mark_id, kind, at, price, shares, stop_price in marks:
            if kind in ENTRY_KINDS and entry is None:
                entry = {"side": "long" if kind == "long_entry" else "short", "price": price, "shares": shares}
                entry["stop"] = stop_price
            elif kind == "stop" and entry is not None and stop_price is not None:
                entry["stop"] = entry["stop"] if entry["stop"] is not None else stop_price
            elif kind in EXIT_KINDS and entry is not None:
                sign = 1 if entry["side"] == "long" else -1
                entry_price, exit_price = float(entry["price"]), float(price)
                pnl = round(sign * (exit_price - entry_price) * entry["shares"], 2)
                stop = entry["stop"]
                r = None
                if stop is not None and float(stop) != entry_price:
                    r = round(sign * (exit_price - entry_price) / abs(entry_price - float(stop)), 2)
                bind.execute(
                    sa.text(
                        "INSERT INTO practice_ledger (thread_id, session_id, mark_id, day, symbol, side, shares, "
                        "entry_price, exit_price, pnl_usd, r, realized_at, created_at) VALUES (:thread, :session, "
                        ":mark, :day, :symbol, :side, :shares, :entry_price, :exit_price, :pnl, :r, :at, :now)"
                    ),
                    {
                        "thread": thread_id,
                        "session": session_id,
                        "mark": mark_id,
                        "day": day,
                        "symbol": symbol,
                        "side": entry["side"],
                        "shares": entry["shares"],
                        "entry_price": entry["price"],
                        "exit_price": price,
                        "pnl": Decimal(str(pnl)),
                        "r": None if r is None else Decimal(str(r)),
                        "at": at,
                        "now": now,
                    },
                )
                entry = None
