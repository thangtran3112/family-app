"""The Fundamental-lane tables of Alembic 0012 (02n §d): the database itself refuses what the rules forbid, whoever
writes (a job, the API or a stray script), the cascades remove what belongs to an account, and `downgrade()` is exact
and reversible."""

from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import delete, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.db.models import (
    Account,
    AiCall,
    AiVerdict,
    CoveredCallScan,
    HoldingImport,
    HoldingLot,
    HoldingTrade,
    IvHistory,
    SymbolFundamental,
    User,
)

NEW_0012_TABLES = {
    "accounts",
    "holding_imports",
    "holding_lots",
    "holding_trades",
    "covered_call_scans",
    "iv_history",
    "symbol_fundamentals",
    "ai_verdicts",
    "ai_calls",
}
NOW = datetime(2026, 10, 29, 14, 0, tzinfo=UTC)
DAY = date(2026, 10, 28)
_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


def _alembic_config(url: str) -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def make_account(db: Session, external_id: str = "U0000001", **over) -> Account:
    if not db.scalar(text("SELECT count(*) FROM users")):
        db.add(User(email="fundamental@example.com", settings={}))
        db.flush()
    owner = db.scalar(text("SELECT id FROM users LIMIT 1"))
    account = Account(owner_user_id=owner, external_id=external_id, label="Account 1", created_at=NOW, **over)
    db.add(account)
    db.flush()
    return account


def make_import(db: Session, account: Account, statement_date: date = DAY, **over) -> HoldingImport:
    row = HoldingImport(account_id=account.id, statement_date=statement_date, imported_at=NOW, **over)
    db.add(row)
    db.flush()
    return row


def lot(imp: HoldingImport, **over) -> HoldingLot:
    fields = {
        "import_id": imp.id,
        "account_id": imp.account_id,
        "symbol": "AAPL",
        "asset_class": "STK",
        "quantity": 120.0,
        "cost_per_share": 150.0,
        "acquired": date(2024, 3, 1),
    }
    return HoldingLot(**{**fields, **over})


def verdict(**over) -> AiVerdict:
    fields = {
        "symbol": "AAPL",
        "trading_day": DAY,
        "rating": "buy",
        "target_low": 180.0,
        "target_base": 200.0,
        "target_high": 230.0,
        "confidence": 70,
        "model": "test-model",
        "content_hash": "0" * 64,
        "created_at": NOW,
    }
    return AiVerdict(**{**fields, **over})


def refused(db: Session, row) -> None:
    db.add(row)
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_account_type_is_limited_and_the_broker_account_number_is_unique(db_session: Session) -> None:
    account = make_account(db_session)
    assert (account.broker, account.type) == ("ibkr", "taxable")  # the column defaults
    refused(
        db_session,
        Account(owner_user_id=account.owner_user_id, external_id="U2", label="x", type="margin", created_at=NOW),
    )
    db_session.add(Account(owner_user_id=account.owner_user_id, external_id="U0000001", label="x", created_at=NOW))
    with pytest.raises(IntegrityError):  # the same broker number twice, for anyone
        db_session.flush()
    db_session.rollback()


def test_an_import_is_one_per_account_and_statement_date_with_a_known_state(db_session: Session) -> None:
    account = make_account(db_session)
    first = make_import(db_session, account)
    assert (first.source, first.state, first.lots) == ("ibkr_flex", "ok", 0)
    make_import(db_session, account, date(2026, 10, 27))  # another date is fine
    refused(db_session, HoldingImport(account_id=account.id, statement_date=DAY, imported_at=NOW))
    refused(
        db_session,
        HoldingImport(account_id=account.id, statement_date=date(2026, 10, 1), imported_at=NOW, state="done"),
    )
    refused(
        db_session,
        HoldingImport(account_id=account.id, statement_date=date(2026, 10, 2), imported_at=NOW, source="csv"),
    )
    refused(
        db_session, HoldingImport(account_id=account.id, statement_date=date(2026, 10, 3), imported_at=NOW, lots=-1)
    )


