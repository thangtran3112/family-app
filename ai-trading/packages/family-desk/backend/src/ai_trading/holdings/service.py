"""The holdings read model (02n §d `holdings/service.py`): the newest imported statement of each of the user's accounts,
grouped per symbol and account, priced from the stored daily closes (a quote when a symbol has no stored bar), with the
cover cap applied. Every read is scoped to the user's own accounts (02n §c1): another user's account is a 404, and the
broker account number is never selected, so it cannot reach a response.

A symbol no source prices has a null `last`, market value and weight, and the unavailable stamp; the totals are null
whenever any row is unpriced, because a partial sum would read as the whole portfolio."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

from ai_trading_common.registry import DataSources
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.core import covered_calls as engine
from ai_trading.core.calendar import ET
from ai_trading.db.models import (
    Account,
    EarningsResult,
    HoldingImport,
    HoldingLot,
    SymbolFundamental,
    UniverseSymbol,
    User,
)
from ai_trading.fundamental.prices import Price, close_prices, spot_prices, stamp_of
from ai_trading.fundamental.settings import METRIC_KEYS, covered_call_settings
from ai_trading.fundamental.sources import fundamental_sources
from ai_trading.holdings.importer import RUNTIME, ImportRuntime, flex_user_email

SHORT_TERM_DAYS = 365  # the engine's own rule: a lot opened within a year of today is short term


@dataclass(frozen=True)
class Position:
    """One symbol in one account: its stock lots and the short calls written on it."""

    account_id: int
    symbol: str
    lots: tuple[HoldingLot, ...]
    short_calls: tuple[HoldingLot, ...] = field(default=())

    @property
    def shares(self) -> float:
        return sum(lot.quantity for lot in self.lots)

    @property
    def open_contracts(self) -> int:
        return int(sum(-call.quantity for call in self.short_calls))

    @property
    def cost(self) -> float | None:
        """What the shares cost, or None when any lot lacks its cost basis."""
        if any(lot.cost_per_share is None for lot in self.lots):
            return None
        return sum(lot.quantity * lot.cost_per_share for lot in self.lots)  # type: ignore[operator]


def today_et(now: datetime) -> date:
    return now.astimezone(ET).date()


def accounts_of(db: Session, user_id: int) -> list[Account]:
    return list(db.execute(select(Account).where(Account.owner_user_id == user_id).order_by(Account.id)).scalars())


def owned_account(db: Session, user_id: int, account_id: int) -> Account:
    account = db.get(Account, account_id)
    if account is None or account.owner_user_id != user_id:
        raise HTTPException(status_code=404, detail="account not found")
    return account


def latest_lots(db: Session, user_id: int, account_id: int | None = None) -> list[HoldingLot]:
    """The lots of each of the user's accounts as of that account's newest statement."""
    newest = (
        select(HoldingImport.account_id, func.max(HoldingImport.statement_date).label("statement_date"))
        .join(Account, Account.id == HoldingImport.account_id)
        .where(Account.owner_user_id == user_id, HoldingImport.state == "ok")
        .group_by(HoldingImport.account_id)
        .subquery()
    )
    query = (
        select(HoldingLot)
        .join(HoldingImport, HoldingImport.id == HoldingLot.import_id)
        .join(
            newest,
            (newest.c.account_id == HoldingImport.account_id)
            & (newest.c.statement_date == HoldingImport.statement_date),
        )
        .order_by(HoldingLot.account_id, HoldingLot.symbol, HoldingLot.acquired, HoldingLot.id)
    )
    if account_id is not None:
        query = query.where(HoldingLot.account_id == account_id)
    return list(db.execute(query).scalars())


def open_short_calls(lots: list[HoldingLot], today: date) -> list[HoldingLot]:
    """Short call lots that have not expired; a statement older than an expiry no longer has that call open."""
    return [
        lot
        for lot in lots
        if lot.asset_class == "OPT" and lot.option_right == "C" and lot.quantity < 0 and lot.expiry >= today  # type: ignore[operator]
    ]


def positions_of(lots: list[HoldingLot], today: date) -> list[Position]:
    """Stock positions per (account, symbol), each with the short calls open on that symbol in that account."""
    calls = open_short_calls(lots, today)
    out = []
    keys = sorted({(lot.account_id, lot.symbol) for lot in lots if lot.asset_class == "STK"})
    for account_id, symbol in keys:
        out.append(
            Position(
                account_id,
                symbol,
                tuple(
                    lot
                    for lot in lots
                    if lot.asset_class == "STK" and (lot.account_id, lot.symbol) == (account_id, symbol)
                ),
                tuple(c for c in calls if (c.account_id, c.symbol) == (account_id, symbol)),
            )
        )
    return out


def user_settings(db: Session, user_id: int) -> dict[str, Any]:
    user = db.get(User, user_id)
    return {} if user is None else (user.settings or {})


def next_earnings_dates(db: Session, symbols: list[str], today: date) -> dict[str, date]:
    """Each symbol's next report date from the earnings store: the earliest date on or after today of a period not yet
    reported. A symbol the snapshot job has not seen has none (never guessed)."""
    if not symbols:
        return {}
    rows = db.execute(
        select(EarningsResult.symbol, func.min(EarningsResult.report_date))
        .where(
            EarningsResult.symbol.in_(symbols),
            EarningsResult.eps_actual.is_(None),
            EarningsResult.report_date >= today,
        )
        .group_by(EarningsResult.symbol)
    ).all()
    return {symbol: when for symbol, when in rows}


def import_state(
    db: Session, user_email: str, user_id: int, env: Mapping[str, str], runtime: ImportRuntime = RUNTIME
) -> dict[str, Any]:
    """The `ImportState` of 02n §c3: the newest imported statement date across the user's accounts, then a running or
    failed import on top of it. Nothing imported reads `none`; a Flex that is not set up reads `not_configured`."""
    newest = db.execute(
        select(func.max(HoldingImport.statement_date))
        .join(Account, Account.id == HoldingImport.account_id)
        .where(Account.owner_user_id == user_id, HoldingImport.state == "ok")
    ).scalar_one()
    statement_date, imported_at, lots = None, None, 0
    if newest is not None:
        statement_date = newest
        imported_at, lots = db.execute(
            select(func.max(HoldingImport.imported_at), func.coalesce(func.sum(HoldingImport.lots), 0))
            .join(Account, Account.id == HoldingImport.account_id)
            .where(
                Account.owner_user_id == user_id,
                HoldingImport.state == "ok",
                HoldingImport.statement_date == newest,
            )
        ).one()
    flex_user = flex_user_email(env)
    if runtime.running:
        state = "running"
    elif runtime.failed_at is not None and (imported_at is None or runtime.failed_at > imported_at):
        state = "failed"
    elif newest is not None:
        state = "ok"
    elif flex_user is not None and flex_user != user_email.lower():
        state = "none"  # the import belongs to someone else: "No holdings imported for you"
    else:
        state = "none" if fundamental_sources(env)["holdings"].state == "configured" else "not_configured"
    return {
        "source": "ibkr_flex",
        "account_scope": "data",
        "statement_date": statement_date,
        "imported_at": imported_at,
        "lots": int(lots),
        "state": state,
    }


def _price_map(db: Session, sources: DataSources, symbols: list[str], now: datetime) -> dict[str, Price]:
    prices = close_prices(db, symbols, now)
    missing = [s for s in symbols if s not in prices]
    return {**spot_prices(sources, missing, now), **prices} if missing else prices


def _share_term(acquired: date, today: date) -> str:
    return "short" if acquired > today - timedelta(days=SHORT_TERM_DAYS) else "long"


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(value, digits)


def holdings(
    db: Session,
    user_id: int,
    user_email: str,
    sources: DataSources,
    env: Mapping[str, str],
    account_id: int | None,
    now: datetime,
    runtime: ImportRuntime = RUNTIME,
) -> dict[str, Any]:
    """`GET /holdings`: import state, the user's accounts, totals, one row per held symbol and the option lots."""
    accounts = accounts_of(db, user_id)
    if account_id is not None:
        owned_account(db, user_id, account_id)
    today = today_et(now)
    lots = latest_lots(db, user_id, account_id)
    cap_pct = covered_call_settings(user_settings(db, user_id))[1]
    by_symbol: dict[str, list[Position]] = {}
    for position in positions_of(lots, today):
        by_symbol.setdefault(position.symbol, []).append(position)
    symbols = sorted(by_symbol)
    prices = _price_map(db, sources, symbols, now)
    earnings = next_earnings_dates(db, symbols, today)
    names = dict(
        db.execute(select(UniverseSymbol.symbol, UniverseSymbol.name).where(UniverseSymbol.symbol.in_(symbols))).all()
    )
    stored = {
        row.symbol: row.metrics
        for row in db.execute(select(SymbolFundamental).where(SymbolFundamental.symbol.in_(symbols))).scalars()
    }

    def value_of(symbol: str) -> float | None:
        price = prices.get(symbol)
        return None if price is None else sum(p.shares for p in by_symbol[symbol]) * price.last

    values = {symbol: value_of(symbol) for symbol in symbols}
    priced = all(v is not None for v in values.values())
    total_value = sum(values.values()) if priced else None  # type: ignore[arg-type]
    rows = []
    for symbol in symbols:
        group = by_symbol[symbol]
        shares = sum(p.shares for p in group)
        costs = [p.cost for p in group]
        cost = None if any(c is None for c in costs) else sum(costs)  # type: ignore[arg-type]
        price, value = prices.get(symbol), values[symbol]
        coverable = sum(engine.coverable_contracts(p.shares, cap_pct, p.open_contracts) for p in group)
        weight = None if value is None or not total_value else value / total_value * 100
        gain = None if value is None or not cost else (value / cost - 1) * 100
        rows.append(
            {
                "symbol": symbol,
                "name": names.get(symbol, symbol),
                "account_ids": sorted({p.account_id for p in group}),
                "shares": shares,
                "avg_cost": round(cost / shares, 4) if cost is not None and shares else 0.0,
                "last": None if price is None else price.last,
                "change_pct": None if price is None else _round(price.change_pct, 2),
                "market_value": _round(value),
                "weight_pct": _round(weight, 1),
                "unrealized_pct": _round(gain, 1),
                "coverable_contracts": coverable,
                "open_calls": sum(p.open_contracts for p in group),
                "next_earnings": earnings.get(symbol),
                "ai_rating": None,
                "fundamentals": {
                    **{key: value for key, value in (stored.get(symbol) or {}).items() if key in METRIC_KEYS},
                    "next_earnings": earnings.get(symbol),
                    "weight_pct": _round(weight, 1),
                    "gain_vs_cost_pct": _round(gain, 1),
                    "cc_coverable": coverable,
                    "ai_rating": None,
                    "ai_target_base": None,
                    "ai_upside_pct": None,
                },
                "stamp": stamp_of(price, now),
            }
        )
    rows.sort(key=lambda r: (r["market_value"] is None, -(r["market_value"] or 0), r["symbol"]))
    return {
        "import": import_state(db, user_email, user_id, env, runtime),
        "accounts": [{"id": a.id, "label": a.label, "type": a.type} for a in accounts],
        "totals": _totals(rows, by_symbol, prices),
        "rows": rows,
        "option_lots": [
            {
                "id": lot.id,
                "symbol": lot.symbol,
                "account_id": lot.account_id,
                "right": lot.option_right,
                "strike": lot.strike,
                "expiry": lot.expiry,
                "contracts": int(lot.quantity),
            }
            for lot in sorted(lots, key=lambda lot: (lot.symbol, lot.expiry or date.min, lot.strike or 0, lot.id))
            if lot.asset_class == "OPT"
        ],
    }


