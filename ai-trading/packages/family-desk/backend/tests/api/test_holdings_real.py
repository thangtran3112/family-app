"""The real holdings routes (02n §c3 #2 to #5, §j): rows priced from the stored closes, totals, the account filter, the
lots pane, the account patch, the import start with its 202, 404 and 409, and the privacy rules of §c1 (a user sees only
their own accounts; the broker account number is in no response). Needs Postgres; no network."""

import dataclasses
import json
from datetime import date

import pytest
from ai_trading_common.testing import FakeOptionChain
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from fakes import fake_data_sources
from fundamental_world import (
    ACCOUNT_A,
    ACCOUNT_B,
    AFTER_CLOSE,
    FakeQuotes,
    frozen,
    import_xml,
    option_lot,
    response,
    statement,
    stock_lot,
    user,
)
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.api.holdings import get_session_factory
from ai_trading.db.models import Account, Bar1d, EarningsResult
from ai_trading.fundamental_stub import STUB_FLAG
from ai_trading.holdings import importer

PREFIX = "/api/desk"
XML = response(
    statement(
        ACCOUNT_A,
        "20261023",
        [
            stock_lot("AAPL", 600, 150.0, "20240312"),
            stock_lot("AAPL", 400, 180.5, "20260105"),
            option_lot("AAPL", -2, 215, "20261120"),
        ],
    ),
    statement(ACCOUNT_B, "20261023", [stock_lot("MSFT", 250, 300.0, "20250601")]),
)


