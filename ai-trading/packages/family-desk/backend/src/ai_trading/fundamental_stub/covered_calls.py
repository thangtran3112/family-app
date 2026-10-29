"""Stub builders for the covered-call family (02n §c3 #6 to #10), from the engine's own math on the invented chains."""

from typing import Any

from fastapi import HTTPException

from ai_trading.covered_calls.service import ASSIGNMENT_NOTE
from ai_trading.fundamental_stub import holdings, stamp, unavailable_stamp
from ai_trading.fundamental_stub import world as w

#: (month, premium, contracts) from the invented Trades history, oldest first.
_INCOME = (
    ("2025-11", 180.0, 2),
    ("2025-12", 295.0, 3),
    ("2026-01", 340.0, 3),
    ("2026-02", 275.0, 2),
    ("2026-03", 505.0, 4),
    ("2026-04", 460.0, 4),
    ("2026-05", 410.0, 3),
    ("2026-06", 655.0, 5),
    ("2026-07", 520.0, 4),
    ("2026-08", 790.0, 6),
    ("2026-09", 610.0, 5),
    ("2026-10", 345.0, 3),
)


def coverage() -> dict[str, Any]:
    rows = []
    for symbol in w.SYMBOLS:
        for account_id in w.account_ids(symbol):
            reason, text = w.coverage_reason(symbol, account_id)
            rows.append(
                {
                    "symbol": symbol,
                    "account_id": account_id,
                    "shares": w.account_shares(symbol, account_id),
                    "open_contracts": w.open_contracts(symbol, account_id),
                    "coverable": w.coverable(symbol, account_id),
                    "reason": reason,
                    "reason_text": text,
                }
            )
    return {"cap_pct": w.CAP_PCT, "rows": rows}


def candidates(symbol: str, account_id: int | None) -> dict[str, Any]:
    held = w.account_ids(symbol) if symbol in w.QUOTES else []
    if not held:
        raise HTTPException(status_code=404, detail="symbol not found")
    if account_id is None:
        account_id = held[0]
    if account_id not in held:
        raise HTTPException(status_code=404, detail="account does not hold this symbol")
    rank, sessions = w.IV.get(symbol, w.SHORT_HISTORY)
    verdict = w.VERDICTS.get(symbol)
    return {
        "symbol": symbol,
        "account_id": account_id,
        "spot": w.last(symbol),
        "spot_stamp": stamp(),
        "chain_stamp": stamp() if symbol in w.CHAINS else unavailable_stamp(),
        "iv_rank": rank,
        "iv_history_sessions": sessions,
        "opportunity": w.is_opportunity(symbol, account_id),
        "candidates": w.candidate_rows(symbol, account_id),
        "ai_context": None
        if verdict is None
        else {
            "rating": verdict[0],
            "target_base": verdict[3],
            "note": f"Desk AI rates {symbol} a {verdict[0].title()}: a call strike below ${verdict[3]:g} caps part of "
            "that view.",
        },
    }


def roll(call_id: int) -> dict[str, Any]:
    call = next((c for c in w.SHORT_CALLS if c[0] == call_id), None)
    if call is None:
        raise HTTPException(status_code=404, detail="short call not found")
    cost, rolls = w.roll_rows(call_id)
    account_type = w.ACCOUNT_TYPE[call[2]]
    return {
        "cost_to_close": cost,
        "candidates": rolls,
        "assignment_note": {"account_type": account_type, "text": ASSIGNMENT_NOTE[account_type]},
        "chain_stamp": stamp() if cost is not None else unavailable_stamp(),
    }


def income(months: int) -> dict[str, Any]:
    return {
        "state": "ok",
        "by_month": [{"month": month, "premium": premium, "contracts": n} for month, premium, n in _INCOME[-months:]],
        "assignments": [
            {"date": "2026-08-21", "symbol": "KO", "contracts": 2, "strike": 70.0},
            {"date": "2026-03-20", "symbol": "JNJ", "contracts": 1, "strike": 170.0},
        ],
        "ytd_premium": sum(premium for month, premium, _ in _INCOME if month.startswith("2026")),
        "source_stamp": stamp(quality="eod"),
    }


def short_calls() -> list[dict[str, Any]]:
    return holdings.short_calls()
