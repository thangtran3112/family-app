"""Network-free test doubles for `ThrottledClient` users; the common and Desk suites both import them."""

from __future__ import annotations

from ai_trading_common.http import ThrottledClient


class FakeClock:
    """A controllable clock: sleep() advances it, instead of a real sleep."""

    def __init__(self, start: float = 0.0) -> None:
        self.t = start

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


class FakeResponse:
    def __init__(self, status_code: int, body=None, headers=None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.headers = headers or {}

    def json(self):
        if self._body == "not-json":
            raise ValueError("not json")
        return self._body


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[tuple[str, dict | None, dict | None]] = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, params, headers))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def make_client(responses, clock: FakeClock | None = None) -> tuple[ThrottledClient, FakeSession, FakeClock]:
    clock = clock or FakeClock()
    session = FakeSession(responses)
    client = ThrottledClient(clock=clock.now, sleep=clock.sleep, jitter=lambda a, b: 0.0, session=session)
    return client, session, clock
