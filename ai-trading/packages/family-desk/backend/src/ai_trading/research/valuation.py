"""Valuation and earnings reaction of one stock (02n §c3 #14, §d `research/valuation.py`, 02h §4): `core/valuation.py`
and `core/earnings_reaction.py` run unchanged on SEC annual filings (`DataSources.fundamentals`), the delayed Alpaca
price (`quotes`), daily bars and the 8-K Item 2.02 dates (`earnings_announcements`). Every number is the engine's; this
module only picks the inputs, converts the engine's totals to per-share values, and says each default the engine took.

Never a 500 and never a stand-in: a provider that fails leaves its methods null with a line saying why, a method whose
input is missing is null with the input named, and a blend over fewer than three of the other methods is still the
engine's own blend (`blended_value` names what it used). The options-implied move needs the delayed chain's
at-the-money straddle and is not built yet, so `implied_move_pct` is null.

Filings, bars and the earnings reaction are fetched once per symbol and ET day and kept in process memory
(`_CACHE`); the price is read on every call. Only a fully successful fetch is kept, so a failed provider is retried.
"""

import math
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from ai_trading_common.types import Fact
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.earnings_reaction import ReactionStats, event_reaction, summarize
from ai_trading.core.valuation import (
    blended_value,
    calculate_dcf_scenarios,
    calculate_ev_ebitda_value,
    calculate_owner_earnings_value,
    calculate_residual_income_value,
    calculate_wacc,
)
from ai_trading.db.models import EarningsResult
from ai_trading.research.service import today_et

# us-gaap tags: the first one of a group that has any annual (or instant) fact is the group's series.
OPERATING_CASH_FLOW = ("NetCashProvidedByUsedInOperatingActivities",)
CAPEX = ("PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets")
NET_INCOME = ("NetIncomeLoss",)
DEPRECIATION = ("DepreciationDepletionAndAmortization", "DepreciationAndAmortization")
WORKING_CAPITAL_CHANGE = ("IncreaseDecreaseInOperatingCapital",)
REVENUE = ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet")
OPERATING_INCOME = ("OperatingIncomeLoss",)
INTEREST_EXPENSE = ("InterestExpense", "InterestExpenseDebt")
EQUITY = ("StockholdersEquity",)
CASH = ("CashAndCashEquivalentsAtCarryingValue",)
LONG_TERM_DEBT = ("LongTermDebt", "LongTermDebtNoncurrent")
SHORT_TERM_DEBT = ("DebtCurrent", "LongTermDebtCurrent")
SHARES = ("CommonStockSharesOutstanding",)
SHARES_WEIGHTED = ("WeightedAverageNumberOfDilutedSharesOutstanding",)
CONCEPTS = tuple(
    dict.fromkeys(
        OPERATING_CASH_FLOW
        + CAPEX
        + NET_INCOME
        + DEPRECIATION
        + WORKING_CAPITAL_CHANGE
        + REVENUE
        + OPERATING_INCOME
        + INTEREST_EXPENSE
        + EQUITY
        + CASH
        + LONG_TERM_DEBT
        + SHORT_TERM_DEBT
        + SHARES
        + SHARES_WEIGHTED
    )
)

HISTORY_YEARS = 6  # daily bars: the 5-year multiple history plus the year-end before it
ANNOUNCEMENT_YEARS = 3
REPORTS = 8  # 02h §4: the last 8 reports
MIN_MULTIPLES = 3  # the current multiple and two year-end ones: a median of one is the price itself
GROWTH_CAP = 0.25  # the engine's own cap on a growth rate it is given (`_enhanced_dcf_value`)
DEFAULT_GROWTH = 0.05  # the engine's default when there is no revenue history
BENCHMARK = "SPY"
METHODS = ("dcf", "owner_earnings", "ev_ebitda", "residual_income")


