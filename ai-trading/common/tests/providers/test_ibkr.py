"""The IBKR gateway quote source (02m §b4 item 3), offline: an in-process `FakeGateway` for the source and
registry behaviour, and a fake `ib_async` module for the wire client. Nothing here opens a socket."""

import ast
import logging
import math
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.providers import ibkr
from ai_trading_common.providers.ibkr import (
    RETRY_AFTER_S,
    IbAsyncConnector,
    IbkrCredentials,
    IbkrSettings,
    IbkrSource,
    RawBar,
    RawTick,
)
from ai_trading_common.registry import DEFAULT_CHAINS, REGISTRY, DataSources
from ai_trading_common.sources import GatewayStatusSource, QuoteSource
from ai_trading_common.testing import FakeClock, FakeGateway, FakeResponse, make_client

NOW = pd.Timestamp("2026-10-26T14:00:00Z")
TICK_AT = pd.Timestamp("2026-10-26T13:59:58Z")
USER, PASSWORD = "datauser-7f3a", "pw-Zk9!q2-secret"
CREDS = IbkrCredentials(USER, PASSWORD)


def tick(last=210.5, *, bid=None, ask=None, data_type=1, at=TICK_AT) -> RawTick:
    return RawTick(last=last, bid=bid, ask=ask, data_type=data_type, at=at)


def make_source(gateway: FakeGateway, *, creds=CREDS, clock=None, **settings) -> IbkrSource:
    return IbkrSource(IbkrSettings(**settings), creds, gateway, clock=(clock or FakeClock()).now)


# -- settings and credentials -------------------------------------------------------------------------------


def test_settings_default_to_a_local_paper_mode_gateway_and_read_the_env():
    assert IbkrSettings.from_env({}) == IbkrSettings(host="127.0.0.1", port=4002, client_id=902, max_lines=70)
    env = {"IBKR_GATEWAY_HOST": "10.0.0.5", "IBKR_GATEWAY_PORT": "4001", "IBKR_GATEWAY_CLIENT_ID": "7"}
    assert IbkrSettings.from_env(env) == IbkrSettings(host="10.0.0.5", port=4001, client_id=7)
    with pytest.raises(ValueError, match="IBKR_GATEWAY_PORT"):
        IbkrSettings.from_env({"IBKR_GATEWAY_PORT": "four-thousand"})


def test_credentials_need_both_values_and_never_show_them():
    assert IbkrCredentials.from_env({"IBKR_DATA_USERNAME": USER}) is None
    assert IbkrCredentials.from_env({"IBKR_DATA_PASSWORD": PASSWORD}) is None
    creds = IbkrCredentials.from_env({"IBKR_DATA_USERNAME": USER, "IBKR_DATA_PASSWORD": PASSWORD})
    assert creds == CREDS
    for text in (repr(creds), str(creds), f"{creds}", repr(IbkrSource(IbkrSettings(), creds, FakeGateway()))):
        assert USER not in text and PASSWORD not in text


# -- quotes, ticks, quality ---------------------------------------------------------------------------------


def test_nothing_connects_until_the_first_quote_is_asked_for():
    gateway = FakeGateway()
    make_source(gateway)
    assert gateway.opens == 0


def test_a_live_tick_becomes_a_realtime_quote_stamped_with_the_ticks_own_time():
    gateway = FakeGateway(login=CREDS)
    gateway.ticks["NVDA"] = tick(210.5)
    source = make_source(gateway)
    [quote] = source.latest(["NVDA"], now=NOW)
    assert (quote.symbol, quote.price, quote.provider, quote.quality) == ("NVDA", 210.5, "ibkr", "realtime")
    assert quote.as_of == TICK_AT
    assert isinstance(source, QuoteSource) and isinstance(source, GatewayStatusSource)
    assert gateway.opens == 1
    assert source.latest(["NVDA"], now=NOW)[0].price == 210.5
    assert gateway.opens == 1  # the session is reused


@pytest.mark.parametrize(
    ("data_type", "quality"),
    [(1, "realtime"), (2, "eod"), (3, "delayed-15m"), (4, "delayed-15m")],
)
def test_the_stamp_never_claims_more_than_the_gateway_said(data_type, quality):
    gateway = FakeGateway()
    gateway.ticks["SPY"] = tick(data_type=data_type)
    [quote] = make_source(gateway).latest(["SPY"], now=NOW)
    assert quote.quality == quality


