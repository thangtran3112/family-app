"""02b §4b in code: the source of each Fundamental-lane field and what it honestly is today. Only whether a value is
set is read, never the value, so the report is safe to log."""

from ai_trading.fundamental.sources import fundamental_sources

KEYS = {
    "IBKR_FLEX_TOKEN": "flex-token-sentinel",
    "IBKR_FLEX_QUERY_ID": "123",
    "ALPACA_API_KEY_ID": "k",
    "ALPACA_API_SECRET_KEY": "s",
}  # pragma: allowlist secret


def test_with_the_keys_set_holdings_come_from_flex_and_quotes_are_delayed_alpaca():
    sources = fundamental_sources(KEYS)
    assert (sources["holdings"].source, sources["holdings"].state, sources["holdings"].quality) == (
        "ibkr_flex",
        "configured",
        "eod",
    )
    assert (sources["quotes"].source, sources["quotes"].state, sources["quotes"].quality) == (
        "alpaca",
        "delayed",
        "delayed-15m",
    )


def test_without_the_keys_both_are_not_configured_and_say_what_to_set():
    sources = fundamental_sources({})
    assert (sources["holdings"].state, sources["holdings"].quality) == ("not_configured", "unavailable")
    assert "IBKR_FLEX_TOKEN" in sources["holdings"].reason and "IBKR_FLEX_QUERY_ID" in sources["holdings"].reason
    assert (sources["quotes"].state, sources["quotes"].quality) == ("not_configured", "unavailable")
    assert "ALPACA_API_KEY_ID" in sources["quotes"].reason


def test_one_missing_half_of_a_credential_pair_is_not_configured():
    assert fundamental_sources({"IBKR_FLEX_TOKEN": "t"})["holdings"].state == "not_configured"
    assert fundamental_sources({"IBKR_FLEX_QUERY_ID": "1"})["holdings"].state == "not_configured"
    assert fundamental_sources({"ALPACA_API_KEY_ID": "k"})["quotes"].state == "not_configured"
    assert fundamental_sources({"IBKR_FLEX_TOKEN": "", "IBKR_FLEX_QUERY_ID": ""})["holdings"].state == "not_configured"


def test_a_field_with_no_source_is_marked_unavailable_or_deferred_never_given_a_provider():
    sources = fundamental_sources(KEYS)
    for field, state in (("futures_prices", "deferred"), ("ex_dividend", "unavailable")):
        assert (sources[field].source, sources[field].state, sources[field].quality) == (None, state, "unavailable"), (
            field
        )
    assert "futures deferred" in sources["futures_prices"].reason


def test_the_option_chain_resolves_through_alpaca_options_and_is_delayed():
    chain = fundamental_sources(KEYS)["option_chain"]
    assert (chain.source, chain.state, chain.quality) == ("alpaca_options", "delayed", "delayed-15m")
    assert "15 minutes delayed" in chain.reason


def test_without_the_alpaca_keys_the_option_chain_is_not_configured_and_says_what_to_set():
    chain = fundamental_sources({})["option_chain"]
    assert (chain.source, chain.state, chain.quality) == (None, "not_configured", "unavailable")
    assert "ALPACA_API_KEY_ID" in chain.reason


def test_no_credential_value_appears_in_the_report():
    report = repr(fundamental_sources(KEYS))
    assert not any(value in report for value in ("flex-token-sentinel", "123"))
