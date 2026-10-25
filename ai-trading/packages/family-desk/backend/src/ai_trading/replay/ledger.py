"""The practice ledger (02r): one row per realized practice trade, keyed by the exit mark that realized it.

`book` is idempotent per mark, so every path that can realize a trade (her exit mark, the day's auto-exit) calls it
without checking first. Undoing an exit mark deletes the mark, and the foreign key takes the ledger row with it. The
P/L is the journal's own `trade_pnl`, so a ledger sum and a journal total can only differ if a row is missing.
"""

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.db.models import PracticeLedger, ReplaySession
from ai_trading.replay.journal import Trade, trade_pnl

R_LIMIT = 1000  # the contract's bound on `r`; a tighter-than-a-tick stop is served without one


def utc_z(value: datetime) -> str:
    """A UTC instant as the contracts spell it: whole seconds and a trailing Z."""
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def book(db: Session, row: ReplaySession, trades: list[Trade], now: datetime) -> int:
    """Write a ledger row for each closed trade of a thread session that is not booked yet; returns how many were
    added. A session with no thread (a standalone one) books nothing."""
    if row.thread_id is None:
        return 0
    done = set(db.execute(select(PracticeLedger.mark_id).where(PracticeLedger.session_id == row.id)).scalars())
    added = 0
    for trade in trades:
        if trade.exit_mark_id is None or trade.exit_mark_id in done or trade.exit_price is None:
            continue
        assert trade.exit_at is not None
        r = trade.r_of(trade.exit_price)
        db.add(
            PracticeLedger(
                thread_id=row.thread_id,
                session_id=row.id,
                mark_id=trade.exit_mark_id,
                day=row.day,
                symbol=row.symbol,
                side=trade.side,
                shares=trade.shares,
                entry_price=Decimal(str(trade.entry_price)),
                exit_price=Decimal(str(trade.exit_price)),
                pnl_usd=Decimal(str(trade_pnl(trade))),
                r=None if r is None else Decimal(str(round(r, 2))),
                realized_at=trade.exit_at.to_pydatetime(),
                created_at=now,
            )
        )
        added += 1
    if added:
        db.flush()
    return added


def entry_out(row: PracticeLedger) -> dict[str, Any]:
    """A `PracticeLedgerEntryV1` as a dict: `r` is absent, never null, when there was no stop."""
    out: dict[str, Any] = {
        "schemaVersion": 1,
        "id": row.id,
        "threadId": row.thread_id,
        "sessionId": row.session_id,
        "markId": row.mark_id,
        "symbol": row.symbol,
        "day": row.day.isoformat(),
        "side": row.side,
        "shares": row.shares,
        "entryPrice": float(row.entry_price),
        "exitPrice": float(row.exit_price),
        "pnlUsd": float(row.pnl_usd),
        "realizedAt": utc_z(row.realized_at),
    }
    if row.r is not None and abs(row.r) <= R_LIMIT:
        out["r"] = float(row.r)
    return out