def _totals(
    rows: list[dict[str, Any]], by_symbol: dict[str, list[Position]], prices: dict[str, Price]
) -> dict[str, Any]:
    """Portfolio totals, all null unless every held symbol has a price (a partial sum is not the portfolio)."""
    empty = {k: None for k in ("market_value", "cost", "unrealized", "unrealized_pct", "day_change", "day_change_pct")}
    if not rows or any(row["market_value"] is None for row in rows):
        return empty
    value = sum(row["market_value"] for row in rows)
    costs = [p.cost for group in by_symbol.values() for p in group]
    cost = None if any(c is None for c in costs) else sum(costs)  # type: ignore[arg-type]
    day = None
    if all(prices[row["symbol"]].prev_close for row in rows):
        day = sum(
            row["shares"] * (prices[row["symbol"]].last - prices[row["symbol"]].prev_close)  # type: ignore[operator]
            for row in rows
        )
    return {
        "market_value": round(value, 2),
        "cost": _round(cost),
        "unrealized": None if cost is None else round(value - cost, 2),
        "unrealized_pct": None if not cost else round((value / cost - 1) * 100, 1),
        "day_change": _round(day),
        "day_change_pct": None if day is None or value == day else round(day / (value - day) * 100, 2),
    }


def lots(db: Session, user_id: int, sources: DataSources, symbol: str, now: datetime) -> dict[str, Any]:
    """`GET /holdings/{symbol}/lots` without its short calls (the router adds the covered-call service's rows)."""
    today = today_et(now)
    own = [lot for lot in latest_lots(db, user_id) if lot.asset_class == "STK" and lot.symbol == symbol]
    if not own:
        raise HTTPException(status_code=404, detail="symbol not found")
    price = _price_map(db, sources, [symbol], now).get(symbol)
    return {
        "symbol": symbol,
        "lots": [
            {
                "account_id": lot.account_id,
                "shares": lot.quantity,
                "cost_per_share": lot.cost_per_share or 0.0,
                "acquired": lot.acquired,
                "term": _share_term(lot.acquired, today),  # type: ignore[arg-type]
                "gain_pct": None
                if price is None or not lot.cost_per_share
                else round((price.last / lot.cost_per_share - 1) * 100, 1),
            }
            for lot in own
        ],
    }


def patch_account(db: Session, user_id: int, account_id: int, label: str | None, kind: str | None) -> dict[str, Any]:
    account = owned_account(db, user_id, account_id)
    if label is not None:
        account.label = label
    if kind is not None:
        account.type = kind
    db.flush()
    return {"id": account.id, "label": account.label, "type": account.type}