@pytest.mark.parametrize(
    "over",
    [
        {"quantity": 0.0},
        {"multiplier": 0},
        {"asset_class": "FUT"},
        {"option_right": "C"},  # a stock lot carries no option fields
        {"strike": 100.0},
        {"asset_class": "OPT"},  # an option lot needs right, strike and expiry
        {"asset_class": "OPT", "option_right": "X", "strike": 100.0, "expiry": date(2026, 11, 20)},
        {"asset_class": "OPT", "option_right": "C", "strike": 0.0, "expiry": date(2026, 11, 20)},
        {"asset_class": "OPT", "option_right": "C", "strike": 100.0},
    ],
)
def test_the_database_refuses_a_lot_that_breaks_a_rule(db_session: Session, over) -> None:
    imp = make_import(db_session, make_account(db_session))
    refused(db_session, lot(imp, **over))


def test_the_database_accepts_a_stock_lot_and_a_short_call_and_cascades_from_the_import(db_session: Session) -> None:
    account = make_account(db_session)
    imp = make_import(db_session, account)
    db_session.add_all(
        [
            lot(imp),
            lot(
                imp,
                quantity=-1.0,
                cost_per_share=None,
                acquired=None,
                asset_class="OPT",
                option_right="C",
                strike=210.0,
                expiry=date(2026, 11, 20),
                multiplier=100,
            ),
        ]
    )
    db_session.flush()
    assert db_session.scalar(text("SELECT count(*) FROM holding_lots")) == 2
    db_session.execute(delete(HoldingImport).where(HoldingImport.id == imp.id))
    assert db_session.scalar(text("SELECT count(*) FROM holding_lots")) == 0


def trade(account: Account, **over) -> HoldingTrade:
    fields = {
        "account_id": account.id,
        "external_ref": "T-1",
        "symbol": "AAPL",
        "option_right": "C",
        "strike": 210.0,
        "expiry": date(2026, 11, 20),
        "kind": "sell_to_open",
        "trade_date": DAY,
        "quantity": -1.0,
        "price": 2.15,
    }
    return HoldingTrade(**{**fields, **over})


def test_a_trade_is_counted_once_per_account_and_must_be_an_option_trade_of_a_known_kind(db_session: Session) -> None:
    account = make_account(db_session)
    db_session.add(trade(account))
    db_session.flush()
    assert db_session.scalar(text("SELECT multiplier FROM holding_trades")) == 100  # the option default
    refused(db_session, trade(account))  # the same broker reference again, as a later statement would bring it
    for over in (
        {"external_ref": "T-2", "kind": "dividend"},
        {"external_ref": "T-3", "option_right": "S"},
        {"external_ref": "T-4", "strike": 0.0},
    ):
        refused(db_session, trade(account, **over))
    other = make_account(db_session, "U0000002")
    db_session.add(trade(other))  # the same reference in another account is another trade
    db_session.flush()


def test_deleting_an_account_removes_everything_the_import_made(db_session: Session) -> None:
    account = make_account(db_session)
    imp = make_import(db_session, account)
    db_session.add_all([lot(imp), trade(account)])
    db_session.add(CoveredCallScan(account_id=account.id, symbol="AAPL", run_at=NOW, stamp={"quality": "unavailable"}))
    db_session.flush()
    db_session.execute(delete(Account).where(Account.id == account.id))
    for table in ("holding_imports", "holding_lots", "holding_trades", "covered_call_scans"):
        assert db_session.scalar(text(f"SELECT count(*) FROM {table}")) == 0, table


