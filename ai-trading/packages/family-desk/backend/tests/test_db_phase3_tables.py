"""Phase 3 (Alembic `0002`) table constraints: the three named unique constraints, the
`watchlist_items` composite primary key, the `strategies.current_version_id` <-> `strategy_versions`
round trip with no FK (db/models.py's own note), and the named foreign keys. Needs a real Postgres
(`scripts/test-db.sh`)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.db.models import Alert, Delivery, Signal, Strategy, StrategyVersion, User, Watchlist, WatchlistItem

NOW = datetime(2026, 10, 12, 20, 0, tzinfo=UTC)


def _make_user(session: Session, email: str = "owner@example.test") -> int:
    user_id = session.execute(insert(User).values(email=email).returning(User.id)).scalar_one()
    session.commit()
    return user_id


def _make_strategy_version(session: Session, user_id: int, *, version: int = 1) -> tuple[int, int]:
    strategy_id = session.execute(
        insert(Strategy).values(owner_user_id=user_id, name="gap-and-go", created_at=NOW).returning(Strategy.id)
    ).scalar_one()
    version_id = session.execute(
        insert(StrategyVersion)
        .values(
            strategy_id=strategy_id,
            version=version,
            schema_version=1,
            spec={"template": "gap_and_go"},
            created_by=user_id,
            created_at=NOW,
        )
        .returning(StrategyVersion.id)
    ).scalar_one()
    session.commit()
    return strategy_id, version_id


# --- unique constraints ----------------------------------------------------------------------------


def test_users_email_unique_rejects_a_duplicate(db_session: Session) -> None:
    _make_user(db_session, "dup@example.test")
    with pytest.raises(IntegrityError):
        db_session.execute(insert(User).values(email="dup@example.test"))
        db_session.commit()
    db_session.rollback()


def test_strategy_versions_unique_strategy_id_version_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    strategy_id, _ = _make_strategy_version(db_session, user_id, version=1)
    with pytest.raises(IntegrityError):
        db_session.execute(
            insert(StrategyVersion).values(
                strategy_id=strategy_id,
                version=1,
                schema_version=1,
                spec={"template": "gap_and_go"},
                created_by=user_id,
                created_at=NOW,
            )
        )
        db_session.commit()
    db_session.rollback()


def test_signals_unique_dedupe_key_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _, version_id = _make_strategy_version(db_session, user_id)
    db_session.execute(
        insert(Signal).values(
            strategy_version_id=version_id,
            symbol="AAPL",
            bar_time=NOW,
            evidence={},
            data_quality="delayed-15m",
            created_at=NOW,
        )
    )
    db_session.commit()
    with pytest.raises(IntegrityError):
        db_session.execute(
            insert(Signal).values(
                strategy_version_id=version_id,
                symbol="AAPL",
                bar_time=NOW,
                evidence={"different": True},
                data_quality="delayed-15m",
                created_at=NOW,
            )
        )
        db_session.commit()
    db_session.rollback()


# --- watchlist_items composite primary key ----------------------------------------------------------


def test_watchlist_items_composite_primary_key_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    watchlist_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="AAPL", asset_type="stock"))
    db_session.commit()
    with pytest.raises(IntegrityError):
        db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="AAPL", asset_type="stock"))
        db_session.commit()
    db_session.rollback()


def test_watchlist_items_allows_the_same_symbol_on_a_different_watchlist(db_session: Session) -> None:
    user_id = _make_user(db_session)
    first_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    second_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="intraday", horizon="intraday").returning(Watchlist.id)
    ).scalar_one()
    db_session.execute(insert(WatchlistItem).values(watchlist_id=first_id, symbol="AAPL", asset_type="stock"))
    db_session.execute(insert(WatchlistItem).values(watchlist_id=second_id, symbol="AAPL", asset_type="stock"))
    db_session.commit()  # no IntegrityError: the pair (watchlist_id, symbol) differs each time


# --- strategies.current_version_id: no FK, round trip allowed ---------------------------------------


def test_strategies_current_version_id_round_trips_with_no_fk_error(db_session: Session) -> None:
    user_id = _make_user(db_session)
    strategy_id, version_id = _make_strategy_version(db_session, user_id)
    db_session.execute(update(Strategy).where(Strategy.id == strategy_id).values(current_version_id=version_id))
    db_session.commit()  # would raise IntegrityError here if a FK existed and were ever violated

    row = db_session.execute(select(Strategy).where(Strategy.id == strategy_id)).scalar_one()
    assert row.current_version_id == version_id


# --- named foreign keys ------------------------------------------------------------------------------


def test_watchlists_user_id_foreign_key_rejects_an_unknown_user(db_session: Session) -> None:
    with pytest.raises(IntegrityError):
        db_session.execute(insert(Watchlist).values(user_id=999_999, name="ghost", horizon="swing"))
        db_session.commit()
    db_session.rollback()


def test_signals_strategy_version_id_foreign_key_rejects_an_unknown_version(db_session: Session) -> None:
    with pytest.raises(IntegrityError):
        db_session.execute(
            insert(Signal).values(
                strategy_version_id=999_999,
                symbol="AAPL",
                bar_time=NOW,
                evidence={},
                data_quality="eod",
                created_at=NOW,
            )
        )
        db_session.commit()
    db_session.rollback()


def test_deliveries_alert_id_foreign_key_rejects_an_unknown_alert(db_session: Session) -> None:
    with pytest.raises(IntegrityError):
        db_session.execute(insert(Delivery).values(alert_id=999_999, channel="inbox"))
        db_session.commit()
    db_session.rollback()


# --- delete rules (integration fix, PROTO-BRIEF.md ruling): RESTRICT for signals ->
# strategy_versions and strategy_versions -> strategies; CASCADE for watchlist_items ->
# watchlists, watchlists -> users, and deliveries -> alerts. ---------------------------------------


def test_deleting_a_watchlist_cascades_to_its_items(db_session: Session) -> None:
    user_id = _make_user(db_session)
    watchlist_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="AAPL", asset_type="stock"))
    db_session.commit()

    db_session.execute(delete(Watchlist).where(Watchlist.id == watchlist_id))
    db_session.commit()

    remaining = (
        db_session.execute(select(WatchlistItem).where(WatchlistItem.watchlist_id == watchlist_id)).scalars().all()
    )
    assert remaining == []


def test_deleting_a_user_cascades_to_their_watchlists(db_session: Session) -> None:
    user_id = _make_user(db_session)
    watchlist_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    db_session.commit()

    db_session.execute(delete(User).where(User.id == user_id))
    db_session.commit()

    remaining = db_session.execute(select(Watchlist).where(Watchlist.id == watchlist_id)).scalars().all()
    assert remaining == []


def test_deleting_an_alert_cascades_to_its_deliveries(db_session: Session) -> None:
    user_id = _make_user(db_session)
    alert_id = db_session.execute(
        insert(Alert)
        .values(user_id=user_id, kind="system", severity="info", title="t", body="b", created_at=NOW)
        .returning(Alert.id)
    ).scalar_one()
    delivery_id = db_session.execute(
        insert(Delivery).values(alert_id=alert_id, channel="inbox").returning(Delivery.id)
    ).scalar_one()
    db_session.commit()

    db_session.execute(delete(Alert).where(Alert.id == alert_id))
    db_session.commit()

    remaining = db_session.execute(select(Delivery).where(Delivery.id == delivery_id)).scalars().all()
    assert remaining == []


def test_deleting_a_strategy_is_restricted_by_an_existing_version(db_session: Session) -> None:
    user_id = _make_user(db_session)
    strategy_id, _ = _make_strategy_version(db_session, user_id)

    with pytest.raises(IntegrityError):
        db_session.execute(delete(Strategy).where(Strategy.id == strategy_id))
        db_session.commit()
    db_session.rollback()


def test_deleting_a_strategy_version_is_restricted_by_an_existing_signal(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _, version_id = _make_strategy_version(db_session, user_id)
    db_session.execute(
        insert(Signal).values(
            strategy_version_id=version_id,
            symbol="AAPL",
            bar_time=NOW,
            evidence={},
            data_quality="delayed-15m",
            created_at=NOW,
        )
    )
    db_session.commit()

    with pytest.raises(IntegrityError):
        db_session.execute(delete(StrategyVersion).where(StrategyVersion.id == version_id))
        db_session.commit()
    db_session.rollback()
