"""SSE rate cap and disconnect-stop (PROTO-BRIEF.md §4 L4). Exercises `quote_events`/
`stream_quotes` directly with a fake `DataSources` and a fake clock/sleep -- no real 0.25s wait,
no real socket, no live network call."""

import asyncio

from fakes import FakeBarsSource, fake_data_sources, one_bar_frame

from ai_trading.api.auth import AuthedUser
from ai_trading.api.quotes import MIN_INTERVAL_SECONDS, quote_events, stream_quotes


async def _no_sleep(seconds: float) -> None:
    return None


def _disconnect_after(n: int):
    calls = 0

    async def is_disconnected() -> bool:
        nonlocal calls
        calls += 1
        return calls > n

    return is_disconnected


def test_quote_events_sleeps_the_minimum_interval_every_tick_even_with_an_instant_read():
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    data_sources = fake_data_sources(FakeBarsSource({"AAPL": one_bar_frame(101.0)}))

    async def run() -> list[dict]:
        return [event async for event in quote_events("AAPL", data_sources, _disconnect_after(5), sleep=fake_sleep)]

    events = asyncio.run(run())

    assert len(events) == 5
    assert sleeps == [MIN_INTERVAL_SECONDS] * 5


def test_quote_events_stops_as_soon_as_the_client_disconnects():
    data_sources = fake_data_sources()

    async def already_disconnected() -> bool:
        return True

    async def run() -> list[dict]:
        return [event async for event in quote_events("AAPL", data_sources, already_disconnected, sleep=_no_sleep)]

    assert asyncio.run(run()) == []


def test_quote_events_skips_a_tick_with_no_data_but_keeps_the_cadence():
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    data_sources = fake_data_sources()  # no frame for "AAPL" -> every tick is a quiet one

    async def run() -> list[dict]:
        return [event async for event in quote_events("AAPL", data_sources, _disconnect_after(3), sleep=fake_sleep)]

    events = asyncio.run(run())

    assert events == []  # nothing to send, but the generator still ran -- and slept -- 3 times
    assert sleeps == [MIN_INTERVAL_SECONDS] * 3


def test_stream_quotes_route_wires_an_event_source_response_around_quote_events():
    class _AlreadyDisconnectedRequest:
        async def is_disconnected(self) -> bool:
            return True

    async def run():
        response = await stream_quotes(
            "AAPL",
            _AlreadyDisconnectedRequest(),
            user=AuthedUser(id=1, email="owner@example.com"),
            data_sources=fake_data_sources(),
        )
        events = [event async for event in response.body_iterator]
        return response, events

    response, events = asyncio.run(run())

    assert response.media_type == "text/event-stream"
    assert events == []
