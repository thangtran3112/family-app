"""The covered-call service on a golden fixture (02n §j): the engine's numbers through `FakeOptionChain`, no live
Alpaca call anywhere. Spot 200.00 on Friday 2026-10-23 at 15:30 ET; one taxable and one IRA account hold AAPL. Every
expected value below is worked by hand from `core/covered_calls.py`'s own formulas (premium_yield = bid / spot,
annualized = premium_yield x 365 / DTE, score, top three, opportunity), not read back from the code under test."""

from datetime import date, timedelta

import pandas as pd
import pytest
from ai_trading_common.errors import NotConfigured, Unavailable
from ai_trading_common.testing import FakeOptionChain
from ai_trading_common.types import OptionContract
from fundamental_world import (
    ACCOUNT_A,
    ACCOUNT_B,
    NOW,
    FakeQuotes,
    data_sources,
    import_xml,
    option_lot,
    response,
    statement,
    stock_lot,
    trade,
    user,
)
from sqlalchemy import select

from ai_trading.covered_calls import service
from ai_trading.db.models import Account, EarningsResult, IvHistory
from ai_trading.fundamental.sources import ALPACA_KEY_VARS

SPOT = 200.0
QUOTED = pd.Timestamp("2026-10-23T19:15:00Z")


def call(strike, expiry, bid, ask, delta, oi=500, iv=0.3) -> OptionContract:
    return OptionContract(
        "AAPL", f"AAPL{expiry:%y%m%d}C{int(strike * 1000):08d}", "C", expiry, strike, 0, bid, ask, delta, iv, oi,
        QUOTED, "alpaca_options", "delayed-15m",
    )  # fmt: skip


NOV06, NOV20, DEC04, OCT30 = date(2026, 11, 6), date(2026, 11, 20), date(2026, 12, 4), date(2026, 10, 30)
CHAIN = [
    call(215, NOV20, 2.85, 3.00, 0.28, 900),  # DTE 28: premium 1.425%, 18.58% a year: the best
    call(220, NOV20, 1.60, 1.70, 0.18, 500),  # 10.43% a year
    call(210, NOV20, 4.80, 5.00, 0.40, 700),  # delta above 0.30: out
    call(225, NOV20, 0.90, 1.00, 0.10, 700),  # delta below 0.15: out
    call(217.5, NOV20, 2.20, 2.60, 0.24, 400),  # spread 16.7% of mid: out
    call(225, DEC04, 2.50, 2.70, 0.22, 300),  # DTE 42: premium 1.25%, 10.86% a year
    call(215, DEC04, 3.90, 4.10, 0.29, 50),  # open interest 50: out
    call(230, DEC04, 1.40, 1.50, 0.16, 250),  # 6.08% a year: passes, but is the fourth
    call(200, NOV06, 2.90, 3.10, 0.52, 800),  # the open short call's own contract (DTE 14)
    call(205, NOV20, 4.20, 4.40, 0.45, 600),  # roll targets, bid vs the 3.10 buyback
    call(210, DEC04, 4.00, 4.20, 0.40, 600),
    call(201, OCT30, 1.90, 2.10, 0.55, 100),  # the second open call (DTE 7)
]


def book(*, trades=None) -> str:
    return response(
        statement(
            ACCOUNT_A,
            "20261023",
            [
                stock_lot("AAPL", 600, 150.0, "20240312"),
                stock_lot("AAPL", 400, 180.5, "20260105"),  # opened within a year: short term
                option_lot("AAPL", -2, 200, "20261106"),
                option_lot("AAPL", -1, 201, "20261030"),
                stock_lot("KO", 150, 60.0, "20250101"),  # under one contract at a 50% cap
            ],
            trades,
        ),
        statement(
            ACCOUNT_B,
            "20261023",
            [
                stock_lot("AAPL", 400, 140.0, "20250201"),
                stock_lot("MSFT", 200, 300.0, "20250601"),
                option_lot("MSFT", -1, 330, "20261120"),  # the one contract the cap allows is already open
            ],
        ),
    )


