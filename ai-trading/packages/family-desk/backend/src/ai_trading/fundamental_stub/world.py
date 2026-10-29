"""The invented Fundamental world behind `DESK_FUNDAMENTAL_STUB=1` (02n §h step 3b).

Every symbol, share count, cost, price, quote and date here is made up: the repository is public and the owner's real
holdings never enter it. Where the engine has the math (`core/covered_calls.py`, `core/futures.py`) the world runs it,
so a stub's coverable contracts, candidates, risks, roll credits, roll and expiry dates are what the engine says about
the invented inputs.

The world is Friday 2026-10-23 after the close. Two accounts, five holdings, ten lots (seven stock, three short calls).
"""

from datetime import date, timedelta
from functools import cache
from typing import Any

from ai_trading.core import covered_calls as engine
from ai_trading.core.futures import MONTH_CODES, front_month, last_trade_date, roll_date
from ai_trading.fundamental.settings import DEFAULT_CAP_PCT, covered_call_settings

TODAY = date(2026, 10, 23)
NEXT_TRADING_DAY = date(2026, 10, 26)
CAP_PCT = DEFAULT_CAP_PCT

ACCOUNTS: tuple[dict[str, Any], ...] = (
    {"id": 1, "label": "Taxable", "type": "taxable"},
    {"id": 2, "label": "IRA", "type": "ira"},
)
ACCOUNT_TYPE = {account["id"]: account["type"] for account in ACCOUNTS}

#: symbol -> (name, last, change %, next earnings)
QUOTES: dict[str, tuple[str, float, float, date]] = {
    "AAPL": ("Apple Inc.", 231.40, 0.8, date(2027, 1, 28)),
    "MSFT": ("Microsoft Corporation", 428.60, -0.4, date(2026, 10, 28)),
    "NVDA": ("NVIDIA Corporation", 142.80, 1.9, date(2026, 11, 18)),
    "KO": ("The Coca-Cola Company", 71.90, 0.2, date(2026, 10, 27)),
    "JNJ": ("Johnson & Johnson", 164.30, -0.1, date(2027, 1, 20)),
}
SYMBOLS = tuple(QUOTES)
STRIP = (("SPY", 612.40, 0.3), ("QQQ", 538.20, 0.5), ("IWM", 231.10, -0.2))

#: (id, symbol, account id, shares, cost per share, acquired)
STOCK_LOTS = (
    (1, "AAPL", 1, 400.0, 152.30, date(2023, 3, 14)),
    (2, "AAPL", 1, 200.0, 188.10, date(2024, 6, 3)),
    (3, "AAPL", 2, 300.0, 171.00, date(2024, 1, 10)),
    (4, "MSFT", 1, 150.0, 310.00, date(2023, 9, 12)),
    (5, "NVDA", 1, 400.0, 128.00, date(2026, 3, 20)),
    (6, "KO", 2, 1000.0, 58.40, date(2022, 8, 2)),
    (7, "JNJ", 2, 500.0, 147.00, date(2024, 2, 20)),
)
#: (id, symbol, account id, strike, expiry, short contracts, simulated delta)
SHORT_CALLS = (
    (8, "AAPL", 1, 245.0, date(2026, 11, 20), 1, 0.24),
    (9, "KO", 2, 72.5, date(2026, 10, 30), 3, 0.52),
    (10, "JNJ", 2, 175.0, date(2026, 12, 18), 2, None),  # no option quote yet: the delta rules do not fire
)
LOT_COUNT = len(STOCK_LOTS) + len(SHORT_CALLS)

#: symbol -> (rating, previous rating, low, base, high, confidence, stale days); JNJ has no verdict yet.
VERDICTS: dict[str, tuple[str, str | None, float, float, float, float, int]] = {
    "AAPL": ("buy", "buy", 235.0, 265.0, 290.0, 72.0, 0),
    "MSFT": ("hold", "buy", 395.0, 445.0, 480.0, 61.0, 0),
    "NVDA": ("buy", None, 120.0, 165.0, 200.0, 66.0, 1),
    "KO": ("hold", "hold", 62.0, 72.0, 78.0, 58.0, 0),
}

