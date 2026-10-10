"""Covered-call scan math and short-call risk rules (02 section 6.3). Prices come in; nothing is fetched.

Money and percentage values are rounded to 6 decimals before they meet a threshold, so a spread of
exactly 10% of mid passes a 10% filter despite binary floating point.
"""

import math
from dataclasses import dataclass
from datetime import date, timedelta

from ai_trading.core.options_math import bs_greeks


@dataclass(frozen=True)
class OptionQuote:
    """One call on the chain. `delta` is the broker's model delta; `iv` computes one when it is missing."""

    expiry: date
    strike: float
    bid: float
    ask: float
    open_interest: int
    delta: float | None = None
    iv: float | None = None


@dataclass(frozen=True)
class Lot:
    shares: float
    cost_per_share: float
    acquired: date


@dataclass(frozen=True)
class Filters:
    """02 section 6.3 defaults; every value is a user setting."""

    min_dte: int = 21
    max_dte: int = 45
    min_delta: float = 0.15
    max_delta: float = 0.30
    min_open_interest: int = 100
    max_spread_pct: float = 10.0  # of mid
    min_bid: float = 0.10


DEFAULT_FILTERS = Filters()


@dataclass(frozen=True)
class Candidate:
    quote: OptionQuote
    dte: int
    delta: float
    premium_yield: float  # bid / spot
    annualized_yield: float  # premium yield x 365 / DTE
    upside_cap: float  # (strike - spot) / spot
    return_if_called: float  # (strike - spot + bid) / spot
    spread_pct: float
    flags: tuple[str, ...]
    score: float


@dataclass(frozen=True)
class ShortCall:
    expiry: date
    strike: float
    contracts: int


def _r(value: float) -> float:
    return round(value, 6)


def coverable_contracts(shares: float, max_cover_pct: float, open_contracts: int) -> int:
    """Contracts that may still be sold: 1,000 shares under a 50% cap with 3 open leaves 2."""
    return max(0, math.floor(_r(shares * max_cover_pct / 100 / 100)) - open_contracts)


def _delta(quote: OptionQuote, spot: float, dte: int, rate: float) -> float | None:
    if quote.delta is not None:
        return quote.delta
    if quote.iv is None or quote.iv <= 0:
        return None
    return bs_greeks(spot, quote.strike, dte / 365, rate, quote.iv, "call")["delta"]


def candidates(
    spot: float,
    quotes: list[OptionQuote],
    today: date,
    *,
    filters: Filters = DEFAULT_FILTERS,
    lots: tuple[Lot, ...] = (),
    taxable: bool = True,
    tax_advantaged_contracts_free: int = 0,
    ex_dividend: date | None = None,
    earnings: date | None = None,
    iv_rank: float | None = None,
    rate: float = 0.0,
) -> list[Candidate]:
    """Calls that pass the filters for one account and symbol, best score first.

    `lots` are this account's lots of the symbol. `tax_advantaged_contracts_free` is how many
    contracts the same owner could still sell in tax-advantaged accounts. An unknown IV rank
    (short history) adds nothing to the score. The scan keeps the first three.
    """
    shares = sum(lot.shares for lot in lots)
    average_cost = sum(lot.shares * lot.cost_per_share for lot in lots) / shares if shares else None
    short_term = taxable and any(lot.acquired > today - timedelta(days=365) for lot in lots)
    out = []
    for quote in quotes:
        dte = (quote.expiry - today).days
        mid = (quote.bid + quote.ask) / 2
        if not filters.min_dte <= dte <= filters.max_dte or mid <= 0:
            continue
        spread_pct = _r((quote.ask - quote.bid) / mid * 100)
        if (
            quote.bid < filters.min_bid
            or quote.open_interest < filters.min_open_interest
            or spread_pct > filters.max_spread_pct
            or (earnings is not None and today <= earnings <= quote.expiry)
        ):
            continue
        delta = _delta(quote, spot, dte, rate)
        if delta is None or not filters.min_delta <= delta <= filters.max_delta:
            continue
        flags = []
        if ex_dividend is not None and today <= ex_dividend <= quote.expiry:
            flags.append("ex_dividend_before_expiry")
        if average_cost is not None and quote.strike < average_cost:
            flags.append("strike_below_cost_basis")
        if short_term:
            flags.append("short_term_lots")
        if taxable and tax_advantaged_contracts_free > 0:
            flags.append("cover_tax_advantaged_first")
        premium = _r(quote.bid / spot)
        annualized = _r(premium * 365 / dte)
        score = (
            100 * min(annualized, 0.40)
            + 0.1 * (iv_rank or 0.0)
            - 10 * len(flags)
            - (5 if spread_pct > 5 else 0)
            - (5 if delta > 0.25 else 0)
        )
        out.append(
            Candidate(
                quote=quote,
                dte=dte,
                delta=delta,
                premium_yield=premium,
                annualized_yield=annualized,
                upside_cap=_r((quote.strike - spot) / spot),
                return_if_called=_r((quote.strike - spot + quote.bid) / spot),
                spread_pct=spread_pct,
                flags=tuple(flags),
                score=_r(score),
            )
        )
    return sorted(out, key=lambda c: c.score, reverse=True)


