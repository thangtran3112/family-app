"""`DataSources.from_env` (02j §5, §9 "Registry" and "Swap").

Uses a small, synthetic registry/defaults covering all thirteen kinds with fake adapters -- not the
real six vendors -- so these tests pin the registry *machinery* (defaults, env override, startup
failures, whitespace, build-once, swapping a provider) independently of any real provider's
shape. `test_conformance.py` and `test_chains.py` cover the real `REGISTRY`.
"""

from dataclasses import fields
from typing import get_args

import pandas as pd
import pytest

from ai_trading_common.errors import Unavailable
from ai_trading_common.registry import DEFAULT_CHAINS, KIND_PROTOCOLS, DataSources, Kind, Provider

NOW = pd.Timestamp("2026-10-11T00:00:00Z")


class FakeAdapter:
    """Implements every Protocol method across all thirteen kinds with trivial canned values, so one
    fake can serve as the provider for any kind in a test's custom `registry=`/`defaults=`."""

    def __init__(self, label: str, *, raises: Exception | None = None) -> None:
        self.label = label
        self.raises = raises
        self.build_count = 0

    def _value(self):
        if self.raises is not None:
            raise self.raises
        return self.label

    def bars(self, symbol, timeframe, start, end, *, now):
        return self._value()

    def facts(self, symbol, *, as_of, concepts=None):
        return [self._value()]

    def announcements(self, symbol, *, since):
        return [self._value()]

    def observations(self, series_id, start, end, *, as_of):
        return [self._value()]

    def release_dates(self, series_id, *, as_of=None):
        return [self._value()]

    def news(self, symbol, start, end):
        return [self._value()]

    def earnings_calendar(self, symbol, start, end):
        return [self._value()]

    def consensus(self, symbol, *, now):
        return [self._value()]

    def earnings_results(self, symbol, *, now):
        return [self._value()]

    def analyst_targets(self, symbol, *, now):
        return self._value()

    def assets(self):
        return [self._value()]

    def most_actives(self, by, top):
        return [self._value()]

    def movers(self, top):
        return [self._value()]

    def latest(self, symbols, *, now):
        return [self._value()]

    def trades(self, symbol, start, end, *, feed, now=None):
        return self._value()

    def option_chain(self, symbol, *, now, right="C", min_dte=0, max_dte, min_strike=None, max_strike=None):
        return [self._value()]


_ALL_KINDS = (
    "bars",
    "fundamentals",
    "earnings_announcements",
    "macro",
    "news",
    "earnings_calendar",
    "consensus",
    "earnings",
    "targets",
    "universe",
    "quotes",
    "trades",
    "option_chain",
)


def _provider(name: str, adapter: FakeAdapter, kinds: tuple[str, ...] = _ALL_KINDS) -> Provider:
    def build(env, http):
        adapter.build_count += 1
        return adapter

    return Provider(name=name, kinds=kinds, build=build)


def _full_setup(*, extra: dict[str, Provider] | None = None) -> tuple[dict[str, Provider], dict[str, tuple[str, ...]]]:
    """A complete registry/defaults pair covering all thirteen kinds with one shared fake provider
    named "fake", so a test only has to override the one kind (or provider) it cares about."""
    fake = FakeAdapter("fake")
    registry = {"fake": _provider("fake", fake)}
    if extra:
        registry.update(extra)
    defaults = {kind: ("fake",) for kind in _ALL_KINDS}
    return registry, defaults


class TestDefaults:
    def test_an_unset_env_var_uses_the_default_chain(self):
        registry, defaults = _full_setup()
        sources = DataSources.from_env(env={}, registry=registry, defaults=defaults)
        assert sources.bars.bars("AAPL", "1d", None, None, now=NOW) == "fake"

    def test_every_kind_is_registered_in_each_table(self):
        assert set(KIND_PROTOCOLS) == set(get_args(Kind)) == set(DEFAULT_CHAINS)

    def test_trades_defaults_to_alpaca(self):
        assert DEFAULT_CHAINS["trades"] == ("alpaca",)


