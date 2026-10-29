"""Network-free test doubles for `ThrottledClient` users; the common and Desk suites both import them."""

from __future__ import annotations

from dataclasses import replace

import pandas as pd

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.trades import Trades, empty_trades_frame
from ai_trading_common.types import OptionContract


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


class FakeTrades:
    """A trades source over canned frames keyed by `(symbol, feed)`. It returns the stored prints with
    `start <= t < end`, or an empty `Trades` for a key with none. `refuse_sip` makes the SIP feed raise
    `NotConfigured`, as a free key without the SIP entitlement does. Every call is recorded in `calls` as
    `(symbol, start, end, feed)`."""

    def __init__(self, frames: dict[tuple[str, str], pd.DataFrame] | None = None, *, refuse_sip: bool = False) -> None:
        self.frames = frames or {}
        self.refuse_sip = refuse_sip
        self.calls: list[tuple[str, pd.Timestamp, pd.Timestamp, str]] = []

    def trades(self, symbol, start, end, *, feed, now=None) -> Trades:
        self.calls.append((symbol, start, end, feed))
        if self.refuse_sip and feed == "sip":
            raise NotConfigured("fake", "sip refused")
        frame = self.frames.get((symbol, feed))
        if frame is None:
            return Trades(frame=empty_trades_frame(), source="fake", feed=feed)
        kept = frame[(frame["t"] >= start) & (frame["t"] < end)].reset_index(drop=True)
        return Trades(frame=kept, source="fake", feed=feed)


class FakeOptionChain:
    """An option-chain source over canned contracts keyed by underlying. It applies the `OptionChainSource` window
    (`right`, `min_dte`..`max_dte` from `now`'s New York date, the strike bounds) to the stored contracts and sets
    each `dte` from `now`, so a test gets the same narrowing a real provider does; an underlying with none is an
    empty chain. `raises` makes every
    call raise it, as a provider outage or a rejected key does. Every call is recorded in `calls` as
    `(symbol, now, right, min_dte, max_dte, min_strike, max_strike)`."""

    def __init__(self, contracts: dict[str, list[OptionContract]] | None = None, *, raises: Exception | None = None):
        self.contracts = contracts or {}
        self.raises = raises
        self.calls: list[tuple] = []

    def option_chain(self, symbol, *, now, right="C", min_dte=0, max_dte, min_strike=None, max_strike=None):
        self.calls.append((symbol, now, right, min_dte, max_dte, min_strike, max_strike))
        if self.raises is not None:
            raise self.raises
        today = now.tz_convert("America/New_York").date()
        found = [
            replace(c, dte=(c.expiry - today).days)
            for c in self.contracts.get(symbol, [])
            if c.right == right
            and min_dte <= (c.expiry - today).days <= max_dte
            and (min_strike is None or c.strike >= min_strike)
            and (max_strike is None or c.strike <= max_strike)
        ]
        return sorted(found, key=lambda c: (c.expiry, c.strike))


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
