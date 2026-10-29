"""The Flex client and parser (02n §j): the recorded-shape statement (stocks, short calls, two accounts, trades), a
malformed file, a DTD or entity refused, the poll flow, and the rule that the token never leaves the request."""

from datetime import date

import pytest
from fundamental_world import ACCOUNT_A, ACCOUNT_B, option_lot, response, statement, stock_lot, trade

from ai_trading.holdings import flex

TOKEN = "tok-sentinel-123"  # pragma: allowlist secret
QUERY = "987654"


def two_accounts() -> str:
    return response(
        statement(
            ACCOUNT_A,
            "20261023",
            [
                stock_lot("AAPL", 600, 150.0, "20240312"),
                stock_lot("AAPL", 400, 180.5, "20260105"),
                stock_lot("AAPL", 1000, 165.0, "20240312", level="SUMMARY"),  # the roll-up of the two lots above
                option_lot("AAPL", -2, 215, "20261120"),
                stock_lot("USD", 5000, 1.0, "20260101", category="CASH"),
            ],
            [
                trade("T1", "AAPL", "sell_to_open", "20261001", 2, 1.4),
                trade("T2", "AAPL", "assignment", "20260821", 1, 0.0),
            ],
        ),
        statement(ACCOUNT_B, "20261023", [stock_lot("MSFT", 250, 300.0, "20250601")]),
    )


def test_a_statement_gives_lots_and_trades_per_account():
    a, b = flex.parse_statements(two_accounts())
    assert (a.account_id, a.statement_date, b.account_id) == (ACCOUNT_A, date(2026, 10, 23), ACCOUNT_B)
    stock = [lot for lot in a.lots if lot.asset_class == "STK"]
    assert [(lot.symbol, lot.quantity, lot.cost_per_share, lot.acquired) for lot in stock] == [
        ("AAPL", 600, 150.0, date(2024, 3, 12)),
        ("AAPL", 400, 180.5, date(2026, 1, 5)),
    ]
    (short_call,) = [lot for lot in a.lots if lot.asset_class == "OPT"]
    assert (short_call.symbol, short_call.quantity, short_call.option_right, short_call.strike) == (
        "AAPL",
        -2,
        "C",
        215,
    )
    assert (short_call.expiry, short_call.multiplier) == (date(2026, 11, 20), 100)
    assert [(t.external_ref, t.kind, t.quantity) for t in a.trades] == [
        ("T1", "sell_to_open", -2),
        ("T2", "assignment", 1),
    ]
    assert [lot.symbol for lot in b.lots] == ["MSFT"] and b.trades == ()


def test_summary_rows_and_other_asset_classes_are_counted_and_skipped_not_double_counted():
    a, _ = flex.parse_statements(two_accounts())
    assert sum(lot.quantity for lot in a.lots if lot.asset_class == "STK") == 1000  # not 2000
    assert a.skipped == 2  # the SUMMARY row and the CASH row


def test_a_lot_without_its_open_date_is_skipped_never_dated_by_guess():
    xml = response(statement(ACCOUNT_A, "20261023", [stock_lot("AAPL", 100, 150.0, "")]))
    (a,) = flex.parse_statements(xml)
    assert a.lots == () and a.skipped == 1


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        ("sell_to_open", "sell_to_open"),
        ("buy_to_close", "buy_to_close"),
        ("buy_to_open", "buy_to_open"),
        ("sell_to_close", "sell_to_close"),
        ("assignment", "assignment"),
        ("expiration", "expiration"),
    ],
)
def test_every_trade_kind_maps_from_how_ibkr_writes_it(kind, expected):
    xml = response(statement(ACCOUNT_A, "20261023", [], [trade("T9", "AAPL", kind, "20261001", 1, 0.5)]))
    assert flex.parse_statements(xml)[0].trades[0].kind == expected


def test_the_date_formats_a_query_can_choose_all_read():
    for text in ("20261023", "2026-10-23", "10/23/2026", "20261023;153000", "2026-10-23, 15:30:00"):
        assert flex._date(text) == date(2026, 10, 23)
    assert flex._date("") is None and flex._date("not a date") is None


