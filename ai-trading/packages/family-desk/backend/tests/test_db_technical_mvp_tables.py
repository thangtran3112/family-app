"""Technical desktop MVP (Alembic `0003`, 02m §b2) table constraints and defaults: watchlist name
uniqueness, the new watchlist-item, strategy, and alert columns, the screener filter tables, the
universe/metrics/feed-health tables, and the 0002 -> head data migration that renames duplicate
watchlist names and backfills item positions. Needs a real Postgres (`scripts/test-db.sh`).

Test passwords/emails below are throwaway fixtures (example.test), never a real secret or address.
"""

import os
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, create_engine, delete, insert, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.db.models import (
    Alert,
    FeedHealth,
    FilterMatch,
    FilterRun,
    FilterStrategy,
    FilterStrategyVersion,
    SymbolMetrics,
    UniverseSymbol,
    User,
    Watchlist,
    WatchlistItem,
)

NOW = datetime(2026, 10, 24, 20, 0, tzinfo=UTC)

_URL_VAR = "DESK_TEST_DATABASE_URL"
_REQUIRE_VAR = "DESK_REQUIRE_DB"
_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


def _alembic_config(url: str) -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def _make_user(session: Session, email: str = "owner@example.test") -> int:
    user_id = session.execute(insert(User).values(email=email).returning(User.id)).scalar_one()
    session.commit()
    return user_id


