"""Multi-provider chain precedence (02j §9), two ways:

- `Test*Chain` classes: light wiring tests per multi-provider kind (consensus, earnings,
  targets), using Protocol-conforming fakes -- confirms each chain calls the right method with
  the right keyword arguments and relabels correctly. The generic precedence law itself (a
  transient failure anywhere beats a later `NoData`, etc.) is already exhaustively pinned in
  `test_fallback.py`; these tests only pin the *wiring*, not re-derive the law.
- `TestRealAdapterFallback`: the one real-adapter, fixture-backed fallback test the brief asks
  for -- real `REGISTRY` adapters, a fake HTTP layer, Eulerpool failing live-shaped (bounded
  retries exhausted), Alpha Vantage's real recorded fixture winning, labeled `fallback`.
"""

import json
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from ai_trading_common.errors import NotConfigured, Unavailable
from ai_trading_common.registry import REGISTRY, DataSources, Provider
from ai_trading_common.testing import FakeOptionChain, FakeResponse, FakeTrades, make_client
from ai_trading_common.types import (
    ActiveSymbol,
    AnalystTargets,
    ConsensusSnapshot,
    EarningsResult,
    Mover,
    OptionContract,
    Quote,
    UniverseAsset,
)

NOW = pd.Timestamp("2026-10-11T21:00:00Z")
FIXTURES = Path(__file__).parent / "fixtures"


def _snapshot(provider: str) -> ConsensusSnapshot:
    return ConsensusSnapshot(
        symbol="AAPL",
        period_end=date(2026, 12, 31),
        period_kind="annual",
        fiscal_year=2026,
        fiscal_quarter=None,
        eps_mean=5.0,
        eps_high=6.0,
        eps_low=4.0,
        analyst_count=10,
        provider=provider,
        quality="eod",
        as_of=NOW,
    )


def _result(provider: str) -> EarningsResult:
    return EarningsResult(
        symbol="AAPL",
        period_end=date(2026, 6, 30),
        fiscal_year=2026,
        fiscal_quarter=3,
        report_date=date(2026, 7, 30),
        report_time=None,
        eps_estimate=1.9,
        eps_actual=2.02,
        surprise=0.12,
        surprise_percent=6.3,
        provider=provider,
        quality="eod",
        as_of=NOW,
    )


def _targets(provider: str, *, with_prices: bool) -> AnalystTargets:
    return AnalystTargets(
        symbol="AAPL",
        target_mean=340.72 if with_prices else None,
        target_median=360 if with_prices else None,
        target_high=400 if with_prices else None,
        target_low=245 if with_prices else None,
        strong_buy=10,
        buy=20,
        hold=5,
        sell=1,
        strong_sell=0,
        provider=provider,
        quality="eod",
        as_of=NOW,
        period=date(2026, 9, 1),
    )


class FakeConsensus:
    def __init__(self, *, result=None, raises=None):
        self._result, self._raises = result, raises

    def consensus(self, symbol, *, now):
        if self._raises:
            raise self._raises
        return self._result


class FakeEarnings:
    def __init__(self, *, result=None, raises=None):
        self._result, self._raises = result, raises

    def earnings_results(self, symbol, *, now):
        if self._raises:
            raise self._raises
        return self._result


class FakeTargets:
    def __init__(self, *, result=None, raises=None):
        self._result, self._raises = result, raises

    def analyst_targets(self, symbol, *, now):
        if self._raises:
            raise self._raises
        return self._result


def _sources_with(**overrides) -> DataSources:
    """A `DataSources` where only the kinds in `overrides` matter; every other kind falls back to
    a trivial, never-called stub (each test here only calls the kind(s) it overrides)."""
    registry = dict(REGISTRY)
    defaults = {
        "bars": ("alpaca",),
        "fundamentals": ("sec_edgar",),
        "earnings_announcements": ("sec_edgar",),
        "macro": ("fred",),
        "news": ("finnhub",),
        "earnings_calendar": ("finnhub",),
        "consensus": ("eulerpool", "alphavantage"),
        "earnings": ("eulerpool", "finnhub", "alphavantage"),
        "targets": ("eulerpool", "finnhub"),
        "universe": ("alpaca",),
        "quotes": ("alpaca",),
        "trades": ("alpaca",),
        "option_chain": ("alpaca_options",),
    }
    for kind, (names, adapter) in overrides.items():
        names_tuple = tuple(names) if isinstance(names, list) else names
        for i in range(len(names_tuple)):
            key = f"_fake_{kind}_{i}"
            registry[key] = Provider(name=key, kinds=(kind,), build=lambda env, http, a=adapter[i]: a)
        defaults[kind] = tuple(f"_fake_{kind}_{i}" for i in range(len(names_tuple)))
    return DataSources.from_env(env={}, registry=registry, defaults=defaults)


