"""The covered-call read model (02n §d `covered_calls/service.py`): coverage, the top three calls, open short calls with
their risks, the roll panel and premium income. The numbers are `core/covered_calls.py`'s, called as it is: nothing is
recomputed here or in the browser.

Data, resolved on each request (the scan job and its stored scans are step 6, so `covered_call_scans` is not read):
the spot is the registry's `quotes` kind (Alpaca, 15 minutes delayed), the chain is the `option_chain` kind (Alpaca
options: bid, ask, model delta, IV, open interest; DTE 21-45 from the user's filters, 02n §g), the lots and short
calls are the newest Flex statement. A quote or chain that cannot be read (no key, a rejected key, an outage) gives a
null spot or an empty list with the unavailable stamp, never a stand-in. Nothing here knows an ex-dividend date
(02n §g.3), so the engine gets `None`.
"""

import logging
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from ai_trading_common.types import OptionContract
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.api.stamp import make_stamp
from ai_trading.core import covered_calls as engine
from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import Account, HoldingImport, HoldingLot, HoldingTrade, IvHistory
from ai_trading.fundamental.prices import Price, spot_prices, stamp_of, unavailable_stamp
from ai_trading.fundamental.settings import covered_call_settings
from ai_trading.fundamental.sources import fundamental_sources
from ai_trading.holdings import service as holdings_service
from ai_trading.holdings.service import Position, latest_lots, next_earnings_dates, today_et, user_settings

log = logging.getLogger(__name__)

_CHAIN_INTERVAL = timedelta(minutes=15)
_STRIKE_CEILING = 1.6  # a call at 160% of spot is far past any delta the filters accept; it only bounds the chain pages
_ROLL_MAX_DTE = 60  # `engine.roll_candidates`' own default

RISK_TEXT = {
    "delta_above_0_50": "Delta is above 0.50: assignment is now more likely than not",
    "near_strike_near_expiry": "Within 2% of the strike with 7 days or fewer left",
    "early_assignment_before_dividend": "Ex-dividend tomorrow with less time value than the dividend: "
    "early assignment is possible",
    "earnings_before_expiry": "Earnings fall before this call expires",
}
ASSIGNMENT_NOTE = {
    "taxable": "If assigned, the shares are sold at the strike and the gain is taxable, short or long term by lot. "
    "Not tax advice.",
    "ira": "Held in an IRA: assignment sells the shares inside the account with no immediate tax. Not tax advice.",
    "roth": "Held in a Roth IRA: assignment sells the shares inside the account with no immediate tax. Not tax advice.",
}

#: The last chain read's outcome and time (None before any), so `/status` does not call a rejected key "connected".
#: In process memory: a restart forgets it and the next read decides.
CHAIN_HEALTH: dict[str, Any] = {"ok": None, "at": None}


@dataclass(frozen=True)
class Chain:
    contracts: list[OptionContract]
    stamp: dict[str, Any]

    def quote(self, expiry: date, strike: float) -> OptionContract | None:
        return next((c for c in self.contracts if c.expiry == expiry and abs(c.strike - strike) < 1e-6), None)


def _quotes(contracts: Sequence[OptionContract]) -> list[engine.OptionQuote]:
    """The engine's `OptionQuote`s. An unknown open interest is 0: it fails the filter, never passes it."""
    return [
        engine.OptionQuote(c.expiry, c.strike, c.bid, c.ask, c.open_interest or 0, c.delta, c.iv) for c in contracts
    ]


def read_chain(
    sources: DataSources,
    symbol: str,
    now: datetime,
    *,
    min_dte: int,
    max_dte: int,
    min_strike: float,
    max_strike: float,
) -> Chain | None:
    """One chain read, or None when it cannot be read or is empty (the caller says unavailable). The stamp is the
    chain's own: its freshest quote's time and the provider's quality, read just now."""
    try:
        if sources.option_chain is None:
            raise ProviderError("option_chain", "no chain source")
        contracts = sources.option_chain.option_chain(
            symbol,
            now=pd.Timestamp(now),
            right="C",
            min_dte=min_dte,
            max_dte=max_dte,
            min_strike=min_strike,
            max_strike=max_strike,
        )
    except ProviderError as error:
        CHAIN_HEALTH.update(ok=False, at=now)
        log.warning("option chain unavailable: %s", type(error).__name__)
        return None
    CHAIN_HEALTH.update(ok=True, at=now)
    if not contracts:
        return None
    newest = max(c.as_of for c in contracts).to_pydatetime()
    stamp = make_stamp(
        quality=contracts[0].quality,
        source=contracts[0].provider,
        as_of=newest,
        interval=_CHAIN_INTERVAL,
        last_ok_at=now,
        now=now,
    ).model_dump()
    return Chain(contracts, stamp)


