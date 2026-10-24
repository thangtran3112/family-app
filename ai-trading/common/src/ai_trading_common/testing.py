"""Network-free test doubles for `ThrottledClient` users; the common and Desk suites both import them."""

from __future__ import annotations

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
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


class FakeGateway:
    """An in-process stand-in for a signed-in IB Gateway, as a `GatewayConnector` (and, per open session,
    a `GatewayConnection`): scripted ticks and bars, an optional login check, and a way to drop every
    session. `calls` records each session method the code under test used, so a test can assert that
    only market-data calls were made."""

    def __init__(self, *, login=None, up: bool = True) -> None:
        self.login = login  # an `IbkrCredentials` the gateway insists on, or None for no check
        self.up = up
        self.ticks: dict = {}  # symbol -> RawTick; a symbol not listed is unknown to the gateway
        self.bars: dict = {}  # symbol -> list[RawBar]
        self.opens = 0
        self.sessions: list = []
        self.calls: list[str] = []

    def open(self, settings, credentials):
        self.opens += 1
        if not self.up:
            raise Unavailable("ibkr", "gateway unreachable")
        if self.login is not None and credentials != self.login:
            raise NotConfigured("ibkr", "login refused")
        session = _FakeSession(self)
        self.sessions.append(session)
        return session

    def drop_all(self) -> None:
        for session in self.sessions:
            session.alive = False


class _FakeSession:
    def __init__(self, gateway: FakeGateway) -> None:
        self._gateway = gateway
        self.alive = True
        self.subscribed: set[str] = set()

    def _use(self, name: str) -> None:
        self._gateway.calls.append(name)
        if not self.alive:
            raise Unavailable("ibkr", "session dropped")

    def is_connected(self) -> bool:
        return self.alive

    def subscribe(self, symbol: str) -> None:
        self._use("subscribe")
        if symbol not in self._gateway.ticks:
            raise NoData("ibkr", f"unknown symbol {symbol!r}")
        self.subscribed.add(symbol)

    def unsubscribe(self, symbol: str) -> None:
        self._use("unsubscribe")
        self.subscribed.discard(symbol)

    def tick(self, symbol: str, wait_s: float):
        self._use("tick")
        return self._gateway.ticks.get(symbol) if symbol in self.subscribed else None

    def minute_bars(self, symbol: str, start, end):
        self._use("minute_bars")
        return [bar for bar in self._gateway.bars.get(symbol, []) if start <= bar.start <= end]

    def close(self) -> None:
        self.alive = False