class RecordingBars:
    """Records the keyword arguments each `bars` call received, so a test can see what the chain forwards."""

    def __init__(self):
        self.kwargs: list[dict] = []

    def bars(self, symbol, timeframe, start, end, **kwargs):
        self.kwargs.append(kwargs)
        return "bars"


class TestBarsChain:
    def test_adjustment_is_forwarded_only_when_it_is_not_the_default(self):
        recorder = RecordingBars()
        sources = _sources_with(bars=(["a"], [recorder]))
        sources.bars.bars("AAPL", "1d", NOW, NOW, now=NOW)
        sources.bars.bars("AAPL", "1d", NOW, NOW, now=NOW, adjustment="raw")
        assert recorder.kwargs == [{"now": NOW}, {"now": NOW, "adjustment": "raw"}]


def _prints(*times: str) -> pd.DataFrame:
    n = len(times)
    return pd.DataFrame(
        {
            "t": pd.to_datetime(list(times), utc=True),
            "p": [10.0] * n,
            "s": [100] * n,
            "x": ["V"] * n,
            "c": [""] * n,
        }
    )


class TestTradesChain:
    def test_a_refused_sip_feed_falls_through_to_the_next_provider(self):
        primary = FakeTrades(refuse_sip=True)
        secondary = FakeTrades({("AAPL", "sip"): _prints("2026-10-11T20:00:00Z", "2026-10-12T00:00:00Z")})
        sources = _sources_with(trades=(["a", "b"], [primary, secondary]))
        start, end = pd.Timestamp("2026-10-11T19:00:00Z"), pd.Timestamp("2026-10-11T23:00:00Z")
        got = sources.trades.trades("AAPL", start, end, feed="sip", now=NOW)
        assert got.source == "fake"
        assert len(got.frame) == 1  # the 00:00 next-day print is outside the window
        assert primary.calls == [("AAPL", start, end, "sip")]
        assert secondary.calls == [("AAPL", start, end, "sip")]


class TestConsensusChain:
    def test_eulerpool_primary_keeps_its_own_quality(self):
        sources = _sources_with(consensus=(["a"], [FakeConsensus(result=[_snapshot("a")])]))
        got = sources.consensus.consensus("AAPL", now=NOW)
        assert got[0].quality == "eod"

    def test_a_later_providers_result_is_relabeled_fallback(self):
        primary = FakeConsensus(raises=Unavailable("eulerpool", "down"))
        secondary = FakeConsensus(result=[_snapshot("alphavantage")])
        sources = _sources_with(consensus=(["a", "b"], [primary, secondary]))
        got = sources.consensus.consensus("AAPL", now=NOW)
        assert got[0].quality == "fallback"
        assert got[0].provider == "alphavantage"


class TestEarningsChain:
    def test_finnhub_tried_before_alphavantage(self):
        primary = FakeEarnings(raises=Unavailable("eulerpool", "down"))
        finnhub = FakeEarnings(result=[_result("finnhub")])
        av = FakeEarnings(raises=AssertionError("should not be reached"))
        sources = _sources_with(earnings=(["e", "f", "a"], [primary, finnhub, av]))
        got = sources.earnings.earnings_results("AAPL", now=NOW)
        assert got[0].provider == "finnhub"
        assert got[0].quality == "fallback"


class TestTargetsChain:
    def test_finnhub_fallback_has_counts_but_no_targets(self):
        primary = FakeTargets(raises=Unavailable("eulerpool", "down"))
        finnhub = FakeTargets(result=_targets("finnhub", with_prices=False))
        sources = _sources_with(targets=(["e", "f"], [primary, finnhub]))
        got = sources.targets.analyst_targets("AAPL", now=NOW)
        assert got.quality == "fallback"
        assert got.period == date(2026, 9, 1)
        assert got.provider == "finnhub"
        assert got.target_mean is None
        assert got.buy == 20

    def test_not_configured_falls_through_like_unavailable(self):
        primary = FakeTargets(raises=NotConfigured("eulerpool", "no key"))
        finnhub = FakeTargets(result=_targets("finnhub", with_prices=False))
        sources = _sources_with(targets=(["e", "f"], [primary, finnhub]))
        got = sources.targets.analyst_targets("AAPL", now=NOW)
        assert got.provider == "finnhub"


class FakeUniverse:
    def __init__(self, *, result=None, raises=None):
        self._result, self._raises = result, raises

    def assets(self):
        return self._pick()

    def most_actives(self, by, top):
        return self._pick()

    def movers(self, top):
        return self._pick()

    def _pick(self):
        if self._raises:
            raise self._raises
        return self._result


class FakeQuotes:
    def __init__(self, *, result=None, raises=None):
        self._result, self._raises = result, raises

    def latest(self, symbols, *, now):
        if self._raises:
            raise self._raises
        return self._result


