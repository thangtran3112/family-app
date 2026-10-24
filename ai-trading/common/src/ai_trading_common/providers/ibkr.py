"""IBKR Gateway live quotes (02m §b4 item 3, 02e): a read-only quote source behind a switch that is OFF.

Lives in common, behind the 02j registry, because a data-provider client belongs here (ai-trading
AGENTS.md) and the registry is what lets the Desk swap it in with no caller change.

**Off by default.** `DESK_IBKR_GATEWAY_ENABLED=1` is the only switch (the Desk owns the one gateway
session, hence the prefix). While it is not exactly "1" the registry leaves this provider out of
every chain, so Alpaca stays the primary quote source and keeps its honest `delayed-15m` label.
Nothing here opens a connection until `latest()` is first called on an enabled, configured source.

**Read-only, always.** The gateway is the data user's, whose account is read-only data (STATUS.md
account policy). Nothing in this module places, changes, cancels or previews an order, or reads
positions or balances; the session connects with the API's read-only flag, and a test pins the
absence of every order call (`tests/providers/test_ibkr.py`).

**Credentials.** `IBKR_DATA_USERNAME` / `IBKR_DATA_PASSWORD` come from the Desk's Firestore profile via
the config render. They gate the "configured" state and are handed to the connector as the login to
present; the IB Gateway API socket itself carries no login (the gateway is signed in by a human
approving on the phone, or by a launcher), so `IbAsyncConnector` ignores them. They are never logged
or put in an error message, and the holder redacts its `repr`.

**Quality.** The gateway reports a market-data type per tick; it maps to the registry label (1 live ->
`realtime`, 3/4 delayed -> `delayed-15m`, 2 frozen -> `eod`). Anything else is left out rather than
guessed, so the Desk's stamp never claims more than the gateway said.

The wire client is `ib_async` (pinned in the probe; the optional `ibkr` extra of this package), imported
only when the first connection opens, so common and the Desk run without it while the switch is off.
"""

from __future__ import annotations

import asyncio
import logging
import math
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.bars import Bars, drop_unclosed, to_utc, validate
from ai_trading_common.errors import NoData, NotConfigured, ProviderError, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.quality import Quality
from ai_trading_common.types import GatewayStatus, Quote

logger = logging.getLogger(__name__)

PROVIDER_NAME = "ibkr"
ENABLED_VAR = "DESK_IBKR_GATEWAY_ENABLED"
USERNAME_VAR = "IBKR_DATA_USERNAME"
PASSWORD_VAR = "IBKR_DATA_PASSWORD"

#: IB's `marketDataType` per tick -> the registry label. Unlisted types (0 = none) yield no quote.
_QUALITY: dict[int, Quality] = {1: "realtime", 2: "eod", 3: "delayed-15m", 4: "delayed-15m"}
#: After a failed connect, the next attempt waits this long (a signed-out gateway must not be hammered).
RETRY_AFTER_S = 60.0


@dataclass(frozen=True, repr=False)
class IbkrCredentials:
    """The data user's login. Holds the values only; `repr` and `str` never show them."""

    username: str
    password: str

    def __repr__(self) -> str:
        return "IbkrCredentials(<redacted>)"

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> IbkrCredentials | None:
        """None unless both values are present (a half-set pair is not a login)."""
        username, password = env.get(USERNAME_VAR, ""), env.get(PASSWORD_VAR, "")
        return cls(username, password) if username and password else None


@dataclass(frozen=True)
class IbkrSettings:
    host: str = "127.0.0.1"
    port: int = 4002  # IB Gateway: 4002 paper-mode login, 4001 live-mode login (the probe decides, 02e)
    client_id: int = 902  # the probe uses 901; one id per process that connects
    max_lines: int = 70  # the account's streaming market-data lines (02a §7), same cap as the slot allocator
    connect_timeout_s: float = 15.0
    tick_wait_s: float = 2.0  # how long a new subscription waits for its first tick

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> IbkrSettings:
        """Reads `IBKR_GATEWAY_{HOST,PORT,CLIENT_ID,MAX_LINES}`; a non-integer value is a startup `ValueError`."""
        defaults = cls()

        def number(var: str, default: int) -> int:
            raw = env.get(var)
            if raw is None or not raw.strip():
                return default
            try:
                return int(raw)
            except ValueError:
                raise ValueError(f"{var} must be an integer") from None

        return cls(
            host=env.get("IBKR_GATEWAY_HOST") or defaults.host,
            port=number("IBKR_GATEWAY_PORT", defaults.port),
            client_id=number("IBKR_GATEWAY_CLIENT_ID", defaults.client_id),
            max_lines=number("IBKR_GATEWAY_MAX_LINES", defaults.max_lines),
        )


