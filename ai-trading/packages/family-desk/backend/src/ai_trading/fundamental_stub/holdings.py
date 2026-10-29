"""Stub builders for the holdings family (02n §c3 #2, #3, #4, #5) and the pieces the other families share: the import
state, the per-symbol `Fundamentals` object, and the short-call row.

Plain dicts only; `api/holdings.py` validates them against their response models."""

from typing import Any

from fastapi import HTTPException

from ai_trading.fundamental_stub import stamp
from ai_trading.fundamental_stub import world as w

RISK_TEXT = {
    "delta_above_0_50": "Delta is above 0.50: assignment is now more likely than not",
    "near_strike_near_expiry": "Within 2% of the strike with 7 days or fewer left",
    "early_assignment_before_dividend": "Ex-dividend tomorrow with less time value than the dividend: "
    "early assignment is possible",
    "earnings_before_expiry": "Earnings fall before this call expires",
}


def import_state(state: str = "ok") -> dict[str, Any]:
    running = state == "running"
    return {
        "source": "ibkr_flex",
        "account_scope": "data",
        "statement_date": None if running else w.TODAY,
        "imported_at": None if running else "2026-10-24T09:15:00Z",
        "lots": 0 if running else w.LOT_COUNT,
        "state": state,
    }


def accounts() -> list[dict[str, Any]]:
    return [dict(account) for account in w.ACCOUNTS]


def _position(symbol: str) -> tuple[float, float]:
    """(shares, cost) over every account's lots of the symbol."""
    lots = [lot for lot in w.STOCK_LOTS if lot[1] == symbol]
    return sum(lot[3] for lot in lots), sum(lot[3] * lot[4] for lot in lots)


def _market_value(symbol: str) -> float:
    return _position(symbol)[0] * w.last(symbol)


def _total_market_value() -> float:
    return sum(_market_value(symbol) for symbol in w.SYMBOLS)


def fundamentals(symbol: str) -> dict[str, Any]:
    """02n §c4's keys: the invented metrics, plus what the world derives (earnings, the Desk AI view, weight, gain)."""
    shares, cost = _position(symbol)
    verdict = w.VERDICTS.get(symbol)
    return {
        **w.METRICS[symbol],
        "next_earnings": w.QUOTES[symbol][3],
        "ai_rating": None if verdict is None else verdict[0],
        "ai_target_base": None if verdict is None else verdict[3],
        "ai_upside_pct": w.upside_pct(symbol),
        "weight_pct": round(_market_value(symbol) / _total_market_value() * 100, 1),
        "gain_vs_cost_pct": round((w.last(symbol) * shares / cost - 1) * 100, 1),
        "cc_coverable": w.coverable_total(symbol),
    }


def _row(symbol: str) -> dict[str, Any]:
    shares, cost = _position(symbol)
    value = shares * w.last(symbol)
    verdict = w.VERDICTS.get(symbol)
    return {
        "symbol": symbol,
        "name": w.QUOTES[symbol][0],
        "account_ids": w.account_ids(symbol),
        "shares": shares,
        "avg_cost": round(cost / shares, 2),
        "last": w.last(symbol),
        "change_pct": w.change_pct(symbol),
        "market_value": round(value, 2),
        "weight_pct": round(value / _total_market_value() * 100, 1),
        "unrealized_pct": round((value / cost - 1) * 100, 1),
        "coverable_contracts": w.coverable_total(symbol),
        "open_calls": w.open_contracts(symbol),
        "next_earnings": w.QUOTES[symbol][3],
        "ai_rating": None if verdict is None else verdict[0],
        "fundamentals": fundamentals(symbol),
        "stamp": stamp(),
    }


def totals() -> dict[str, Any]:
    value = _total_market_value()
    cost = sum(_position(symbol)[1] for symbol in w.SYMBOLS)
    day = sum(_market_value(symbol) - _market_value(symbol) / (1 + w.change_pct(symbol) / 100) for symbol in w.SYMBOLS)
    return {
        "market_value": round(value, 2),
        "cost": round(cost, 2),
        "unrealized": round(value - cost, 2),
        "unrealized_pct": round((value / cost - 1) * 100, 1),
        "day_change": round(day, 2),
        "day_change_pct": round(day / (value - day) * 100, 2),
    }


def holdings(account_id: int | None) -> dict[str, Any]:
    if account_id is not None and account_id not in w.ACCOUNT_TYPE:
        raise HTTPException(status_code=404, detail="account not found")
    symbols = [s for s in w.SYMBOLS if account_id is None or account_id in w.account_ids(s)]
    return {
        "import": import_state(),
        "accounts": accounts(),
        "totals": totals(),
        "rows": [_row(symbol) for symbol in symbols],
        "option_lots": [
            {
                "id": id_,
                "symbol": symbol,
                "account_id": acct,
                "right": "C",
                "strike": strike,
                "expiry": expiry,
                "contracts": -n,
            }
            for id_, symbol, acct, strike, expiry, n, _ in w.SHORT_CALLS
            if account_id is None or acct == account_id
        ],
    }


def short_call_row(call: tuple[Any, ...]) -> dict[str, Any]:
    id_, symbol, acct, strike, expiry, contracts, delta = call
    spot = w.last(symbol)
    return {
        "id": id_,
        "symbol": symbol,
        "account_id": acct,
        "strike": strike,
        "expiry": expiry,
        "contracts": contracts,
        "dte": (expiry - w.TODAY).days,
        "spot": spot,
        "moneyness_pct": round((spot / strike - 1) * 100, 2),  # below 0 = out of the money
        "delta": delta,
        "risks": [{"kind": kind, "text": RISK_TEXT[kind]} for kind in w.risks_of(id_)],
        "stamp": stamp(),
    }


def short_calls() -> list[dict[str, Any]]:
    return [short_call_row(call) for call in w.SHORT_CALLS]


def lots(symbol: str) -> dict[str, Any]:
    if symbol not in w.QUOTES:
        raise HTTPException(status_code=404, detail="symbol not found")
    return {
        "symbol": symbol,
        "lots": [
            {
                "account_id": acct,
                "shares": shares,
                "cost_per_share": cost,
                "acquired": acquired,
                "term": w.term(acquired),
                "gain_pct": round((w.last(symbol) / cost - 1) * 100, 1),
            }
            for _, sym, acct, shares, cost, acquired in w.STOCK_LOTS
            if sym == symbol
        ],
        "short_calls": [short_call_row(call) for call in w.SHORT_CALLS if call[1] == symbol],
    }


def account_patch(account_id: int, label: str | None, kind: str | None) -> dict[str, Any]:
    """The account as it would read after the patch; the stub stores nothing."""
    account = next((a for a in w.ACCOUNTS if a["id"] == account_id), None)
    if account is None:
        raise HTTPException(status_code=404, detail="account not found")
    return {**account, **({"label": label} if label else {}), **({"type": kind} if kind else {})}
