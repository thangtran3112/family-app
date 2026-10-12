"""Contract tests against real Eulerpool responses recorded by scripts/record.py, plus the
earnings-calendar/surprise join that lives entirely inside this adapter (not cross-provider
fallback -- that lives in `registry.py`)."""

import json
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

from ai_trading_common.errors import NoData, NotConfigured
from ai_trading_common.providers.eulerpool import (
    CalendarEntry,
    EarningsSurprise,
    EulerpoolClient,
    EulerpoolSource,
)
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent.parent / "fixtures" / "eulerpool"
NOW = pd.Timestamp("2026-10-11T21:00:00Z")


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def client_for(name: str, status: int = 200) -> EulerpoolClient:
    http, _, _ = make_client([FakeResponse(status, load(name)["body"])])
    return EulerpoolClient("key", http=http)


class TestEstimates:
    def test_parses_real_estimate_periods(self):
        client = client_for("estimates_aapl")
        got = client.estimates("AAPL")
        assert got[0].eps_mean is not None
        assert got[0].eps_analyst_count is not None

    def test_known_security_with_no_coverage_is_no_data(self):
        # Confirmed live: BRK.B has no analyst EPS-estimate coverage on Eulerpool
        # even though its ticker/ISIN both resolve fine elsewhere (recommendations).
        client = client_for("estimates_empty_brkb")
        try:
            client.estimates("BRK.B")
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")


class TestEarningsCalendar:
    def test_parses_real_calendar_entries(self):
        client = client_for("calendar_aapl")
        got = client.earnings_calendar("AAPL")
        assert got[0].symbol == "AAPL"


class TestEarningsSurprises:
    def test_parses_real_surprise_rows(self):
        client = client_for("surprises_aapl")
        got = client.earnings_surprises("AAPL")
        assert got[0].surprise_percent is not None


class TestRecommendations:
    def test_parses_counts_and_targets_together(self):
        client = client_for("recommendations_aapl")
        got = client.recommendations("AAPL")
        row = got[0]
        assert row.buy >= 0
        assert row.target_mean is not None

    def test_unknown_symbol_is_no_data(self):
        client = client_for("unknown_recommendations_404", status=404)
        try:
            client.recommendations("ZZZZINVALIDXYZ")
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")


class TestErrors:
    def test_bad_key_is_not_configured(self):
        client = client_for("bad_key_401", status=401)
        try:
            client.estimates("AAPL")
        except NotConfigured:
            pass
        else:
            raise AssertionError("expected NotConfigured")

    def test_unknown_security_is_no_data(self):
        client = client_for("unknown_symbol_404", status=404)
        try:
            client.estimates("ZZZZINVALIDXYZ")
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")

    def test_no_key_is_not_configured_without_a_request(self):
        client = EulerpoolClient("")
        try:
            client.estimates("AAPL")
        except NotConfigured:
            pass
        else:
            raise AssertionError("expected NotConfigured")


class TestEulerpoolSourceAdapter:
    """Maps the recorded fixtures into the shared neutral types (02j §9: "Adapters")."""

    def test_consensus_maps_estimates(self):
        source = EulerpoolSource(client_for("estimates_aapl"))
        got = source.consensus("AAPL", now=NOW)
        assert got and got[0].provider == "eulerpool"
        assert got[0].quality == "eod"  # the chain, not the adapter, decides fallback labeling

    def test_analyst_targets_carries_both_counts_and_prices(self):
        source = EulerpoolSource(client_for("recommendations_aapl"))
        got = source.analyst_targets("AAPL", now=NOW)
        assert got.period == date(2026, 9, 1)
        assert got.as_of == NOW
        assert got.target_mean is not None
        assert got.buy >= 0
        assert got.provider == "eulerpool"