@dataclass(frozen=True)
class RawTick:
    """The newest tick of one subscription, as the gateway sent it."""

    last: float | None
    bid: float | None
    ask: float | None
    data_type: int  # IB marketDataType: 1 live, 2 frozen, 3 delayed, 4 delayed-frozen
    at: pd.Timestamp | None  # UTC, when the gateway stamped it


@dataclass(frozen=True)
class RawBar:
    start: pd.Timestamp  # UTC
    open: float
    high: float
    low: float
    close: float
    volume: float


class GatewayConnection(Protocol):
    """One signed-in session. Reads market data only: there is deliberately no order method.
    Raises `Unavailable` when the session drops and `NoData` for a symbol the gateway does not know."""

    def is_connected(self) -> bool: ...

    def subscribe(self, symbol: str) -> None: ...

    def unsubscribe(self, symbol: str) -> None: ...

    def tick(self, symbol: str, wait_s: float) -> RawTick | None: ...

    def minute_bars(self, symbol: str, start: pd.Timestamp, end: pd.Timestamp) -> list[RawBar]: ...

    def close(self) -> None: ...


class GatewayConnector(Protocol):
    """Opens a session. `Unavailable`: the gateway is unreachable or signed out. `NotConfigured`: the
    login was refused, or the wire library is missing."""

    def open(self, settings: IbkrSettings, credentials: IbkrCredentials) -> GatewayConnection: ...


def _usable(value: float | None) -> bool:
    return value is not None and math.isfinite(value) and value > 0