class TestTradesKind:
    def test_data_sources_has_a_trades_field_after_quotes(self):
        names = [f.name for f in fields(DataSources)]
        assert names.index("trades") == names.index("quotes") + 1

    def test_a_trades_provider_is_served_through_the_chain(self):
        fake = FakeAdapter("trades-fake")
        registry, defaults = _full_setup(extra={"custom": _provider("custom", fake, kinds=("trades",))})
        sources = DataSources.from_env(env={"DATA_PROVIDERS_TRADES": "custom"}, registry=registry, defaults=defaults)
        assert sources.trades.trades("AAPL", NOW, NOW, feed="sip") == "trades-fake"

    def test_an_unknown_provider_for_trades_raises_value_error(self):
        registry, defaults = _full_setup()
        with pytest.raises(ValueError, match="DATA_PROVIDERS_TRADES names unknown provider 'nope'"):
            DataSources.from_env(env={"DATA_PROVIDERS_TRADES": "nope"}, registry=registry, defaults=defaults)

    def test_a_provider_that_does_not_serve_trades_raises_value_error(self):
        only_bars = FakeAdapter("only_bars")
        registry, defaults = _full_setup(extra={"only_bars": _provider("only_bars", only_bars, kinds=("bars",))})
        with pytest.raises(ValueError, match="does not serve 'trades'"):
            DataSources.from_env(env={"DATA_PROVIDERS_TRADES": "only_bars"}, registry=registry, defaults=defaults)


class TestOptionChainKind:
    def test_option_chain_defaults_to_alpaca_options(self):
        assert DEFAULT_CHAINS["option_chain"] == ("alpaca_options",)

    def test_data_sources_has_an_option_chain_field_last_and_defaulted(self):
        # It is the last *kind* field; the two seams follow it (02t B2): `bridge`, the routing surface the
        # Settings card and the sync job read, and `serving`, the per-class vendor `/status` reports.
        names = [f.name for f in fields(DataSources)]
        kinds = [name for name in names if name in set(get_args(Kind))]
        assert names.index("option_chain") == len(kinds) - 1
        assert fields(DataSources)[names.index("option_chain")].default is None  # a pre-existing DataSources builds
        assert [name for name in names if name not in set(get_args(Kind))] == ["bridge", "serving"]

    def test_a_pre_option_chain_data_sources_still_builds(self):
        unused = object()
        old_fields = {f.name: unused for f in fields(DataSources) if f.name != "option_chain"}
        assert DataSources(**old_fields).option_chain is None

    def test_an_option_chain_provider_is_served_through_the_chain(self):
        fake = FakeAdapter("chain-fake")
        registry, defaults = _full_setup(extra={"custom": _provider("custom", fake, kinds=("option_chain",))})
        env = {"DATA_PROVIDERS_OPTION_CHAIN": "custom"}
        sources = DataSources.from_env(env=env, registry=registry, defaults=defaults)
        assert sources.option_chain.option_chain("AAPL", now=NOW, max_dte=45) == ["chain-fake"]

    def test_the_chain_forwards_every_argument(self):
        seen = {}

        class Recorder:
            def option_chain(self, symbol, **kwargs):
                seen.update(symbol=symbol, **kwargs)
                return []

        registry, defaults = _full_setup(
            extra={"rec": Provider(name="rec", kinds=("option_chain",), build=lambda env, http: Recorder())}
        )
        sources = DataSources.from_env(env={"DATA_PROVIDERS_OPTION_CHAIN": "rec"}, registry=registry, defaults=defaults)
        sources.option_chain.option_chain(
            "AAPL", now=NOW, right="P", min_dte=7, max_dte=45, min_strike=100.0, max_strike=150.0
        )
        assert seen == {
            "symbol": "AAPL",
            "now": NOW,
            "right": "P",
            "min_dte": 7,
            "max_dte": 45,
            "min_strike": 100.0,
            "max_strike": 150.0,
        }

    def test_a_provider_that_does_not_serve_option_chain_raises_value_error(self):
        only_bars = FakeAdapter("only_bars")
        registry, defaults = _full_setup(extra={"only_bars": _provider("only_bars", only_bars, kinds=("bars",))})
        with pytest.raises(ValueError, match="does not serve 'option_chain'"):
            DataSources.from_env(env={"DATA_PROVIDERS_OPTION_CHAIN": "only_bars"}, registry=registry, defaults=defaults)