@pytest.fixture
def world(db_session):
    owner = user(db_session)
    import_xml(db_session, owner.id, book())
    ids = {a.external_id: a.id for a in db_session.execute(select(Account)).scalars()}
    values = [0.20 + 0.001 * i for i in range(60)]
    values[30], values[-1] = 0.30, 0.28  # the year's range is 0.20 to 0.30, today 0.28: IV rank 80
    for i, iv in enumerate(values):
        day = date(2026, 8, 24) + timedelta(days=i)
        db_session.add(IvHistory(symbol="AAPL", day=day, iv30=iv, source="fake", quality="delayed-15m"))
    db_session.get(Account, ids[ACCOUNT_B]).type = "ira"  # accounts are taxable until the owner says otherwise
    db_session.commit()
    return owner.id, ids[ACCOUNT_A], ids[ACCOUNT_B]


def report_on(db, day: date) -> None:
    """The earnings store holds one not-yet-reported period of AAPL, due on `day`."""
    db.query(EarningsResult).delete()
    db.add(
        EarningsResult(
            symbol="AAPL", period_end=date(2026, 9, 30), report_date=day, provider="fake", quality="eod",
            as_of=NOW, captured_at=NOW,
        )
    )  # fmt: skip
    db.commit()


def sources(chain=None, quotes=None):
    return data_sources(
        quotes=quotes or FakeQuotes({"AAPL": SPOT, "MSFT": 310.0, "KO": 62.0}),
        option_chain=chain or FakeOptionChain({"AAPL": CHAIN}),
    )


def top(db, owner, account, chain=None, **kw):
    return service.candidates(db, owner, sources(chain, kw.get("quotes")), "AAPL", account, NOW)


def test_the_ira_top_three_are_the_engines_numbers_best_first(db_session, world):
    owner, _, ira = world
    body = top(db_session, owner, ira)
    assert (body["symbol"], body["account_id"], body["spot"]) == ("AAPL", ira, SPOT)
    assert (body["iv_rank"], body["iv_history_sessions"]) == (80.0, 60)
    rows = body["candidates"]
    # DTE 28, 42, 28 -> annualized = premium_yield x 365 / DTE, premium_yield = bid / spot
    assert [(c["expiry"], c["strike"]) for c in rows] == [(NOV20, 215), (DEC04, 225), (NOV20, 220)]
    first, second, third = rows
    assert first["premium_yield"] == pytest.approx(2.85 / SPOT) == pytest.approx(0.01425)
    assert first["annualized_yield"] == pytest.approx(0.01425 * 365 / 28) == pytest.approx(0.185759, abs=1e-6)
    assert (first["dte"], first["bid"], first["ask"], first["delta"], first["open_interest"]) == (
        28,
        2.85,
        3.0,
        0.28,
        900,
    )
    assert first["upside_cap"] == pytest.approx(0.075) and first["return_if_called"] == pytest.approx(0.08925)
    assert first["spread_pct"] == pytest.approx(0.15 / 2.925 * 100, abs=1e-5) and first["flags"] == []
    assert second["annualized_yield"] == pytest.approx(0.0125 * 365 / 42, abs=1e-6)
    assert third["annualized_yield"] == pytest.approx(0.008 * 365 / 28, abs=1e-6)
    # score = 100 x min(annualized, 0.40) + 0.1 x IV rank - 5 (spread above 5%) - 5 (delta above 0.25)
    assert first["score"] == pytest.approx(100 * 0.185759 + 8 - 10, abs=1e-3)
    assert second["score"] == pytest.approx(100 * 0.108631 + 8 - 5, abs=1e-3)
    assert third["score"] == pytest.approx(100 * 0.104286 + 8 - 5, abs=1e-3)
    assert [c["score"] for c in rows] == sorted((c["score"] for c in rows), reverse=True)


def test_the_filters_drop_what_the_engine_drops_and_the_fourth_never_shows(db_session, world):
    owner, _, ira = world
    shown = {(c["expiry"], c["strike"]) for c in top(db_session, owner, ira)["candidates"]}
    for out in ((NOV20, 210), (NOV20, 225), (NOV20, 217.5), (DEC04, 215), (OCT30, 201), (DEC04, 230)):
        assert out not in shown  # delta, delta, spread, open interest, outside DTE 21-45, fourth place