def _next_trading_day(today: date) -> date:
    day = today + timedelta(days=1)
    while trading_session("stock", day) is None:
        day += timedelta(days=1)
    return day


def _chain_configured(env: Mapping[str, str]) -> bool:
    return fundamental_sources(env)["option_chain"].state == "delayed"


def _coverage_reason(
    position: Position, cap_pct: float, today: date, max_dte: int, earnings: date | None, chain_configured: bool
) -> tuple[str, str]:
    """(reason, words) in 02n §c3 #6's order: the cap, the cover left, the chain, then earnings."""
    shares = position.shares
    if engine.coverable_contracts(shares, cap_pct, 0) == 0:
        return "under_one_contract", f"{shares:g} shares: under one contract at a {cap_pct:g}% cap"
    coverable = engine.coverable_contracts(shares, cap_pct, position.open_contracts)
    if coverable == 0:
        return "fully_covered", "fully covered at its cap"
    if not chain_configured:
        return "no_chain", "no option chain for this symbol yet"
    if earnings is not None and today <= earnings <= today + timedelta(days=max_dte):
        return "earnings_wait", f"earnings {earnings:%b} {earnings.day}: waits"
    return "ok", f"{coverable} contract{'s' if coverable != 1 else ''} can be sold at a {cap_pct:g}% cap"


def coverage(db: Session, user_id: int, env: Mapping[str, str], now: datetime) -> dict[str, Any]:
    """`GET /covered-calls/coverage`: coverable contracts per holding and account, with the reason in words."""
    today = today_et(now)
    filters, cap_pct = covered_call_settings(user_settings(db, user_id))
    positions = holdings_service.positions_of(latest_lots(db, user_id), today)
    earnings = next_earnings_dates(db, sorted({p.symbol for p in positions}), today)
    configured = _chain_configured(env)
    rows = []
    for p in positions:
        reason, text = _coverage_reason(p, cap_pct, today, filters.max_dte, earnings.get(p.symbol), configured)
        rows.append(
            {
                "symbol": p.symbol,
                "account_id": p.account_id,
                "shares": p.shares,
                "open_contracts": p.open_contracts,
                "coverable": engine.coverable_contracts(p.shares, cap_pct, p.open_contracts),
                "reason": reason,
                "reason_text": text,
            }
        )
    return {"cap_pct": cap_pct, "rows": rows}


def _iv_history(db: Session, symbol: str) -> list[float]:
    return list(db.execute(select(IvHistory.iv30).where(IvHistory.symbol == symbol).order_by(IvHistory.day)).scalars())


def candidates(
    db: Session,
    user_id: int,
    sources: DataSources,
    symbol: str,
    account_id: int | None,
    now: datetime,
) -> dict[str, Any]:
    """`GET /covered-calls/candidates`: the engine's top three for one account's lots of `symbol`. 404 when the user
    holds no such stock in that account. `account_id` omitted means the first account that holds it."""
    today = today_et(now)
    filters, cap_pct = covered_call_settings(user_settings(db, user_id))
    held = [p for p in holdings_service.positions_of(latest_lots(db, user_id), today) if p.symbol == symbol]
    if not held:
        raise HTTPException(status_code=404, detail="symbol not found")
    position = held[0] if account_id is None else next((p for p in held if p.account_id == account_id), None)
    if position is None:
        raise HTTPException(status_code=404, detail="account does not hold this symbol")
    types = {a.id: a.type for a in db.execute(select(Account).where(Account.owner_user_id == user_id)).scalars()}
    price = spot_prices(sources, [symbol], now).get(symbol)
    history = _iv_history(db, symbol)
    rank = engine.iv_rank(history)
    result: dict[str, Any] = {
        "symbol": symbol,
        "account_id": position.account_id,
        "spot": None if price is None else price.last,
        "spot_stamp": stamp_of(price, now),
        "chain_stamp": unavailable_stamp(),
        "iv_rank": rank,
        "iv_history_sessions": len(history),
        "opportunity": False,
        "candidates": [],
        "ai_context": None,  # Desk AI is step 5
    }
    if price is None:
        return result
    chain = read_chain(
        sources,
        symbol,
        now,
        min_dte=filters.min_dte,
        max_dte=filters.max_dte,
        min_strike=price.last,
        max_strike=price.last * _STRIKE_CEILING,
    )
    if chain is None:
        return result
    result["chain_stamp"] = chain.stamp
    if engine.coverable_contracts(position.shares, cap_pct, position.open_contracts) == 0:
        return result  # nothing can be sold here: the chain is read so its stamp is true, the list stays empty
    free_elsewhere = sum(
        engine.coverable_contracts(p.shares, cap_pct, p.open_contracts)
        for p in held
        if p.account_id != position.account_id and types.get(p.account_id, "taxable") != "taxable"
    )
    earnings = next_earnings_dates(db, [symbol], today).get(symbol)
    found = engine.candidates(
        price.last,
        _quotes(chain.contracts),
        today,
        filters=filters,
        lots=tuple(
            engine.Lot(lot.quantity, lot.cost_per_share or 0.0, lot.acquired)  # type: ignore[arg-type]
            for lot in position.lots
        ),
        taxable=types.get(position.account_id, "taxable") == "taxable",
        tax_advantaged_contracts_free=free_elsewhere,
        earnings=earnings,
        iv_rank=rank,
    )
    result["candidates"] = [
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
        for c in found
    ]
    result["opportunity"] = bool(found) and engine.is_opportunity(found[0], rank)
    return result


