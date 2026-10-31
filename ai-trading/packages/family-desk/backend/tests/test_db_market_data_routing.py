"""Market-data routing (Alembic `0013`, 02t §3.5): the family-scoped preference table's shape, its defaults,
and the version bump the toggle and the sync job rely on. Needs a real Postgres (`scripts/test-db.sh`).
"""

from datetime import UTC, datetime

from sqlalchemy import insert, inspect

from ai_trading.data import routing as routing_store
from ai_trading.db.models import MarketDataRouting

NOW = datetime(2026, 10, 31, 15, 0, tzinfo=UTC)


def test_the_table_has_one_row_per_data_class_and_nothing_owner_scoped(db_session):
    inspector = inspect(db_session.get_bind())
    columns = [column["name"] for column in inspector.get_columns("market_data_routing")]
    assert columns == ["data_class", "preferred", "version", "updated_by", "updated_at"]
    assert inspector.get_pk_constraint("market_data_routing")["constrained_columns"] == ["data_class"]
    # One value for the whole family: no user_id, no FK, exactly as 02t ruling 12 asks.
    assert "user_id" not in columns


def test_the_version_defaults_to_zero_and_the_preference_starts_empty(db_session):
    db_session.execute(insert(MarketDataRouting).values(data_class="equity_quotes", updated_at=NOW))
    db_session.commit()
    stored = routing_store.read(db_session)
    assert stored.unused is True
    assert stored.preferences == {"equity_quotes": ""}


def test_recording_a_choice_bumps_the_family_version(db_session):
    first = routing_store.record(
        db_session, data_class="equity_quotes", provider="ibkr", updated_by="owner@example.test", now=NOW
    )
    assert (first.version, first.preferences["equity_quotes"]) == (1, "ibkr")
    second = routing_store.record(
        db_session, data_class="equity_bars", provider="alpaca", updated_by="owner@example.test", now=NOW
    )
    assert (second.version, second.preferences) == (2, {"equity_quotes": "ibkr", "equity_bars": "alpaca"})


def test_clearing_a_choice_stores_no_preference(db_session):
    routing_store.record(
        db_session, data_class="equity_quotes", provider="ibkr", updated_by="owner@example.test", now=NOW
    )
    cleared = routing_store.record(
        db_session, data_class="equity_quotes", provider="", updated_by="owner@example.test", now=NOW
    )
    assert cleared.preferences["equity_quotes"] == ""
    assert db_session.get(MarketDataRouting, "equity_quotes").preferred is None
    assert db_session.get(MarketDataRouting, "equity_quotes").version == cleared.version


def test_an_unknown_data_class_is_refused(db_session):
    try:
        routing_store.record(db_session, data_class="futures", provider="alpaca", updated_by="x", now=NOW)
    except ValueError as exc:
        assert "unknown data class" in str(exc)
    else:  # pragma: no cover - the assertion is the test
        raise AssertionError("expected ValueError")