#: The metric columns the stub has no engine for (02n §c4); the rest are derived below.
METRICS: dict[str, dict[str, Any]] = {
    "AAPL": dict(
        fwd_pe=28.4,
        pe_vs_5y_median_pct=6.2,
        fcf_yield_pct=3.1,
        revenue_growth_yoy_pct=6.8,
        debt_to_equity=1.5,
        eps_rev_7d_pct=0.4,
        eps_rev_30d_pct=1.4,
        eps_rev_90d_pct=2.9,
        dividend_yield_pct=0.4,
        ex_dividend=None,
        dist_to_252d_high_pct=-3.1,
    ),
    "MSFT": dict(
        fwd_pe=31.2,
        pe_vs_5y_median_pct=-4.5,
        fcf_yield_pct=2.4,
        revenue_growth_yoy_pct=13.1,
        debt_to_equity=0.3,
        eps_rev_7d_pct=-0.2,
        eps_rev_30d_pct=-0.6,
        eps_rev_90d_pct=0.8,
        dividend_yield_pct=0.8,
        ex_dividend=None,
        dist_to_252d_high_pct=-6.7,
    ),
    "NVDA": dict(
        fwd_pe=24.9,
        pe_vs_5y_median_pct=-31.0,
        fcf_yield_pct=2.9,
        revenue_growth_yoy_pct=58.0,
        debt_to_equity=0.2,
        eps_rev_7d_pct=1.1,
        eps_rev_30d_pct=3.1,
        eps_rev_90d_pct=7.4,
        dividend_yield_pct=0.0,
        ex_dividend=None,
        dist_to_252d_high_pct=-8.9,
    ),
    "KO": dict(
        fwd_pe=22.3,
        pe_vs_5y_median_pct=2.1,
        fcf_yield_pct=4.0,
        revenue_growth_yoy_pct=3.2,
        debt_to_equity=1.6,
        eps_rev_7d_pct=0.1,
        eps_rev_30d_pct=0.3,
        eps_rev_90d_pct=None,  # less than 90 days of snapshots
        dividend_yield_pct=3.0,
        ex_dividend=date(2026, 11, 13),
        dist_to_252d_high_pct=-1.2,
    ),
    "JNJ": dict(
        fwd_pe=14.6,
        pe_vs_5y_median_pct=-9.3,
        fcf_yield_pct=5.1,
        revenue_growth_yoy_pct=4.4,
        debt_to_equity=0.5,
        eps_rev_7d_pct=None,
        eps_rev_30d_pct=None,
        eps_rev_90d_pct=None,
        dividend_yield_pct=3.1,
        ex_dividend=None,
        dist_to_252d_high_pct=-5.8,
    ),
}


def _quote(
    expiry: date, strike: float, bid: float, ask: float, open_interest: int, delta: float | None
) -> engine.OptionQuote:
    return engine.OptionQuote(expiry, strike, bid, ask, open_interest, delta)


#: Invented call chains (bid and ask per share). AAPL's includes calls the filters reject (delta, spread, interest).
CHAINS: dict[str, list[engine.OptionQuote]] = {
    "AAPL": [
        _quote(date(2026, 11, 13), 245.0, 1.45, 1.60, 2500, 0.19),
        _quote(date(2026, 11, 20), 240.0, 3.60, 3.80, 2200, 0.34),
        _quote(date(2026, 11, 20), 245.0, 2.85, 3.00, 3100, 0.28),
        _quote(date(2026, 11, 20), 250.0, 1.30, 1.42, 1800, 0.17),
        _quote(date(2026, 11, 20), 260.0, 0.45, 0.75, 60, 0.07),
        _quote(date(2026, 12, 4), 245.0, 3.35, 3.55, 900, 0.27),
        _quote(date(2026, 12, 4), 250.0, 2.45, 2.60, 1400, 0.21),
        _quote(date(2026, 12, 4), 255.0, 1.70, 1.85, 640, 0.16),
    ],
    "KO": [
        _quote(date(2026, 11, 20), 72.5, 1.55, 1.65, 4200, 0.45),
        _quote(date(2026, 11, 20), 75.0, 0.62, 0.68, 3300, 0.22),
        _quote(date(2026, 12, 18), 75.0, 1.30, 1.38, 2900, 0.29),
        _quote(date(2026, 12, 18), 77.5, 0.70, 0.78, 1500, 0.17),
    ],
}
#: What it costs per share to buy a short call back, from the same invented chain.
BUYBACK_ASK = {9: 0.95, 8: 1.10}
#: symbol -> (IV rank, sessions of IV history); a short history hides the rank (60 sessions needed).
IV = {"AAPL": (62.0, 252)}
SHORT_HISTORY = (None, 6)


def last(symbol: str) -> float:
    return QUOTES[symbol][1]


def change_pct(symbol: str) -> float:
    return QUOTES[symbol][2]


def term(acquired: date) -> str:
    return "long" if acquired <= TODAY - timedelta(days=365) else "short"


def account_shares(symbol: str, account_id: int) -> float:
    return sum(lot[3] for lot in STOCK_LOTS if lot[1] == symbol and lot[2] == account_id)


def open_contracts(symbol: str, account_id: int | None = None) -> int:
    return sum(call[5] for call in SHORT_CALLS if call[1] == symbol and (account_id is None or call[2] == account_id))


def coverable(symbol: str, account_id: int) -> int:
    return engine.coverable_contracts(account_shares(symbol, account_id), CAP_PCT, open_contracts(symbol, account_id))


def coverable_total(symbol: str) -> int:
    return sum(coverable(symbol, account_id) for account_id in account_ids(symbol))


def account_ids(symbol: str) -> list[int]:
    return sorted({lot[2] for lot in STOCK_LOTS if lot[1] == symbol})


def verdict_target(symbol: str) -> tuple[float, float, float] | None:
    verdict = VERDICTS.get(symbol)
    return None if verdict is None else (verdict[2], verdict[3], verdict[4])


