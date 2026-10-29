"""Invented filings, bars, quotes and fake sources for the Research tests (02n §c3 #14): a company with five annual
filings, a benchmark and a stock whose daily returns are exactly `BETA x benchmark + ALPHA` except on the day after an
announcement, so the earnings-reaction numbers have known answers. Every value is made up (the repository is public)."""

from dataclasses import replace
from datetime import date, timedelta

import numpy as np
import pandas as pd
from ai_trading_common.bars import Bars
from ai_trading_common.registry import DataSources
from ai_trading_common.types import EarningsAnnouncement, Fact, NewsItem, Quote

FY_ENDS = (
    date(2025, 9, 27),
    date(2024, 9, 28),
    date(2023, 9, 30),
    date(2022, 9, 24),
    date(2021, 9, 25),
)  # newest first
PRICE = 100.0
SHARES = 1.0e9
BETA = 1.5
ALPHA = 0.0002
FIRST_DAY = "2023-01-02"
DAYS = 900
FIRST_EVENT = 300
EVENT_SPACING = 63

#: concept -> (unit, span, the five fiscal years' values, newest first)
FILINGS: dict[str, tuple[str, str, tuple[float, ...]]] = {
    "NetCashProvidedByUsedInOperatingActivities": ("USD", "annual", (10.0e9, 9.5e9, 9.0e9, 8.5e9, 8.0e9)),
    "PaymentsToAcquirePropertyPlantAndEquipment": ("USD", "annual", (1.1e9, 1.0e9, 1.0e9, 0.9e9, 0.9e9)),
    "NetIncomeLoss": ("USD", "annual", (8.0e9, 7.6e9, 7.2e9, 6.8e9, 6.4e9)),
    "DepreciationDepletionAndAmortization": ("USD", "annual", (1.0e9,) * 5),
    "IncreaseDecreaseInOperatingCapital": ("USD", "annual", (2.0e8,) * 5),
    "Revenues": ("USD", "annual", (40.0e9, 38.0e9, 36.0e9, 34.0e9, 32.0e9)),
    "OperatingIncomeLoss": ("USD", "annual", (10.0e9, 9.5e9, 9.0e9, 8.5e9, 8.0e9)),
    "InterestExpense": ("USD", "annual", (2.0e8,) * 5),
    "StockholdersEquity": ("USD", "instant", (30.0e9,) * 5),
    "CashAndCashEquivalentsAtCarryingValue": ("USD", "instant", (20.0e9,) * 5),
    "LongTermDebt": ("USD", "instant", (10.0e9,) * 5),
    "DebtCurrent": ("USD", "instant", (1.0e9,) * 5),
    "CommonStockSharesOutstanding": ("shares", "instant", (SHARES,) * 5),
}


def fact(
    concept: str, value: float, end: date, *, span: str = "annual", unit: str = "USD", filed: date | None = None
) -> Fact:
    return Fact(
        concept=concept,
        unit=unit,
        value=value,
        period_start=None if span == "instant" else end - timedelta(days=364),
        period_end=end,
        span=span,  # type: ignore[arg-type]
        fiscal_year=end.year,
        fiscal_period="FY",
        form="10-K",
        filed=filed or end + timedelta(days=35),
        reference="0000000000-25-000001",
        provider="sec_edgar",
        quality="eod",
    )


def filings(*, without: tuple[str, ...] = ()) -> list[Fact]:
    """Five fiscal years of every concept the valuation reads, minus the concepts in `without`."""
    return [
        fact(concept, values[year], end, span=span, unit=unit)
        for concept, (unit, span, values) in FILINGS.items()
        if concept not in without
        for year, end in enumerate(FY_ENDS)
    ]


def _frame(close: np.ndarray, days: list[date]) -> pd.DataFrame:
    return pd.DataFrame(
        {"open": close, "high": close, "low": close, "close": close, "volume": 1000.0}, index=pd.Index(days)
    )


def bar_frames(jumps: dict[int, float] | None = None) -> dict[str, pd.DataFrame]:
    """Daily bars for the stock (`AAA`) and the benchmark (`SPY`). `jumps` maps a day index to an extra return on the
    stock that day (the day after an announcement)."""
    days = [ts.date() for ts in pd.bdate_range(FIRST_DAY, periods=DAYS)]
    market = np.random.default_rng(7).normal(0.0004, 0.01, DAYS)
    stock = BETA * market + ALPHA
    for index, jump in (jumps or {}).items():
        stock[index] += jump
    return {"SPY": _frame(50 * np.cumprod(1 + market), days), "AAA": _frame(50 * np.cumprod(1 + stock), days)}


def event_days(count: int = 8) -> list[int]:
    return [FIRST_EVENT + EVENT_SPACING * k for k in range(count)]


def event_jumps(count: int = 8) -> dict[int, float]:
    """+5% the day after every other announcement (a beat), -3% after the rest (a miss), oldest first."""
    return {day + 1: (0.05 if k % 2 == 0 else -0.03) for k, day in enumerate(event_days(count))}


def announced(count: int = 8) -> list[EarningsAnnouncement]:
    days = bar_frames()["AAA"].index
    return [
        EarningsAnnouncement(
            symbol="AAA", announced_on=days[day], reference=f"acc-{k}", provider="sec_edgar", quality="eod"
        )
        for k, day in enumerate(event_days(count))
    ]


class FakeFundamentals:
    def __init__(self, items: list[Fact] | None = None, *, raises: Exception | None = None) -> None:
        self.items = filings() if items is None else items
        self.raises = raises
        self.calls = 0

    def facts(self, symbol, *, as_of, concepts=None):
        self.calls += 1
        if self.raises is not None:
            raise self.raises
        return [f for f in self.items if concepts is None or f.concept in concepts]


class FakeQuotes:
    def __init__(self, price: float | None = PRICE, *, raises: Exception | None = None) -> None:
        self.price = price
        self.raises = raises

    def latest(self, symbols, *, now):
        if self.raises is not None:
            raise self.raises
        if self.price is None:
            return []
        return [Quote(symbol=s, price=self.price, as_of=now, provider="alpaca", quality="delayed-15m") for s in symbols]


class FakeBars:
    def __init__(self, frames: dict[str, pd.DataFrame] | None = None, *, raises: Exception | None = None) -> None:
        self.frames = bar_frames(event_jumps()) if frames is None else frames
        self.raises = raises

    def bars(self, symbol, timeframe, start, end, *, now):
        if self.raises is not None:
            raise self.raises
        return Bars(frame=self.frames[symbol], source="fake", quality="delayed-15m")


class FakeAnnouncements:
    def __init__(self, items: list[EarningsAnnouncement] | None = None, *, raises: Exception | None = None) -> None:
        self.items = announced() if items is None else items
        self.raises = raises

    def announcements(self, symbol, *, since):
        if self.raises is not None:
            raise self.raises
        return list(self.items)


class FakeNews:
    def __init__(self, items: list[NewsItem] | None = None, *, raises: Exception | None = None) -> None:
        self.items = items or []
        self.raises = raises

    def news(self, symbol, start, end):
        if self.raises is not None:
            raise self.raises
        return list(self.items)


def data_sources(**overrides) -> DataSources:
    """A `DataSources` of unused sentinels with the given kinds replaced by the fakes above."""
    unused = object()
    base = DataSources(
        bars=unused,
        fundamentals=unused,
        earnings_announcements=unused,
        macro=unused,
        news=unused,
        earnings_calendar=unused,
        consensus=unused,
        earnings=unused,
        targets=unused,
        universe=unused,
        quotes=unused,
        trades=unused,
    )
    return replace(base, **overrides)
