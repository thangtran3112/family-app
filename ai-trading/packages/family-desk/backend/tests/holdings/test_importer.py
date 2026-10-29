"""The importer (02n §j): accounts made on first sight and never taken from another user, idempotent per statement
date, trades stored once, and the runtime state a failed or running import leaves. Needs Postgres."""

from datetime import timedelta

import pytest
from fundamental_world import (
    ACCOUNT_A,
    ACCOUNT_B,
    NOW,
    option_lot,
    response,
    statement,
    stock_lot,
    trade,
    user,
)
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from ai_trading.db.models import Account, HoldingImport, HoldingLot, HoldingTrade, User
from ai_trading.fundamental.sources import FLEX_QUERY_VAR, FLEX_TOKEN_VAR
from ai_trading.holdings import importer
from ai_trading.holdings.flex import FlexError, parse_statements


def xml(date: str = "20261023", *, extra_trades: list[str] | None = None) -> str:
    return response(
        statement(
            ACCOUNT_A,
            date,
            [
                stock_lot("AAPL", 600, 150.0, "20240312"),
                stock_lot("AAPL", 400, 180.5, "20260105"),
                option_lot("AAPL", -2, 215, "20261120"),
            ],
            [trade("T1", "AAPL", "sell_to_open", "20261001", 2, 1.4), *(extra_trades or [])],
        ),
        statement(ACCOUNT_B, date, [stock_lot("MSFT", 250, 300.0, "20250601")]),
    )


def count(db, model) -> int:
    return db.execute(select(func.count()).select_from(model)).scalar_one()


def test_a_first_import_makes_labelled_accounts_and_stores_lots_and_trades(db_session):
    owner = user(db_session)
    result = importer.store(db_session, owner.id, parse_statements(xml()), now=NOW)
    db_session.commit()
    assert (result.accounts, result.lots, result.trades) == (2, 4, 1)
    accounts = db_session.execute(select(Account).order_by(Account.id)).scalars().all()
    assert [(a.label, a.type, a.broker, a.owner_user_id) for a in accounts] == [
        ("Account 1", "taxable", "ibkr", owner.id),
        ("Account 2", "taxable", "ibkr", owner.id),
    ]
    assert {a.external_id for a in accounts} == {ACCOUNT_A, ACCOUNT_B}
    imports = db_session.execute(select(HoldingImport).order_by(HoldingImport.account_id)).scalars().all()
    assert [(i.lots, i.state) for i in imports] == [(3, "ok"), (1, "ok")]
    assert imports[0].detail == "2 stock lots, 1 option lots, 1 trades, 0 rows skipped"


def test_the_same_statement_date_twice_replaces_lots_and_never_double_counts(db_session):
    owner = user(db_session)
    importer.store(db_session, owner.id, parse_statements(xml()), now=NOW)
    db_session.commit()
    later = NOW + timedelta(hours=3)
    again = importer.store(db_session, owner.id, parse_statements(xml()), now=later)
    db_session.commit()
    assert again.trades == 0  # the trade was stored by the first run
    assert (count(db_session, HoldingImport), count(db_session, HoldingLot), count(db_session, HoldingTrade)) == (
        2,
        4,
        1,
    )
    assert count(db_session, Account) == 2
    assert {i.imported_at for i in db_session.execute(select(HoldingImport)).scalars()} == {later}


def test_an_overlapping_trades_window_adds_only_the_trades_it_has_not_stored(db_session):
    owner = user(db_session)
    importer.store(db_session, owner.id, parse_statements(xml()), now=NOW)
    new = [trade("T2", "AAPL", "buy_to_close", "20261015", 1, 0.3)]
    result = importer.store(db_session, owner.id, parse_statements(xml("20261026", extra_trades=new)), now=NOW)
    db_session.commit()
    assert result.trades == 1
    assert count(db_session, HoldingTrade) == 2
    assert count(db_session, HoldingImport) == 4  # a new statement date is a new import beside the old one