@dataclass
class _Bundle:
    """What one fetch of the slow providers produced for a symbol and day."""

    facts: list[Fact] = field(default_factory=list)
    closes: dict[date, float] = field(default_factory=dict)
    reaction: dict[str, Any] | None = None
    facts_failed: bool = False
    complete: bool = True


#: Process memory: (symbol, ET day) -> the fetch. Ceiling: a restart refetches, and a day's entries are dropped at the
#: next day's first insert, so it never holds more than one day of symbols.
_CACHE: dict[tuple[str, date], _Bundle] = {}


def clear_cache() -> None:
    _CACHE.clear()


def _finite(value: float | None, digits: int = 4) -> float | None:
    return None if value is None or not math.isfinite(value) else round(value, digits)


def _series(facts: list[Fact], names: tuple[str, ...], *, span: str, unit: str = "USD") -> dict[date, float]:
    """period end -> value for the first tag of `names` that has any fact of that span and unit.
    ponytail: one tag per group, so a filer that switched tags mid-history loses the older years; add a per-period
    fallback when a real filer needs it."""
    for name in names:
        found = {f.period_end: f.value for f in facts if f.concept == name and f.span == span and f.unit == unit}
        if found:
            return found
    return {}


def _latest(series: dict[date, float]) -> float | None:
    return series[max(series)] if series else None


def _per_share(total: float | None, shares: float | None) -> float | None:
    return None if total is None or not shares else _finite(total / shares, 2)


def _close_on_or_before(closes: list[tuple[date, float]], day: date) -> float | None:
    """The last close on or before `day`; `closes` is sorted by day."""
    index = bisect_right(closes, day, key=lambda pair: pair[0])
    return closes[index - 1][1] if index else None


def _debt(facts: list[Fact], day: date | None = None) -> float | None:
    """Long-term plus current debt at `day` (the latest filing when None); None when the filings carry neither."""
    parts = []
    for names in (LONG_TERM_DEBT, SHORT_TERM_DEBT):
        series = _series(facts, names, span="instant")
        value = series.get(day) if day is not None else _latest(series)
        if value is not None:
            parts.append(value)
    return sum(parts) if parts else None


