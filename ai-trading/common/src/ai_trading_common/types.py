"""Vendor-neutral result types and their as-of selectors (02j §4).

Every result record carries `provider: str` and `quality: Quality`, so a registry chain
(`registry.py`) can label a fallback result without knowing the vendor's own shape. The one
exception is `Bars`, which stays in `bars.py` with its existing `source` field holding the
provider name.

No module here imports a vendor module (`providers/*`): a provider's own client maps its
records into these types inside its adapter, never the other way around.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal

import pandas as pd

from ai_trading_common.quality import Quality

Span = Literal["instant", "quarterly", "ytd_6m", "ytd_9m", "annual"]
Timing = Literal["before_open", "after_close", "unknown"]


@dataclass(frozen=True)
class Fact:
    """One fundamentals fact (e.g. SEC CompanyFacts) as the provider reported it: a value, its
    span, and when it was filed. `reference` is the provider's own filing/record identifier
    (SEC's accession number)."""

    concept: str
    unit: str
    value: float
    period_start: date | None  # None for an instant fact (a balance-sheet line)
    period_end: date
    span: Span
    fiscal_year: int | None
    fiscal_period: str | None  # "Q1".."Q4", "FY"
    form: str
    filed: date
    reference: str
    provider: str
    quality: Quality


@dataclass(frozen=True)
class EarningsAnnouncement:
    """One earnings-announcement date. For SEC, the 8-K Item 2.02 filing date (ai-hedge-fund
    `hedge_fund/signals/pead.py`'s pattern: the 8-K, not the 10-Q, is the announcement date)."""

    symbol: str
    announced_on: date
    reference: str
    provider: str
    quality: Quality


@dataclass(frozen=True)
class Observation:
    """One macro-series observation at a pinned ALFRED vintage."""

    series_id: str
    date: date  # the observation period (a day, or a month's/quarter's first day)
    value: float
    realtime_start: date
    realtime_end: date
    provider: str
    quality: Quality


@dataclass(frozen=True)
class NewsItem:
    symbol: str
    headline: str
    publisher: str  # renamed from `source` so it isn't confused with the provider
    url: str
    published_at: pd.Timestamp  # UTC
    provider: str
    quality: Quality


@dataclass(frozen=True)
class EarningsEvent:
    """One earnings-calendar entry. `timing` normalizes a vendor's own before/after-close code
    (Finnhub's `bmo`/`amc`)."""

    symbol: str
    report_date: date
    timing: Timing
    fiscal_year: int | None
    fiscal_quarter: int | None
    eps_estimate: float | None
    eps_actual: float | None
    revenue_estimate: float | None
    revenue_actual: float | None
    provider: str
    quality: Quality


@dataclass(frozen=True)
class ConsensusSnapshot:
    """EPS estimates for one fiscal period, with the analyst count (02f §4)."""

    symbol: str
    period_end: date
    period_kind: str  # "quarter" | "annual"
    fiscal_year: int | None
    fiscal_quarter: int | None
    eps_mean: float | None
    eps_high: float | None
    eps_low: float | None
    analyst_count: int | None
    provider: str
    quality: Quality
    as_of: pd.Timestamp


@dataclass(frozen=True)
class EarningsResult:
    """Reported-vs-estimated EPS with surprise, and the report date."""

    symbol: str
    period_end: date | None  # None for a calendar row never joined to a surprise (see providers/eulerpool.py)
    fiscal_year: int | None
    fiscal_quarter: int | None
    report_date: date | None
    report_time: str | None
    eps_estimate: float | None
    eps_actual: float | None
    surprise: float | None
    surprise_percent: float | None
    provider: str
    quality: Quality
    as_of: pd.Timestamp


@dataclass(frozen=True)
class AnalystTargets:
    """Rating counts, optional targets, and the source recommendation period."""

    symbol: str
    target_mean: float | None
    target_median: float | None
    target_high: float | None
    target_low: float | None
    strong_buy: int | None
    buy: int | None
    hold: int | None
    sell: int | None
    strong_sell: int | None
    provider: str
    quality: Quality
    as_of: pd.Timestamp
    period: date | None = None


def facts_as_of(facts: list[Fact], as_of: date) -> list[Fact]:
    """Pure point-in-time selector: only facts filed on or before `as_of`.

    A period reported more than once (an amendment) keeps only its latest filing on or before
    `as_of` -- an amendment counts from the day it was filed, never before. Example seen live:
    Apple's fiscal 2007 net income read $3,496M from the original 10-K (filed 2009-10-27) until
    a 10-K/A (filed 2010-01-25) restated it to $3,495M; a run `as_of` 2009-12-01 must still see
    $3,496M.
    """
    known = [f for f in facts if f.filed <= as_of]
    latest: dict[tuple[str, str, date, Span], Fact] = {}
    for fact in sorted(known, key=lambda f: f.filed):
        key = (fact.concept, fact.unit, fact.period_end, fact.span)
        latest[key] = fact  # later filings sort last and overwrite earlier ones
    return sorted(latest.values(), key=lambda f: (f.concept, f.period_end))


def announcements_as_of(announcements: list[EarningsAnnouncement], as_of: date) -> list[EarningsAnnouncement]:
    """Pure selector: announcements known by `as_of` (an announcement's own date is itself)."""
    return sorted((a for a in announcements if a.announced_on <= as_of), key=lambda a: a.announced_on)


def news_as_of(items: list[NewsItem], as_of: pd.Timestamp) -> list[NewsItem]:
    """Only news published at or before `as_of` (02h, Review Focus 6: as-of discipline).

    Pattern from TradingAgents' news handling: "unavailable" (the client call itself failing)
    is kept apart from "no news" (this returning an empty list) -- this selector only ever
    narrows an already-fetched list.
    """
    return [item for item in items if item.published_at <= as_of]