class IbkrSource:
    """`QuoteSource` over a gateway session, plus the hooks the Desk's status surface and slot manager use."""

    def __init__(
        self,
        settings: IbkrSettings,
        credentials: IbkrCredentials | None,
        connector: GatewayConnector,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._credentials = credentials
        self._connector = connector
        self._clock = clock
        self._lock = threading.RLock()  # ponytail: one lock for the one session; split if a second consumer needs it
        self._conn: GatewayConnection | None = None
        self._ever_connected = False
        self._retry_at = 0.0
        self._subscribed: set[str] = set()
        self._newest: tuple[Quality, pd.Timestamp] | None = None

    # -- QuoteSource ----------------------------------------------------------------------------

    def latest(self, symbols: Sequence[str], *, now: pd.Timestamp) -> list[Quote]:
        """The newest tick of each symbol, subscribing on first sight (up to `max_lines`; later symbols
        are left out, like a symbol with no data). A symbol with no usable tick yet is left out, not an error."""
        if self._credentials is None:
            raise NotConfigured(PROVIDER_NAME, "no data-user login configured")
        if not symbols:
            return []
        now_utc = to_utc(now)
        with self._lock:
            conn = self._connection()
            try:
                wanted = []
                for symbol in symbols:
                    if symbol in self._subscribed:
                        wanted.append(symbol)
                    elif len(self._subscribed) < self._settings.max_lines:
                        try:
                            conn.subscribe(symbol)
                        except NoData:
                            continue
                        self._subscribed.add(symbol)
                        wanted.append(symbol)
                quotes = []
                for symbol in wanted:
                    quote = self._quote(symbol, conn.tick(symbol, self._settings.tick_wait_s), now_utc)
                    if quote is not None:
                        quotes.append(quote)
                return quotes
            except Unavailable:
                self._drop()
                raise

    def release(self, symbols: Sequence[str]) -> None:
        """Gives the symbols' streaming lines back (the slot manager's `granted=False` or a closed chart)."""
        with self._lock:
            for symbol in symbols:
                if symbol in self._subscribed and self._conn is not None:
                    self._subscribed.discard(symbol)
                    try:
                        self._conn.unsubscribe(symbol)
                    except Unavailable:
                        self._drop()
                        return

    def minute_bars(self, symbol: str, start: pd.Timestamp, end: pd.Timestamp, *, now: pd.Timestamp) -> Bars:
        """Closed 1-minute bars, `realtime` only when the newest tick said so, else `delayed-15m`. Not a
        registered `bars` source yet: the 02e probe decides 1m depth and adjustment parity first (02m §b3)."""
        if self._credentials is None:
            raise NotConfigured(PROVIDER_NAME, "no data-user login configured")
        with self._lock:
            conn = self._connection()
            try:
                raw = conn.minute_bars(symbol, to_utc(start), to_utc(end))
            except Unavailable:
                self._drop()
                raise
            newest = self._newest
        if not raw:
            raise NoData(PROVIDER_NAME, f"no bars for {symbol!r}")
        frame = pd.DataFrame(
            {
                "open": [bar.open for bar in raw],
                "high": [bar.high for bar in raw],
                "low": [bar.low for bar in raw],
                "close": [bar.close for bar in raw],
                "volume": [bar.volume for bar in raw],
            },
            index=pd.DatetimeIndex([bar.start for bar in raw], tz="UTC"),
        )
        frame = drop_unclosed(validate(frame, "1m"), "1m", now)
        quality: Quality = "realtime" if newest is not None and newest[0] == "realtime" else "delayed-15m"
        return Bars(frame=frame, source=PROVIDER_NAME, quality=quality)

    # -- status ---------------------------------------------------------------------------------

    def gateway_status(self) -> GatewayStatus:
        """Reads without the session lock, so a status poll never waits on a slow tick."""
        newest = self._newest
        quality, as_of = newest if newest is not None else (None, None)
        if self._credentials is None:
            return GatewayStatus("not_configured", None, None)
        conn = self._conn
        if conn is not None and conn.is_connected():
            return GatewayStatus("connected", quality, as_of)
        return GatewayStatus("reconnecting" if self._ever_connected else "down", quality, as_of)

    def close(self) -> None:
        with self._lock:
            self._drop()

    # -- internals ------------------------------------------------------------------------------

    def _connection(self) -> GatewayConnection:
        if self._conn is not None and self._conn.is_connected():
            return self._conn
        self._drop()
        if self._clock() < self._retry_at:
            raise Unavailable(PROVIDER_NAME, "gateway not reachable; retrying shortly")
        assert self._credentials is not None  # callers check first
        try:
            self._conn = self._connector.open(self._settings, self._credentials)
        except (Unavailable, NotConfigured) as exc:
            self._retry_at = self._clock() + RETRY_AFTER_S
            logger.warning("ibkr gateway connect failed: %s", type(exc).__name__)
            raise
        self._ever_connected = True
        logger.info("ibkr gateway connected (%s:%s)", self._settings.host, self._settings.port)
        return self._conn

    def _drop(self) -> None:
        conn, self._conn = self._conn, None
        self._subscribed.clear()  # a new session starts with no lines
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - closing a dead session must never mask the caller's error
                logger.debug("ibkr gateway close failed", exc_info=False)

    def _quote(self, symbol: str, tick: RawTick | None, now: pd.Timestamp) -> Quote | None:
        if tick is None:
            return None
        quality = _QUALITY.get(tick.data_type)
        if _usable(tick.last):
            price = tick.last
        elif _usable(tick.bid) and _usable(tick.ask):
            price = (tick.bid + tick.ask) / 2
        else:
            return None
        if quality is None:
            return None
        as_of = to_utc(tick.at) if tick.at is not None else now
        self._newest = (quality, as_of)
        return Quote(symbol=symbol, price=float(price), as_of=as_of, provider=PROVIDER_NAME, quality=quality)


# -- the wire client ----------------------------------------------------------------------------


def _finite(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


class _IbSession:
    """One `ib_async` session on its own event-loop thread (the library is asyncio, the sources are
    blocking). Only market-data calls exist here."""

    def __init__(self, ib_async: Any, settings: IbkrSettings) -> None:
        self._lib = ib_async
        self._settings = settings
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="ibkr-gateway", daemon=True)
        self._thread.start()
        self._ib: Any = None
        self._contracts: dict[str, Any] = {}
        self._tickers: dict[str, Any] = {}

    def _run(self, coro: Any, timeout: float) -> Any:
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return future.result(timeout)
        except ProviderError:
            raise
        except Exception as exc:  # noqa: BLE001 - a wire error says nothing the Desk can act on; keep only its type
            future.cancel()
            raise Unavailable(PROVIDER_NAME, f"gateway did not answer ({type(exc).__name__})") from None

    def connect(self) -> None:
        async def go() -> None:
            self._ib = self._lib.IB()
            # readonly: the API itself refuses orders on this session, on top of there being no order call here.
            await self._ib.connectAsync(
                self._settings.host,
                self._settings.port,
                clientId=self._settings.client_id,
                timeout=self._settings.connect_timeout_s,
                readonly=True,
            )
            self._ib.reqMarketDataType(1)  # ask for live; each tick still reports what it really is

        try:
            self._run(go(), self._settings.connect_timeout_s + 5)
        except Unavailable:
            self.close()
            raise

    def is_connected(self) -> bool:
        return self._ib is not None and bool(self._ib.isConnected())

    async def _contract(self, symbol: str) -> Any:
        if symbol not in self._contracts:
            found = await self._ib.qualifyContractsAsync(self._lib.Stock(symbol, "SMART", "USD"))
            usable = [c for c in found if c is not None and getattr(c, "conId", 0)]
            if not usable:
                raise NoData(PROVIDER_NAME, f"unknown symbol {symbol!r}")
            self._contracts[symbol] = usable[0]
        return self._contracts[symbol]

    def subscribe(self, symbol: str) -> None:
        async def go() -> None:
            contract = await self._contract(symbol)
            self._tickers[symbol] = self._ib.reqMktData(contract, "", False, False)

        self._run(go(), self._settings.connect_timeout_s)

    def unsubscribe(self, symbol: str) -> None:
        async def go() -> None:
            self._tickers.pop(symbol, None)
            if symbol in self._contracts:
                self._ib.cancelMktData(self._contracts[symbol])

        self._run(go(), self._settings.connect_timeout_s)

    def tick(self, symbol: str, wait_s: float) -> RawTick | None:
        ticker = self._tickers.get(symbol)
        if ticker is None:
            return None
        deadline = time.monotonic() + wait_s
        while True:
            last, bid, ask = _finite(ticker.last), _finite(ticker.bid), _finite(ticker.ask)
            if any(v is not None for v in (last, bid, ask)) or time.monotonic() >= deadline:
                at = getattr(ticker, "time", None)
                return RawTick(
                    last, bid, ask, int(ticker.marketDataType or 0), None if at is None else pd.Timestamp(at)
                )
            if not self.is_connected():
                raise Unavailable(PROVIDER_NAME, "gateway session dropped")
            time.sleep(0.05)

    def minute_bars(self, symbol: str, start: pd.Timestamp, end: pd.Timestamp) -> list[RawBar]:
        async def go() -> list[RawBar]:
            contract = await self._contract(symbol)
            span = max(int((end - start).total_seconds()), 60)
            duration = f"{span} S" if span <= 86400 else f"{math.ceil(span / 86400)} D"
            bars = await self._ib.reqHistoricalDataAsync(
                contract, end.strftime("%Y%m%d-%H:%M:%S"), duration, "1 min", "TRADES", False, 2
            )
            return [
                RawBar(
                    pd.Timestamp(b.date), float(b.open), float(b.high), float(b.low), float(b.close), float(b.volume)
                )
                for b in bars
                if pd.Timestamp(b.date) >= start
            ]

        return self._run(go(), 90.0)

    def close(self) -> None:
        if self._ib is not None:
            try:
                self._loop.call_soon_threadsafe(self._ib.disconnect)
            except RuntimeError:  # the loop is already stopped
                pass
        self._loop.call_soon_threadsafe(self._loop.stop)


class IbAsyncConnector:
    """Opens an `ib_async` session. `ib_module` is for tests; production imports `ib_async` on first use."""

    def __init__(self, ib_module: Any = None) -> None:
        self._module = ib_module

    def open(self, settings: IbkrSettings, credentials: IbkrCredentials) -> GatewayConnection:
        # The API socket takes no login (see the module docstring): `credentials` is deliberately unused here.
        module = self._module
        if module is None:
            try:
                import ib_async as module  # noqa: PLC0415 - optional dependency, only needed once enabled
            except ImportError:
                raise NotConfigured(PROVIDER_NAME, "the ib_async package is not installed") from None
        session = _IbSession(module, settings)
        session.connect()
        return session


def _enabled(env: Mapping[str, str]) -> bool:
    return env.get(ENABLED_VAR) == "1"


def _build(env: Mapping[str, str], http: ThrottledClient) -> IbkrSource:
    return IbkrSource(IbkrSettings.from_env(env), IbkrCredentials.from_env(env), IbAsyncConnector())


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("quotes",), build=_build, enabled=_enabled)