def _methods(facts: list[Fact], price: float | None, closes: dict[date, float]) -> dict[str, dict[str, Any]]:
    """The four methods as `{id: {value, inputs, fallbacks}}`, per share, from the engine's totals."""
    annual = {
        name: _series(facts, tags, span="annual")
        for name, tags in (
            ("ocf", OPERATING_CASH_FLOW),
            ("capex", CAPEX),
            ("net_income", NET_INCOME),
            ("depreciation", DEPRECIATION),
            ("working_capital", WORKING_CAPITAL_CHANGE),
            ("revenue", REVENUE),
            ("operating_income", OPERATING_INCOME),
            ("interest", INTEREST_EXPENSE),
        )
    }
    shares_by_end = _series(facts, SHARES, span="instant", unit="shares")
    shares = _latest(shares_by_end) or _latest(_series(facts, SHARES_WEIGHTED, span="annual", unit="shares"))
    equity = _latest(_series(facts, EQUITY, span="instant"))
    cash_by_end = _series(facts, CASH, span="instant")
    cash = _latest(cash_by_end)
    market_cap = price * shares if price is not None and shares else None

    no_shares = "Shares outstanding: not in the filings, so no per-share value"
    no_price = "Price unavailable: the market value needs it"
    out: dict[str, dict[str, Any]] = {
        name: {"value": None, "inputs": {}, "fallbacks": [] if shares else [no_shares]} for name in METHODS
    }

    revenue = sorted(annual["revenue"].items(), reverse=True)
    revenue_growth = revenue[0][1] / revenue[1][1] - 1 if len(revenue) >= 2 and revenue[1][1] > 0 else None
    growth_text = None  # said only when the engine's own rate was not simply the last year's revenue growth
    if revenue_growth is None:
        growth_text = "Growth rate: 5% default, no revenue history"
    elif revenue_growth > GROWTH_CAP:
        growth_text = f"Growth rate: revenue growth {revenue_growth * 100:.1f}% over the last year, capped at 25%"

    # DCF on free cash flow (operating cash flow less capital spending), newest year first.
    fcf = [
        annual["ocf"][end] - annual["capex"][end]
        for end in sorted(annual["ocf"], reverse=True)
        if end in annual["capex"]
    ][:5]
    dcf = out["dcf"]
    dcf["inputs"] = {
        "fcf_latest": _finite(fcf[0] if fcf else None, 0),
        "fcf_years": float(len(fcf)),
        "revenue_growth_pct": _finite(None if revenue_growth is None else revenue_growth * 100, 2),
        "market_cap": _finite(market_cap, 0),
    }
    wacc = None
    if market_cap is None:
        dcf["fallbacks"].append(no_price)
    elif not fcf:
        dcf["fallbacks"].append("Free cash flow: no annual operating cash flow with capital spending in the filings")
    else:
        interest, operating = _latest(annual["interest"]), _latest(annual["operating_income"])
        coverage = operating / interest if interest and operating is not None and interest > 0 else None
        wacc = calculate_wacc(market_cap, _debt(facts), cash, coverage)
        dcf["inputs"]["wacc_pct"] = _finite(wacc * 100, 2)
        dcf["fallbacks"] += [
            "Beta: 1.0 proxy, no beta source",
            "Risk-free rate 4.5% and market premium 6%: the engine's fixed assumptions",
            "Discount rate: clamped to 6%-20%",
        ]
        if coverage is None:
            dcf["fallbacks"].append("Cost of debt: default spread, no interest expense in the filings")
        if growth_text:
            dcf["fallbacks"].append(growth_text)
        scenarios = calculate_dcf_scenarios(fcf, wacc, market_cap, revenue_growth)
        if scenarios is None:
            dcf["fallbacks"].append("Latest free cash flow is not positive, so there is no DCF")
        else:
            dcf["value"] = _per_share(scenarios["expected_value"], shares)
            dcf["fallbacks"].append("Value: bear, base and bull scenarios weighted 20/60/20")

    # Owner earnings: the latest year that has all four lines.
    owner = out["owner_earnings"]
    ends = set.intersection(*(set(annual[k]) for k in ("net_income", "depreciation", "capex", "working_capital")))
    growth = DEFAULT_GROWTH if revenue_growth is None else min(revenue_growth, GROWTH_CAP)
    if ends:
        end = max(ends)
        lines = {k: annual[k][end] for k in ("net_income", "depreciation", "capex", "working_capital")}
        owner["inputs"] = {**{k: _finite(v, 0) for k, v in lines.items()}, "growth_pct": _finite(growth * 100, 2)}
        owner["value"] = _per_share(calculate_owner_earnings_value(*lines.values(), growth_rate=growth), shares)
        owner["fallbacks"] += ["Required return 15% and margin of safety 25%: the engine's fixed assumptions"]
        if growth_text:
            owner["fallbacks"].append(growth_text)
        if owner["value"] is None and shares:
            owner["fallbacks"].append("Owner earnings are not positive, so there is no value")
    elif shares:
        owner["fallbacks"].append(
            "Owner earnings: the filings lack net income, depreciation, capital spending or the working-capital "
            "change for one year"
        )

    # EV/EBITDA at the stock's own median year-end multiple (annual EBITDA = operating income + depreciation).
    ev = out["ev_ebitda"]
    ebitda = {
        end: annual["operating_income"][end] + annual["depreciation"][end]
        for end in annual["operating_income"]
        if end in annual["depreciation"]
    }
    if market_cap is None:
        ev["fallbacks"].append(no_price)
    elif not ebitda or ebitda[max(ebitda)] <= 0:
        ev["fallbacks"].append("EBITDA: not in the filings, or not positive")
    else:
        latest_end = max(ebitda)
        net_debt = (_debt(facts) or 0.0) - (cash or 0.0)
        enterprise = market_cap + net_debt
        ratios: list[float | None] = [enterprise / ebitda[latest_end] if ebitda[latest_end] > 0 else None]
        priced = sorted(closes.items())
        for end in sorted((e for e in ebitda if e < latest_end), reverse=True):
            close, held = _close_on_or_before(priced, end), shares_by_end.get(end)
            if close is not None and held and ebitda[end] > 0:
                ratios.append((close * held + (_debt(facts, end) or 0.0) - cash_by_end.get(end, 0.0)) / ebitda[end])
        known = [r for r in ratios if r]
        ev["inputs"] = {
            "enterprise_value": _finite(enterprise, 0),
            "ebitda": _finite(ebitda[latest_end], 0),
            "net_debt": _finite(net_debt, 0),
            "multiples_used": float(len(known)),
        }
        if ratios[0] is None or len(known) < MIN_MULTIPLES:
            ev["fallbacks"].append(
                f"EBITDA multiple: needs the current one and two year-end ones from price history, found {len(known)}"
            )
        else:
            ev["inputs"]["current_multiple"] = _finite(ratios[0], 2)
            ev["value"] = _per_share(calculate_ev_ebitda_value(enterprise, market_cap, ratios), shares)
            ev["fallbacks"].append(
                f"EBITDA multiple: median of {len(known)} year-end multiples from annual filings, not five years"
                if len(known) < 5
                else "EBITDA multiple: median of five year-end multiples from annual filings"
            )

    # Residual income: book value from the filings, the engine's 10% cost of equity and 3% growth defaults.
    residual = out["residual_income"]
    income = _latest(annual["net_income"])
    if market_cap is None:
        residual["fallbacks"].append(no_price)
    elif not equity or equity <= 0 or income is None:
        residual["fallbacks"].append("Book value or net income: not in the filings, or book value is not positive")
    else:
        residual["inputs"] = {
            "net_income": _finite(income, 0),
            "book_value": _finite(equity, 0),
            "price_to_book": _finite(market_cap / equity, 2),
        }
        residual["value"] = _per_share(calculate_residual_income_value(market_cap, income, market_cap / equity), shares)
        residual["fallbacks"].append(
            "Cost of equity 10%, book-value growth 3% and margin of safety 20%: engine defaults"
        )
        if residual["value"] is None:
            residual["fallbacks"].append("Income above the cost of equity is not positive, so there is no value")
    return out