def is_opportunity(candidate: Candidate, iv_rank: float | None) -> bool:
    """Opportunity alert: at least 15% a year, IV rank at least 50, and no flags."""
    return candidate.annualized_yield >= 0.15 and iv_rank is not None and iv_rank >= 50 and not candidate.flags


def extrinsic_value(call_mid: float, spot: float, strike: float) -> float:
    return _r(call_mid - max(spot - strike, 0.0))


def short_call_risks(
    call: ShortCall,
    *,
    spot: float,
    today: date,
    delta: float,
    extrinsic: float,
    next_trading_day: date,
    ex_dividend: date | None = None,
    dividend: float | None = None,
    earnings: date | None = None,
) -> list[str]:
    """Risk-alert reasons for one open short call; empty when there is nothing to report."""
    risks = []
    if delta > 0.50:
        risks.append("delta_above_0_50")
    if (call.expiry - today).days <= 7 and abs(spot - call.strike) <= _r(0.02 * call.strike):
        risks.append("near_strike_near_expiry")
    if ex_dividend == next_trading_day and dividend is not None and extrinsic < dividend:
        risks.append("early_assignment_before_dividend")
    if earnings is not None and today <= earnings <= call.expiry:
        risks.append("earnings_before_expiry")
    return risks


def roll_candidates(
    call: ShortCall,
    *,
    buyback_ask: float,
    quotes: list[OptionQuote],
    today: date,
    max_dte: int = 60,
    min_credit: float = 0.05,
) -> list[tuple[OptionQuote, float]]:
    """Same or higher strike, later expiry within `max_dte`, net credit per share of at least `min_credit`."""
    out = []
    for quote in quotes:
        if quote.strike < call.strike or quote.expiry <= call.expiry or (quote.expiry - today).days > max_dte:
            continue
        credit = _r(quote.bid - buyback_ask)
        if credit >= min_credit:
            out.append((quote, credit))
    return sorted(out, key=lambda pair: pair[1], reverse=True)


def iv_rank(iv30_history: list[float]) -> float | None:
    """(IV30 now - 52-week low) / (52-week high - 52-week low) x 100 over the last 252 sessions,
    latest last. None before 60 sessions (02a section 12 hides it); callers label it "short
    history" before 252, and None when the year's IV never moved."""
    if len(iv30_history) < 60:
        return None
    window = iv30_history[-252:]
    low, high = min(window), max(window)
    return None if high == low else _r((window[-1] - low) / (high - low) * 100)


def iv_percentile(iv30_history: list[float]) -> float | None:
    """Share of the last 252 sessions (latest excluded) with IV30 below today's, x 100."""
    if len(iv30_history) < 60:
        return None
    window = iv30_history[-253:-1]
    return _r(sum(value < iv30_history[-1] for value in window) / len(window) * 100)