def _make_watchlist(session: Session, user_id: int, name: str = "core") -> int:
    watchlist_id = session.execute(
        insert(Watchlist).values(user_id=user_id, name=name, horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    session.commit()
    return watchlist_id


def _make_filter_strategy(session: Session, user_id: int, name: str = "breakout") -> int:
    filter_id = session.execute(
        insert(FilterStrategy)
        .values(owner_user_id=user_id, name=name, origin="user", created_at=NOW)
        .returning(FilterStrategy.id)
    ).scalar_one()
    session.commit()
    return filter_id


def _make_filter_version(session: Session, user_id: int, filter_id: int, *, version: int = 1) -> int:
    version_id = session.execute(
        insert(FilterStrategyVersion)
        .values(
            filter_strategy_id=filter_id,
            version=version,
            schema_version=1,
            spec={"template": "breakout"},
            created_by=user_id,
            created_at=NOW,
        )
        .returning(FilterStrategyVersion.id)
    ).scalar_one()
    session.commit()
    return version_id


def _make_filter_run(session: Session, version_id: int) -> int:
    run_id = session.execute(
        insert(FilterRun)
        .values(
            filter_strategy_version_id=version_id,
            run_on="2026-10-23",
            session="regular",
            evaluation_point=NOW,
            scanned=100,
            no_data=3,
            matches_total=1,
            source="bars_delayed",
            quality="delayed-15m",
            created_at=NOW,
        )
        .returning(FilterRun.id)
    ).scalar_one()
    session.commit()
    return run_id


def _make_filter_match(session: Session, run_id: int, symbol: str = "AAPL") -> None:
    session.execute(
        insert(FilterMatch).values(
            run_id=run_id,
            symbol=symbol,
            rank=1,
            rank_value=1.0,
            matched_since=NOW,
            operands={},
            columns={},
        )
    )
    session.commit()


def _insert_watchlist(conn: Connection, user_id: int, name: str) -> int:
    return conn.execute(
        text("INSERT INTO watchlists (user_id, name, horizon) VALUES (:u, :name, 'swing') RETURNING id"),
        {"u": user_id, "name": name},
    ).scalar_one()


# --- watchlists: unique (user_id, name) ------------------------------------------------------------


def test_watchlists_unique_user_and_name_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _make_watchlist(db_session, user_id, "core")
    with pytest.raises(IntegrityError):
        _make_watchlist(db_session, user_id, "core")
    db_session.rollback()


def test_watchlists_name_can_be_reused_by_a_different_user(db_session: Session) -> None:
    first = _make_user(db_session, "first@example.test")
    second = _make_user(db_session, "second@example.test")
    _make_watchlist(db_session, first, "core")
    _make_watchlist(db_session, second, "core")  # no IntegrityError: the pair (user_id, name) differs


# --- column defaults (raw SQL leaves the columns out, so the server default is what's tested) ------


def test_watchlist_items_position_defaults_to_zero(db_session: Session) -> None:
    user_id = _make_user(db_session)
    watchlist_id = _make_watchlist(db_session, user_id)
    db_session.execute(
        text("INSERT INTO watchlist_items (watchlist_id, symbol, asset_type) VALUES (:wl, 'AAPL', 'stock')"),
        {"wl": watchlist_id},
    )
    db_session.commit()
    position = db_session.execute(
        select(WatchlistItem.position).where(WatchlistItem.watchlist_id == watchlist_id)
    ).scalar_one()
    assert position == 0


def test_strategies_lane_origin_and_archived_at_defaults(db_session: Session) -> None:
    user_id = _make_user(db_session)
    strategy_id = db_session.execute(
        text("INSERT INTO strategies (owner_user_id, name, created_at) VALUES (:u, 'gap-and-go', :now) RETURNING id"),
        {"u": user_id, "now": NOW},
    ).scalar_one()
    db_session.commit()
    row = db_session.execute(
        text("SELECT lane, origin, archived_at FROM strategies WHERE id = :id"), {"id": strategy_id}
    ).one()
    assert (row.lane, row.origin, row.archived_at) == ("technical", "user", None)


# --- filter_strategies: live name unique per owner, archived names reusable, cascade from user ------


def test_filter_strategies_live_name_is_unique_per_owner(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _make_filter_strategy(db_session, user_id, "breakout")
    with pytest.raises(IntegrityError):
        _make_filter_strategy(db_session, user_id, "breakout")
    db_session.rollback()


def test_filter_strategies_archived_name_can_be_reused(db_session: Session) -> None:
    user_id = _make_user(db_session)
    first_id = _make_filter_strategy(db_session, user_id, "breakout")
    db_session.execute(update(FilterStrategy).where(FilterStrategy.id == first_id).values(archived_at=NOW))
    db_session.commit()
    _make_filter_strategy(db_session, user_id, "breakout")  # the partial unique index skips archived rows


def test_deleting_a_user_cascades_to_their_filter_strategies(db_session: Session) -> None:
    user_id = _make_user(db_session)
    filter_id = _make_filter_strategy(db_session, user_id)
    db_session.execute(delete(User).where(User.id == user_id))
    db_session.commit()
    remaining = db_session.execute(select(FilterStrategy).where(FilterStrategy.id == filter_id)).scalars().all()
    assert remaining == []


# --- filter_strategy_versions: unique (filter_strategy_id, version); RESTRICT from the filter ---------


def test_filter_strategy_versions_unique_filter_and_version_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    filter_id = _make_filter_strategy(db_session, user_id)
    _make_filter_version(db_session, user_id, filter_id, version=1)
    with pytest.raises(IntegrityError):
        _make_filter_version(db_session, user_id, filter_id, version=1)
    db_session.rollback()


def test_deleting_a_filter_strategy_is_restricted_by_an_existing_version(db_session: Session) -> None:
    user_id = _make_user(db_session)
    filter_id = _make_filter_strategy(db_session, user_id)
    _make_filter_version(db_session, user_id, filter_id)
    with pytest.raises(IntegrityError):
        db_session.execute(delete(FilterStrategy).where(FilterStrategy.id == filter_id))
        db_session.commit()
    db_session.rollback()


# --- filter_runs and filter_matches -------------------------------------------------------------------


def test_filter_runs_unique_evaluation_key_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    version_id = _make_filter_version(db_session, user_id, _make_filter_strategy(db_session, user_id))
    _make_filter_run(db_session, version_id)
    with pytest.raises(IntegrityError):
        _make_filter_run(db_session, version_id)
    db_session.rollback()


def test_filter_matches_primary_key_rejects_a_duplicate_symbol_in_a_run(db_session: Session) -> None:
    user_id = _make_user(db_session)
    version_id = _make_filter_version(db_session, user_id, _make_filter_strategy(db_session, user_id))
    run_id = _make_filter_run(db_session, version_id)
    _make_filter_match(db_session, run_id, "AAPL")
    with pytest.raises(IntegrityError):
        _make_filter_match(db_session, run_id, "AAPL")
    db_session.rollback()


def test_deleting_a_filter_run_cascades_to_its_matches(db_session: Session) -> None:
    user_id = _make_user(db_session)
    version_id = _make_filter_version(db_session, user_id, _make_filter_strategy(db_session, user_id))
    run_id = _make_filter_run(db_session, version_id)
    _make_filter_match(db_session, run_id, "AAPL")
    # Only the run is deleted: its version is RESTRICT-protected, but the run is the referencing side.
    db_session.execute(delete(FilterRun).where(FilterRun.id == run_id))
    db_session.commit()
    remaining = db_session.execute(select(FilterMatch).where(FilterMatch.run_id == run_id)).scalars().all()
    assert remaining == []


# --- alerts: symbol and strategy_id ----------------------------------------------------------------------


def test_alerts_symbol_and_strategy_id_are_nullable(db_session: Session) -> None:
    user_id = _make_user(db_session)
    alert_id = db_session.execute(
        insert(Alert)
        .values(user_id=user_id, kind="system", severity="info", title="t", body="b", created_at=NOW)
        .returning(Alert.id)
    ).scalar_one()
    db_session.commit()
    row = db_session.execute(select(Alert.symbol, Alert.strategy_id).where(Alert.id == alert_id)).one()
    assert (row.symbol, row.strategy_id) == (None, None)


def test_alerts_strategy_id_foreign_key_rejects_an_unknown_strategy(db_session: Session) -> None:
    user_id = _make_user(db_session)
    with pytest.raises(IntegrityError):
        db_session.execute(
            insert(Alert).values(
                user_id=user_id,
                kind="signal",
                severity="info",
                title="t",
                body="b",
                created_at=NOW,
                strategy_id=999_999,
            )
        )
        db_session.commit()
    db_session.rollback()


# --- universe_symbols, symbol_metrics, feed_health: basic insert and primary key -------------------------


def test_universe_symbols_inserts_and_rejects_a_duplicate_symbol(db_session: Session) -> None:
    row = {
        "symbol": "AAPL",
        "name": "Test Company",
        "asset_type": "stock",
        "exchange": "NASDAQ",
        "active": True,
        "passed_floor": True,
        "floor_reason": None,
        "updated_at": NOW,
    }
    db_session.execute(insert(UniverseSymbol).values(**row))
    db_session.commit()
    with pytest.raises(IntegrityError):
        db_session.execute(insert(UniverseSymbol).values(**row))
        db_session.commit()
    db_session.rollback()


def test_symbol_metrics_inserts_and_rejects_a_duplicate_symbol(db_session: Session) -> None:
    row = {
        "symbol": "AAPL",
        "as_of": NOW,
        "source": "bars_delayed",
        "quality": "delayed-15m",
        "metrics": {"rsi_14": 55.2},
    }
    db_session.execute(insert(SymbolMetrics).values(**row))
    db_session.commit()
    with pytest.raises(IntegrityError):
        db_session.execute(insert(SymbolMetrics).values(**row))
        db_session.commit()
    db_session.rollback()


def test_feed_health_accepts_a_null_last_ok_at_and_rejects_a_duplicate_feed(db_session: Session) -> None:
    row = {"feed": "bars_delayed", "state": "down", "last_ok_at": None, "detail": "no pass yet", "updated_at": NOW}
    db_session.execute(insert(FeedHealth).values(**row))
    db_session.commit()
    with pytest.raises(IntegrityError):
        db_session.execute(insert(FeedHealth).values(**row))
        db_session.commit()
    db_session.rollback()


# --- data migration: 0002 -> head ----------------------------------------------------------------------


@pytest.fixture
def scratch_db_url() -> Iterator[str]:
    """A throwaway database on the test server, dropped again after the test (as test_db_roles does)."""
    server_url = os.environ.get(_URL_VAR)
    if not server_url:
        if os.environ.get(_REQUIRE_VAR) == "1":
            pytest.fail(f"{_URL_VAR} is unset and {_REQUIRE_VAR}=1")
        pytest.skip(f"{_URL_VAR} is not set")

    db_name = f"desk_0003_{uuid.uuid4().hex[:12]}"
    admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin_engine.dispose()
    try:
        yield make_url(server_url).set(database=db_name).render_as_string(hide_password=False)
    finally:
        admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
        with admin_engine.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{db_name}" WITH (FORCE)'))
        admin_engine.dispose()


def test_0003_renames_duplicate_watchlist_names_and_backfills_item_positions(scratch_db_url: str) -> None:
    cfg = _alembic_config(scratch_db_url)
    command.upgrade(cfg, "0002")

    # Legacy data at 0002: two watchlists with the same name (allowed then), and one list whose
    # items were inserted out of alphabetical order (C, A, B).
    engine = create_engine(scratch_db_url)
    try:
        with engine.begin() as conn:
            user_id = conn.execute(
                text("INSERT INTO users (email) VALUES (:email) RETURNING id"), {"email": "legacy@example.test"}
            ).scalar_one()
            first_id = _insert_watchlist(conn, user_id, "Name")
            second_id = _insert_watchlist(conn, user_id, "Name")
            core_id = _insert_watchlist(conn, user_id, "Core")
            for symbol in ("C", "A", "B"):
                conn.execute(
                    text(
                        "INSERT INTO watchlist_items (watchlist_id, symbol, asset_type) VALUES (:wl, :symbol, 'stock')"
                    ),
                    {"wl": core_id, "symbol": symbol},
                )
    finally:
        engine.dispose()

    command.upgrade(cfg, "head")

    engine = create_engine(scratch_db_url)
    try:
        with engine.connect() as conn:
            names = dict(conn.execute(text("SELECT id, name FROM watchlists WHERE user_id = :u"), {"u": user_id}).all())
            positions = dict(
                conn.execute(
                    text("SELECT symbol, position FROM watchlist_items WHERE watchlist_id = :wl"), {"wl": core_id}
                ).all()
            )
    finally:
        engine.dispose()

    assert (names[first_id], names[second_id]) == ("Name", "Name (2)")
    assert positions == {"A": 0, "B": 1, "C": 2}