def test_a_dtd_or_an_entity_is_refused_before_anything_expands():
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>'
        "<FlexQueryResponse>&b;</FlexQueryResponse>"
    )
    with pytest.raises(flex.FlexError, match="DTD or entity"):
        flex.parse_statements(bomb)
    xxe = '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><FlexQueryResponse>&x;</FlexQueryResponse>'
    with pytest.raises(flex.FlexError, match="DTD or entity"):
        flex.parse_statements(xxe)
    with pytest.raises(flex.FlexError, match="DTD or entity"):
        flex.parse_statements('<FlexQueryResponse><!ENTITY y "z"></FlexQueryResponse>')


def test_a_malformed_or_foreign_document_is_an_error_not_a_crash():
    for text in ("", "<FlexQueryResponse><FlexStatements>", "<html/>"):
        with pytest.raises(flex.FlexError):
            flex.parse_statements(text)
    with pytest.raises(flex.FlexError, match="no account or no date"):
        flex.parse_statements("<FlexQueryResponse><FlexStatement toDate='20261023'/></FlexQueryResponse>")


def test_an_account_id_masks_to_its_prefix():
    assert flex.mask_account("DU0000001") == "DU*******"
    assert flex.mask_account(ACCOUNT_A) == "U*******"
    assert flex.mask_account("") == ""


def fake_get(replies):
    calls: list[tuple[str, dict[str, str]]] = []

    def get(url, params):
        calls.append((url, params))
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    return get, calls


BROKER_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement"
SENT = (
    "<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF1</ReferenceCode>"
    f"<Url>{BROKER_URL}</Url></FlexStatementResponse>"
)
PENDING = (
    "<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode>"
    "<ErrorMessage>generating</ErrorMessage></FlexStatementResponse>"
)


def test_the_statement_is_requested_then_polled_until_it_exists():
    get, calls = fake_get([SENT, PENDING, two_accounts()])
    waits: list[float] = []
    body = flex.fetch_statement(TOKEN, QUERY, get=get, sleep=waits.append)
    assert "<FlexQueryResponse" in body
    assert [url.rsplit("/", 1)[-1] for url, _ in calls] == ["SendRequest", "GetStatement", "GetStatement"]
    assert calls[0][1] == {"t": TOKEN, "q": QUERY, "v": "3"}
    assert calls[1][1] == {"t": TOKEN, "q": "REF1", "v": "3"}  # the poll asks for the reference, not the query
    assert waits == [flex.FIRST_WAIT_S, flex.POLL_WAIT_S]


def test_a_refusal_names_the_code_and_never_the_token():
    refused = "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode></FlexStatementResponse>"
    get, _ = fake_get([refused])
    with pytest.raises(flex.FlexError) as error:
        flex.fetch_statement(TOKEN, QUERY, get=get, sleep=lambda s: None)
    assert "1012" in str(error.value) and TOKEN not in str(error.value) and QUERY not in str(error.value)


def test_a_transport_error_hides_the_url_that_holds_the_token():
    get, _ = fake_get([OSError(f"cannot reach https://flex.example/SendRequest?t={TOKEN}&q={QUERY}")])
    with pytest.raises(flex.FlexError) as error:
        flex.fetch_statement(TOKEN, QUERY, get=get, sleep=lambda s: None)
    assert str(error.value) == "SendRequest failed: OSError"
    assert error.value.__cause__ is None and error.value.__suppress_context__


def test_a_statement_that_never_finishes_gives_up_after_the_bounded_tries():
    get, calls = fake_get([SENT] + [PENDING] * flex.MAX_ATTEMPTS)
    with pytest.raises(flex.FlexError, match="still generating"):
        flex.fetch_statement(TOKEN, QUERY, get=get, sleep=lambda s: None)
    assert len(calls) == 1 + flex.MAX_ATTEMPTS


@pytest.mark.parametrize(
    "bad",
    [
        "http://ndcdyn.interactivebrokers.com/x",
        "https://evil.example/steal",
        "https://x.interactivebrokers.com.evil.example/y",
        "",
    ],
)
def test_a_get_statement_url_off_the_broker_is_ignored_for_the_fixed_host(bad):
    sent = SENT.replace("https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement", bad)
    get, calls = fake_get([sent, two_accounts()])
    flex.fetch_statement(TOKEN, QUERY, get=get, sleep=lambda s: None)
    assert calls[1][0] == f"{flex.BASE_URL}/GetStatement"


def test_the_brokers_own_get_statement_url_is_used():
    get, calls = fake_get([SENT, two_accounts()])
    flex.fetch_statement(TOKEN, QUERY, get=get, sleep=lambda s: None)
    assert calls[1][0].startswith("https://ndcdyn.interactivebrokers.com/")
