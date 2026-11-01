"""Typed SQLAlchemy 2 models for the Desk's Postgres store: 02b §5's bar tables, 02a §9's roll map
(`bars_1d`, `bars_1h`, `bars_1m`, `futures_rolls`, Phase 2a), and Phase 3's strategy/alert tables
(02 §7, 02a §9: `users`, `watchlists`, `watchlist_items`, `strategies`, `strategy_versions`,
`signals`, `alerts`, `deliveries` -- Alembic `0002`), and the technical desktop MVP's screener, universe,
metrics, and feed-health tables (02m §b2 -- Alembic `0003`), the consensus-history tables
(`consensus_snapshots`, `earnings_results`, `analyst_targets` -- 02n §d, Alembic `0004`), and the replay
practice tables (02o c3 -- Alembic `0005`), the feedback log (02s -- Alembic `0010`), and the Fundamental lane's
holdings, covered-call, IV, fundamentals and Desk AI tables (02n §d -- Alembic `0012`), and the family-scoped
market-data routing row the provider toggle reads and writes (02t §3.5 -- Alembic `0013`). Still out of scope:
`iv_daily`, `order_intents`/`fills` and the rest of 02a §9's later-phase tables (Phase 2a's own D3 ruling -- "a
table arrives with the phase that first needs it").

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
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    String,
    Text,
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
        # 0015: per-symbol bar-time ranges (chart markers, tags, runtime history) and the dashboard's "since" window;
        # the unique key above leads with strategy_version_id, so neither could use it.
        Index("ix_signals_symbol_bar_time", "symbol", "bar_time"),
        Index("ix_signals_bar_time", "bar_time"),
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
    __table_args__ = (
        # 0015: the inbox, the delivery log, read-all and the unread badge filter `user_id`; the first two page by
        # `created_at DESC, id DESC`, which this index serves directly. `signal_id` is `fires`' delivery lookup.
        Index("ix_alerts_user_id_created_at", "user_id", text("created_at DESC"), text("id DESC")),
        Index("ix_alerts_signal_id", "signal_id"),
    )

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
    # 0015: every delivery read joins on `alert_id`, and an alert delete cascades through it.
    __table_args__ = (Index("ix_deliveries_alert_id", "alert_id"),)

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


class MarketDataRouting(Base):
    """The family-scoped provider preference, one row per data class (02t §3.5, ruling 12).

    The bridge's cached copy is the runtime truth; this table is the Desk's own record, so a bridge
    restart is re-synced by `jobs/bridge_routing.py` without waiting for anyone to open Settings. One
    value for the whole family, unlike `users.settings` (per user), hence its own table.
    """

    __tablename__ = "market_data_routing"

    # "equity_quotes" | "equity_bars" | "option_chain"
    data_class: Mapped[str] = mapped_column(String, primary_key=True)
    #: "" and NULL both mean "no preference" (the ladder's first rung answers).
    preferred: Mapped[str | None] = mapped_column(String)
    #: The Desk's routing version the bridge was last told; the bridge re-syncs when its own differs.
    version: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default=text("0"))
    updated_by: Mapped[str | None] = mapped_column(String)  # the owner's verified email, never a token
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


# -- Replay practice (Alembic 0005, 02o c3): replay sessions, practice marks, notable days, blob cache --


class ReplaySession(Base):
    """One practice attempt at one symbol-day. A new attempt is a new row; only one may be `active`."""

    __tablename__ = "replay_sessions"
    __table_args__ = (
        UniqueConstraint(
            "owner_user_id", "symbol", "day", "attempt", name="uq_replay_sessions_owner_user_id_symbol_day_attempt"
        ),
        Index("ix_replay_sessions_owner_user_id_updated_at", "owner_user_id", text("updated_at DESC")),
        # One active session per symbol and day per user; ended attempts are unconstrained.
        Index(
            "uq_replay_sessions_owner_user_id_symbol_day_active",
            "owner_user_id",
            "symbol",
            "day",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
        CheckConstraint("status IN ('active', 'ended')", name="ck_replay_sessions_status"),
        CheckConstraint("rating IS NULL OR rating BETWEEN 1 AND 5", name="ck_replay_sessions_rating"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # CASCADE (02o c3): deleting a user deletes their replay sessions.
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    symbol: Mapped[str] = mapped_column(String, nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # Resolved strategy refs (`version_id`, `name`, `bias`) and the would-fire list. The list is never
    # served past `revealed_through`.
    armed: Mapped[Any] = mapped_column(JSONB, nullable=False)
    signals: Mapped[Any] = mapped_column(JSONB, nullable=False)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    window_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revealed_through: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    tape_feed: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)  # "active" | "ended"
    journal: Mapped[Any | None] = mapped_column(JSONB)  # final journal, written when the session ends
    notes: Mapped[str | None] = mapped_column(Text)
    rating: Mapped[int | None] = mapped_column(SmallInteger)  # 1..5 self-rating, or null
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Alembic 0006 (02o-b v1): the day list this session practises, null for a standalone session.
    day_list_id: Mapped[int | None] = mapped_column(
        ForeignKey("replay_day_lists.id", ondelete="CASCADE"), index=True, nullable=True
    )
    # Alembic 0007 (02r): the practice thread a day-list session books into; null for a standalone session.
    thread_id: Mapped[int | None] = mapped_column(
        ForeignKey("practice_threads.id", ondelete="CASCADE"), index=True, nullable=True
    )
    # Alembic 0009 (02o-b2): the spans `[from, to]` (ISO) in which she was not on this name; see `replay/model.py`.
    away: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"), default=list)
    # Alembic 0016: the practice orders that were not filled at once (a limit, stop or stop-limit entry waiting on the
    # tape) with what became of them; see replay/orders.py.
    orders: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"), default=list)
    # Alembic 0014: when play last paused on this session's open trade because its stop was crossed (a day holds one
    # open trade per name, so one flag). A new entry, stop note or exit clears it.
    stop_hit_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PracticeMark(Base):
    """A her-or-auto mark on a session's chart. `seq` orders marks within their session."""

    __tablename__ = "practice_marks"
    __table_args__ = (
        UniqueConstraint("session_id", "seq", name="uq_practice_marks_session_id_seq"),
        CheckConstraint(
            "kind IN ('long_entry', 'short_entry', 'long_exit', 'short_exit', 'stop', 'note')",
            name="ck_practice_marks_kind",
        ),
        CheckConstraint("source IN ('her', 'auto')", name="ck_practice_marks_source"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # CASCADE (02o c3): deleting a session deletes its marks.
    session_id: Mapped[int] = mapped_column(ForeignKey("replay_sessions.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    price: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))  # null for a note
    shares: Mapped[int | None] = mapped_column(Integer)
    stop_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    note: Mapped[str | None] = mapped_column(Text)
    trade_no: Mapped[int | None] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String, nullable=False)  # "her" | "auto"
    # Alembic 0014: the day's P/L (realized + open trades marked at the day clock) when an entry was placed: the
    # max-loss rule's basis. Entry marks of a day-list session only; null on any other row (the journal then reads
    # realized only).
    day_pnl_usd: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ReplayNotableDay(Base):
    """A scanned symbol-day the replay picker can offer. Keyed by (symbol, day), no attempts."""

    __tablename__ = "replay_notable_days"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    rv: Mapped[float] = mapped_column(Float, nullable=False)
    rv_pct_rank: Mapped[float] = mapped_column(Float, nullable=False)
    gap_pct: Mapped[float | None] = mapped_column(Float)
    rvol: Mapped[float | None] = mapped_column(Float)
    tags: Mapped[Any] = mapped_column(JSONB, nullable=False)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ReplayBlob(Base):
    """A compressed history payload cached per (kind, symbol, day, part, feed)."""

    __tablename__ = "replay_blobs"
    kind: Mapped[str] = mapped_column(String, primary_key=True)  # "bars1m" | "bars1d" | "tape"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    # '' except for tape chunks: the 30-minute chunk start as ET 'HHMM'.
    part: Mapped[str] = mapped_column(String, primary_key=True, default="", server_default=text("''"))
    feed: Mapped[str] = mapped_column(String, primary_key=True)  # "sip" | "iex"
    payload: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


# -- Daily-list practice (Alembic 0006, 02o-b v1): the plan and cursor, the frozen day lists, the universe snapshot --


class PracticePlan(Base):
    """The saved daily-list setup and its cursor. One active plan per thread (Alembic 0008 moved the index from the
    owner to the thread, so a day thread and a swing thread run side by side); `day_cursor` is the newest opened day."""

    __tablename__ = "practice_plans"
    __table_args__ = (
        Index(
            "uq_practice_plans_thread_id_active",
            "thread_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
        CheckConstraint("status IN ('active', 'archived')", name="ck_practice_plans_status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    first_day: Mapped[date] = mapped_column(Date, nullable=False)
    universe: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    prep: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    day_cursor: Mapped[date | None] = mapped_column(Date)
    days_opened: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    status: Mapped[str] = mapped_column(String, nullable=False)  # "active" | "archived"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Alembic 0007 (02r): the thread this plan's days book into. Its `spec` still carries the old plan fields
    # (`setup.plan`, `setup.shares`) on rows saved before 0007: deprecated, never read, never dropped.
    thread_id: Mapped[int | None] = mapped_column(
        ForeignKey("practice_threads.id", ondelete="CASCADE"), index=True, nullable=True
    )


class ReplayDayList(Base):
    """One practice day: the frozen candidate list, her stars, the day clock, and (once ended) the review."""

    __tablename__ = "replay_day_lists"
    __table_args__ = (
        UniqueConstraint("plan_id", "day", name="uq_replay_day_lists_plan_id_day"),
        Index("ix_replay_day_lists_owner_user_id_day", "owner_user_id", "day"),
        CheckConstraint("status IN ('listed', 'practicing', 'ended')", name="ck_replay_day_lists_status"),
        CheckConstraint("rating IS NULL OR rating BETWEEN 1 AND 5", name="ck_replay_day_lists_rating"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("practice_plans.id", ondelete="CASCADE"), nullable=False)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    day_no: Mapped[int] = mapped_column(Integer, nullable=False)
    screen: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    list_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    data_through: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    universe: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    columns: Mapped[Any] = mapped_column(JSONB, nullable=False)
    candidates: Mapped[Any] = mapped_column(JSONB, nullable=False)
    watch: Mapped[Any] = mapped_column(JSONB, nullable=False)
    revealed_through: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # the shared day clock
    status: Mapped[str] = mapped_column(String, nullable=False)  # "listed" | "practicing" | "ended"
    journal: Mapped[Any | None] = mapped_column(JSONB)
    review: Mapped[Any | None] = mapped_column(JSONB)  # only ever served once the day has ended
    notes: Mapped[str | None] = mapped_column(Text)
    rating: Mapped[int | None] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ReplayDayScan(Base):
    """A re-scan of a day list's filters at the day clock (02o-b2). The frozen list stays as it was: a scan is a row."""

    __tablename__ = "replay_day_scans"
    __table_args__ = (UniqueConstraint("day_list_id", "seq", name="uq_replay_day_scans_day_list_id_seq"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    day_list_id: Mapped[int] = mapped_column(ForeignKey("replay_day_lists.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)  # the day clock when she scanned
    data_through: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    universe: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    columns: Mapped[Any] = mapped_column(JSONB, nullable=False)
    candidates: Mapped[Any] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class UniverseDay(Base):
    """The symbols the live premarket pass scanned on a morning. Written by the premarket pass (02o-b v1); read by
    the practice day lists and `GET /replay/universe-days` (02o-b2)."""

    __tablename__ = "universe_days"
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    symbols: Mapped[Any] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


# -- Practice threads (Alembic 0007, 02r): the paper account across practice days, and its ledger --


class PracticeThread(Base):
    """A practice thread: the SIMULATED balance she practises in, with the risk plan that governs every day in it.
    Any number of threads may be active per owner and mode (Alembic 0011 dropped the one-active index); the balance is
    never stored (`starting_balance` + the ledger)."""

    __tablename__ = "practice_threads"
    __table_args__ = (
        CheckConstraint("mode IN ('day', 'swing')", name="ck_practice_threads_mode"),
        CheckConstraint("status IN ('active', 'closed')", name="ck_practice_threads_status"),
        CheckConstraint("starting_balance BETWEEN 1000 AND 10000000", name="ck_practice_threads_starting_balance"),
        CheckConstraint("stop_note_on_entry IN ('yes', 'no')", name="ck_practice_threads_stop_note_on_entry"),
        CheckConstraint("trade_only_on_signal IN ('yes', 'no')", name="ck_practice_threads_trade_only_on_signal"),
        CheckConstraint(
            "max_loss_usd IS NULL OR max_loss_usd BETWEEN 1 AND 100000", name="ck_practice_threads_max_loss"
        ),
        CheckConstraint("max_trades IS NULL OR max_trades BETWEEN 1 AND 50", name="ck_practice_threads_max_trades"),
        CheckConstraint("(status = 'closed') = (closed_at IS NOT NULL)", name="ck_practice_threads_closed_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    mode: Mapped[str] = mapped_column(String, nullable=False)  # "day" | "swing" (swing is unused until 02p)
    starting_balance: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    # The risk plan (PracticeThreadPlanV1): "yes" | "no" flags as the contract spells them.
    stop_note_on_entry: Mapped[str] = mapped_column(String, nullable=False)
    trade_only_on_signal: Mapped[str] = mapped_column(String, nullable=False)
    max_loss_usd: Mapped[int | None] = mapped_column(Integer)
    max_trades: Mapped[int | None] = mapped_column(Integer)
    plan_note: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String, nullable=False)  # "active" | "closed"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PracticeLedger(Base):
    """One realized practice trade, keyed by its exit mark (so booking twice is a no-op). Undoing the exit mark
    deletes the row with it. A swing row is keyed by its hold (Alembic 0008) and may have no session or mark: a hold
    that auto-exits at a close was never marked."""

    __tablename__ = "practice_ledger"
    __table_args__ = (
        UniqueConstraint("mark_id", name="uq_practice_ledger_mark_id"),
        Index("ix_practice_ledger_thread_id_day", "thread_id", "day"),
        Index("uq_practice_ledger_hold_id", "hold_id", unique=True, postgresql_where=text("hold_id IS NOT NULL")),
        CheckConstraint("side IN ('long', 'short')", name="ck_practice_ledger_side"),
        CheckConstraint(
            "hold_id IS NOT NULL OR (session_id IS NOT NULL AND mark_id IS NOT NULL)", name="ck_practice_ledger_source"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    thread_id: Mapped[int] = mapped_column(ForeignKey("practice_threads.id", ondelete="CASCADE"), nullable=False)
    # Null for a swing row that auto-exited at a close; `hold_id` then names the source.
    session_id: Mapped[int | None] = mapped_column(
        ForeignKey("replay_sessions.id", ondelete="CASCADE"), index=True, nullable=True
    )
    mark_id: Mapped[int | None] = mapped_column(ForeignKey("practice_marks.id", ondelete="CASCADE"), nullable=True)
    hold_id: Mapped[int | None] = mapped_column(
        ForeignKey("practice_holds.id", ondelete="CASCADE"), index=True, nullable=True
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    symbol: Mapped[str] = mapped_column(String, nullable=False)
    side: Mapped[str] = mapped_column(String, nullable=False)  # "long" | "short"
    shares: Mapped[int] = mapped_column(Integer, nullable=False)
    entry_price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    exit_price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    pnl_usd: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)  # the journal's own figure
    r: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))  # null when no stop was set
    realized_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


# -- Swing practice (Alembic 0008, 02p): multi-day practice holds and the weekly review --


class PracticeHold(Base):
    """A swing practice hold: open from the day she enters until she exits it (or a close does). A stop never exits
    it (it only flags `stop_hit_at`); the exit session and mark are null for an auto exit at a close. At most one open
    hold per symbol in a thread."""

    __tablename__ = "practice_holds"
    __table_args__ = (
        Index(
            "uq_practice_holds_thread_id_symbol_open",
            "thread_id",
            "symbol",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
        Index("ix_practice_holds_thread_id_status", "thread_id", "status"),
        CheckConstraint("side IN ('long', 'short')", name="ck_practice_holds_side"),
        CheckConstraint("status IN ('open', 'closed')", name="ck_practice_holds_status"),
        CheckConstraint("exit_source IS NULL OR exit_source IN ('her', 'auto')", name="ck_practice_holds_exit_source"),
        CheckConstraint("shares >= 1", name="ck_practice_holds_shares"),
        CheckConstraint(
            "(status = 'closed') = (exit_day IS NOT NULL AND exit_price IS NOT NULL AND exit_source IS NOT NULL)",
            name="ck_practice_holds_closed_fields",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    thread_id: Mapped[int] = mapped_column(ForeignKey("practice_threads.id", ondelete="CASCADE"), nullable=False)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    symbol: Mapped[str] = mapped_column(String, nullable=False)
    side: Mapped[str] = mapped_column(String, nullable=False)  # "long" | "short"
    shares: Mapped[int] = mapped_column(Integer, nullable=False)
    entry_day: Mapped[date] = mapped_column(Date, nullable=False)
    entry_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    entry_price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    # SET NULL: the hold outlives the session and mark it began on.
    entry_session_id: Mapped[int | None] = mapped_column(ForeignKey("replay_sessions.id", ondelete="SET NULL"))
    entry_mark_id: Mapped[int | None] = mapped_column(ForeignKey("practice_marks.id", ondelete="SET NULL"))
    stop_at_entry: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    stop_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    stop_hit_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String, nullable=False)  # "open" | "closed"
    exit_day: Mapped[date | None] = mapped_column(Date)
    exit_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exit_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    exit_session_id: Mapped[int | None] = mapped_column(ForeignKey("replay_sessions.id", ondelete="SET NULL"))
    exit_mark_id: Mapped[int | None] = mapped_column(ForeignKey("practice_marks.id", ondelete="SET NULL"))
    exit_source: Mapped[str | None] = mapped_column(String)  # "her" | "auto"
    # The latest official close the hold was valued at, restated to the day's share basis (R7).
    last_close: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    last_close_day: Mapped[date | None] = mapped_column(Date)
    splits: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PracticeWeek(Base):
    """One trading week of a swing thread: opens with its first day, closes with its last, and then carries the review
    the server built and her notes and rating. Keyed by (thread, week number)."""

    __tablename__ = "practice_weeks"
    __table_args__ = (
        CheckConstraint("status IN ('open', 'closed')", name="ck_practice_weeks_status"),
        CheckConstraint("rating IS NULL OR rating BETWEEN 1 AND 5", name="ck_practice_weeks_rating"),
        CheckConstraint("(status = 'closed') = (closed_at IS NOT NULL)", name="ck_practice_weeks_closed_at"),
    )

    thread_id: Mapped[int] = mapped_column(ForeignKey("practice_threads.id", ondelete="CASCADE"), primary_key=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    week_no: Mapped[int] = mapped_column(Integer, primary_key=True)
    first_day: Mapped[date] = mapped_column(Date, nullable=False)
    last_day: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)  # "open" | "closed"
    review: Mapped[Any | None] = mapped_column(JSONB)
    notes: Mapped[str | None] = mapped_column(Text)
    rating: Mapped[int | None] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# -- Feedback log (Alembic 0010, 02s): bugs and feature requests the family files from the Desk ---------------


class FeedbackReport(Base):
    """One bug or feature request (`F-001`, ...: the id, never reused). Every signed-in user reads every report; a bug
    carries a severity, a request does not. `fixed` always names its fix and `duplicate` its original."""

    __tablename__ = "feedback_reports"
    __table_args__ = (
        CheckConstraint("kind IN ('bug', 'request')", name="ck_feedback_reports_kind"),
        CheckConstraint(
            "severity IS NULL OR severity IN ('P0', 'P1', 'P2', 'P3')", name="ck_feedback_reports_severity"
        ),
        CheckConstraint("(kind = 'bug') = (severity IS NOT NULL)", name="ck_feedback_reports_kind_severity"),
        CheckConstraint(
            "status IN ('open', 'in_progress', 'fixed', 'wont_fix', 'duplicate')", name="ck_feedback_reports_status"
        ),
        CheckConstraint("status <> 'fixed' OR fix_ref IS NOT NULL", name="ck_feedback_reports_fixed_ref"),
        CheckConstraint("status <> 'duplicate' OR duplicate_of IS NOT NULL", name="ck_feedback_reports_duplicate_of"),
        Index("ix_feedback_reports_status_id", "status", text("id DESC")),
        Index("ix_feedback_reports_user_id", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)  # "bug" | "request"
    severity: Mapped[str | None] = mapped_column(String)  # "P0".."P3"; bugs only
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    expected: Mapped[str | None] = mapped_column(Text)
    screen: Mapped[str] = mapped_column(Text, nullable=False)
    route: Mapped[str] = mapped_column(Text, nullable=False)
    app_version: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[Any] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    links: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    # "open" | "in_progress" | "fixed" | "wont_fix" | "duplicate"
    status: Mapped[str] = mapped_column(String, nullable=False, default="open", server_default=text("'open'"))
    fix_ref: Mapped[str | None] = mapped_column(Text)  # a commit hash and/or `PR #nnn`
    duplicate_of: Mapped[int | None] = mapped_column(ForeignKey("feedback_reports.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class FeedbackEvent(Base):
    """The timeline of a report: one row for the filing (`from_status` null) and one per status change."""

    __tablename__ = "feedback_events"
    __table_args__ = (Index("ix_feedback_events_report_id_at", "report_id", "at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("feedback_reports.id", ondelete="CASCADE"), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    actor: Mapped[str] = mapped_column(String, nullable=False)  # "user" | "owner" | "claude-code" | "hermes"
    from_status: Mapped[str | None] = mapped_column(String)
    to_status: Mapped[str] = mapped_column(String, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)


class FeedbackAttachment(Base):
    """A screenshot, stored as bytes next to the report like `replay_blobs.payload`. `report_id` is null while the file
    is staged (uploaded before the report exists); staged files older than a day are swept on the next staging call."""

    __tablename__ = "feedback_attachments"
    __table_args__ = (
        CheckConstraint("size_bytes <= 5242880", name="ck_feedback_attachments_size_bytes"),
        Index("ix_feedback_attachments_report_id", "report_id"),
        Index("ix_feedback_attachments_user_staged", "user_id", postgresql_where=text("report_id IS NULL")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int | None] = mapped_column(ForeignKey("feedback_reports.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(String, nullable=False)  # "image/png" | "image/jpeg" | "image/webp"
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, deferred=True)  # never loaded with the row
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


# -- Fundamental lane (Alembic 0012, 02n §d) ------------------------------------------------------------------------
# Created in FK-dependency order: accounts -> holding_imports -> holding_lots, holding_trades; the scan, IV and
# fundamentals tables stand alone; ai_verdicts -> ai_calls. Quantities and prices are floats like the engine's own
# `covered_calls.Lot` and `OptionQuote` (a report is read, never settled against). Option rows say which side of the
# chain they sit on with `option_right`: `right` is a reserved word in SQL.


class Account(Base):
    """One broker account of one Desk user. `external_id` is the broker's account number: it only matches an import to
    its account and no endpoint ever returns it (02n §c1); the owner sees `label` and `type`."""

    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint("broker", "external_id", name="uq_accounts_broker_external_id"),
        CheckConstraint("type IN ('taxable', 'ira', 'roth')", name="ck_accounts_type"),
        Index("ix_accounts_owner_user_id", "owner_user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    broker: Mapped[str] = mapped_column(String, nullable=False, default="ibkr", server_default=text("'ibkr'"))
    external_id: Mapped[str] = mapped_column(String, nullable=False)
    label: Mapped[str] = mapped_column(String, nullable=False)  # owner-set; "Account 1" until then
    type: Mapped[str] = mapped_column(String, nullable=False, default="taxable", server_default=text("'taxable'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class HoldingImport(Base):
    """One account's import of one statement date, idempotent per (account, statement date): a re-run replaces the
    row's lots. `state` is stored for statements that were read; "not configured" and "none" are read-time answers.
    `detail` carries counts and states, never values (02d §7)."""

    __tablename__ = "holding_imports"
    __table_args__ = (
        UniqueConstraint("account_id", "statement_date", name="uq_holding_imports_account_id_statement_date"),
        CheckConstraint("source IN ('ibkr_flex')", name="ck_holding_imports_source"),
        CheckConstraint("state IN ('running', 'ok', 'failed')", name="ck_holding_imports_state"),
        CheckConstraint("lots >= 0", name="ck_holding_imports_lots"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False, default="ibkr_flex", server_default=text("'ibkr_flex'"))
    statement_date: Mapped[date] = mapped_column(Date, nullable=False)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    lots: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    state: Mapped[str] = mapped_column(String, nullable=False, default="ok", server_default=text("'ok'"))
    detail: Mapped[str | None] = mapped_column(Text)


class HoldingLot(Base):
    """One LOT row of a statement: a stock lot (`STK`, with `acquired`) or an option lot (`OPT`, with right, strike and
    expiry; a negative `quantity` is a short position, in contracts). `account_id` repeats the import's for the
    per-symbol reads."""

    __tablename__ = "holding_lots"
    __table_args__ = (
        CheckConstraint("quantity <> 0", name="ck_holding_lots_quantity"),
        CheckConstraint("multiplier >= 1", name="ck_holding_lots_multiplier"),
        CheckConstraint(
            "(asset_class = 'STK' AND option_right IS NULL AND strike IS NULL AND expiry IS NULL) OR "
            "(asset_class = 'OPT' AND option_right IN ('C', 'P') AND strike > 0 AND expiry IS NOT NULL)",
            name="ck_holding_lots_asset_class",
        ),
        Index("ix_holding_lots_import_id", "import_id"),
        Index("ix_holding_lots_account_id_symbol", "account_id", "symbol"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    import_id: Mapped[int] = mapped_column(ForeignKey("holding_imports.id", ondelete="CASCADE"), nullable=False)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False)
    symbol: Mapped[str] = mapped_column(String, nullable=False)  # the underlying, for an option lot too
    asset_class: Mapped[str] = mapped_column(String, nullable=False)  # "STK" | "OPT"
    quantity: Mapped[float] = mapped_column(Float, nullable=False)
    cost_per_share: Mapped[float | None] = mapped_column(Float)
    acquired: Mapped[date | None] = mapped_column(Date)
    option_right: Mapped[str | None] = mapped_column(String)  # "C" | "P"
    strike: Mapped[float | None] = mapped_column(Float)
    expiry: Mapped[date | None] = mapped_column(Date)
    multiplier: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default=text("1"))


class HoldingTrade(Base):
    """An option trade from the data user's Flex `Trades` section: the sells, buys, assignments and expirations that the
    premium-income history is summed from. Unique per (account, broker trade reference), so overlapping 365-day
    statements never count a trade twice. `quantity` is in contracts and signed like the broker's."""

    __tablename__ = "holding_trades"
    __table_args__ = (
        UniqueConstraint("account_id", "external_ref", name="uq_holding_trades_account_id_external_ref"),
        CheckConstraint("option_right IN ('C', 'P')", name="ck_holding_trades_option_right"),
        CheckConstraint("strike > 0", name="ck_holding_trades_strike"),
        CheckConstraint(
            "kind IN ('sell_to_open', 'buy_to_close', 'buy_to_open', 'sell_to_close', 'assignment', 'expiration')",
            name="ck_holding_trades_kind",
        ),
        Index("ix_holding_trades_account_id_trade_date", "account_id", "trade_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False)
    external_ref: Mapped[str] = mapped_column(String, nullable=False)
    symbol: Mapped[str] = mapped_column(String, nullable=False)  # the underlying
    option_right: Mapped[str] = mapped_column(String, nullable=False)
    strike: Mapped[float] = mapped_column(Float, nullable=False)
    expiry: Mapped[date] = mapped_column(Date, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    trade_date: Mapped[date] = mapped_column(Date, nullable=False)
    quantity: Mapped[float] = mapped_column(Float, nullable=False)
    price: Mapped[float] = mapped_column(Float, nullable=False)  # premium per share
    multiplier: Mapped[int] = mapped_column(Integer, nullable=False, default=100, server_default=text("100"))
    commission: Mapped[float | None] = mapped_column(Float)


class CoveredCallScan(Base):
    """One scan of one holding in one account (02n §d `covered_calls/scan.py`): the engine's top candidates as it
    returned them, with the chain's own `stamp` (`{as_of, source, quality, freshness}`), so a delayed or missing chain
    is stored as such. A stored scan is never rewritten; the latest `run_at` is the one the screens read."""

    __tablename__ = "covered_call_scans"
    __table_args__ = (
        CheckConstraint("iv_rank IS NULL OR iv_rank BETWEEN 0 AND 100", name="ck_covered_call_scans_iv_rank"),
    )

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    spot: Mapped[float | None] = mapped_column(Float)
    stamp: Mapped[Any] = mapped_column(JSONB, nullable=False)
    iv_rank: Mapped[float | None] = mapped_column(Float)  # null until 60 sessions of `iv_history` exist
    opportunity: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    candidates: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))


class IvHistory(Base):
    """One day's 30-day implied volatility of a symbol, the series `core.covered_calls.iv_rank` reads (latest day last).
    `source` and `quality` name where the point came from, so a delayed chain's IV is never filed as real-time."""

    __tablename__ = "iv_history"
    __table_args__ = (CheckConstraint("iv30 > 0", name="ck_iv_history_iv30"),)

    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    iv30: Mapped[float] = mapped_column(Float, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)
    quality: Mapped[str] = mapped_column(String, nullable=False)


class SymbolFundamental(Base):
    """The 02n §c4 metric row of one symbol, as of one time; a metric that cannot be computed is null in `metrics`."""

    __tablename__ = "symbol_fundamentals"

    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    metrics: Mapped[Any] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))


class AiVerdict(Base):
    """The Desk AI's verdict of one symbol on one trading day (02f §5): the rating, the 12-month target, the votes, the
    inputs with their as-of times, the model, tokens and cost. The checks 02f §5 makes in code are repeated here:
    0 < low <= base <= high and confidence within 0-100. The rating's value set is the step-5 spec's, so it is free
    text here."""

    __tablename__ = "ai_verdicts"
    __table_args__ = (
        CheckConstraint(
            "target_low > 0 AND target_low <= target_base AND target_base <= target_high", name="ck_ai_verdicts_target"
        ),
        CheckConstraint("confidence BETWEEN 0 AND 100", name="ck_ai_verdicts_confidence"),
    )

    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    trading_day: Mapped[date] = mapped_column(Date, primary_key=True)
    rating: Mapped[str] = mapped_column(String, nullable=False)
    target_low: Mapped[float] = mapped_column(Float, nullable=False)
    target_base: Mapped[float] = mapped_column(Float, nullable=False)
    target_high: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[int] = mapped_column(Integer, nullable=False)
    reasons: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    risks: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    changed: Mapped[str | None] = mapped_column(Text)  # what changed since the previous day's verdict
    votes: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    bull: Mapped[str | None] = mapped_column(Text)
    bear: Mapped[str | None] = mapped_column(Text)
    inputs: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    model: Mapped[str] = mapped_column(String, nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    content_hash: Mapped[str] = mapped_column(
        String, nullable=False
    )  # the cache key: the same inputs, the same verdict
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AiCall(Base):
    """A Desk AI rating change (02h §3): the calls the track record counts, one per verdict whose rating differs from
    the one before. Its outcome after 90 trading days is the settlement job's own table, not added yet."""

    __tablename__ = "ai_calls"
    __table_args__ = (
        UniqueConstraint("symbol", "trading_day", name="uq_ai_calls_symbol_trading_day"),
        ForeignKeyConstraint(
            ["symbol", "trading_day"],
            ["ai_verdicts.symbol", "ai_verdicts.trading_day"],
            name="fk_ai_calls_symbol_trading_day_ai_verdicts",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String, nullable=False)
    trading_day: Mapped[date] = mapped_column(Date, nullable=False)
    rating: Mapped[str] = mapped_column(String, nullable=False)
    prev_rating: Mapped[str | None] = mapped_column(String)  # null for a symbol's first verdict
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