def test_a_tick_of_unknown_type_or_without_a_usable_price_is_left_out():
    gateway = FakeGateway()
    gateway.ticks.update(
        {
            "NONE": tick(data_type=0),  # the gateway has no data type for it: not guessed
            "NAN": tick(math.nan),
            "ZERO": tick(0.0),
            "HALF": tick(None, bid=100.0, ask=None),
            "OK": tick(10.0),
        }
    )
    quotes = make_source(gateway).latest(["NONE", "NAN", "ZERO", "HALF", "OK"], now=NOW)
    assert [q.symbol for q in quotes] == ["OK"]


def test_with_no_last_trade_the_quote_is_the_bid_ask_midpoint():
    gateway = FakeGateway()
    gateway.ticks["AAPL"] = tick(None, bid=99.0, ask=101.0)
    assert make_source(gateway).latest(["AAPL"], now=NOW)[0].price == 100.0


def test_an_untimestamped_tick_takes_the_callers_now():
    gateway = FakeGateway()
    gateway.ticks["AAPL"] = tick(at=None)
    assert make_source(gateway).latest(["AAPL"], now=NOW)[0].as_of == NOW


def test_a_symbol_the_gateway_does_not_know_is_left_out_not_an_error():
    gateway = FakeGateway()
    gateway.ticks["AAPL"] = tick()
    quotes = make_source(gateway).latest(["NOPE", "AAPL"], now=NOW)
    assert [q.symbol for q in quotes] == ["AAPL"]


def test_streaming_lines_are_capped_and_release_frees_them():
    gateway = FakeGateway()
    gateway.ticks.update({s: tick() for s in ("A", "B", "C")})
    source = make_source(gateway, max_lines=2)
    assert [q.symbol for q in source.latest(["A", "B", "C"], now=NOW)] == ["A", "B"]
    source.release(["A"])
    assert [q.symbol for q in source.latest(["B", "C"], now=NOW)] == ["B", "C"]


# -- connection state, fallback, retry ----------------------------------------------------------------------


def test_status_walks_not_configured_down_connected_reconnecting():
    clock = FakeClock()
    gateway = FakeGateway(up=False)
    gateway.ticks["AAPL"] = tick()
    source = make_source(gateway, clock=clock)
    assert make_source(gateway, creds=None).gateway_status().state == "not_configured"
    assert source.gateway_status().state == "down"  # switched on, never reached

    with pytest.raises(Unavailable):
        source.latest(["AAPL"], now=NOW)
    assert source.gateway_status().state == "down"

    gateway.up = True
    with pytest.raises(Unavailable):  # inside the retry window: no new attempt
        source.latest(["AAPL"], now=NOW)
    assert gateway.opens == 1
    clock.sleep(RETRY_AFTER_S + 1)
    source.latest(["AAPL"], now=NOW)
    status = source.gateway_status()
    assert (status.state, status.quality, status.as_of) == ("connected", "realtime", TICK_AT)

    gateway.drop_all()
    assert source.gateway_status().state == "reconnecting"
    assert source.latest(["AAPL"], now=NOW)[0].price == 210.5  # reopened, and the symbol subscribed again
    assert source.gateway_status().state == "connected"
    assert gateway.opens == 3


def test_a_session_that_drops_mid_call_raises_unavailable_and_recovers():
    gateway = FakeGateway()
    gateway.ticks["AAPL"] = tick()
    source = make_source(gateway)
    source.latest(["AAPL"], now=NOW)
    gateway.drop_all()
    source.latest(["AAPL"], now=NOW)  # is_connected is False: reopened before any call fails
    session = gateway.sessions[-1]
    session.alive = False  # now it dies between the liveness check and the call
    session.is_connected = lambda: True
    with pytest.raises(Unavailable):
        source.latest(["AAPL"], now=NOW)
    assert source.gateway_status().state == "reconnecting"


def test_a_missing_login_raises_not_configured_without_ever_connecting():
    gateway = FakeGateway()
    source = make_source(gateway, creds=None)
    with pytest.raises(NotConfigured):
        source.latest(["AAPL"], now=NOW)
    assert gateway.opens == 0


def test_a_refused_login_raises_not_configured_and_waits_before_retrying():
    clock = FakeClock()
    gateway = FakeGateway(login=IbkrCredentials(USER, "a-different-password"))
    source = make_source(gateway, clock=clock)
    with pytest.raises(NotConfigured):
        source.latest(["AAPL"], now=NOW)
    with pytest.raises(Unavailable):
        source.latest(["AAPL"], now=NOW)
    assert gateway.opens == 1
    assert source.gateway_status().state == "down"