def _call_row(
    lot: HoldingLot,
    price: Price | None,
    chain: Chain | None,
    today: date,
    next_day: date,
    earnings: date | None,
    now: datetime,
) -> dict[str, Any]:
    quote = None if chain is None else chain.quote(lot.expiry, lot.strike)  # type: ignore[arg-type]
    delta = None if quote is None else quote.delta
    risks = engine.short_call_risks(
        engine.ShortCall(lot.expiry, lot.strike, int(-lot.quantity)),  # type: ignore[arg-type]
        spot=price.last if price else math.inf,  # no spot: an infinite price is never near a strike
        today=today,
        next_trading_day=next_day,
        delta=delta,
        earnings=earnings,
    )
    return {
        "id": lot.id,
        "symbol": lot.symbol,
        "account_id": lot.account_id,
        "strike": lot.strike,
        "expiry": lot.expiry,
        "contracts": int(-lot.quantity),
        "dte": (lot.expiry - today).days,  # type: ignore[operator]
        "spot": None if price is None else price.last,
        "moneyness_pct": None if price is None else round((price.last / lot.strike - 1) * 100, 2),  # type: ignore[operator]
        "delta": delta,
        "risks": [{"kind": kind, "text": RISK_TEXT[kind]} for kind in risks],
        "stamp": stamp_of(price, now),
    }


def short_calls(
    db: Session, user_id: int, sources: DataSources, now: datetime, *, symbol: str | None = None
) -> list[dict[str, Any]]:
    """`GET /covered-calls/short-calls` (and one symbol's, for the lots route): the open short calls of the newest
    statements with moneyness from the spot, delta from the chain and the engine's risks. With no spot there is no
    moneyness and the near-strike rule cannot run; with no chain there is no delta and its rule cannot run."""
    today = today_et(now)
    opened = holdings_service.open_short_calls(latest_lots(db, user_id), today)
    calls = [c for c in opened if symbol in (None, c.symbol)]
    by_symbol: dict[str, list[HoldingLot]] = {}
    for call in calls:
        by_symbol.setdefault(call.symbol, []).append(call)
    prices = spot_prices(sources, sorted(by_symbol), now)
    earnings = next_earnings_dates(db, sorted(by_symbol), today)
    next_day = _next_trading_day(today)
    chains: dict[str, Chain | None] = {}
    for sym, group in by_symbol.items():
        dtes = [(c.expiry - today).days for c in group]  # type: ignore[operator]
        strikes = [c.strike for c in group]
        chains[sym] = read_chain(
            sources,
            sym,
            now,
            min_dte=min(dtes),
            max_dte=max(dtes),
            min_strike=min(strikes),  # type: ignore[type-var]
            max_strike=max(strikes),  # type: ignore[type-var]
        )
    return [
        _call_row(c, prices.get(c.symbol), chains[c.symbol], today, next_day, earnings.get(c.symbol), now)
        for c in sorted(calls, key=lambda c: (c.expiry, c.symbol, c.strike, c.id))  # type: ignore[type-var]
    ]


