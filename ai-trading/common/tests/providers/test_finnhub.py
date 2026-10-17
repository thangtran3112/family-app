"""Contract tests against real Finnhub responses recorded by scripts/record.py."""

import json
from datetime import date
from pathlib import Path

import pandas as pd

from ai_trading_common.errors import NoData, NotConfigured
from ai_trading_common.providers.finnhub import FinnhubClient, FinnhubSource
from ai_trading_common.testing import FakeResponse, make_client
from ai_trading_common.types import news_as_of

FIXTURES = Path(__file__).parent.parent / "fixtures" / "finnhub"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def client_for(name: str, status: int = 200) -> FinnhubClient:
    http, _, _ = make_client([FakeResponse(status, load(name)["body"])])
    return FinnhubClient("key", http=http)


class TestEarningsCalendar:
    def test_parses_a_real_calendar_entry(self):
        client = client_for("calendar_earnings_aapl")
        got = client.earnings_calendar("AAPL", date(2026, 1, 1), date(2026, 12, 31))
        assert got[0].symbol == "AAPL"
        assert got[0].hour == "amc"
        assert got[0].eps_estimate is not None

    def test_empty_calendar_is_no_data(self):
        client = client_for("calendar_earnings_empty")
        try:
            client.earnings_calendar("ZZZZ", date(1990, 1, 1), date(1990, 1, 2))
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")


class TestCompanyNews:
    def test_parses_real_news_items(self):
        client = client_for("company_news_aapl")
        got = client.company_news("AAPL", date(2026, 10, 1), date(2026, 10, 11))
        assert len(got) == 3
        assert got[0].published_at.tzinfo is not None

    def test_empty_window_is_no_data(self):
        client = client_for("company_news_empty")
        try:
            client.company_news("AAPL", date(2026, 10, 12), date(2026, 10, 12))
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")

    def test_news_as_of_drops_anything_published_after_the_cutoff(self):
        client = client_for("company_news_aapl")
        items = client.company_news("AAPL", date(2026, 10, 1), date(2026, 10, 11))
        cutoff = items[-1].published_at
        got = news_as_of(items, cutoff)
        assert all(item.published_at <= cutoff for item in got)
        assert len(got) < len(items)


class TestRecommendationTrends:
    def test_parses_real_counts(self):
        client = client_for("stock_recommendation_aapl")
        got = client.recommendation_trends("AAPL")
        assert got[0].symbol == "AAPL"
        assert got[0].strong_buy >= 0


class TestEarningsSurprises:
    def test_parses_real_surprise_rows(self):
        client = client_for("stock_earnings_aapl")
        got = client.earnings_surprises("AAPL")
        assert got[0].surprise is not None
        assert got[0].surprise_percent is not None


class TestErrors:
    def test_bad_key_is_not_configured(self):
        client = client_for("bad_key_401", status=401)
        try:
            client.earnings_surprises("AAPL")
        except NotConfigured:
            pass
        else:
            raise AssertionError("expected NotConfigured")

    def test_no_key_is_not_configured_without_a_request(self):
        client = FinnhubClient("")
        try:
            client.earnings_surprises("AAPL")
        except NotConfigured:
            pass
        else:
            raise AssertionError("expected NotConfigured")


def test_news_as_of_is_pure_and_order_preserving():
    now = pd.Timestamp("2026-10-11T00:00:00Z")
    client = client_for("company_news_aapl")
    items = client.company_news("AAPL", date(2026, 10, 1), date(2026, 10, 11))
    got = news_as_of(items, now)
    assert got == [item for item in items if item.published_at <= now]


class TestFinnhubSourceAdapter:
    """Maps the recorded fixtures into the shared neutral types (02j §9: "Adapters")."""

    def test_news_renames_source_to_publisher(self):
        source = FinnhubSource(client_for("company_news_aapl"))
        got = source.news("AAPL", date(2026, 10, 1), date(2026, 10, 11))
        assert got and all(item.publisher for item in got)
        assert all(item.provider == "finnhub" and item.quality == "eod" for item in got)

    def test_earnings_calendar_maps_amc_hour_code_to_after_close_timing(self):
        source = FinnhubSource(client_for("calendar_earnings_aapl"))
        got = source.earnings_calendar("AAPL", date(2026, 1, 1), date(2026, 12, 31))
        assert got[0].timing == "after_close"
        assert got[0].provider == "finnhub"

    def test_unknown_hour_code_maps_to_unknown_timing(self):
        client, _, _ = make_client(
            [
                FakeResponse(
                    200,
                    {
                        "earningsCalendar": [
                            {"symbol": "AAPL", "date": "2026-01-01", "hour": "", "year": 2026, "quarter": 1}
                        ]
                    },
                )
            ]
        )
        source = FinnhubSource(FinnhubClient("key", http=client))
        got = source.earnings_calendar("AAPL", date(2026, 1, 1), date(2026, 12, 31))
        assert got[0].timing == "unknown"

    def test_analyst_targets_has_counts_but_no_prices(self):
        source = FinnhubSource(client_for("stock_recommendation_aapl"))
        got = source.analyst_targets("AAPL", now=pd.Timestamp("2026-10-11T00:00:00Z"))
        assert got.period == date(2026, 9, 1)
        assert got.as_of == pd.Timestamp("2026-10-11T00:00:00Z")
        assert got.target_mean is None
        assert got.target_high is None
        assert got.buy >= 0
        assert got.quality == "eod"  # the chain, not the adapter, decides fallback labeling

    def test_earnings_results_maps_surprises(self):
        source = FinnhubSource(client_for("stock_earnings_aapl"))
        got = source.earnings_results("AAPL", now=pd.Timestamp("2026-10-11T00:00:00Z"))
        assert got and got[0].surprise is not None
        assert got[0].provider == "finnhub"
        # a fiscal period end is not a report date: claiming one would date the result too early
        assert all(r.report_date is None and r.period_end is not None for r in got)
