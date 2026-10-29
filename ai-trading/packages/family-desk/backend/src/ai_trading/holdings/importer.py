"""The holdings import (02n §d `holdings/importer.py`): fetch one Flex statement and store it, idempotent per (account,
statement date). The import belongs to one Desk user, named by `DESK_FLEX_USER` (an email, set only in Firestore
`ai-trading/desk`); nobody else can claim it (02n §c1). Logs and `holding_imports.detail` carry counts and states, never
a value, a token or an account number.

`ImportRuntime` is the in-process half of the state a screen shows: whether an import is running, when the last one
started (Flex allows ten requests a minute, so a second start inside 60 s is refused) and whether the last one failed.
A statement that was read is stored with its own `state`; a failure before any statement exists has no row to live in.
"""

import logging
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.db.engine import session_scope
from ai_trading.db.models import Account, HoldingImport, HoldingLot, HoldingTrade, User
from ai_trading.fundamental.sources import FLEX_QUERY_VAR, FLEX_TOKEN_VAR
from ai_trading.holdings.flex import FlexError, FlexStatement, fetch_statement, parse_statements

log = logging.getLogger(__name__)

FLEX_USER_VAR = "DESK_FLEX_USER"
COOLDOWN = timedelta(seconds=60)


def flex_user_email(env: Mapping[str, str]) -> str | None:
    return (env.get(FLEX_USER_VAR) or "").strip().lower() or None


class ImportRuntime:
    """Whether an import is running or just failed. In process memory (a single API process): a restart forgets a
    failure and the screens fall back to the last stored import; a second process would not see the first's run."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.started_at: datetime | None = None
        self.running = False
        self.failed_at: datetime | None = None

    def begin(self, now: datetime) -> bool:
        """False when one is running or one started in the last 60 seconds."""
        with self._lock:
            if self.running or (self.started_at is not None and now - self.started_at < COOLDOWN):
                return False
            self.running, self.started_at = True, now
            return True

    def end(self, ok: bool, now: datetime) -> None:
        with self._lock:
            self.running = False
            self.failed_at = None if ok else now


RUNTIME = ImportRuntime()


@dataclass(frozen=True)
class ImportResult:
    accounts: int
    lots: int
    trades: int


def _user_id(session: Session, email: str) -> int:
    """The Desk user of `email`, created like `api.auth` does on a first sign-in (only the family ever exists)."""
    user = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is None:
        user = User(email=email, settings={})
        session.add(user)
        session.flush()
    return user.id


def _account(session: Session, user_id: int, external_id: str, now: datetime) -> Account:
    """The account of this broker id, made on first sight with the label "Account N" (the owner renames it)."""
    account = session.execute(
        select(Account).where(Account.broker == "ibkr", Account.external_id == external_id)
    ).scalar_one_or_none()
    if account is not None:
        if account.owner_user_id != user_id:
            raise FlexError("an account in the statement belongs to another Desk user")
        return account
    owned = len(session.execute(select(Account.id).where(Account.owner_user_id == user_id)).all())
    account = Account(
        owner_user_id=user_id, broker="ibkr", external_id=external_id, label=f"Account {owned + 1}", created_at=now
    )
    session.add(account)
    session.flush()
    return account


def _store_one(session: Session, account: Account, statement: FlexStatement, now: datetime) -> int:
    """Replace the account's import of this statement date; returns the trades that were new."""
    stock = sum(lot.asset_class == "STK" for lot in statement.lots)
    detail = (
        f"{stock} stock lots, {len(statement.lots) - stock} option lots, {len(statement.trades)} trades, "
        f"{statement.skipped} rows skipped"
    )
    row = session.execute(
        select(HoldingImport).where(
            HoldingImport.account_id == account.id, HoldingImport.statement_date == statement.statement_date
        )
    ).scalar_one_or_none()
    if row is None:
        row = HoldingImport(account_id=account.id, statement_date=statement.statement_date)
        session.add(row)
    else:
        session.execute(delete(HoldingLot).where(HoldingLot.import_id == row.id))
    row.imported_at, row.lots, row.state, row.detail = now, len(statement.lots), "ok", detail
    session.flush()
    session.add_all(
        HoldingLot(
            import_id=row.id,
            account_id=account.id,
            symbol=lot.symbol,
            asset_class=lot.asset_class,
            quantity=lot.quantity,
            cost_per_share=lot.cost_per_share,
            acquired=lot.acquired,
            option_right=lot.option_right,
            strike=lot.strike,
            expiry=lot.expiry,
            multiplier=lot.multiplier,
        )
        for lot in statement.lots
    )
    if not statement.trades:
        return 0
    inserted = session.execute(
        pg_insert(HoldingTrade)
        .values(
            [
                {
                    "account_id": account.id,
                    "external_ref": trade.external_ref,
                    "symbol": trade.symbol,
                    "option_right": trade.option_right,
                    "strike": trade.strike,
                    "expiry": trade.expiry,
                    "kind": trade.kind,
                    "trade_date": trade.trade_date,
                    "quantity": trade.quantity,
                    "price": trade.price,
                    "multiplier": trade.multiplier,
                    "commission": trade.commission,
                }
                for trade in statement.trades
            ]
        )
        .on_conflict_do_nothing(index_elements=["account_id", "external_ref"])
        .returning(HoldingTrade.id)
    )
    return len(inserted.all())


def store(session: Session, user_id: int, statements: list[FlexStatement], *, now: datetime) -> ImportResult:
    """Store every statement for `user_id`. Re-running the same statement date replaces that import's lots and adds only
    the trades it has not stored yet. The caller commits."""
    trades = 0
    for statement in statements:
        trades += _store_one(session, _account(session, user_id, statement.account_id, now), statement, now)
    return ImportResult(len(statements), sum(len(s.lots) for s in statements), trades)


def run_import(
    session_factory: sessionmaker[Session],
    env: Mapping[str, str],
    *,
    runtime: ImportRuntime = RUNTIME,
    fetch: Callable[[str, str], str] | None = None,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> None:
    """Fetch the Flex statement and store it for the Flex user; runs in a background task after `POST /holdings/import`
    answered 202. Every failure ends in `runtime.end(False)` and a log line with the reason class only."""
    ok = False
    try:
        email = flex_user_email(env)
        if email is None:
            raise FlexError(f"{FLEX_USER_VAR} is not set")
        statements = parse_statements((fetch or fetch_statement)(env[FLEX_TOKEN_VAR], env[FLEX_QUERY_VAR]))
        with session_scope(session_factory) as session:
            result = store(session, _user_id(session, email), statements, now=clock())
        log.info("holdings import: %d accounts, %d lots, %d new trades", result.accounts, result.lots, result.trades)
        ok = True
    except FlexError as error:
        log.warning("holdings import failed: %s", error)
    except Exception as error:  # a database or mapping fault: the class only, a message could carry a value
        log.error("holdings import failed: %s", type(error).__name__)
    finally:
        runtime.end(ok, clock())