class TestEarningsResultsCalendarSurpriseJoin:
    """`EulerpoolSource.earnings_results` merges its own calendar and surprise endpoints by
    period (`_merge_by_period`), since neither endpoint alone carries both the report date and
    the fiscal period it covers."""

    def test_merges_calendar_and_surprises_by_period(self):
        # The calendar's date is the report date; the surprise's date is the fiscal period end
        # that report covers -- the two must stay distinct fields on the merged row, not collapse
        # onto each other (the bug this test was rewritten to catch).
        calendar = [
            CalendarEntry(
                symbol="AAPL",
                report_date=date(2026, 7, 30),
                eps_estimate=1.9,
                eps_actual=2.02,
                revenue_estimate=None,
                revenue_actual=None,
            )
        ]
        surprises = [
            EarningsSurprise(
                symbol="AAPL",
                period_end=date(2026, 6, 30),
                fiscal_year=2026,
                fiscal_quarter=3,
                eps_estimate=1.9,
                eps_actual=2.02,
                eps_difference=0.12,
                surprise_percent=6.3,
            )
        ]
        client, _, _ = make_client([])  # unused: calendar/surprises are stubbed below
        source = EulerpoolSource(EulerpoolClient("key", http=client))
        source._client.earnings_calendar = lambda symbol: calendar  # noqa: SLF001
        source._client.earnings_surprises = lambda symbol: surprises  # noqa: SLF001
        got = source.earnings_results("AAPL", now=NOW)
        assert len(got) == 1
        assert got[0].period_end == date(2026, 6, 30)
        assert got[0].report_date == date(2026, 7, 30)
        assert got[0].surprise == 0.12
        assert got[0].fiscal_quarter == 3

    def test_fixture_calendar_and_surprises_merge_into_one_row_per_period_with_both_dates_right(self):
        """Real recorded AAPL data: the calendar's report dates and the surprise history's period
        ends genuinely differ (a report lands about a month after its own period end), so this
        pins the join against real-world data, not just a hand-built example."""
        client, _, _ = make_client(
            [FakeResponse(200, load("calendar_aapl")["body"]), FakeResponse(200, load("surprises_aapl")["body"])]
        )
        source = EulerpoolSource(EulerpoolClient("key", http=client))
        got = source.earnings_results("AAPL", now=NOW)

        matched = {r.period_end: r for r in got if r.period_end is not None}
        assert matched[date(2026, 6, 30)].report_date == date(2026, 7, 30)
        assert matched[date(2026, 3, 31)].report_date == date(2026, 4, 29)
        assert matched[date(2025, 12, 31)].report_date == date(2026, 1, 29)
        assert matched[date(2025, 9, 30)].report_date == date(2025, 10, 30)
        assert len(matched) == 4  # every recorded surprise row found its report

    def test_an_unmatched_surprise_has_no_report_date(self):
        surprises = [
            EarningsSurprise(
                symbol="AAPL",
                period_end=date(2020, 6, 30),  # far older than any calendar row recorded here
                fiscal_year=2020,
                fiscal_quarter=3,
                eps_estimate=1.0,
                eps_actual=1.1,
                eps_difference=0.1,
                surprise_percent=10.0,
            )
        ]
        client, _, _ = make_client([])
        source = EulerpoolSource(EulerpoolClient("key", http=client))
        source._client.earnings_calendar = lambda symbol: []  # noqa: SLF001
        source._client.earnings_surprises = lambda symbol: surprises  # noqa: SLF001
        got = source.earnings_results("AAPL", now=NOW)
        assert len(got) == 1
        assert got[0].period_end == date(2020, 6, 30)
        assert got[0].report_date is None

    def test_an_unmatched_calendar_row_has_no_period_end(self):
        calendar = [
            CalendarEntry(
                symbol="AAPL",
                report_date=date(2001, 7, 17),  # the oldest recorded row: no surprise reaches back this far
                eps_estimate=0.0028,
                eps_actual=0.003,
                revenue_estimate=None,
                revenue_actual=None,
            )
        ]
        client, _, _ = make_client([])
        source = EulerpoolSource(EulerpoolClient("key", http=client))
        source._client.earnings_calendar = lambda symbol: calendar  # noqa: SLF001
        source._client.earnings_surprises = lambda symbol: []  # noqa: SLF001
        got = source.earnings_results("AAPL", now=NOW)
        assert len(got) == 1
        assert got[0].period_end is None
        assert got[0].report_date == date(2001, 7, 17)

    def test_the_90_day_join_window_boundary(self):
        period_end = date(2026, 6, 30)
        surprises = [
            EarningsSurprise(
                symbol="AAPL",
                period_end=period_end,
                fiscal_year=2026,
                fiscal_quarter=3,
                eps_estimate=1.9,
                eps_actual=2.02,
                eps_difference=0.12,
                surprise_percent=6.3,
            )
        ]
        at_the_boundary = [
            CalendarEntry(
                symbol="AAPL",
                report_date=period_end + timedelta(days=90),  # exactly 90 days: must match
                eps_estimate=1.9,
                eps_actual=2.02,
                revenue_estimate=None,
                revenue_actual=None,
            )
        ]
        past_the_boundary = [
            CalendarEntry(
                symbol="AAPL",
                report_date=period_end + timedelta(days=91),  # one day past: must not match
                eps_estimate=1.9,
                eps_actual=2.02,
                revenue_estimate=None,
                revenue_actual=None,
            )
        ]

        client, _, _ = make_client([])
        matched_source = EulerpoolSource(EulerpoolClient("key", http=client))
        matched_source._client.earnings_calendar = lambda symbol: at_the_boundary  # noqa: SLF001
        matched_source._client.earnings_surprises = lambda symbol: surprises  # noqa: SLF001
        matched = matched_source.earnings_results("AAPL", now=NOW)
        assert len(matched) == 1
        assert matched[0].report_date == period_end + timedelta(days=90)

        unmatched_source = EulerpoolSource(EulerpoolClient("key", http=client))
        unmatched_source._client.earnings_calendar = lambda symbol: past_the_boundary  # noqa: SLF001
        unmatched_source._client.earnings_surprises = lambda symbol: surprises  # noqa: SLF001
        unmatched = unmatched_source.earnings_results("AAPL", now=NOW)
        assert len(unmatched) == 2  # the surprise and the calendar row both stay unmatched
        assert all(r.report_date is None for r in unmatched if r.period_end == period_end)