class TestEnvOverride:
    def test_an_env_var_reorders_a_chain(self):
        a, b = FakeAdapter("a"), FakeAdapter("b")
        registry, defaults = _full_setup(
            extra={"a": _provider("a", a, kinds=("consensus",)), "b": _provider("b", b, kinds=("consensus",))}
        )
        defaults = {**defaults, "consensus": ("b", "a")}  # default: b primary

        by_default = DataSources.from_env(env={}, registry=registry, defaults=defaults)
        assert by_default.consensus.consensus("AAPL", now=NOW) == ["b"]

        overridden = DataSources.from_env(env={"DATA_PROVIDERS_CONSENSUS": "a,b"}, registry=registry, defaults=defaults)
        assert overridden.consensus.consensus("AAPL", now=NOW) == ["a"]


class TestStartupFailures:
    def test_an_empty_list_raises_value_error_naming_the_var(self):
        registry, defaults = _full_setup()
        with pytest.raises(ValueError, match="DATA_PROVIDERS_BARS"):
            DataSources.from_env(env={"DATA_PROVIDERS_BARS": ""}, registry=registry, defaults=defaults)

    def test_an_unknown_provider_name_raises_value_error(self):
        registry, defaults = _full_setup()
        with pytest.raises(ValueError, match="unknown provider 'nope'"):
            DataSources.from_env(env={"DATA_PROVIDERS_BARS": "nope"}, registry=registry, defaults=defaults)

    def test_a_provider_that_does_not_serve_the_kind_raises_value_error(self):
        only_bars = FakeAdapter("only_bars")
        registry, defaults = _full_setup(extra={"only_bars": _provider("only_bars", only_bars, kinds=("bars",))})
        with pytest.raises(ValueError, match="does not serve 'macro'"):
            DataSources.from_env(env={"DATA_PROVIDERS_MACRO": "only_bars"}, registry=registry, defaults=defaults)


class TestWhitespace:
    def test_surrounding_whitespace_in_a_list_is_tolerated(self):
        a, b = FakeAdapter("a"), FakeAdapter("b")
        registry, defaults = _full_setup(
            extra={"a": _provider("a", a, kinds=("consensus",)), "b": _provider("b", b, kinds=("consensus",))}
        )
        sources = DataSources.from_env(
            env={"DATA_PROVIDERS_CONSENSUS": " a , b "}, registry=registry, defaults=defaults
        )
        assert sources.consensus.consensus("AAPL", now=NOW) == ["a"]


class TestBuildOnce:
    def test_a_provider_used_in_two_kinds_is_built_exactly_once(self):
        shared = FakeAdapter("shared")
        registry, defaults = _full_setup(extra={"shared": _provider("shared", shared)})
        defaults = {**defaults, "bars": ("shared",), "macro": ("shared",)}
        DataSources.from_env(env={}, registry=registry, defaults=defaults)
        assert shared.build_count == 1


class TestSwap:
    def test_a_fake_provider_through_registry_serves_data_with_no_caller_change(self):
        fake = FakeAdapter("swapped-in")
        registry, defaults = _full_setup(extra={"custom": _provider("custom", fake, kinds=("bars",))})
        sources = DataSources.from_env(env={"DATA_PROVIDERS_BARS": "custom"}, registry=registry, defaults=defaults)
        assert sources.bars.bars("AAPL", "1d", None, None, now=NOW) == "swapped-in"

    def test_when_the_primary_raises_unavailable_the_next_providers_result_is_labeled_fallback(self):
        from dataclasses import dataclass

        from ai_trading_common.quality import Quality

        @dataclass(frozen=True)
        class Labeled:
            value: str
            quality: Quality

        class PrimaryFails:
            def bars(self, symbol, timeframe, start, end, *, now):
                raise Unavailable("primary", "down")

        class SecondarySucceeds:
            def bars(self, symbol, timeframe, start, end, *, now):
                return Labeled("secondary", "eod")

        registry, defaults = _full_setup(
            extra={
                "primary": Provider(name="primary", kinds=("bars",), build=lambda env, http: PrimaryFails()),
                "secondary": Provider(name="secondary", kinds=("bars",), build=lambda env, http: SecondarySucceeds()),
            }
        )
        sources = DataSources.from_env(
            env={"DATA_PROVIDERS_BARS": "primary,secondary"}, registry=registry, defaults=defaults
        )
        got = sources.bars.bars("AAPL", "1d", None, None, now=NOW)
        assert got.value == "secondary"
        assert got.quality == "fallback"