def test_minute_bars_are_closed_bars_and_labeled_by_the_newest_tick():
    gateway = FakeGateway()
    gateway.ticks["AAPL"] = tick(data_type=3)
    start = pd.Timestamp("2026-10-26T13:56:00Z")
    gateway.bars["AAPL"] = [RawBar(start + pd.Timedelta(minutes=m), 10.0, 11.0, 9.0, 10.5, 100.0) for m in range(5)]
    source = make_source(gateway)
    source.latest(["AAPL"], now=NOW)
    bars = source.minute_bars("AAPL", start, NOW, now=NOW)
    assert (bars.source, bars.quality) == ("ibkr", "delayed-15m")
    assert list(bars.frame.index) == [start + pd.Timedelta(minutes=m) for m in range(4)]  # the 14:00 bar is still open
    with pytest.raises(NoData):
        source.minute_bars("AAPL", NOW + pd.Timedelta(days=1), NOW + pd.Timedelta(days=2), now=NOW)


# -- credentials are never logged ---------------------------------------------------------------------------


def test_credential_values_never_reach_a_log_or_an_error(caplog):
    caplog.set_level(logging.DEBUG)
    messages = []
    gateway = FakeGateway(login=CREDS)
    gateway.ticks["AAPL"] = tick()
    good = make_source(gateway)
    good.latest(["AAPL"], now=NOW)
    gateway.drop_all()
    good.close()

    for bad_gateway in (FakeGateway(up=False), FakeGateway(login=IbkrCredentials("x", "y"))):
        bad = make_source(bad_gateway)
        with pytest.raises((Unavailable, NotConfigured)) as raised:
            bad.latest(["AAPL"], now=NOW)
        messages.append(str(raised.value))

    assert caplog.records, "the connect attempts should have been logged"
    text = "\n".join([r.getMessage() for r in caplog.records] + messages)
    assert USER not in text and PASSWORD not in text


# -- no orders, ever ----------------------------------------------------------------------------------------

#: Every IB call that could place, change, cancel or preview an order, or read positions or balances.
_FORBIDDEN = {
    "placeOrder",
    "cancelOrder",
    "reqGlobalCancel",
    "whatIfOrder",
    "whatIfOrderAsync",
    "reqPositions",
    "reqAccountSummary",
    "reqAccountUpdates",
    "reqOpenOrders",
    "reqAllOpenOrders",
    "reqExecutions",
    "reqPnL",
    "exerciseOptions",
    "Order",
    "MarketOrder",
    "LimitOrder",
    "StopOrder",
}
_ORDERISH = ("order", "trade", "execute", "exercise", "position", "account", "buy", "sell", "transmit")


def _public_names(cls) -> list[str]:
    return [name for name in dir(cls) if not name.startswith("_")]


def test_the_client_has_no_order_methods():
    from ai_trading_common import testing

    for cls in (IbkrSource, ibkr._IbSession, IbAsyncConnector, testing._FakeSession):
        for name in _public_names(cls):
            assert not any(word in name.lower() for word in _ORDERISH), f"{cls.__name__}.{name}"
    assert set(_public_names(IbkrSource)) == {"latest", "release", "minute_bars", "gateway_status", "close"}
    assert set(_public_names(ibkr.GatewayConnection)) == {
        "is_connected",
        "subscribe",
        "unsubscribe",
        "tick",
        "minute_bars",
        "close",
    }