def test_the_opportunity_needs_a_clean_top_pick_the_ira_has_it_the_taxable_account_does_not(db_session, world):
    owner, taxable, ira = world
    assert top(db_session, owner, ira)["opportunity"] is True  # 18.6% a year, IV rank 80, no flags
    body = top(db_session, owner, taxable)
    assert body["opportunity"] is False
    assert body["candidates"][0]["flags"] == ["short_term_lots", "cover_tax_advantaged_first"]


def test_the_chain_is_asked_for_calls_in_the_users_dte_window_above_the_spot(db_session, world):
    owner, _, ira = world
    chain = FakeOptionChain({"AAPL": CHAIN})
    top(db_session, owner, ira, chain)
    (symbol, now, right, min_dte, max_dte, min_strike, max_strike) = chain.calls[0]
    assert (symbol, right, min_dte, max_dte, min_strike, max_strike) == ("AAPL", "C", 21, 45, SPOT, SPOT * 1.6)
    assert now == pd.Timestamp(NOW)


def test_the_users_scan_settings_move_the_window_and_the_cap(db_session, world):
    owner, _, ira = world
    user(db_session, settings={"covered_calls": {"min_dte": 10, "max_dte": 30, "cap_pct": 100}})
    db_session.commit()
    chain = FakeOptionChain({"AAPL": CHAIN})
    body = top(db_session, owner, ira, chain)
    assert chain.calls[0][3:5] == (10, 30)
    assert {c["expiry"] for c in body["candidates"]} == {NOV20}  # December is past the 30-day window


def test_the_stamps_say_where_the_numbers_came_from_and_how_old(db_session, world):
    owner, _, ira = world
    body = top(db_session, owner, ira)
    assert body["spot_stamp"]["source"] == "fake" and body["spot_stamp"]["quality"] == "delayed-15m"
    assert body["chain_stamp"]["source"] == "alpaca_options" and body["chain_stamp"]["quality"] == "delayed-15m"
    assert body["chain_stamp"]["as_of"] == QUOTED.to_pydatetime()


