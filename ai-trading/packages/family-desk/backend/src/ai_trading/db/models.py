"""Typed SQLAlchemy 2 models for the Desk's Postgres store: 02b §5's bar tables, 02a §9's roll map
(`bars_1d`, `bars_1h`, `bars_1m`, `futures_rolls`, Phase 2a), and Phase 3's strategy/alert tables
(02 §7, 02a §9: `users`, `watchlists`, `watchlist_items`, `strategies`, `strategy_versions`,
`signals`, `alerts`, `deliveries` -- Alembic `0002`), and the technical desktop MVP's screener, universe,
metrics, and feed-health tables (02m §b2 -- Alembic `0003`), and the consensus-history tables
(`consensus_snapshots`, `earnings_results`, `analyst_targets` -- 02n §d, Alembic `0004`). Still out of
scope: `iv_daily`, `order_intents`/`fills` and the rest of 02a §9's later-phase tables (Phase 2a's own
D3 ruling -- "a table arrives with the phase that first needs it").

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

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
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
    # 0003: `watch.universe.watchlist` references a list by name, so a user's names are unique.
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_watchlists_user_id_name"),)

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
    # 0003: manage-mode order (02m §a3.5); `PUT /watchlists/{id}/order` rewrites it.
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))


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
    # 0003 (02m §b2): `lane` is "technical" | "fundamental"; `origin` is "user" | "seed" | "library" | "ai";
    # `archived_at` hides a strategy from lists while its versions and signals stay (RESTRICT FKs).
    lane: Mapped[str] = mapped_column(String, nullable=False, default="technical", server_default=text("'technical'"))
    origin: Mapped[str] = mapped_column(String, nullable=False, default="user", server_default=text("'user'"))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


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
    # 0003 (02m §b2): the inbox, "Alerts on this stock", and the delivery log filter on these
    # without a three-hop join through signals -> strategy_versions -> strategies.
    symbol: Mapped[str | None] = mapped_column(String, index=True)
    strategy_id: Mapped[int | None] = mapped_column(ForeignKey("strategies.id"), index=True)


class Delivery(Base):
    __tablename__ = "deliveries"
    id: Mapped[int] = mapped_column(primary_key=True)
    # CASCADE (integration fix): deleting an alert deletes its per-channel delivery rows.
    alert_id: Mapped[int] = mapped_column(ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    channel: Mapped[str] = mapped_column(String, nullable=False)  # "inbox" | "telegram" | "slack"
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending", server_default=text("'pending'"))
    attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(String)


# -- Technical desktop MVP (Alembic 0003, 02m §b2): screener filters, universe, metrics, feed health ----


class FilterStrategy(Base):
    """A saved screener filter. Seeds are per-user read-only copies (`origin` "seed"); hers are "user"."""

    __tablename__ = "filter_strategies"
    __table_args__ = (
        # Names are unique per owner among live filters, so an archived name can be reused.
        Index(
            "uq_filter_strategies_owner_user_id_name_live",
            "owner_user_id",
            "name",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    origin: Mapped[str] = mapped_column(String, nullable=False)  # "seed" | "user"
    seed_key: Mapped[str | None] = mapped_column(String)
    # No ForeignKey, like `strategies.current_version_id`: the versions table FKs back here.
    current_version_id: Mapped[int | None] = mapped_column(Integer)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class FilterStrategyVersion(Base):
    __tablename__ = "filter_strategy_versions"
    __table_args__ = (
        UniqueConstraint("filter_strategy_id", "version", name="uq_filter_versions_filter_strategy_id_version"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    filter_strategy_id: Mapped[int] = mapped_column(
        ForeignKey("filter_strategies.id", ondelete="RESTRICT"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    change_note: Mapped[str | None] = mapped_column(String)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class FilterRun(Base):
    """One evaluation of a filter version at one closed bar; the unique key makes a re-run write nothing."""

    __tablename__ = "filter_runs"
    __table_args__ = (
        UniqueConstraint(
            "filter_strategy_version_id",
            "run_on",
            "session",
            "evaluation_point",
            name="uq_filter_runs_version_run_on_session_evaluation_point",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    filter_strategy_version_id: Mapped[int] = mapped_column(
        ForeignKey("filter_strategy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    run_on: Mapped[str] = mapped_column(String, nullable=False)
    session: Mapped[str] = mapped_column(String, nullable=False)  # "regular" | "extended"
    evaluation_point: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    scanned: Mapped[int] = mapped_column(Integer, nullable=False)
    no_data: Mapped[int] = mapped_column(Integer, nullable=False)
    matches_total: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)
    quality: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class FilterMatch(Base):
    __tablename__ = "filter_matches"
    __table_args__ = (Index("ix_filter_matches_run_id_rank", "run_id", "rank"),)

    run_id: Mapped[int] = mapped_column(ForeignKey("filter_runs.id", ondelete="CASCADE"), primary_key=True)
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    rank_value: Mapped[float] = mapped_column(Float, nullable=False)
    matched_since: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    operands: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    columns: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)


class UniverseSymbol(Base):
    __tablename__ = "universe_symbols"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    asset_type: Mapped[str] = mapped_column(String, nullable=False)  # "stock" | "etf"
    exchange: Mapped[str] = mapped_column(String, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False)
    passed_floor: Mapped[bool] = mapped_column(Boolean, nullable=False)
    floor_reason: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SymbolMetrics(Base):
    """The shared per-symbol metric row (02m §a1 metric names), one jsonb blob per symbol."""

    __tablename__ = "symbol_metrics"
    __table_args__ = (Index("ix_symbol_metrics_as_of", "as_of"),)

    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)
    quality: Mapped[str] = mapped_column(String, nullable=False)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)


class FeedHealth(Base):
    """Written by the scheduler's refresher and read by the API: they are separate compose services."""

    __tablename__ = "feed_health"
    feed: Mapped[str] = mapped_column(String, primary_key=True)  # "bars_delayed" | "quotes_live" | "scan"
    state: Mapped[str] = mapped_column(String, nullable=False)  # "ok" | "degraded" | "down"
    # Null until the first successful pass: a feed that never worked has no last-ok time.
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    detail: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ConsensusSnapshot(Base):
    """One day's consensus EPS for one fiscal period of one symbol (02f §4). The Desk's own daily rows are where
    the 7/30/90-day revisions come from, so a row is never rewritten by a later day; a re-run on the same
    `snapshot_date` (an ET trading day) replaces that day's row."""

    __tablename__ = "consensus_snapshots"

    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    period_kind: Mapped[str] = mapped_column(String, primary_key=True)  # "quarter" | "annual"
    period_end: Mapped[date] = mapped_column(Date, primary_key=True)
    snapshot_date: Mapped[date] = mapped_column(Date, primary_key=True)
    fiscal_year: Mapped[int | None] = mapped_column(Integer)
    fiscal_quarter: Mapped[int | None] = mapped_column(Integer)
    eps_mean: Mapped[float | None] = mapped_column(Float)
    eps_high: Mapped[float | None] = mapped_column(Float)
    eps_low: Mapped[float | None] = mapped_column(Float)
    analyst_count: Mapped[int | None] = mapped_column(Integer)
    provider: Mapped[str] = mapped_column(String, nullable=False)
    quality: Mapped[str] = mapped_column(String, nullable=False)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class EarningsResult(Base):
    """Reported-vs-estimated EPS of one fiscal period, latest provider answer (a restated figure replaces the old
    one). A period is keyed by its end date, so a calendar row the provider never joined to a period is not stored."""

    __tablename__ = "earnings_results"

    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    period_end: Mapped[date] = mapped_column(Date, primary_key=True)
    fiscal_year: Mapped[int | None] = mapped_column(Integer)
    fiscal_quarter: Mapped[int | None] = mapped_column(Integer)
    report_date: Mapped[date | None] = mapped_column(Date)
    report_time: Mapped[str | None] = mapped_column(String)
    eps_estimate: Mapped[float | None] = mapped_column(Float)
    eps_actual: Mapped[float | None] = mapped_column(Float)
    surprise: Mapped[float | None] = mapped_column(Float)
    surprise_percent: Mapped[float | None] = mapped_column(Float)
    provider: Mapped[str] = mapped_column(String, nullable=False)
    quality: Mapped[str] = mapped_column(String, nullable=False)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AnalystTarget(Base):
    """One day's analyst rating counts and price targets for a symbol (a target is null when the provider has none)."""

    __tablename__ = "analyst_targets"

    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    snapshot_date: Mapped[date] = mapped_column(Date, primary_key=True)
    target_mean: Mapped[float | None] = mapped_column(Float)
    target_median: Mapped[float | None] = mapped_column(Float)
    target_high: Mapped[float | None] = mapped_column(Float)
    target_low: Mapped[float | None] = mapped_column(Float)
    strong_buy: Mapped[int | None] = mapped_column(Integer)
    buy: Mapped[int | None] = mapped_column(Integer)
    hold: Mapped[int | None] = mapped_column(Integer)
    sell: Mapped[int | None] = mapped_column(Integer)
    strong_sell: Mapped[int | None] = mapped_column(Integer)
    period: Mapped[date | None] = mapped_column(Date)  # the provider's recommendation month
    provider: Mapped[str] = mapped_column(String, nullable=False)
    quality: Mapped[str] = mapped_column(String, nullable=False)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
