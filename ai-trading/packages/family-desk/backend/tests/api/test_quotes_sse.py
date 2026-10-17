"""SSE quote polling uses only persisted, closed bars and releases each DB session per poll."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from sqlalchemy.orm import sessionmaker

from ai_trading.api.app import app
from ai_trading.api.auth import IDENTITY_HEADER, AuthedUser, get_current_user_for_stream
from ai_trading.api.quotes import POLL_INTERVAL_SECONDS, _latest_quote, quote_events, stream_quotes
from ai_trading.db.models import Bar1m


def _store_bar(session, *, symbol="AAPL", bar_start=None, close=101.0):
    bar_start = bar_start or datetime.now(UTC).replace(second=0, microsecond=0) - timedelta(minutes=16)
    session.add(
        Bar1m(
            symbol=symbol,
            bar_start=bar_start,
            open=close,
            high=close,
            low=close,
            close=close,
            volume=1_000.0,
            source="alpaca",
        )
    )
    session.commit()
    return bar_start


def _factory(db_session):
    return sessionmaker(db_session.get_bind(), expire_on_commit=False)


def test_latest_quote_uses_persisted_timestamp_for_delayed_data(db_session):
    bar_start = _store_bar(db_session)

    quote = _latest_quote("AAPL", _factory(db_session))

    assert quote == {
        "symbol": "AAPL",
        "close": 101.0,
        "quality": "delayed-15m",
        "as_of": bar_start.isoformat(),
    }


def test_quote_events_caps_store_polling_at_sixty_seconds(db_session):
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    async def run():
        return [
            event
            async for event in quote_events(
                "AAPL", _factory(db_session), _disconnect_after(5), sleep=fake_sleep
            )
        ]

    assert asyncio.run(run()) == []
    assert sleeps == [POLL_INTERVAL_SECONDS] * 5
    assert POLL_INTERVAL_SECONDS == 60


def test_quote_events_stops_as_soon_as_the_client_disconnects(db_session):
    async def already_disconnected() -> bool:
        return True

    async def run():
        return [
            event
            async for event in quote_events(
                "AAPL", _factory(db_session), already_disconnected, sleep=_no_sleep
            )
        ]

    assert asyncio.run(run()) == []


def test_quote_events_sends_one_changed_stored_quote_and_skips_unknown_symbols(db_session):
    bar_start = _store_bar(db_session)
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    async def run():
        events = [
            event
            async for event in quote_events(
                "AAPL", _factory(db_session), _disconnect_after(3), sleep=fake_sleep
            )
        ]
        unknown = [
            event
            async for event in quote_events(
                "UNKNOWN", _factory(db_session), _disconnect_after(1), sleep=fake_sleep
            )
        ]
        future = [
            event
            async for event in quote_events(
                "/ES", _factory(db_session), _disconnect_after(1), sleep=fake_sleep
            )
        ]
        return events, unknown, future

    events, unknown, future = asyncio.run(run())

    assert len(events) == 1
    assert json.loads(events[0]["data"]) == {
        "symbol": "AAPL",
        "close": 101.0,
        "quality": "delayed-15m",
        "as_of": bar_start.isoformat(),
    }
    assert unknown == []
    assert future == []
    assert sleeps == [POLL_INTERVAL_SECONDS] * 5


def test_latest_quote_rejects_non_finite_stored_close(db_session):
    _store_bar(db_session, close=float("nan"))

    assert _latest_quote("AAPL", _factory(db_session)) is None


def test_latest_quote_ignores_unclosed_future_bar(db_session):
    future_bar_start = datetime.now(UTC).replace(second=0, microsecond=0) + timedelta(minutes=2)
    _store_bar(db_session, bar_start=future_bar_start)

    assert _latest_quote("AAPL", _factory(db_session)) is None


def test_stream_quotes_route_wires_event_source_response_around_quote_events(db_session):
    class _AlreadyDisconnectedRequest:
        app = SimpleNamespace(state=SimpleNamespace(session_factory=_factory(db_session)))

        async def is_disconnected(self) -> bool:
            return True

    async def run():
        response = await stream_quotes(
            "AAPL",
            _AlreadyDisconnectedRequest(),
            user=AuthedUser(id=1, email="owner@example.com"),
        )
        events = [event async for event in response.body_iterator]
        return response, events

    response, events = asyncio.run(run())

    assert response.media_type == "text/event-stream"
    assert events == []


def test_quote_route_keeps_verified_identity_requirement(client):
    response = client.get("/api/desk/quotes/AAPL")

    assert response.status_code == 401


def test_quote_route_validates_path_symbols_after_decoding(client, db_session):
    previous_factory = getattr(app.state, "session_factory", None)
    app.state.session_factory = _factory(db_session)
    try:
        response = client.get("/api/desk/quotes/AAPL/extra", headers={IDENTITY_HEADER: "owner@example.com"})
    finally:
        if previous_factory is None:
            del app.state.session_factory
        else:
            app.state.session_factory = previous_factory

    assert response.status_code == 422
    assert response.json()["detail"] == "invalid symbol"


def test_stream_identity_session_closes_before_the_long_lived_response(db_session):
    request = SimpleNamespace(
        headers={IDENTITY_HEADER: "owner@example.com"},
        app=SimpleNamespace(state=SimpleNamespace(session_factory=_factory(db_session))),
    )

    user = get_current_user_for_stream(request)

    assert user.email == "owner@example.com"
    assert db_session.get_bind().pool.checkedout() == 0


def _disconnect_after(n: int):
    calls = 0

    async def is_disconnected() -> bool:
        nonlocal calls
        calls += 1
        return calls > n

    return is_disconnected


async def _no_sleep(seconds: float) -> None:
    return None
