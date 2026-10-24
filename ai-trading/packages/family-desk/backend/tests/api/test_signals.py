from datetime import UTC, datetime, timedelta

from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.cli.seed_technical import seed_alert_specs
from ai_trading.db.models import Signal, Strategy, StrategyVersion, User

NOW = datetime(2026, 7, 15, 20, 0, tzinfo=UTC)


def _user_id(client, db_session, email: str) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _make_signal(
    db_session,
    owner_id: int,
    *,
    symbol: str = "AAPL",
    bar_time=NOW,
    created_at=NOW,
    name: str = "S",
    spec: dict | None = None,
) -> Signal:
    strategy = Strategy(owner_user_id=owner_id, name=name, stage="alert_only", created_at=NOW)
    db_session.add(strategy)
    db_session.flush()
    version = StrategyVersion(
        strategy_id=strategy.id, version=1, schema_version=1, spec=spec or {}, created_by=owner_id, created_at=NOW
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


def test_signals_name_the_strategy_and_classify_its_kind(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    orb_spec = seed_alert_specs()[0].model_dump(mode="json", by_alias=True, exclude_none=True)
    orb = _make_signal(db_session, owner_id, name="ORB 15m", spec=orb_spec)
    _make_signal(db_session, owner_id, symbol="MSFT", bar_time=NOW + timedelta(minutes=1), name="Lane B", spec={})

    rows = {row["symbol"]: row for row in client.get("/api/desk/signals", headers=auth_headers()).json()}

    orb_version = db_session.get(StrategyVersion, orb.strategy_version_id)
    assert rows["AAPL"]["strategy_id"] == orb_version.strategy_id
    assert rows["AAPL"]["strategy_name"] == "ORB 15m"
    assert rows["AAPL"]["kind"] == "orb"
    assert rows["MSFT"]["strategy_name"] == "Lane B"
    assert rows["MSFT"]["kind"] == "other"  # a spec without an alert `when` is not an error