def _names_used(source: str) -> set[str]:
    tree = ast.parse(source)
    used = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    used |= {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    return used | {node.name for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}


def test_the_module_source_never_names_an_order_or_account_call():
    assert _names_used("async def go(ib):\n    ib.placeOrder(MarketOrder('BUY', 1))") & _FORBIDDEN  # the scan can fail
    assert _names_used(Path(ibkr.__file__).read_text()) & _FORBIDDEN == set()


def test_the_registry_entry_serves_quotes_only_and_is_off_by_default():
    provider = REGISTRY["ibkr"]
    assert provider.kinds == ("quotes",)
    assert provider.enabled({}) is False
    assert provider.enabled({"DESK_IBKR_GATEWAY_ENABLED": "0"}) is False
    assert provider.enabled({"DESK_IBKR_GATEWAY_ENABLED": "true"}) is False
    assert provider.enabled({"DESK_IBKR_GATEWAY_ENABLED": "1"}) is True


# -- registry wiring: the quotes slot ----------------------------------------------------------------------

_ALPACA_ENV = {"ALPACA_API_KEY_ID": "k", "ALPACA_API_SECRET_KEY": "s"}
_ALPACA_BAR = {"bars": [{"t": "2026-10-23T19:44:00Z", "c": 205.25}]}


def _sources(env: dict[str, str], gateway: FakeGateway | None = None) -> tuple[DataSources, list]:
    http, session, _ = make_client([FakeResponse(200, _ALPACA_BAR) for _ in range(4)])
    registry = dict(REGISTRY)
    if gateway is not None:
        source = IbkrSource(IbkrSettings(), CREDS, gateway)
        registry["ibkr"] = replace(REGISTRY["ibkr"], build=lambda env, http: source)
    return DataSources.from_env(env={**_ALPACA_ENV, **env}, http=http, registry=registry), session.calls


def test_the_default_quotes_chain_names_the_gateway_first():
    assert DEFAULT_CHAINS["quotes"] == ("ibkr", "alpaca")


def test_with_the_switch_off_alpaca_is_the_primary_and_keeps_its_delayed_label():
    gateway = FakeGateway()
    gateway.ticks["NVDA"] = tick()
    sources, _ = _sources({}, gateway)
    [quote] = sources.quotes.latest(["NVDA"], now=NOW)
    assert (quote.provider, quote.quality) == ("alpaca", "delayed-15m")  # not relabeled "fallback"
    assert gateway.opens == 0
    assert sources.gateway_status().state == "not_configured"


def test_with_the_switch_on_the_gateway_answers_realtime():
    gateway = FakeGateway(login=CREDS)
    gateway.ticks["NVDA"] = tick(212.0)
    sources, http_calls = _sources({"DESK_IBKR_GATEWAY_ENABLED": "1"}, gateway)
    [quote] = sources.quotes.latest(["NVDA"], now=NOW)
    assert (quote.provider, quote.quality, quote.price) == ("ibkr", "realtime", 212.0)
    assert http_calls == []  # Alpaca was never asked
    assert sources.gateway_status().state == "connected"


def test_with_the_switch_on_and_the_gateway_down_alpaca_answers_labeled_fallback():
    gateway = FakeGateway(up=False)
    sources, _ = _sources({"DESK_IBKR_GATEWAY_ENABLED": "1"}, gateway)
    [quote] = sources.quotes.latest(["NVDA"], now=NOW)
    assert (quote.provider, quote.quality, quote.price) == ("alpaca", "fallback", 205.25)
    assert sources.gateway_status().state == "down"


def test_naming_only_the_gateway_while_it_is_off_fails_fast():
    with pytest.raises(ValueError, match="DATA_PROVIDERS_QUOTES"):
        DataSources.from_env(env={"DATA_PROVIDERS_QUOTES": "ibkr"})


def test_the_real_registry_builds_with_the_switch_off_and_on_without_the_wire_library():
    off = DataSources.from_env(env={})
    assert [type(p).__name__ for p in off.quotes.providers] == ["AlpacaBars"]
    on = DataSources.from_env(env={"DESK_IBKR_GATEWAY_ENABLED": "1"})
    assert [type(p).__name__ for p in on.quotes.providers] == ["IbkrSource", "AlpacaBars"]
    assert on.gateway_status().state == "not_configured"  # no data-user login in this env


# -- the wire client, against a fake ib_async module ---------------------------------------------------------


class FakeTicker:
    def __init__(self) -> None:
        self.last = self.bid = self.ask = math.nan
        self.marketDataType = 0
        self.time = None


class FakeIB:
    """Only the `ib_async.IB` calls the session may make; any other attribute access (`placeOrder`, ...) raises."""

    instances: list["FakeIB"] = []
    refuse = False

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.connected = False
        self.tickers: dict[str, FakeTicker] = {}
        FakeIB.instances.append(self)

    async def connectAsync(self, host, port, clientId, timeout, readonly):
        self.calls.append(("connectAsync", host, port, clientId, readonly))
        if FakeIB.refuse:
            raise ConnectionRefusedError("gateway not running")
        self.connected = True

    def reqMarketDataType(self, kind):
        self.calls.append(("reqMarketDataType", kind))

    async def qualifyContractsAsync(self, *contracts):
        self.calls.append(("qualifyContractsAsync",))
        for contract in contracts:
            contract.conId = 0 if contract.symbol == "NOPE" else 1
        return list(contracts)

    def reqMktData(self, contract, generic, snapshot, regulatory):
        self.calls.append(("reqMktData", contract.symbol))
        self.tickers[contract.symbol] = ticker = FakeTicker()
        return ticker

    def cancelMktData(self, contract):
        self.calls.append(("cancelMktData", contract.symbol))

    async def reqHistoricalDataAsync(self, contract, end, duration, bar_size, what, rth, fmt):
        self.calls.append(("reqHistoricalDataAsync", contract.symbol, duration, bar_size, what))
        base = pd.Timestamp("2026-10-26T13:00:00Z")
        return [
            SimpleNamespace(date=base + pd.Timedelta(minutes=m), open=1, high=2, low=1, close=2, volume=9)
            for m in range(3)
        ]

    def isConnected(self):
        return self.connected

    def disconnect(self):
        self.calls.append(("disconnect",))
        self.connected = False


FAKE_IB_ASYNC = SimpleNamespace(
    IB=FakeIB, Stock=lambda symbol, exchange, currency: SimpleNamespace(symbol=symbol, conId=0)
)
_IB_ALLOWED = {
    "connectAsync",
    "reqMarketDataType",
    "qualifyContractsAsync",
    "reqMktData",
    "cancelMktData",
    "reqHistoricalDataAsync",
    "disconnect",
}


@pytest.fixture
def fake_ib():
    FakeIB.instances, FakeIB.refuse = [], False
    return FakeIB


def open_session(settings: IbkrSettings | None = None):
    return IbAsyncConnector(FAKE_IB_ASYNC).open(
        settings or IbkrSettings(host="gw.local", port=4009, client_id=5), CREDS
    )


def test_the_wire_client_connects_read_only_and_maps_a_ticker(fake_ib):
    session = open_session()
    try:
        [ib] = fake_ib.instances
        assert ib.calls[0] == ("connectAsync", "gw.local", 4009, 5, True)  # read-only API flag, configured address
        assert session.is_connected()
        session.subscribe("NVDA")
        assert session.tick("NVDA", 0.0) == RawTick(None, None, None, 0, None)  # no tick yet: the caller omits it
        ticker = ib.tickers["NVDA"]
        ticker.last, ticker.bid, ticker.marketDataType = 210.5, math.nan, 1
        ticker.time = pd.Timestamp("2026-10-26T13:59:58Z").to_pydatetime()
        assert session.tick("NVDA", 0.5) == RawTick(210.5, None, None, 1, TICK_AT)
        session.unsubscribe("NVDA")
        assert ("cancelMktData", "NVDA") in ib.calls
        assert session.tick("NVDA", 0.0) is None
        assert {call[0] for call in ib.calls} <= _IB_ALLOWED
    finally:
        session.close()


def test_the_wire_client_reports_unknown_symbols_history_and_a_dropped_session(fake_ib):
    session = open_session()
    try:
        with pytest.raises(NoData):
            session.subscribe("NOPE")
        start = pd.Timestamp("2026-10-26T13:01:00Z")
        bars = session.minute_bars("AAPL", start, pd.Timestamp("2026-10-26T14:00:00Z"))
        assert [bar.start for bar in bars] == [
            start + pd.Timedelta(minutes=m) for m in range(2)
        ]  # 13:00 is before start
        [ib] = fake_ib.instances
        assert ("reqHistoricalDataAsync", "AAPL", "3540 S", "1 min", "TRADES") in ib.calls
        session.subscribe("AAPL")
        ib.connected = False
        assert not session.is_connected()
        with pytest.raises(Unavailable):
            session.tick("AAPL", 1.0)
    finally:
        session.close()


def test_a_gateway_that_is_not_running_is_unavailable_and_a_missing_library_is_not_configured(fake_ib, monkeypatch):
    fake_ib.refuse = True
    with pytest.raises(Unavailable, match="ConnectionRefusedError"):
        open_session()
    monkeypatch.setitem(sys.modules, "ib_async", None)  # `import ib_async` now raises ImportError
    with pytest.raises(NotConfigured, match="ib_async"):
        IbAsyncConnector().open(IbkrSettings(), CREDS)


def test_the_source_runs_end_to_end_over_the_wire_client(fake_ib):
    source = IbkrSource(IbkrSettings(tick_wait_s=0.0), CREDS, IbAsyncConnector(FAKE_IB_ASYNC))
    try:
        assert source.latest(["NVDA"], now=NOW) == []  # subscribed; no tick has arrived yet
        ticker = fake_ib.instances[0].tickers["NVDA"]
        ticker.last, ticker.marketDataType = 211.0, 3
        [quote] = source.latest(["NVDA"], now=NOW)
        assert (quote.price, quote.quality, quote.as_of) == (211.0, "delayed-15m", NOW)
        assert source.gateway_status().state == "connected"
    finally:
        source.close()
    assert source.gateway_status().state != "connected"
