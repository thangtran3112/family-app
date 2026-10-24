"""Provider registry, default chains, and `DataSources.from_env()` (02j §5-6).

Adding a provider for a kind is one new line in `REGISTRY` (and, to make it the default,
`DEFAULT_CHAINS`); no caller code changes, because every caller only ever sees a `DataSources`
built from this module, typed to the `sources.py` Protocols.

**Import note:** `Provider`'s actual definition lives in `_provider.py`, a leaf module with no
dependency on this module or on `providers/*`, and is re-exported here as
`ai_trading_common.registry.Provider` (the name §5 fixes). This avoids a `registry.py` <->
`providers/*.py` import cycle: each `providers/<name>.py` module imports `Provider` from
`_provider` directly, never from `registry.py`, so importing a provider module on its own (as
its own tests do) never needs this module to exist yet.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Literal

from ai_trading_common._provider import Provider
from ai_trading_common.fallback import first_success
from ai_trading_common.http import ThrottledClient
from ai_trading_common.providers import (
    alpaca,
    alphavantage,
    eulerpool,
    finnhub,
    fred,
    ibkr,
    sec_edgar,
)
from ai_trading_common.sources import (
    BarsSource,
    ConsensusSource,
    EarningsAnnouncementsSource,
    EarningsCalendarSource,
    EarningsSource,
    FundamentalsSource,
    GatewayStatusSource,
    MacroSource,
    NewsSource,
    QuoteSource,
    TargetsSource,
    UniverseSource,
)
from ai_trading_common.types import GatewayStatus

__all__ = ("Kind", "Provider", "REGISTRY", "DEFAULT_CHAINS", "DataSources", "KIND_PROTOCOLS")

Kind = Literal[
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
]

#: Every kind, in `DataSources`' own field order. Fixed, not derived from `DEFAULT_CHAINS`, so
#: `DataSources` is always built with all eleven fields regardless of how small a custom
#: `registry=`/`defaults=` override is (a test overriding one kind still needs the rest).
_KINDS: tuple[Kind, ...] = (
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
)


def _relabel(result: object) -> object:
    """A non-primary chain result, relabeled `quality="fallback"` (02j §6).

    `Bars` and every `types.py` record carry a `quality` field and support `dataclasses.replace`
    (all frozen dataclasses); a plain value (e.g. `release_dates`' `list[date]`) has no `quality`
    attribute and is returned unchanged, per the spec ("Plain values ... are returned unchanged").
    """
    if isinstance(result, list):
        return [replace(item, quality="fallback") if hasattr(item, "quality") else item for item in result]
    if hasattr(result, "quality"):
        return replace(result, quality="fallback")
    return result


def _chain_call(providers: Sequence[object], method: str, *args: object, **kwargs: object) -> object:
    """Try `method` on each provider in order via `fallback.first_success`; relabel a non-primary
    result. Shared by every kind's chain class below so the fallback precedence lives in exactly
    one place."""
    calls = [(lambda provider=provider: getattr(provider, method)(*args, **kwargs)) for provider in providers]
    result, is_primary = first_success(calls)
    return result if is_primary else _relabel(result)


@dataclass(frozen=True)
class _BarsChain:
    providers: tuple[BarsSource, ...]

    def bars(self, symbol, timeframe, start, end, *, now):
        return _chain_call(self.providers, "bars", symbol, timeframe, start, end, now=now)


@dataclass(frozen=True)
class _FundamentalsChain:
    providers: tuple[FundamentalsSource, ...]

    def facts(self, symbol, *, as_of, concepts=None):
        return _chain_call(self.providers, "facts", symbol, as_of=as_of, concepts=concepts)


@dataclass(frozen=True)
class _EarningsAnnouncementsChain:
    providers: tuple[EarningsAnnouncementsSource, ...]

    def announcements(self, symbol, *, since):
        return _chain_call(self.providers, "announcements", symbol, since=since)


@dataclass(frozen=True)
class _MacroChain:
    providers: tuple[MacroSource, ...]

    def observations(self, series_id, start, end, *, as_of):
        return _chain_call(self.providers, "observations", series_id, start, end, as_of=as_of)

    def release_dates(self, series_id, *, as_of=None):
        return _chain_call(self.providers, "release_dates", series_id, as_of=as_of)


@dataclass(frozen=True)
class _NewsChain:
    providers: tuple[NewsSource, ...]

    def news(self, symbol, start, end):
        return _chain_call(self.providers, "news", symbol, start, end)


@dataclass(frozen=True)
class _EarningsCalendarChain:
    providers: tuple[EarningsCalendarSource, ...]

    def earnings_calendar(self, symbol, start, end):
        return _chain_call(self.providers, "earnings_calendar", symbol, start, end)


@dataclass(frozen=True)
class _ConsensusChain:
    providers: tuple[ConsensusSource, ...]

    def consensus(self, symbol, *, now):
        return _chain_call(self.providers, "consensus", symbol, now=now)


@dataclass(frozen=True)
class _EarningsChain:
    providers: tuple[EarningsSource, ...]

    def earnings_results(self, symbol, *, now):
        return _chain_call(self.providers, "earnings_results", symbol, now=now)


@dataclass(frozen=True)
class _TargetsChain:
    providers: tuple[TargetsSource, ...]

    def analyst_targets(self, symbol, *, now):
        return _chain_call(self.providers, "analyst_targets", symbol, now=now)


@dataclass(frozen=True)
class _UniverseChain:
    providers: tuple[UniverseSource, ...]

    def assets(self):
        return _chain_call(self.providers, "assets")

    def most_actives(self, by, top):
        return _chain_call(self.providers, "most_actives", by, top)

    def movers(self, top):
        return _chain_call(self.providers, "movers", top)


@dataclass(frozen=True)
class _QuotesChain:
    providers: tuple[QuoteSource, ...]

    def latest(self, symbols, *, now):
        return _chain_call(self.providers, "latest", symbols, now=now)


#: Kind -> its chain class and its Protocol (the latter used by the conformance test to check
#: each registered provider's adapter against every kind it claims to serve).
_CHAIN_CLASSES: dict[Kind, type] = {
    "bars": _BarsChain,
    "fundamentals": _FundamentalsChain,
    "earnings_announcements": _EarningsAnnouncementsChain,
    "macro": _MacroChain,
    "news": _NewsChain,
    "earnings_calendar": _EarningsCalendarChain,
    "consensus": _ConsensusChain,
    "earnings": _EarningsChain,
    "targets": _TargetsChain,
    "universe": _UniverseChain,
    "quotes": _QuotesChain,
}

KIND_PROTOCOLS: dict[Kind, type] = {
    "bars": BarsSource,
    "fundamentals": FundamentalsSource,
    "earnings_announcements": EarningsAnnouncementsSource,
    "macro": MacroSource,
    "news": NewsSource,
    "earnings_calendar": EarningsCalendarSource,
    "consensus": ConsensusSource,
    "earnings": EarningsSource,
    "targets": TargetsSource,
    "universe": UniverseSource,
    "quotes": QuoteSource,
}


#: One line per provider, sorted by name -- a provider task (02j §11, 2a.2-2a.5) adds exactly
#: one line here.
REGISTRY: dict[str, Provider] = {
    "alpaca": alpaca.PROVIDER,
    "alphavantage": alphavantage.PROVIDER,
    "eulerpool": eulerpool.PROVIDER,
    "finnhub": finnhub.PROVIDER,
    "fred": fred.PROVIDER,
    "ibkr": ibkr.PROVIDER,
    "sec_edgar": sec_edgar.PROVIDER,
}

#: One line per kind, sorted by kind name -- a provider task adds or extends the line(s) for the
#: kinds it serves as the default chain's right-hand column (02j §3).
DEFAULT_CHAINS: dict[Kind, tuple[str, ...]] = {
    "bars": ("alpaca",),
    "consensus": ("eulerpool", "alphavantage"),
    "earnings": ("eulerpool", "finnhub", "alphavantage"),
    "earnings_announcements": ("sec_edgar",),
    "earnings_calendar": ("finnhub",),
    "fundamentals": ("sec_edgar",),
    "macro": ("fred",),
    "news": ("finnhub",),
    "quotes": ("ibkr", "alpaca"),  # ibkr only joins while its switch is on (Provider.enabled)
    "targets": ("eulerpool", "finnhub"),
    "universe": ("alpaca",),
}


@dataclass(frozen=True)
class DataSources:
    """One attribute per kind, each a chain object implementing that kind's Protocol -- a caller
    cannot tell a one-provider chain from a multi-provider fallback chain."""

    bars: BarsSource
    fundamentals: FundamentalsSource
    earnings_announcements: EarningsAnnouncementsSource
    macro: MacroSource
    news: NewsSource
    earnings_calendar: EarningsCalendarSource
    consensus: ConsensusSource
    earnings: EarningsSource
    targets: TargetsSource
    universe: UniverseSource
    quotes: QuoteSource

    def gateway_status(self) -> GatewayStatus:
        """How the live-quote gateway stands: the first quotes provider that holds one reports it, and
        with none in the chain (switched off) the answer is `not_configured`."""
        for provider in getattr(self.quotes, "providers", ()):
            if isinstance(provider, GatewayStatusSource):
                return provider.gateway_status()
        return GatewayStatus("not_configured", None, None)

    @staticmethod
    def from_env(
        env: Mapping[str, str] = os.environ,
        *,
        http: ThrottledClient | None = None,
        registry: Mapping[str, Provider] = REGISTRY,
        defaults: Mapping[Kind, tuple[str, ...]] = DEFAULT_CHAINS,
    ) -> DataSources:
        """Builds every kind's chain from `env`'s `DATA_PROVIDERS_<KIND>` overrides, falling back
        to `defaults`. Fails fast (`ValueError`, naming the env var) when a list is empty, names
        an unknown provider, or names a provider that doesn't serve that kind -- a missing API
        key is never a startup error (the provider itself raises `NotConfigured` when called).
        Each named provider is built at most once and shared across every kind it serves. A
        provider whose `enabled(env)` is False is validated but left out of the chain (a chain with
        nothing left is a `ValueError` too).
        """
        http = http or ThrottledClient()
        built: dict[str, object] = {}

        def adapter_for(name: str) -> object:
            if name not in built:
                built[name] = registry[name].build(env, http)
            return built[name]

        kinds: dict[Kind, object] = {}
        for kind in _KINDS:
            var = f"DATA_PROVIDERS_{kind.upper()}"
            raw = env.get(var)
            names = defaults.get(kind, ()) if raw is None else tuple(part.strip() for part in raw.split(","))
            if not names or any(not name for name in names):
                raise ValueError(f"{var} must name at least one provider")
            providers: list[object] = []
            for name in names:
                if name not in registry:
                    raise ValueError(f"{var} names unknown provider {name!r}")
                if kind not in registry[name].kinds:
                    raise ValueError(f"{var}: provider {name!r} does not serve {kind!r}")
                if registry[name].enabled(env):
                    providers.append(adapter_for(name))
            if not providers:
                raise ValueError(f"{var}: every named provider is switched off")
            kinds[kind] = _CHAIN_CLASSES[kind](tuple(providers))

        return DataSources(**kinds)