def roll(db: Session, user_id: int, sources: DataSources, call_id: int, now: datetime) -> dict[str, Any]:
    """`GET /covered-calls/short-calls/{id}/roll`: the cost to close (the contract's ask per share), the engine's roll
    candidates from the same chain read, and the assignment note of the account's type. 404 for a call that is not an
    open short call of the user's newest statements."""
    today = today_et(now)
    lots = latest_lots(db, user_id)
    call = next((c for c in holdings_service.open_short_calls(lots, today) if c.id == call_id), None)
    if call is None:
        raise HTTPException(status_code=404, detail="short call not found")
    account = db.get(Account, call.account_id)
    price = spot_prices(sources, [call.symbol], now).get(call.symbol)
    chain = read_chain(
        sources,
        call.symbol,
        now,
        min_dte=max(0, (call.expiry - today).days),  # type: ignore[operator]
        max_dte=_ROLL_MAX_DTE,
        min_strike=call.strike,  # type: ignore[arg-type]
        max_strike=max(call.strike, price.last if price else 0.0) * _STRIKE_CEILING,  # type: ignore[type-var]
    )
    held = engine.ShortCall(call.expiry, call.strike, int(-call.quantity))  # type: ignore[arg-type]
    current = None if chain is None else chain.quote(call.expiry, call.strike)  # type: ignore[arg-type]
    rolled = (
        engine.roll_candidates(held, buyback_ask=current.ask, quotes=_quotes(chain.contracts), today=today)  # type: ignore[union-attr]
        if current is not None
        else []
    )
    by_key = {(c.expiry, c.strike): c for c in (chain.contracts if chain else [])}
    kind = account.type if account else "taxable"
    return {
        "cost_to_close": None if current is None else current.ask,
        "candidates": [
            {
                "expiry": quote.expiry,
                "strike": quote.strike,
                "dte": (quote.expiry - today).days,
                "delta": by_key[(quote.expiry, quote.strike)].delta,
                "net_credit": credit,
                "flags": [],
            }
            for quote, credit in rolled
        ],
        "assignment_note": {"account_type": kind, "text": ASSIGNMENT_NOTE[kind]},
        "chain_stamp": chain.stamp if chain is not None else unavailable_stamp(),
    }


def income(db: Session, user_id: int, months: int, now: datetime) -> dict[str, Any]:
    """`GET /covered-calls/income`: premium collected by month from the Flex `Trades` (the calls sold to open, gross:
    buybacks are not netted) and the assignments. `needs_trades` while the Flex query carries no Trades section."""
    today = today_et(now)
    trades = list(
        db.execute(
            select(HoldingTrade)
            .join(Account, Account.id == HoldingTrade.account_id)
            .where(Account.owner_user_id == user_id, HoldingTrade.option_right == "C")
            .order_by(HoldingTrade.trade_date, HoldingTrade.id)
        ).scalars()
    )
    if not trades:
        return {
            "state": "needs_trades",
            "by_month": [],
            "assignments": [],
            "ytd_premium": None,
            "source_stamp": unavailable_stamp(),
        }
    first = (today.year * 12 + today.month - 1) - (months - 1)  # month index, oldest month of the window
    by_month: dict[int, list[float]] = {}
    for t in trades:
        index = t.trade_date.year * 12 + t.trade_date.month - 1
        if t.kind == "sell_to_open" and index >= first:
            bucket = by_month.setdefault(index, [0.0, 0])
            bucket[0] += abs(t.quantity) * t.price * t.multiplier
            bucket[1] += int(abs(t.quantity))
    start = max(first, min(by_month, default=first))
    now_index = today.year * 12 + today.month - 1
    series = [
        {
            "month": f"{index // 12}-{index % 12 + 1:02d}",
            "premium": round(by_month.get(index, [0.0, 0])[0], 2),
            "contracts": by_month.get(index, [0.0, 0])[1],
        }
        for index in range(start, now_index + 1)
    ]
    year = f"{today.year}-"
    return {
        "state": "ok",
        "by_month": series,
        "assignments": [
            {"date": t.trade_date, "symbol": t.symbol, "contracts": int(abs(t.quantity)), "strike": t.strike}
            for t in reversed(trades)
            if t.kind == "assignment"
        ][:50],
        "ytd_premium": round(sum(p["premium"] for p in series if p["month"].startswith(year)), 2),
        "source_stamp": _trades_stamp(db, user_id, now),
    }


def _trades_stamp(db: Session, user_id: int, now: datetime) -> dict[str, Any]:
    """The Trades come from the Flex statement, as of its newest import."""
    imported_at = db.execute(
        select(func.max(HoldingImport.imported_at))
        .join(Account, Account.id == HoldingImport.account_id)
        .where(Account.owner_user_id == user_id, HoldingImport.state == "ok")
    ).scalar_one()
    if imported_at is None:
        return unavailable_stamp()
    day = timedelta(days=1)
    return make_stamp(
        quality="eod", source="ibkr_flex", as_of=imported_at, interval=day, last_ok_at=imported_at, now=now
    ).model_dump()
