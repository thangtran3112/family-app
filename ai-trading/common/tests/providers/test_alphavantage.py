"""Contract tests against real Alpha Vantage responses recorded by scripts/record.py."""

import json
from pathlib import Path

import pandas as pd

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.providers.alphavantage import AlphaVantageClient, AlphaVantageSource, QuotaExceeded
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent.parent / "fixtures" / "alphavantage"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def client_for(name: str) -> AlphaVantageClient:
    http, _, _ = make_client([FakeResponse(200, load(name)["body"])])
    return AlphaVantageClient("key", http=http)


class TestEarningsEstimates:
    def test_parses_both_fiscal_year_and_fiscal_quarter_rows(self):
        client = client_for("earnings_estimates_aapl")
        got = client.earnings_estimates("AAPL")
        horizons = {row.horizon for row in got}
        assert horizons == {"fiscal year", "fiscal quarter"}

    def test_carries_the_revision_fields(self):
        client = client_for("earnings_estimates_aapl")
        got = client.earnings_estimates("AAPL")
        annual = next(row for row in got if row.horizon == "fiscal year")
        assert annual.eps_mean_7d_ago is not None
        assert annual.eps_mean_30d_ago is not None


class TestEarnings:
    def test_parses_reported_vs_estimated_with_surprise(self):
        client = client_for("earnings_aapl")
        got = client.earnings("AAPL")
        row = got[0]
        assert row.reported_eps is not None
        assert row.estimated_eps is not None
        assert row.surprise is not None
        assert row.report_time in {"pre-market", "post-market", None}


class TestQuotaAndEntitlement:
    def test_rate_limit_note_is_quota_exceeded_and_an_unavailable(self):
        client = client_for("quota_note")
        try:
            client.earnings("AAPL")
        except QuotaExceeded:
            pass
        else:
            raise AssertionError("expected QuotaExceeded")

    def test_quota_exceeded_is_an_unavailable_so_fallback_chains_skip_it(self):
        assert issubclass(QuotaExceeded, Unavailable)

    def test_unknown_symbol_is_no_data(self):
        client = client_for("unknown_symbol_empty")
        try:
            client.earnings("ZZZZINVALIDXYZ")
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")


def test_no_key_is_not_configured_without_a_request():
    client = AlphaVantageClient("")
    try:
        client.earnings("AAPL")
    except NotConfigured:
        pass
    else:
        raise AssertionError("expected NotConfigured")


class TestAlphaVantageSourceAdapter:
    """Maps the recorded fixtures into the shared neutral types (02j §9: "Adapters")."""

    def test_consensus_maps_estimates(self):
        source = AlphaVantageSource(client_for("earnings_estimates_aapl"))
        got = source.consensus("AAPL", now=pd.Timestamp("2026-10-11T00:00:00Z"))
        assert got and got[0].provider == "alphavantage"
        assert got[0].quality == "eod"  # the chain, not the adapter, decides fallback labeling

    def test_earnings_results_maps_reported_earnings(self):
        source = AlphaVantageSource(client_for("earnings_aapl"))
        got = source.earnings_results("AAPL", now=pd.Timestamp("2026-10-11T00:00:00Z"))
        assert got and got[0].surprise is not None
        assert got[0].provider == "alphavantage"