class TestUniverseChain:
    def test_every_universe_call_falls_back_and_relabels(self):
        asset = UniverseAsset("AAPL", "Apple", "NASDAQ", "b", "eod")
        active = ActiveSymbol("AAPL", 10.0, 5, "b", "delayed-15m")
        mover = Mover("AAPL", "gainer", 1.5, 10.0, "b", "delayed-15m")
        sources = _sources_with(
            universe=(
                ["a", "b"],
                [FakeUniverse(raises=Unavailable("a", "down")), FakeUniverse(result=[asset])],
            )
        )
        assert sources.universe.assets()[0].quality == "fallback"
        sources = _sources_with(
            universe=(["a", "b"], [FakeUniverse(raises=Unavailable("a", "down")), FakeUniverse(result=[active])])
        )
        assert sources.universe.most_actives("volume", 10) == [ActiveSymbol("AAPL", 10.0, 5, "b", "fallback")]
        sources = _sources_with(
            universe=(["a", "b"], [FakeUniverse(raises=Unavailable("a", "down")), FakeUniverse(result=[mover])])
        )
        assert sources.universe.movers(5)[0].quality == "fallback"


class TestQuotesChain:
    def test_a_later_provider_quote_is_relabeled_fallback(self):
        quote = Quote("AAPL", 10.0, NOW, "b", "delayed-15m")
        sources = _sources_with(
            quotes=(["a", "b"], [FakeQuotes(raises=NotConfigured("a", "no key")), FakeQuotes(result=[quote])])
        )
        got = sources.quotes.latest(["AAPL"], now=NOW)
        assert got[0].quality == "fallback"
        assert got[0].provider == "b"

    def test_the_primary_keeps_its_own_quality(self):
        quote = Quote("AAPL", 10.0, NOW, "a", "delayed-15m")
        sources = _sources_with(quotes=(["a"], [FakeQuotes(result=[quote])]))
        assert sources.quotes.latest(["AAPL"], now=NOW)[0].quality == "delayed-15m"


class TestRealAdapterFallback:
    """Real `REGISTRY` adapters (Eulerpool, Alpha Vantage), a fake HTTP layer: Eulerpool fails
    the way a real outage looks (bounded retries exhausted -> `Unavailable`), Alpha Vantage's
    real recorded fixture answers -- the result must come back labeled `fallback`."""

    def test_eulerpool_unavailable_falls_back_to_alphavantages_fixture(self):
        av_body = json.loads((FIXTURES / "alphavantage" / "earnings_estimates_aapl.json").read_text())["body"]
        # Eulerpool's 4 bounded retries, then Alpha Vantage's real fixture.
        responses = [FakeResponse(500, {}) for _ in range(4)] + [FakeResponse(200, av_body)]
        http, session, _ = make_client(responses)

        sources = DataSources.from_env(
            env={
                "DATA_PROVIDERS_CONSENSUS": "eulerpool,alphavantage",
                "EULERPOOL_API_KEY": "fake-eulerpool-key",
                "ALPHA_VANTAGE_API_KEY": "fake-av-key",
            },
            http=http,
        )

        got = sources.consensus.consensus("AAPL", now=NOW)

        assert len(session.calls) == 5  # 4 failed Eulerpool attempts + 1 successful Alpha Vantage call
        assert got
        assert all(row.provider == "alphavantage" and row.quality == "fallback" for row in got)


class TestOptionChainChain:
    def _contract(self, provider: str, quality="delayed-15m") -> OptionContract:
        return OptionContract(
            underlying="AAPL",
            symbol="AAPL261120C00290000",
            right="C",
            expiry=date(2026, 11, 20),
            strike=290.0,
            dte=40,
            bid=4.1,
            ask=4.3,
            delta=0.34,
            iv=0.25,
            open_interest=2500,
            as_of=NOW,
            provider=provider,
            quality=quality,
        )

    def test_a_later_provider_chain_is_relabeled_fallback(self):
        primary = FakeOptionChain(raises=Unavailable("a", "down"))
        secondary = FakeOptionChain({"AAPL": [self._contract("b")]})
        sources = _sources_with(option_chain=(["a", "b"], [primary, secondary]))
        got = sources.option_chain.option_chain("AAPL", now=NOW, min_dte=30, max_dte=45)
        assert [c.quality for c in got] == ["fallback"]

    def test_the_primary_keeps_its_own_quality(self):
        primary = FakeOptionChain({"AAPL": [self._contract("a")]})
        sources = _sources_with(option_chain=(["a"], [primary]))
        got = sources.option_chain.option_chain("AAPL", now=NOW, min_dte=30, max_dte=45)
        assert [c.quality for c in got] == ["delayed-15m"]

    def test_with_every_provider_down_the_outage_is_raised_not_an_empty_chain(self):
        down = FakeOptionChain(raises=NotConfigured("a", "no key"))
        sources = _sources_with(option_chain=(["a"], [down]))
        with pytest.raises(NotConfigured):
            sources.option_chain.option_chain("AAPL", now=NOW, max_dte=45)