def upside_pct(symbol: str) -> float | None:
    verdict = VERDICTS.get(symbol)
    return None if verdict is None else round((verdict[3] / last(symbol) - 1) * 100, 1)


def coverage_reason(symbol: str, account_id: int) -> tuple[str, str]:
    """(reason, words) in the plan's order: the cap, the cover left, the chain, then earnings (02n §c3 #6)."""
    shares = account_shares(symbol, account_id)
    earnings = QUOTES[symbol][3]
    if engine.coverable_contracts(shares, CAP_PCT, 0) == 0:
        return "under_one_contract", f"{shares:g} shares: under one contract at a {CAP_PCT:g}% cap"
    if coverable(symbol, account_id) == 0:
        return "fully_covered", "fully covered at its cap"
    if symbol not in CHAINS:
        return "no_chain", "no option chain for this symbol yet"
    if TODAY <= earnings <= TODAY + timedelta(days=covered_call_settings({})[0].max_dte):
        return "earnings_wait", f"earnings {earnings:%b} {earnings.day}: waits"
    n = coverable(symbol, account_id)
    return "ok", f"{n} contract{'s' if n != 1 else ''} can be sold at a {CAP_PCT:g}% cap"


def risks_of(call_id: int) -> list[str]:
    call = next(c for c in SHORT_CALLS if c[0] == call_id)
    _, symbol, _, strike, expiry, contracts, delta = call
    return engine.short_call_risks(
        engine.ShortCall(expiry, strike, contracts),
        spot=last(symbol),
        today=TODAY,
        next_trading_day=NEXT_TRADING_DAY,
        delta=delta,
        earnings=QUOTES[symbol][3],
    )


@cache
def _found(symbol: str, account_id: int) -> tuple[engine.Candidate, ...]:
    """The engine's top three for one account's lots (`core.covered_calls.candidates`). Empty when nothing can be sold
    or passes the filters (KO: earnings fall before every expiry)."""
    if symbol not in CHAINS or coverable(symbol, account_id) == 0:
        return ()
    taxable = ACCOUNT_TYPE[account_id] == "taxable"
    free_elsewhere = sum(coverable(symbol, other) for other in account_ids(symbol) if ACCOUNT_TYPE[other] != "taxable")
    return tuple(
        engine.candidates(
            last(symbol),
            CHAINS[symbol],
            TODAY,
            filters=covered_call_settings({})[0],
            lots=tuple(
                engine.Lot(shares, cost, acquired)
                for _, sym, acct, shares, cost, acquired in STOCK_LOTS
                if sym == symbol and acct == account_id
            ),
            taxable=taxable,
            tax_advantaged_contracts_free=free_elsewhere if taxable else 0,
            earnings=QUOTES[symbol][3],
            iv_rank=IV.get(symbol, SHORT_HISTORY)[0],
        )
    )


def candidate_rows(symbol: str, account_id: int) -> list[dict[str, Any]]:
    return [
        {
            "expiry": c.quote.expiry,
            "strike": c.quote.strike,
            "dte": c.dte,
            "bid": c.quote.bid,
            "ask": c.quote.ask,
            "delta": c.delta,
            "premium_yield": c.premium_yield,
            "annualized_yield": c.annualized_yield,
            "upside_cap": c.upside_cap,
            "return_if_called": c.return_if_called,
            "spread_pct": c.spread_pct,
            "open_interest": c.quote.open_interest,
            "flags": list(c.flags),
            "score": c.score,
        }
        for c in _found(symbol, account_id)
    ]


def is_opportunity(symbol: str, account_id: int) -> bool:
    found = _found(symbol, account_id)
    return bool(found) and engine.is_opportunity(found[0], IV.get(symbol, SHORT_HISTORY)[0])


def roll_rows(call_id: int) -> tuple[float | None, list[dict[str, Any]]]:
    """(buyback per share, roll candidates) from the engine's `roll_candidates` on the invented chain."""
    _, symbol, _, strike, expiry, contracts, _ = next(c for c in SHORT_CALLS if c[0] == call_id)
    ask = BUYBACK_ASK.get(call_id)
    if ask is None or symbol not in CHAINS:
        return None, []
    rolled = engine.roll_candidates(
        engine.ShortCall(expiry, strike, contracts), buyback_ask=ask, quotes=CHAINS[symbol], today=TODAY
    )
    return ask, [
        {
            "expiry": quote.expiry,
            "strike": quote.strike,
            "dte": (quote.expiry - TODAY).days,
            "delta": quote.delta,
            "net_credit": credit,
            "flags": [],
        }
        for quote, credit in rolled
    ]


def futures_row(root: str) -> dict[str, Any]:
    """The front contract, its roll and its expiry: `core/futures.py`'s own dates."""
    month = front_month(root, TODAY)
    code = f"{root}{MONTH_CODES[month.month]}{month.year % 10}"
    return {
        "root": f"/{root}",
        "front": code,
        "next_roll": roll_date(root, month),
        "expiry": last_trade_date(root, month),
        "month": month,
    }
