"""One runtime-checkable `Protocol` per data kind (02j §3).

`registry.py` is the only module that builds concrete providers; this module only names the
shape each kind's provider (or chain) must have, so `registry.py`'s conformance test can check
`isinstance(adapter, SomeSource)` and a caller can type-hint against the Protocol instead of a
vendor class. No vendor module is imported here.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import Literal, Protocol, runtime_checkable

import pandas as pd

from ai_trading_common.bars import Bars, Timeframe
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
    Quote,
    UniverseAsset,
)


@runtime_checkable
class BarsSource(Protocol):
    def bars(
        self, symbol: str, timeframe: Timeframe, start: pd.Timestamp, end: pd.Timestamp, *, now: pd.Timestamp
    ) -> Bars: ...


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
class GatewayStatusSource(Protocol):
    """A provider that holds a live gateway session and can say how it is doing."""

    def gateway_status(self) -> GatewayStatus: ...
