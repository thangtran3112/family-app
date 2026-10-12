"""Typed SQLAlchemy 2 models for the Desk's Postgres store: 02b §5's bar tables, 02a §9's roll map
(`bars_1d`, `bars_1h`, `bars_1m`, `futures_rolls`, Phase 2a), and Phase 3's strategy/alert tables
(02 §7, 02a §9: `users`, `watchlists`, `watchlist_items`, `strategies`, `strategy_versions`,
`signals`, `alerts`, `deliveries` -- Alembic `0002`). Still out of scope: `iv_daily`,
`consensus_snapshots`, `order_intents`/`fills` and the rest of 02a §9's later-phase tables (Phase
2a's own D3 ruling -- "a table arrives with the phase that first needs it").

Every bar table's primary key matches how `ai_trading.data.bars`/`rolls` upsert into it (`symbol`
plus the bar's own time column; `product` plus `contract_month`), so `INSERT ... ON CONFLICT DO
UPDATE` needs no separate unique index.

No model below sets an explicit `schema=`: in production the Desk's `desk_migrator`/`desk_runtime`
roles each carry a `search_path` that resolves every unqualified table to the `desk` schema
(`docker/postgres/zz-20-desk-roles.sh`); local/test runs connect as a superuser with no search_path
narrowing, so the same unqualified names land in `public`. Same convention
`expense-tax-management/docker/postgres/zz-20-expense-tax-roles.sh` already uses for its own
app/foundry schemas.
"""

from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


# Each bar table repeats its OHLCV + `source` columns rather than sharing them through a mixin:
# splitting a composite primary key across a mixin and its subclass (symbol here, the time column
# there) makes SQLAlchemy's declarative mapper build the primary key in two steps and emit a
# spurious warning, even though the result is correct. Three short, explicit classes avoid it.


class Bar1d(Base):
    __tablename__ = "bars_1d"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String)


class Bar1h(Base):
    __tablename__ = "bars_1h"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    bar_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String)


class Bar1m(Base):
    __tablename__ = "bars_1m"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    bar_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String)


class FuturesRoll(Base):
    """One contiguous front-month window from `ai_trading.data.rolls.roll_windows`."""

    __tablename__ = "futures_rolls"
    product: Mapped[str] = mapped_column(String, primary_key=True)
    contract_month: Mapped[date] = mapped_column(Date, primary_key=True)
    contract_symbol: Mapped[str] = mapped_column(String)
    active_from: Mapped[date] = mapped_column(Date)
    active_until: Mapped[date] = mapped_column(Date)


# -- Phase 3 (Alembic 0002): strategies, signals, and alert delivery -----------------------------
# Created in FK-dependency order: users -> watchlists -> watchlist_items -> strategies ->
# strategy_versions -> signals -> alerts -> deliveries (the same order the migration uses).


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String)
    telegram_chat_id: Mapped[str | None] = mapped_column(String)
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )


class Watchlist(Base):
    __tablename__ = "watchlists"
    id: Mapped[int] = mapped_column(primary_key=True)
    # CASCADE (integration fix, PROTO-BRIEF.md ruling): deleting a user deletes their watchlists.
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    horizon: Mapped[str] = mapped_column(String, nullable=False)  # "intraday" | "swing" | "long_term"


class WatchlistItem(Base):
    __tablename__ = "watchlist_items"
    # CASCADE (integration fix): deleting a watchlist deletes its items.
    watchlist_id: Mapped[int] = mapped_column(ForeignKey("watchlists.id", ondelete="CASCADE"), primary_key=True)
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    asset_type: Mapped[str] = mapped_column(String, nullable=False)  # "stock" | "future"


class Strategy(Base):
    __tablename__ = "strategies"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    stage: Mapped[str] = mapped_column(String, nullable=False, default="draft", server_default=text("'draft'"))
    # No ForeignKey: strategy_versions.strategy_id FKs back to this table, so a FK here would be
    # circular. Application code enforces the reference; indexed for tick.py's every-60s lookup.
    current_version_id: Mapped[int | None] = mapped_column(Integer, index=True)
    paused_reason: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class StrategyVersion(Base):
    __tablename__ = "strategy_versions"
    __table_args__ = (UniqueConstraint("strategy_id", "version", name="uq_strategy_versions_strategy_id_version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    # RESTRICT (integration fix): a strategy with any version can't be deleted out from under it.
    strategy_id: Mapped[int] = mapped_column(ForeignKey("strategies.id", ondelete="RESTRICT"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    change_note: Mapped[str | None] = mapped_column(String)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Signal(Base):
    __tablename__ = "signals"
    __table_args__ = (
        UniqueConstraint(
            "strategy_version_id", "symbol", "bar_time", name="uq_signals_strategy_version_id_symbol_bar_time"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # RESTRICT (integration fix): a strategy version with any recorded signal can't be deleted.
    strategy_version_id: Mapped[int] = mapped_column(
        ForeignKey("strategy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    symbol: Mapped[str] = mapped_column(String, nullable=False)
    bar_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    data_quality: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    signal_id: Mapped[int | None] = mapped_column(ForeignKey("signals.id"))
    kind: Mapped[str] = mapped_column(String, nullable=False)
    severity: Mapped[str] = mapped_column(String, nullable=False)
    dedupe_key: Mapped[str | None] = mapped_column(String, index=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Delivery(Base):
    __tablename__ = "deliveries"
    id: Mapped[int] = mapped_column(primary_key=True)
    # CASCADE (integration fix): deleting an alert deletes its per-channel delivery rows.
    alert_id: Mapped[int] = mapped_column(ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    channel: Mapped[str] = mapped_column(String, nullable=False)  # "inbox" | "telegram" | "slack"
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending", server_default=text("'pending'"))
    attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(String)
