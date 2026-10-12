from datetime import UTC, datetime, timedelta

from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.db.models import Signal, Strategy, StrategyVersion, User

NOW = datetime(2026, 7, 15, 20, 0, tzinfo=UTC)


def _user_id(client, db_session, email: str) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _make_signal(db_session, owner_id: int, *, symbol: str = "AAPL", bar_time=NOW, created_at=NOW) -> Signal:
    strategy = Strategy(owner_user_id=owner_id, name="S", stage="alert_only", created_at=NOW)
    db_session.add(strategy)
    db_session.flush()
    version = StrategyVersion(
        strategy_id=strategy.id, version=1, schema_version=1, spec={}, created_by=owner_id, created_at=NOW
    )
    db_session.add(version)
    db_session.flush()
    signal = Signal(
        strategy_version_id=version.id,
        symbol=symbol,
        bar_time=bar_time,
        evidence={"close": 101.0},
        data_quality="eod",
        created_at=created_at,
    )
    db_session.add(signal)
    db_session.flush()
    return signal


def test_signals_are_scoped_to_the_owning_strategys_user(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    other_id = _user_id(client, db_session, OTHER_EMAIL)
    mine = _make_signal(db_session, owner_id)
    _make_signal(db_session, other_id, bar_time=NOW + timedelta(minutes=1))

    response = client.get("/api/desk/signals", headers=auth_headers(OWNER_EMAIL))

    assert [row["id"] for row in response.json()] == [mine.id]


def test_signals_filter_by_symbol(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    aapl = _make_signal(db_session, owner_id, symbol="AAPL")
    _make_signal(db_session, owner_id, symbol="MSFT", bar_time=NOW + timedelta(minutes=1))

    response = client.get("/api/desk/signals", params={"symbol": "AAPL"}, headers=auth_headers(OWNER_EMAIL))

    assert [row["id"] for row in response.json()] == [aapl.id]


def test_signals_filter_by_since(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    older = _make_signal(db_session, owner_id, bar_time=NOW, created_at=NOW - timedelta(days=1))
    newer = _make_signal(db_session, owner_id, bar_time=NOW + timedelta(minutes=1), created_at=NOW)

    response = client.get("/api/desk/signals", params={"since": NOW.isoformat()}, headers=auth_headers(OWNER_EMAIL))

    ids = [row["id"] for row in response.json()]
    assert newer.id in ids
    assert older.id not in ids


def test_signals_pagination_limit_and_offset_in_newest_first_order(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    first = _make_signal(db_session, owner_id, bar_time=NOW, created_at=NOW - timedelta(minutes=2))
    second = _make_signal(
        db_session, owner_id, bar_time=NOW + timedelta(minutes=1), created_at=NOW - timedelta(minutes=1)
    )
    third = _make_signal(db_session, owner_id, bar_time=NOW + timedelta(minutes=2), created_at=NOW)

    page1 = client.get("/api/desk/signals", params={"limit": 1}, headers=auth_headers(OWNER_EMAIL)).json()
    page2 = client.get("/api/desk/signals", params={"limit": 1, "offset": 1}, headers=auth_headers(OWNER_EMAIL)).json()

    assert [row["id"] for row in page1] == [third.id]
    assert [row["id"] for row in page2] == [second.id]
    assert first.id not in [row["id"] for row in page1 + page2]