def _reaction_block(
    announced: list[date],
    stock: pd.Series,
    benchmark: pd.Series,
    results: list[EarningsResult],
) -> dict[str, Any] | None:
    """The earnings-reaction summary over the last `REPORTS` announcements, or None below four usable ones.
    `stock` and `benchmark` are daily closes indexed by trading day."""
    returns = pd.concat([stock.pct_change(), benchmark.pct_change()], axis=1, join="inner").dropna()
    stock_returns, benchmark_returns = returns.iloc[:, 0], returns.iloc[:, 1]

    def beat(day: date) -> bool | None:
        for row in results:
            if row.report_date is not None and abs((row.report_date - day).days) <= 1:
                if row.eps_actual is None or row.eps_estimate is None or row.eps_actual == row.eps_estimate:
                    return None
                return row.eps_actual > row.eps_estimate
        return None

    pairs = [
        (day, event_reaction(stock_returns, benchmark_returns, pd.Timestamp(day), beat=beat(day)))
        for day in sorted(announced)[-REPORTS:]
    ]
    # A report with no next day yet (the latest session) has no move to average: leave it out, not half-count it.
    complete = [
        (day, r) for day, r in pairs if r is not None and r.next_day_return is not None and r.excess_0_1 is not None
    ]
    summary = summarize([r for _, r in complete])
    if summary is None:
        return None

    def bucket(stats: ReactionStats | None) -> dict[str, Any]:
        return {
            "n": 0 if stats is None else stats.n,
            "avg_excess_pct": None if stats is None else _finite(stats.avg_excess_0_1 * 100, 2),
        }

    return {
        "reports": summary.overall.n,
        "avg_abs_move_pct": _finite(summary.overall.avg_absolute_next_day_move * 100, 2),
        "avg_excess_pct": _finite(summary.overall.avg_excess_0_1 * 100, 2),
        "beats": bucket(summary.beats),
        "misses": bucket(summary.misses),
        "series": [
            {"date": day, "move_pct": _finite(r.next_day_return * 100, 2), "excess_pct": _finite(r.excess_0_1 * 100, 2)}
            for day, r in sorted(complete, key=lambda pair: pair[0], reverse=True)
        ],
        "implied_move_pct": None,  # the options-implied move needs the delayed chain's straddle: not built yet
    }


