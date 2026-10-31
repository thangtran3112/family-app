"""One runtime-checkable `Protocol` per data kind (02j §3).

`registry.py` is the only module that builds concrete providers; this module only names the
shape each kind's provider (or chain) must have, so `registry.py`'s conformance test can check
`isinstance(adapter, SomeSource)` and a caller can type-hint against the Protocol instead of a
vendor class. No vendor module is imported here.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date
from typing import Literal, Protocol, runtime_checkable

import pandas as pd

from ai_trading_common.bars import Bars, Timeframe
from ai_trading_common.trades import Trades
from ai_trading_common.types import (
    ActiveSymbol,
    AnalystTargets,
    ConsensusSnapshot,
    EarningsAnnouncement,
    EarningsEvent,
    EarningsResult,
    Fact,
    GatewayStatus,
    Mover,
    NewsItem,
    Observation,
    OptionContract,
    OptionRight,
    ProviderHealth,
    Quote,
    Routing,
    UniverseAsset,
)


@runtime_checkable
class BarsSource(Protocol):
    def bars(
        self,
        symbol: str,
        timeframe: Timeframe,
        start: pd.Timestamp,
        end: pd.Timestamp,
        *,
        now: pd.Timestamp,
        adjustment: str = "all",
    ) -> Bars: ...


@runtime_checkable
class TradesSource(Protocol):
    def trades(
        self,
        symbol: str,
        start: pd.Timestamp,
        end: pd.Timestamp,
        *,
        feed: Literal["sip", "iex"],
        now: pd.Timestamp | None = None,
    ) -> Trades: ...


@runtime_checkable
class FundamentalsSource(Protocol):
    def facts(self, symbol: str, *, as_of: date, concepts: tuple[str, ...] | None = None) -> list[Fact]: ...


@runtime_checkable
class EarningsAnnouncementsSource(Protocol):
    def announcements(self, symbol: str, *, since: date) -> list[EarningsAnnouncement]: ...


@runtime_checkable
class MacroSource(Protocol):
    def observations(self, series_id: str, start: date, end: date, *, as_of: date) -> list[Observation]: ...

    def release_dates(self, series_id: str, *, as_of: date | None = None) -> list[date]: ...


@runtime_checkable
class NewsSource(Protocol):
    def news(self, symbol: str, start: date, end: date) -> list[NewsItem]: ...


@runtime_checkable
class EarningsCalendarSource(Protocol):
    def earnings_calendar(self, symbol: str, start: date, end: date) -> list[EarningsEvent]: ...


@runtime_checkable
class ConsensusSource(Protocol):
    def consensus(self, symbol: str, *, now: pd.Timestamp) -> list[ConsensusSnapshot]: ...


@runtime_checkable
class EarningsSource(Protocol):
    def earnings_results(self, symbol: str, *, now: pd.Timestamp) -> list[EarningsResult]: ...


@runtime_checkable
class TargetsSource(Protocol):
    def analyst_targets(self, symbol: str, *, now: pd.Timestamp) -> AnalystTargets: ...


@runtime_checkable
class UniverseSource(Protocol):
    def assets(self) -> list[UniverseAsset]: ...

    def most_actives(self, by: Literal["volume", "trades"], top: int) -> list[ActiveSymbol]: ...

    def movers(self, top: int) -> list[Mover]: ...


@runtime_checkable
class QuoteSource(Protocol):
    def latest(self, symbols: Sequence[str], *, now: pd.Timestamp) -> list[Quote]: ...


@runtime_checkable
class OptionChainSource(Protocol):
    """A snapshot of one underlying's option chain, never a stream. `now` pins the expiry window
    (`min_dte`..`max_dte` calendar days from its New York date) and each contract's `dte`; the quotes are the
    provider's latest, stamped by `quality`. An empty window is an empty list, not `NoData`. `max_dte` is required
    so no caller can ask for a whole chain by accident (a free plan allows 200 requests a minute)."""

    def option_chain(
        self,
        symbol: str,
        *,
        now: pd.Timestamp,
        right: OptionRight = "C",
        min_dte: int = 0,
        max_dte: int,
        min_strike: float | None = None,
        max_strike: float | None = None,
    ) -> list[OptionContract]: ...


@runtime_checkable
class GatewayStatusSource(Protocol):
    """A provider that holds a live gateway session and can say how it is doing."""

    def gateway_status(self) -> GatewayStatus: ...


@runtime_checkable
class RoutingSource(Protocol):
    """The provider toggle's admin surface (02t §4.1): the providers the bridge knows, the routing it
    is serving, and a way to set a class's preference. The Desk finds it on `DataSources.bridge`, never
    on a chain -- routing is one family-wide value, not a data call that can fall through."""

    def providers(self) -> list[ProviderHealth]: ...

    def routing(self) -> Routing: ...

    def set_routing(self, preferences: Mapping[str, str], version: int) -> Routing: ...


@runtime_checkable
class BridgeSource(RoutingSource, GatewayStatusSource, Protocol):
    """Everything the Desk asks the bridge directly, outside any data chain: the process check that
    gates the Settings card, the shadow job's pinned fetch, and the routing/gateway surfaces above."""

    def healthz(self) -> bool: ...

    def pinned_quotes(
        self, symbols: Sequence[str], *, now: pd.Timestamp, provider: str | None = None
    ) -> list[Quote]: ...
