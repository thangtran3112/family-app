"""App background-task wiring smoke test (PROTO-BRIEF.md §4 L4): proves `_background_loop` calls
its `work` callable against a fresh session every `interval` seconds, forever, with a fake clock
and a fake `sleep` -- no real waiting, no real database."""

import asyncio
from datetime import UTC, datetime

from ai_trading.api.app import DISPATCH_INTERVAL_SECONDS, TICK_INTERVAL_SECONDS, _background_loop

_NOW = datetime(2026, 7, 15, 20, 0, tzinfo=UTC)


class _FakeSessionFactory:
    """A bare callable standing in for `sessionmaker[Session]`: each call returns a distinct fake
    "session" object, and nothing here ever touches a real engine."""

    def __init__(self) -> None:
        self.sessions_made = 0

    def __call__(self):
        self.sessions_made += 1
        return _FakeSession()


class _FakeSession:
    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        pass


def _stop_after(n: int):
    """A fake `sleep` that raises once it's been awaited `n` times, ending the otherwise-infinite
    `_background_loop` deterministically."""
    calls: list[float] = []

    async def sleep(seconds: float) -> None:
        calls.append(seconds)
        if len(calls) >= n:
            raise asyncio.CancelledError

    return sleep, calls


def test_background_loop_calls_work_against_a_fresh_session_every_interval():
    factory = _FakeSessionFactory()
    work_calls: list[datetime] = []
    sleep, sleeps = _stop_after(3)

    async def run() -> None:
        await _background_loop(
            lambda session, now: work_calls.append(now),
            factory,
            interval=TICK_INTERVAL_SECONDS,
            sleep=sleep,
            clock=lambda: _NOW,
        )

    try:
        asyncio.run(run())
    except asyncio.CancelledError:
        pass

    assert work_calls == [_NOW] * 3
    assert sleeps == [TICK_INTERVAL_SECONDS] * 3
    assert factory.sessions_made == 3


def test_background_loop_survives_one_failing_iteration_and_uses_its_own_interval():
    calls = 0

    def flaky_work(session, now: datetime) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("boom")

    sleep, sleeps = _stop_after(2)

    async def run() -> None:
        await _background_loop(
            flaky_work, _FakeSessionFactory(), interval=DISPATCH_INTERVAL_SECONDS, sleep=sleep, clock=lambda: _NOW
        )

    try:
        asyncio.run(run())
    except asyncio.CancelledError:
        pass

    assert calls == 2  # the first iteration's RuntimeError never killed the loop
    assert sleeps == [DISPATCH_INTERVAL_SECONDS] * 2