def _closes(frame: pd.DataFrame) -> pd.Series:
    return pd.Series(frame["close"].to_numpy(), index=pd.DatetimeIndex(pd.to_datetime(list(frame.index))))


def _fetch(db: Session, sources: DataSources, symbol: str, now: datetime, today: date) -> _Bundle:
    bundle = _Bundle()
    stamp = pd.Timestamp(now)
    try:
        bundle.facts = sources.fundamentals.facts(symbol, as_of=today, concepts=CONCEPTS)
    except ProviderError:
        bundle.facts_failed, bundle.complete = True, False
    start = pd.Timestamp(today.replace(year=today.year - HISTORY_YEARS), tz="UTC")
    end = pd.Timestamp(today, tz="UTC")
    try:
        stock = sources.bars.bars(symbol, "1d", start, end, now=stamp).frame
        benchmark = sources.bars.bars(BENCHMARK, "1d", start, end, now=stamp).frame
        announcements = sources.earnings_announcements.announcements(
            symbol, since=today.replace(year=today.year - ANNOUNCEMENT_YEARS)
        )
    except ProviderError:
        bundle.complete = False
        return bundle
    if stock.empty or benchmark.empty:
        return bundle
    bundle.closes = {day: float(close) for day, close in zip(stock.index, stock["close"], strict=True)}
    results = list(db.scalars(select(EarningsResult).where(EarningsResult.symbol == symbol)))
    bundle.reaction = _reaction_block(
        [a.announced_on for a in announcements], _closes(stock), _closes(benchmark), results
    )
    return bundle


def _price(sources: DataSources, symbol: str, now: datetime) -> float | None:
    try:
        quotes = sources.quotes.latest([symbol], now=pd.Timestamp(now))
    except ProviderError:
        return None
    return next((q.price for q in quotes if q.symbol == symbol and math.isfinite(q.price)), None)


def valuation(db: Session, sources: DataSources, symbol: str, *, now: datetime) -> dict[str, Any]:
    today = today_et(now)
    bundle = _CACHE.get((symbol, today))
    if bundle is None:
        bundle = _fetch(db, sources, symbol, now, today)
        if bundle.complete:
            for key in [key for key in _CACHE if key[1] != today]:
                del _CACHE[key]
            _CACHE[(symbol, today)] = bundle
    price = _price(sources, symbol, now)
    methods = _methods(bundle.facts, price, bundle.closes)
    if bundle.facts_failed:
        for method in methods.values():
            method["fallbacks"] = ["Filings source unavailable: SEC EDGAR did not answer"]
    blend = blended_value(*(methods[name]["value"] for name in METHODS))
    used = [f.filed for f in bundle.facts if f.concept in CONCEPTS]
    return {
        "price": _finite(price, 2),
        "methods": [{"id": name, **methods[name]} for name in METHODS],
        "blend": None if blend is None else _finite(blend.value, 2),
        "filing_as_of": max(used) if used else None,
        "earnings_reaction": bundle.reaction,
    }
