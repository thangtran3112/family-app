"""Shared by the Fundamental service tests (02n §j): a recorded-shape Flex statement built from invented values, a
`quotes` fake, and the seeding helpers. Nothing here is a real holding, price or account: the account ids are
placeholders shaped like IBKR's (a letter prefix and digits) so the masking and the privacy scans have something to
find, and every number is made up."""

from datetime import UTC, datetime

import pandas as pd
from ai_trading_common.registry import DataSources
from ai_trading_common.types import Quote
from sqlalchemy.orm import Session

from ai_trading.db.models import User
from ai_trading.holdings import importer
from ai_trading.holdings.flex import parse_statements

ACCOUNT_A = "U0000001"  # taxable
ACCOUNT_B = "U0000002"  # ira
NOW = datetime(2026, 10, 23, 19, 30, tzinfo=UTC)  # Friday 15:30 ET, the covered-call scan's own slot
AFTER_CLOSE = datetime(2026, 10, 24, 14, 0, tzinfo=UTC)  # Saturday morning: the Friday close is the latest close


def stock_lot(
    symbol: str, shares: float, cost: float, opened: str, *, level: str = "LOT", category: str = "STK"
) -> str:
    return (
        f'<OpenPosition accountId="X" assetCategory="{category}" symbol="{symbol}" underlyingSymbol="" '
        f'multiplier="1" position="{shares:g}" costBasisPrice="{cost}" levelOfDetail="{level}" '
        f'openDateTime="{opened};093000" putCall="" strike="" expiry=""/>'
    )


def option_lot(
    symbol: str, contracts: int, strike: float, expiry: str, *, right: str = "C", opened: str = "20261001"
) -> str:
    return (
        f'<OpenPosition accountId="X" assetCategory="OPT" symbol="{symbol}  {expiry[2:]}{right}00000000" '
        f'underlyingSymbol="{symbol}" multiplier="100" position="{contracts}" costBasisPrice="1.2" '
        f'levelOfDetail="LOT" openDateTime="{opened};101500" putCall="{right}" strike="{strike:g}" expiry="{expiry}"/>'
    )


def trade(
    ref: str,
    symbol: str,
    kind: str,
    on: str,
    contracts: int,
    price: float,
    *,
    strike: float = 215,
    expiry: str = "20261120",
    right: str = "C",
) -> str:
    """One Flex `Trade` row. `kind` is the Desk's trade kind; it is written the way IBKR writes it."""
    buy_sell, open_close, notes = {
        "sell_to_open": ("SELL", "O", ""),
        "buy_to_close": ("BUY", "C", ""),
        "buy_to_open": ("BUY", "O", ""),
        "sell_to_close": ("SELL", "C", ""),
        "assignment": ("BUY", "C", "A"),
        "expiration": ("BUY", "C", "Ep"),
    }[kind]
    signed = -contracts if buy_sell == "SELL" else contracts
    return (
        f'<Trade assetCategory="OPT" levelOfDetail="EXECUTION" tradeID="{ref}" underlyingSymbol="{symbol}" '
        f'putCall="{right}" strike="{strike:g}" expiry="{expiry}" tradeDate="{on}" quantity="{signed}" '
        f'tradePrice="{price}" multiplier="100" ibCommission="-0.65" buySell="{buy_sell}" '
        f'openCloseIndicator="{open_close}" notes="{notes}"/>'
    )


def statement(account: str, to_date: str, lots: list[str], trades: list[str] | None = None) -> str:
    body = f"<OpenPositions>{''.join(lots)}</OpenPositions>"
    if trades is not None:
        body += f"<Trades>{''.join(trades)}</Trades>"
    return f'<FlexStatement accountId="{account}" fromDate="20251024" toDate="{to_date}">{body}</FlexStatement>'


def response(*statements: str) -> str:
    return (
        '<FlexQueryResponse queryName="desk-holdings" type="AF">'
        f'<FlexStatements count="{len(statements)}">{"".join(statements)}</FlexStatements></FlexQueryResponse>'
    )


class Frozen(datetime):
    """`datetime` whose `now()` is `moment`; a test patches an API module's `datetime` with a subclass of this."""

    moment = NOW

    @classmethod
    def now(cls, tz=None):
        return cls.moment.astimezone(tz or UTC)


def frozen(moment: datetime) -> type[Frozen]:
    return type("Frozen", (Frozen,), {"moment": moment})


class FakeQuotes:
    """A `quotes` source over canned prices; a symbol it has no price for is simply not answered. `raises` makes every
    call fail, as a rejected key does."""

    def __init__(self, prices: dict[str, float] | None = None, *, raises: Exception | None = None) -> None:
        self.prices = prices or {}
        self.raises = raises
        self.calls: list[list[str]] = []

    def latest(self, symbols, *, now):
        self.calls.append(list(symbols))
        if self.raises is not None:
            raise self.raises
        return [
            Quote(s, self.prices[s], pd.Timestamp(now).floor("min") - pd.Timedelta(minutes=15), "fake", "delayed-15m")
            for s in symbols
            if s in self.prices
        ]


def user(db: Session, email: str = "owner@example.com", settings: dict | None = None) -> User:
    from sqlalchemy import select

    row = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if row is None:
        row = User(email=email, settings=settings or {})
        db.add(row)
        db.flush()
    elif settings is not None:
        row.settings = settings
    return row


def import_xml(db: Session, user_id: int, xml: str, *, now: datetime = NOW) -> None:
    importer.store(db, user_id, parse_statements(xml), now=now)
    db.commit()


def data_sources(**kinds) -> DataSources:
    """A `DataSources` whose every kind is a bare sentinel (a test that reaches one fails loudly) but the ones given."""
    unused = object()
    names = (
        "bars fundamentals earnings_announcements macro news earnings_calendar consensus earnings targets universe "
        "quotes trades"
    ).split()
    return DataSources(**{name: kinds.pop(name, unused) for name in names}, **kinds)