def test_a_scan_keeps_the_chain_stamp_and_refuses_an_iv_rank_outside_0_to_100(db_session: Session) -> None:
    account = make_account(db_session)
    stamp = {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"}
    db_session.add(CoveredCallScan(account_id=account.id, symbol="AAPL", run_at=NOW, stamp=stamp))
    db_session.flush()
    row = db_session.get(CoveredCallScan, (account.id, "AAPL", NOW))
    assert (row.candidates, row.opportunity, row.iv_rank, row.stamp) == ([], False, None, stamp)
    refused(db_session, CoveredCallScan(account_id=account.id, symbol="MSFT", run_at=NOW, stamp=stamp, iv_rank=101.0))
    refused(db_session, CoveredCallScan(account_id=account.id, symbol="MSFT", run_at=NOW, stamp=stamp, iv_rank=-1.0))


def test_iv_history_is_one_point_per_symbol_and_day_with_a_source_and_a_positive_iv(db_session: Session) -> None:
    db_session.add(IvHistory(symbol="AAPL", day=DAY, iv30=0.27, source="alpaca", quality="delayed-15m"))
    db_session.flush()
    refused(db_session, IvHistory(symbol="AAPL", day=DAY, iv30=0.28, source="alpaca", quality="delayed-15m"))
    refused(db_session, IvHistory(symbol="AAPL", day=date(2026, 10, 27), iv30=0.0, source="alpaca", quality="eod"))


def test_symbol_fundamentals_default_to_an_empty_metric_object(db_session: Session) -> None:
    db_session.add(SymbolFundamental(symbol="AAPL", as_of=NOW))
    db_session.flush()
    assert db_session.get(SymbolFundamental, "AAPL").metrics == {}


@pytest.mark.parametrize(
    "over",
    [
        {"target_low": 0.0, "target_base": 0.0, "target_high": 0.0},  # all three must be positive
        {"target_low": 210.0},  # low above base
        {"target_high": 190.0},  # high below base
        {"confidence": 101},
        {"confidence": -1},
    ],
)
def test_the_database_refuses_a_verdict_that_fails_the_checks_of_02f(db_session: Session, over) -> None:
    refused(db_session, verdict(**over))


def test_a_call_needs_its_verdict_and_goes_with_it(db_session: Session) -> None:
    refused(db_session, AiCall(symbol="AAPL", trading_day=DAY, rating="buy", created_at=NOW))  # no verdict yet
    db_session.add(verdict())
    db_session.flush()
    db_session.add(AiCall(symbol="AAPL", trading_day=DAY, rating="buy", prev_rating="hold", created_at=NOW))
    db_session.flush()
    refused(db_session, AiCall(symbol="AAPL", trading_day=DAY, rating="buy", created_at=NOW))  # one call per verdict
    db_session.execute(delete(AiVerdict).where(AiVerdict.symbol == "AAPL"))
    assert db_session.scalar(text("SELECT count(*) FROM ai_calls")) == 0


def _plain_indexes(inspector, table: str) -> dict[str, list[str]]:
    """The `ix_` indexes of a table (the inspector lists unique constraints as unique indexes too)."""
    return {i["name"]: i["column_names"] for i in inspector.get_indexes(table) if i["name"].startswith("ix_")}


def test_the_indexes_of_the_spec_exist(db_engine: Engine) -> None:
    inspector = inspect(db_engine)
    assert _plain_indexes(inspector, "holding_lots") == {
        "ix_holding_lots_import_id": ["import_id"],
        "ix_holding_lots_account_id_symbol": ["account_id", "symbol"],
    }
    assert _plain_indexes(inspector, "holding_trades") == {
        "ix_holding_trades_account_id_trade_date": ["account_id", "trade_date"]
    }
    assert _plain_indexes(inspector, "accounts") == {"ix_accounts_owner_user_id": ["owner_user_id"]}
    assert inspector.get_pk_constraint("covered_call_scans")["constrained_columns"] == [
        "account_id",
        "symbol",
        "run_at",
    ]
    assert inspector.get_pk_constraint("iv_history")["constrained_columns"] == ["symbol", "day"]


def test_downgrade_to_0011_drops_exactly_what_0012_made_and_upgrading_brings_it_back(db_engine: Engine) -> None:
    url = db_engine.url.render_as_string(hide_password=False)
    with db_engine.connect() as conn:
        before = set(inspect(conn).get_table_names())
    try:
        # Head is 0013 (the market-data routing table); step past it first so this test stays about 0012's
        # own nine tables.
        command.downgrade(_alembic_config(url), "0012")
        command.downgrade(_alembic_config(url), "0011")
        tables = set(inspect(db_engine).get_table_names())
        # its nine tables, plus 0013's routing table which this test stepped past first
        assert before - tables == NEW_0012_TABLES | {"market_data_routing"} and tables <= before
        with db_engine.connect() as conn:
            left = conn.execute(
                text(
                    "SELECT relname FROM pg_class WHERE relname ~ "
                    "'^(accounts|holding_|covered_call_scans|iv_history|symbol_fundamentals|ai_verdicts|ai_calls)'"
                )
            ).all()
        assert left == []  # no table, index or sequence of 0012 survives
        command.upgrade(_alembic_config(url), "head")
        assert set(inspect(db_engine).get_table_names()) == before
    finally:
        # Every other test in this package expects `db_engine` at head.
        command.upgrade(_alembic_config(url), "head")