def test_an_account_that_belongs_to_another_user_is_refused_not_taken(db_session):
    importer.store(db_session, user(db_session).id, parse_statements(xml()), now=NOW)
    other = user(db_session, "spouse@example.com")
    with pytest.raises(FlexError, match="another Desk user"):
        importer.store(db_session, other.id, parse_statements(xml()), now=NOW)


def test_a_new_account_label_counts_the_owners_own_accounts_only(db_session):
    importer.store(db_session, user(db_session).id, parse_statements(xml()), now=NOW)
    other = user(db_session, "spouse@example.com")
    solo = response(statement("U0000003", "20261023", [stock_lot("KO", 100, 60.0, "20250101")]))
    importer.store(db_session, other.id, parse_statements(solo), now=NOW)
    labels = db_session.execute(select(Account.label).where(Account.owner_user_id == other.id)).scalars().all()
    assert labels == ["Account 1"]


class Env(dict):
    pass


def env(**extra) -> dict[str, str]:
    return {FLEX_TOKEN_VAR: "tok", FLEX_QUERY_VAR: "123", importer.FLEX_USER_VAR: "Owner@Example.com", **extra}


@pytest.fixture
def runtime() -> importer.ImportRuntime:
    return importer.ImportRuntime()


def test_a_run_stores_the_statement_for_the_flex_user_and_clears_the_running_flag(db_session, db_engine, runtime):
    factory = sessionmaker(db_engine, expire_on_commit=False)
    assert runtime.begin(NOW)
    importer.run_import(factory, env(), runtime=runtime, fetch=lambda token, query: xml(), clock=lambda: NOW)
    assert (runtime.running, runtime.failed_at) == (False, None)
    owner = db_session.execute(select(User).where(User.email == "owner@example.com")).scalar_one()  # lower-cased
    assert (
        db_session.execute(
            select(func.count()).select_from(Account).where(Account.owner_user_id == owner.id)
        ).scalar_one()
        == 2
    )


def test_the_fetch_gets_the_token_and_query_from_the_environment_only(db_engine, runtime):
    seen = []
    importer.run_import(
        sessionmaker(db_engine),
        env(),
        runtime=runtime,
        fetch=lambda token, query: seen.append((token, query)) or xml(),
        clock=lambda: NOW,
    )
    assert seen == [("tok", "123")]


@pytest.mark.parametrize(
    "failure",
    [FlexError("SendRequest refused: code 1012"), RuntimeError("boom with a value 123456"), ValueError("<bad>")],
)
def test_a_failure_marks_the_runtime_failed_and_stores_nothing(db_session, db_engine, runtime, caplog, failure):
    def fetch(token, query):
        raise failure

    runtime.begin(NOW)
    importer.run_import(sessionmaker(db_engine), env(), runtime=runtime, fetch=fetch, clock=lambda: NOW)
    assert (runtime.running, runtime.failed_at) == (False, NOW)
    assert count(db_session, Account) == 0
    assert "123456" not in caplog.text and "<bad>" not in caplog.text  # a non-Flex failure logs its class only


def test_with_no_flex_user_named_nothing_is_fetched(db_engine, runtime):
    fetched = []
    environment = env()
    del environment[importer.FLEX_USER_VAR]
    importer.run_import(
        sessionmaker(db_engine),
        environment,
        runtime=runtime,
        fetch=lambda t, q: fetched.append(1) or xml(),
        clock=lambda: NOW,
    )
    assert fetched == [] and runtime.failed_at == NOW


def test_a_second_start_inside_sixty_seconds_is_refused_and_a_later_one_is_not(runtime):
    assert runtime.begin(NOW)
    assert not runtime.begin(NOW + timedelta(seconds=1))  # still running
    runtime.end(True, NOW + timedelta(seconds=5))
    assert not runtime.begin(NOW + timedelta(seconds=59))  # finished, but Flex's rate limit is per minute
    assert runtime.begin(NOW + timedelta(seconds=61))


def test_the_flex_user_email_is_trimmed_and_lower_cased():
    assert importer.flex_user_email({importer.FLEX_USER_VAR: "  Me@Example.COM "}) == "me@example.com"
    assert importer.flex_user_email({}) is None and importer.flex_user_email({importer.FLEX_USER_VAR: " "}) is None