def test_a_rejected_key_gives_the_unavailable_stamp_and_no_candidates_not_a_fake(db_session, world):
    """The Alpaca key is 401 today: the chain raises `NotConfigured`; the answer is empty and says so."""
    owner, _, ira = world
    body = top(db_session, owner, ira, FakeOptionChain({"AAPL": CHAIN}, raises=NotConfigured("alpaca_options", "401")))
    assert body["spot"] == SPOT and body["spot_stamp"]["freshness"] != "unavailable"
    assert body["candidates"] == [] and body["opportunity"] is False
    assert body["chain_stamp"] == {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"}
    assert service.CHAIN_HEALTH["ok"] is False


def test_a_rejected_quote_key_means_no_spot_no_chain_read_and_nothing_shown(db_session, world):
    owner, _, ira = world
    chain = FakeOptionChain({"AAPL": CHAIN})
    quotes = FakeQuotes(raises=NotConfigured("alpaca", "401"))
    body = service.candidates(db_session, owner, sources(chain, quotes), "AAPL", ira, NOW)
    assert body["spot"] is None and body["spot_stamp"]["quality"] == "unavailable"
    assert body["candidates"] == [] and chain.calls == []  # nothing to bound the chain with


def test_an_empty_or_failing_chain_is_unavailable_never_an_empty_success(db_session, world):
    owner, _, ira = world
    for chain in (FakeOptionChain({}), FakeOptionChain({"AAPL": CHAIN}, raises=Unavailable("alpaca_options", "down"))):
        body = top(db_session, owner, ira, chain)
        assert body["candidates"] == [] and body["chain_stamp"]["quality"] == "unavailable"


def test_a_holding_the_user_does_not_have_is_a_404(db_session, world):
    from fastapi import HTTPException

    owner, taxable, ira = world
    with pytest.raises(HTTPException) as error:
        service.candidates(db_session, owner, sources(), "TSLA", None, NOW)
    assert error.value.status_code == 404
    with pytest.raises(HTTPException) as error:
        service.candidates(db_session, owner, sources(), "MSFT", taxable, NOW)  # MSFT is in the IRA only
    assert error.value.status_code == 404


def test_with_no_account_named_the_first_account_that_holds_the_symbol_is_used(db_session, world):
    owner, taxable, _ = world
    assert service.candidates(db_session, owner, sources(), "AAPL", None, NOW)["account_id"] == taxable


def test_nothing_is_offered_where_the_cap_leaves_nothing_to_sell(db_session, world):
    owner, taxable, ira = world
    user(db_session, settings={"covered_calls": {"cap_pct": 20}})  # 400 shares x 20% = 0.8 contracts
    db_session.commit()
    body = top(db_session, owner, ira)
    assert (
        body["candidates"] == [] and body["chain_stamp"]["quality"] == "delayed-15m"
    )  # the chain was read: its stamp is true


# -- coverage ---------------------------------------------------------------------------------------------------------


@pytest.fixture
def keys(monkeypatch):
    for name in ALPACA_KEY_VARS:
        monkeypatch.setenv(name, "set")


def reasons(db, owner, env=None):
    import os

    rows = service.coverage(db, owner, env if env is not None else os.environ, NOW)["rows"]
    return {(r["symbol"], r["account_id"]): r for r in rows}


def test_coverage_names_every_reason_at_its_boundary(db_session, world, keys):
    owner, taxable, ira = world
    rows = reasons(db_session, owner)
    assert (
        rows["AAPL", taxable]["reason"],
        rows["AAPL", taxable]["coverable"],
        rows["AAPL", taxable]["open_contracts"],
    ) == ("ok", 2, 3)
    assert rows["AAPL", taxable]["reason_text"] == "2 contracts can be sold at a 50% cap"
    assert (rows["AAPL", ira]["reason"], rows["AAPL", ira]["coverable"]) == ("ok", 2)
    assert rows["KO", taxable]["reason"] == "under_one_contract"  # 150 shares x 50% = 0.75 of a contract
    assert rows["KO", taxable]["reason_text"] == "150 shares: under one contract at a 50% cap"
    assert (rows["MSFT", ira]["reason"], rows["MSFT", ira]["coverable"]) == ("fully_covered", 0)
    assert rows["MSFT", ira]["reason_text"] == "fully covered at its cap"


def test_the_cap_boundary_is_exactly_one_contract(db_session, world, keys):
    owner, taxable, _ = world
    user(db_session, settings={"covered_calls": {"cap_pct": 50}})
    import_xml(db_session, owner, response(statement(ACCOUNT_A, "20261024", [stock_lot("KO", 200, 60.0, "20250101")])))
    assert reasons(db_session, owner)["KO", taxable]["reason"] == "ok"  # 200 x 50% = 1.0 contract, not 0.99
    import_xml(db_session, owner, response(statement(ACCOUNT_A, "20261025", [stock_lot("KO", 199, 60.0, "20250101")])))
    assert reasons(db_session, owner)["KO", taxable]["reason"] == "under_one_contract"


def test_earnings_inside_the_window_wait_and_beyond_it_do_not(db_session, world, keys):
    owner, taxable, _ = world

    def report(day):
        report_on(db_session, day)
        return reasons(db_session, owner)["AAPL", taxable]

    inside = report(date(2026, 11, 2))
    assert (inside["reason"], inside["reason_text"]) == ("earnings_wait", "earnings Nov 2: waits")
    assert report(date(2026, 12, 7))["reason"] == "earnings_wait"  # today + 45 days is the last day inside
    assert report(date(2026, 12, 8))["reason"] == "ok"
    assert report(date(2026, 10, 22))["reason"] == "ok"  # already reported


def test_without_alpaca_keys_a_sellable_holding_reads_no_chain(db_session, world):
    owner, taxable, ira = world
    rows = reasons(db_session, owner, {})
    assert rows["AAPL", taxable]["reason"] == "no_chain" and rows["AAPL", ira]["reason"] == "no_chain"
    assert rows["KO", taxable]["reason"] == "under_one_contract"  # the cap rules still come first


# -- short calls and roll ---------------------------------------------------------------------------------------------


def test_short_calls_carry_moneyness_delta_and_the_engines_risks(db_session, world):
    owner, taxable, _ = world
    report_on(db_session, date(2026, 11, 2))
    rows = {r["strike"]: r for r in service.short_calls(db_session, owner, sources(), NOW) if r["symbol"] == "AAPL"}
    nov6, oct30 = rows[200.0], rows[201.0]
    assert (nov6["contracts"], nov6["dte"], nov6["spot"], nov6["moneyness_pct"], nov6["delta"]) == (
        2,
        14,
        SPOT,
        0.0,
        0.52,
    )
    assert [r["kind"] for r in nov6["risks"]] == ["delta_above_0_50", "earnings_before_expiry"]
    assert (oct30["dte"], oct30["moneyness_pct"], oct30["delta"]) == (7, -0.5, 0.55)
    assert [r["kind"] for r in oct30["risks"]] == [
        "delta_above_0_50",
        "near_strike_near_expiry",
    ]  # earnings fall after it
    assert all(r["text"] for row in rows.values() for r in row["risks"])
    assert nov6["stamp"]["source"] == "fake" and nov6["account_id"] == taxable


def test_without_a_chain_the_delta_rules_stay_silent_and_the_date_rules_still_run(db_session, world):
    owner, *_ = world
    down = FakeOptionChain({"AAPL": CHAIN}, raises=NotConfigured("alpaca_options", "401"))
    rows = {r["strike"]: r for r in service.short_calls(db_session, owner, sources(down), NOW) if r["symbol"] == "AAPL"}
    assert all(r["delta"] is None for r in rows.values())
    assert rows[200.0]["risks"] == [] and [r["kind"] for r in rows[201.0]["risks"]] == ["near_strike_near_expiry"]


def test_without_a_spot_there_is_no_moneyness_and_no_near_strike_rule(db_session, world):
    owner, *_ = world
    quotes = FakeQuotes(raises=NotConfigured("alpaca", "401"))
    rows = {
        r["strike"]: r
        for r in service.short_calls(db_session, owner, sources(quotes=quotes), NOW)
        if r["symbol"] == "AAPL"
    }
    assert all(r["spot"] is None and r["moneyness_pct"] is None for r in rows.values())
    assert [r["kind"] for r in rows[201.0]["risks"]] == ["delta_above_0_50"]  # the delta is still known from the chain
    assert rows[201.0]["stamp"]["quality"] == "unavailable"


def test_an_expired_call_on_a_stale_statement_is_not_open(db_session, world):
    owner, *_ = world
    later = response(
        statement(
            ACCOUNT_A, "20261023", [stock_lot("AAPL", 1000, 150.0, "20240312"), option_lot("AAPL", -1, 190, "20261016")]
        )
    )
    import_xml(db_session, owner, later)
    assert all(r["expiry"] != date(2026, 10, 16) for r in service.short_calls(db_session, owner, sources(), NOW))


def short_call_id(db, strike):
    from ai_trading.db.models import HoldingLot

    return db.execute(
        select(HoldingLot.id).where(
            HoldingLot.strike == strike,
            HoldingLot.asset_type if False else HoldingLot.asset_class == "OPT",
            HoldingLot.symbol == "AAPL",
        )
    ).scalar_one()


def test_the_roll_panel_is_the_engines_credit_over_the_buyback(db_session, world):
    owner, taxable, _ = world
    body = service.roll(db_session, owner, sources(), short_call_id(db_session, 200.0), NOW)
    assert body["cost_to_close"] == 3.10  # the contract's ask per share
    # net credit = the new bid - 3.10 (at least 0.05), same or higher strike, later expiry within 60 days, best first
    assert [(c["expiry"], c["strike"], c["dte"], c["net_credit"], c["delta"]) for c in body["candidates"]] == [
        (NOV20, 210, 28, pytest.approx(1.70), 0.40),
        (NOV20, 205, 28, pytest.approx(1.10), 0.45),
        (DEC04, 210, 42, pytest.approx(0.90), 0.40),
        (DEC04, 215, 42, pytest.approx(0.80), 0.29),
    ]
    assert (NOV20, 215) not in {(c["expiry"], c["strike"]) for c in body["candidates"]}  # 2.85 - 3.10 is a debit
    assert body["assignment_note"]["account_type"] == "taxable" and "Not tax advice" in body["assignment_note"]["text"]
    assert body["chain_stamp"]["source"] == "alpaca_options"


def test_the_ira_assignment_note_follows_the_account_type(db_session, world):
    from ai_trading.db.models import HoldingLot

    owner, _, ira = world
    msft = db_session.execute(
        select(HoldingLot.id).where(HoldingLot.symbol == "MSFT", HoldingLot.asset_class == "OPT")
    ).scalar_one()
    db_session.get(Account, ira).type = "ira"
    body = service.roll(db_session, owner, sources(), msft, NOW)
    assert body["assignment_note"]["account_type"] == "ira" and "inside the account" in body["assignment_note"]["text"]
    assert body["cost_to_close"] is None and body["candidates"] == []  # the fake chain has no MSFT quotes
    assert body["chain_stamp"]["quality"] == "unavailable"


def test_the_roll_of_a_call_that_is_not_the_users_is_a_404(db_session, world):
    from fastapi import HTTPException

    owner, *_ = world
    other = user(db_session, "spouse@example.com")
    for call_id, user_id in ((99999, owner), (short_call_id(db_session, 200.0), other.id)):
        with pytest.raises(HTTPException) as error:
            service.roll(db_session, user_id, sources(), call_id, NOW)
        assert error.value.status_code == 404


def test_a_roll_with_no_chain_reads_unavailable(db_session, world):
    owner, *_ = world
    down = FakeOptionChain({"AAPL": CHAIN}, raises=Unavailable("alpaca_options", "down"))
    body = service.roll(db_session, owner, sources(down), short_call_id(db_session, 200.0), NOW)
    assert (body["cost_to_close"], body["candidates"], body["chain_stamp"]["quality"]) == (None, [], "unavailable")


# -- income -----------------------------------------------------------------------------------------------------------


def trades():
    return [
        trade("S1", "AAPL", "sell_to_open", "20260902", 2, 1.40),  # 280.00
        trade("S2", "AAPL", "sell_to_open", "20260915", 1, 0.90),  # 90.00
        trade("S3", "AAPL", "sell_to_open", "20261001", 2, 1.40),  # 280.00 in October
        trade("B1", "AAPL", "buy_to_close", "20261015", 1, 0.30),  # a buyback is not premium collected
        trade("A1", "AAPL", "assignment", "20260821", 1, 0.0, strike=215),
        trade("P1", "AAPL", "sell_to_open", "20261002", 5, 9.0, right="P"),  # a put is not a covered call
    ]


def test_income_sums_premium_sold_by_month_and_lists_assignments(db_session, world):
    owner, *_ = world
    import_xml(db_session, owner, book(trades=trades()))
    body = service.income(db_session, owner, 12, NOW)
    assert body["state"] == "ok"
    assert body["by_month"] == [
        {"month": "2026-09", "premium": 370.0, "contracts": 3},
        {"month": "2026-10", "premium": 280.0, "contracts": 2},
    ]
    assert body["ytd_premium"] == 650.0
    assert body["assignments"] == [{"date": date(2026, 8, 21), "symbol": "AAPL", "contracts": 1, "strike": 215.0}]
    assert body["source_stamp"]["source"] == "ibkr_flex" and body["source_stamp"]["quality"] == "eod"


def test_the_months_window_trims_to_the_latest_months(db_session, world):
    owner, *_ = world
    import_xml(db_session, owner, book(trades=trades()))
    body = service.income(db_session, owner, 1, NOW)
    assert [m["month"] for m in body["by_month"]] == ["2026-10"] and body["ytd_premium"] == 280.0


def test_income_needs_trades_until_the_flex_query_has_them(db_session, world):
    owner, *_ = world
    body = service.income(db_session, owner, 12, NOW)  # the fixture statement has no Trades section
    assert body == {
        "state": "needs_trades",
        "by_month": [],
        "assignments": [],
        "ytd_premium": None,
        "source_stamp": {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"},
    }
