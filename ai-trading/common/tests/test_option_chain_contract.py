"""The `OptionChainSource` contract (02j §9), proven on one dataset through two implementations: `FakeOptionChain`
(what the Desk's tests will use) and the real `AlpacaOptionChain` behind a fake Alpaca server that applies each
request's own filters. If the two ever disagree, the fake no longer stands in for the provider. No network."""

from dataclasses import dataclass
from datetime import date

import pandas as pd
import pytest

from ai_trading_common.http import ThrottledClient
from ai_trading_common.providers.alpaca_options import AlpacaOptionChain
from ai_trading_common.sources import OptionChainSource
from ai_trading_common.testing import FakeClock, FakeOptionChain, FakeResponse
from ai_trading_common.types import OptionContract

NOW = pd.Timestamp("2026-10-29T15:00:00Z")  # 11:00 in New York
TODAY = date(2026, 10, 29)
QUOTED_AT = pd.Timestamp("2026-10-29T14:44:00Z")


@dataclass(frozen=True)
class Spec:
    expiry: date
    right: str
    strike: float
    bid: float
    ask: float
    delta: float | None
    iv: float | None
    open_interest: int | None

    @property
    def symbol(self) -> str:
        return f"AAPL{self.expiry:%y%m%d}{self.right}{round(self.strike * 1000):08d}"

    def contract(self) -> OptionContract:
        return OptionContract(
            underlying="AAPL",
            symbol=self.symbol,
            right=self.right,
            expiry=self.expiry,
            strike=self.strike,
            dte=(self.expiry - TODAY).days,
            bid=self.bid,
            ask=self.ask,
            delta=self.delta,
            iv=self.iv,
            open_interest=self.open_interest,
            as_of=QUOTED_AT,
            provider="alpaca_options",
            quality="delayed-15m",
        )

    def snapshot(self) -> dict:
        row = {"latestQuote": {"bp": self.bid, "ap": self.ask, "t": QUOTED_AT.isoformat()}}
        if self.delta is not None:
            row["greeks"] = {"delta": self.delta}
        if self.iv is not None:
            row["impliedVolatility"] = self.iv
        return row


NOV, DEC, JAN = date(2026, 11, 20), date(2026, 12, 4), date(2027, 1, 15)
SPECS = [
    Spec(NOV, "C", 270.0, 14.9, 15.1, 0.72, 0.27, 800),
    Spec(NOV, "C", 290.0, 4.1, 4.3, 0.34, 0.25, 2500),
    Spec(NOV, "C", 300.0, 1.9, 2.0, 0.20, 0.24, 1900),
    Spec(DEC, "C", 290.0, 5.6, 5.8, 0.38, 0.26, 600),
    Spec(DEC, "C", 310.0, 1.4, 1.5, 0.17, 0.25, None),
    Spec(JAN, "C", 290.0, 8.0, 8.4, None, None, 300),
    Spec(NOV, "P", 270.0, 1.0, 1.1, -0.2, 0.28, 400),
]


class FakeAlpacaServer:
    """Answers Alpaca's snapshot and contract endpoints from `SPECS`, narrowing by the request's own parameters."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, params, headers))
        found = [s for s in SPECS if self._wanted(s, params or {})]
        if "/snapshots/" in url:
            return FakeResponse(200, {"snapshots": {s.symbol: s.snapshot() for s in found}, "next_page_token": None})
        rows = [
            {"symbol": s.symbol, "open_interest": None if s.open_interest is None else str(s.open_interest)}
            for s in found
        ]
        return FakeResponse(200, {"option_contracts": rows, "next_page_token": None})

    @staticmethod
    def _wanted(spec: Spec, params: dict) -> bool:
        return (
            params["type"] == {"C": "call", "P": "put"}[spec.right]
            and date.fromisoformat(params["expiration_date_gte"]) <= spec.expiry
            and spec.expiry <= date.fromisoformat(params["expiration_date_lte"])
            and spec.strike >= float(params.get("strike_price_gte", "-inf"))
            and spec.strike <= float(params.get("strike_price_lte", "inf"))
        )


def alpaca_source() -> AlpacaOptionChain:
    clock = FakeClock()
    client = ThrottledClient(clock=clock.now, sleep=clock.sleep, jitter=lambda a, b: 0.0, session=FakeAlpacaServer())
    return AlpacaOptionChain("kid", "sec", http=client)


def fake_source() -> FakeOptionChain:
    return FakeOptionChain({"AAPL": [s.contract() for s in SPECS]})


@pytest.fixture(params=[fake_source, alpaca_source], ids=["fake", "alpaca_options"])
def source(request):
    return request.param()


QUERIES = [
    pytest.param({"min_dte": 21, "max_dte": 45}, id="covered-call-window"),
    pytest.param({"max_dte": 90}, id="whole-quarter"),
    pytest.param({"max_dte": 45, "right": "P"}, id="puts"),
    pytest.param({"min_dte": 21, "max_dte": 45, "min_strike": 285.0, "max_strike": 300.0}, id="strike-band"),
    pytest.param({"max_dte": 5}, id="empty-window"),
]


def test_it_is_an_option_chain_source(source):
    assert isinstance(source, OptionChainSource)


@pytest.mark.parametrize("query", QUERIES)
def test_the_result_honors_the_window_and_the_stamp(source, query):
    got = source.option_chain("AAPL", now=NOW, **query)
    assert isinstance(got, list)
    assert got == sorted(got, key=lambda c: (c.expiry, c.strike))
    for c in got:
        assert isinstance(c, OptionContract)
        assert c.right == query.get("right", "C")
        assert query.get("min_dte", 0) <= c.dte <= query["max_dte"]
        assert c.dte == (c.expiry - TODAY).days
        assert query.get("min_strike", float("-inf")) <= c.strike <= query.get("max_strike", float("inf"))
        assert 0 <= c.bid <= c.ask
        assert c.as_of.tzinfo is not None
        assert c.provider and c.quality in ("delayed-15m", "unavailable")  # never realtime


def test_the_covered_call_window_has_the_expected_calls(source):
    got = source.option_chain("AAPL", now=NOW, min_dte=21, max_dte=45)
    assert [(c.expiry, c.strike) for c in got] == [
        (NOV, 270.0),
        (NOV, 290.0),
        (NOV, 300.0),
        (DEC, 290.0),
        (DEC, 310.0),
    ]
    assert [c.open_interest for c in got] == [800, 2500, 1900, 600, None]


def test_an_empty_window_is_an_empty_list(source):
    assert source.option_chain("AAPL", now=NOW, max_dte=5) == []


@pytest.mark.parametrize("query", QUERIES)
def test_the_fake_and_the_provider_agree(query):
    assert fake_source().option_chain("AAPL", now=NOW, **query) == alpaca_source().option_chain(
        "AAPL", now=NOW, **query
    )


def test_the_fake_records_its_calls_and_can_fail():
    from ai_trading_common.errors import Unavailable

    fake = FakeOptionChain(raises=Unavailable("fake", "down"))
    with pytest.raises(Unavailable):
        fake.option_chain("AAPL", now=NOW, max_dte=45)
    assert fake.calls == [("AAPL", NOW, "C", 0, 45, None, None)]