@pytest.fixture
def world(client, db_session, db_engine, monkeypatch):
    """The owner holds AAPL (taxable) and MSFT (ira); closes for Thursday and Friday; the stub flag is off."""
    monkeypatch.delenv(STUB_FLAG, raising=False)
    for name in ("IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID", "DESK_FLEX_USER"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr("ai_trading.api.holdings.datetime", frozen(AFTER_CLOSE))
    importer.RUNTIME.__init__()
    quotes = FakeQuotes({"AAPL": 205.0, "MSFT": 410.0})
    sources = dataclasses.replace(fake_data_sources(), quotes=quotes, option_chain=FakeOptionChain())
    app.dependency_overrides[get_data_sources] = lambda: sources
    app.dependency_overrides[get_session_factory] = lambda: sessionmaker(db_engine, expire_on_commit=False)
    owner = user(db_session, OWNER_EMAIL)
    user(db_session, OTHER_EMAIL)
    for symbol, thursday, friday in (("AAPL", 200.0, 205.0), ("MSFT", 400.0, 410.0)):
        for day, close in ((date(2026, 10, 22), thursday), (date(2026, 10, 23), friday)):
            db_session.add(
                Bar1d(symbol=symbol, day=day, open=close, high=close, low=close, close=close, volume=1, source="alpaca")
            )
    import_xml(db_session, owner.id, XML, now=AFTER_CLOSE)
    return client


def get(client, url, email=OWNER_EMAIL):
    return client.get(f"{PREFIX}{url}", headers=auth_headers(email))


def test_rows_are_priced_from_the_stored_closes_with_the_engines_cover(world):
    body = get(world, "/holdings").json()
    aapl, msft = body["rows"]  # largest first
    assert (aapl["symbol"], aapl["shares"], aapl["avg_cost"], aapl["last"], aapl["change_pct"]) == (
        "AAPL",
        1000,
        162.2,
        205.0,
        2.5,
    )
    assert (aapl["market_value"], aapl["weight_pct"], aapl["unrealized_pct"]) == (205000.0, 66.7, 26.4)
    assert (aapl["coverable_contracts"], aapl["open_calls"]) == (3, 2)  # 50% of 1000 shares is 5 contracts, 2 are open
    assert (msft["coverable_contracts"], msft["open_calls"], msft["weight_pct"]) == (1, 0, 33.3)
    assert aapl["stamp"] == {
        "as_of": "2026-10-23T20:00:00Z",
        "source": "alpaca",
        "quality": "eod",
        "freshness": "closed",
    }
    assert aapl["fundamentals"]["cc_coverable"] == 3 and aapl["fundamentals"]["weight_pct"] == 66.7
    assert aapl["fundamentals"]["fwd_pe"] is None  # no metric job has run: unknown is never invented


def test_totals_sum_the_whole_portfolio(world):
    assert get(world, "/holdings").json()["totals"] == {
        "market_value": 307500.0,
        "cost": 237200.0,
        "unrealized": 70300.0,
        "unrealized_pct": 29.6,
        "day_change": 7500.0,
        "day_change_pct": 2.5,
    }


def test_the_option_lots_list_the_short_call_with_negative_contracts(world):
    (lot,) = get(world, "/holdings").json()["option_lots"]
    assert (lot["symbol"], lot["right"], lot["strike"], lot["expiry"], lot["contracts"]) == (
        "AAPL",
        "C",
        215,
        "2026-11-20",
        -2,
    )


def test_import_state_reads_the_stored_statement(world):
    state = get(world, "/holdings").json()["import"]
    assert (state["state"], state["statement_date"], state["lots"], state["source"]) == (
        "ok",
        "2026-10-23",
        4,
        "ibkr_flex",
    )
    assert state["imported_at"] == "2026-10-24T14:00:00Z"


def test_a_symbol_with_no_price_has_null_value_and_null_totals_never_a_partial_sum(world, db_session):
    db_session.execute(Bar1d.__table__.delete().where(Bar1d.symbol == "MSFT"))
    db_session.commit()  # MSFT has no stored close and the fake quote source does not know it either
    app.dependency_overrides[get_data_sources] = lambda: dataclasses.replace(
        fake_data_sources(), quotes=FakeQuotes({"AAPL": 205.0}), option_chain=FakeOptionChain()
    )
    body = get(world, "/holdings").json()
    msft = next(row for row in body["rows"] if row["symbol"] == "MSFT")
    assert (msft["last"], msft["market_value"], msft["weight_pct"], msft["stamp"]["freshness"]) == (
        None,
        None,
        None,
        "unavailable",
    )
    assert all(value is None for key, value in body["totals"].items())
    assert body["rows"][-1]["symbol"] == "MSFT"  # an unpriced row sorts last


def test_a_symbol_with_no_stored_close_falls_back_to_the_delayed_quote(world, db_session):
    db_session.execute(Bar1d.__table__.delete().where(Bar1d.symbol == "MSFT"))
    db_session.commit()
    msft = next(row for row in get(world, "/holdings").json()["rows"] if row["symbol"] == "MSFT")
    assert (msft["last"], msft["change_pct"], msft["stamp"]["quality"], msft["stamp"]["source"]) == (
        410.0,
        None,
        "delayed-15m",
        "fake",
    )


def test_the_account_filter_keeps_that_account_and_404s_anothers(world, db_session):
    accounts = {a.external_id: a.id for a in db_session.execute(select(Account)).scalars()}
    rows = get(world, f"/holdings?account_id={accounts[ACCOUNT_B]}").json()["rows"]
    assert [(r["symbol"], r["weight_pct"]) for r in rows] == [("MSFT", 100.0)]
    assert get(world, "/holdings?account_id=99999").status_code == 404
    assert get(world, f"/holdings?account_id={accounts[ACCOUNT_A]}", OTHER_EMAIL).status_code == 404


def test_another_user_sees_nothing_of_the_owners_holdings(world):
    body = get(world, "/holdings", OTHER_EMAIL).json()
    assert body["rows"] == [] and body["accounts"] == [] and body["option_lots"] == []
    assert body["import"]["state"] in {"none", "not_configured"} and body["import"]["lots"] == 0
    assert get(world, "/holdings/AAPL/lots", OTHER_EMAIL).status_code == 404
    assert get(world, "/covered-calls/coverage", OTHER_EMAIL).json()["rows"] == []


def test_the_lots_pane_gives_term_gain_and_the_symbols_short_calls(world):
    body = get(world, "/holdings/aapl/lots").json()  # the symbol is case-insensitive
    assert [(lot["acquired"], lot["term"], lot["gain_pct"]) for lot in body["lots"]] == [
        ("2024-03-12", "long", 36.7),
        ("2026-01-05", "short", 13.6),
    ]
    (call,) = body["short_calls"]
    assert (call["symbol"], call["strike"], call["contracts"], call["delta"]) == ("AAPL", 215, 2, None)  # no chain
    assert get(world, "/holdings/MSFT/lots").json()["short_calls"] == []
    assert get(world, "/holdings/KO/lots").status_code == 404


def test_the_broker_account_number_is_in_no_fundamental_response(world):
    for url in (
        "/holdings",
        "/holdings/AAPL/lots",
        "/covered-calls/coverage",
        "/covered-calls/short-calls",
        "/covered-calls/candidates?symbol=AAPL",
        "/covered-calls/income",
        "/status",
    ):
        text = get(world, url).text
        assert ACCOUNT_A not in text and ACCOUNT_B not in text and "external_id" not in text, url


def test_an_account_is_renamed_and_retyped_by_its_owner_only(world, db_session):
    account_id = db_session.execute(select(Account.id).where(Account.external_id == ACCOUNT_B)).scalar_one()
    patch = lambda body, email=OWNER_EMAIL: world.patch(  # noqa: E731
        f"{PREFIX}/accounts/{account_id}", json=body, headers=auth_headers(email)
    )
    assert patch({"label": "IRA", "type": "ira"}).json() == {"id": account_id, "label": "IRA", "type": "ira"}
    assert patch({"type": "roth"}).json() == {"id": account_id, "label": "IRA", "type": "roth"}  # the rest stays
    assert [a["type"] for a in get(world, "/holdings").json()["accounts"]] == ["taxable", "roth"]
    assert patch({"label": "Mine"}, OTHER_EMAIL).status_code == 404
    assert patch({}).status_code == 422
    assert patch({"type": "joint"}).status_code == 422
    assert world.patch(f"{PREFIX}/accounts/99999", json={"label": "x"}, headers=auth_headers()).status_code == 404


def test_the_cover_cap_setting_changes_what_is_coverable(world, db_session):
    user(db_session, OWNER_EMAIL, {"covered_calls": {"cap_pct": 100}})
    db_session.commit()
    aapl = get(world, "/holdings").json()["rows"][0]
    assert aapl["coverable_contracts"] == 8  # 100% of 1000 shares is 10 contracts, 2 are open


# -- POST /holdings/import --------------------------------------------------------------------------------------------


@pytest.fixture
def flex(monkeypatch):
    monkeypatch.setenv("IBKR_FLEX_TOKEN", "tok-sentinel")
    monkeypatch.setenv("IBKR_FLEX_QUERY_ID", "123")
    monkeypatch.setenv("DESK_FLEX_USER", OWNER_EMAIL)
    monkeypatch.setattr(importer, "fetch_statement", lambda token, query: XML.replace("20261023", "20261026"))


def start(client, email=OWNER_EMAIL):
    return client.post(f"{PREFIX}/holdings/import", headers=auth_headers(email))


def test_the_import_answers_202_running_then_the_statement_is_stored(world, flex):
    response_ = start(world)
    assert response_.status_code == 202
    assert response_.json()["import"]["state"] == "running"
    assert "tok-sentinel" not in response_.text
    state = get(world, "/holdings").json()["import"]  # the background task has finished
    assert (state["state"], state["statement_date"]) == ("ok", "2026-10-26")


def test_a_second_import_inside_a_minute_is_409(world, flex):
    assert start(world).status_code == 202
    assert start(world).status_code == 409


def test_a_failed_import_reads_failed_beside_the_last_good_statement(world, flex, monkeypatch):
    def fail(token, query):
        raise importer.FlexError("SendRequest refused: code 1012")

    monkeypatch.setattr(importer, "fetch_statement", fail)
    assert start(world).status_code == 202
    state = get(world, "/holdings").json()["import"]
    assert (state["state"], state["statement_date"]) == ("failed", "2026-10-23")  # the old statement still stands


def test_only_the_flex_user_may_start_the_import(world, flex):
    assert start(world, OTHER_EMAIL).status_code == 404


def test_an_import_that_is_not_set_up_is_503_and_the_state_says_so(world):
    assert start(world).status_code == 503
    other = get(world, "/holdings", OTHER_EMAIL).json()["import"]
    assert other["state"] == "not_configured"


def test_the_routes_are_not_503_with_the_stub_off(world):
    for url in ("/holdings", "/holdings/AAPL/lots", "/covered-calls/coverage", "/covered-calls/short-calls"):
        assert get(world, url).status_code == 200, url


def test_earnings_dates_reach_the_row_from_the_store(world, db_session):
    db_session.add(
        EarningsResult(
            symbol="AAPL",
            period_end=date(2026, 9, 30),
            report_date=date(2026, 10, 29),
            provider="fake",
            quality="eod",
            as_of=AFTER_CLOSE,
            captured_at=AFTER_CLOSE,
        )
    )
    db_session.commit()
    aapl = get(world, "/holdings").json()["rows"][0]
    assert aapl["next_earnings"] == "2026-10-29" and aapl["fundamentals"]["next_earnings"] == "2026-10-29"


def test_the_response_is_valid_json_with_finite_numbers(world):
    json.loads(get(world, "/holdings").text, parse_constant=lambda c: pytest.fail(f"non-finite {c}"))
