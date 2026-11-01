from datetime import date

import pytest

from ai_trading_common.errors import NoData, NotConfigured, SoftBanned, Unavailable
from ai_trading_common.providers.sec_edgar import (
    EightKFiling,
    SecEdgar,
    _classify_span,
    _oldest_filing_date,
    _parse_facts,
    _parse_item_202,
    _parse_item_202_block,
    eight_k_as_of,
)
from ai_trading_common.testing import FakeResponse, make_client

TICKERS_BODY = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 1067983, "ticker": "BRK-B", "title": "BERKSHIRE HATHAWAY INC"},
}


class TestClassifySpan:
    def test_instant_fact_has_no_start(self):
        assert _classify_span(None, date(2024, 1, 1)) == "instant"

    @pytest.mark.parametrize(
        "days,expected",
        [(91, "quarterly"), (180, "ytd_6m"), (270, "ytd_9m"), (365, "annual")],
    )
    def test_duration_fact_classified_by_span_length(self, days, expected):
        start = date(2024, 1, 1)
        end = date.fromordinal(start.toordinal() + days)
        assert _classify_span(start, end) == expected

    def test_an_unrecognized_span_is_dropped_not_guessed(self):
        assert _classify_span(date(2024, 1, 1), date(2024, 1, 20)) is None  # 19 days: no bucket fits


def _fact(concept="NetIncomeLoss", unit="USD", val=1.0, filed="2020-01-01", form="10-K", end="2019-12-31"):
    return {"val": val, "accn": f"accn-{filed}", "fy": 2019, "fp": "FY", "form": form, "filed": filed, "end": end}


class TestParseFacts:
    def test_parses_an_instant_and_a_duration_fact(self):
        payload = {
            "facts": {
                "us-gaap": {
                    "Assets": {
                        "units": {
                            "USD": [
                                {"val": 100.0, "accn": "a1", "form": "10-K", "filed": "2020-01-01", "end": "2019-12-31"}
                            ]
                        }
                    },
                    "NetIncomeLoss": {
                        "units": {
                            "USD": [
                                {
                                    "val": 5.0,
                                    "accn": "a2",
                                    "form": "10-K",
                                    "filed": "2020-01-01",
                                    "end": "2019-12-31",
                                    "start": "2019-01-01",
                                    "fy": 2019,
                                    "fp": "FY",
                                }
                            ]
                        }
                    },
                }
            }
        }
        facts = _parse_facts(payload)
        by_concept = {f.concept: f for f in facts}
        assert by_concept["Assets"].span == "instant"
        assert by_concept["Assets"].period_start is None
        assert by_concept["Assets"].provider == "sec_edgar"
        assert by_concept["Assets"].quality == "eod"
        assert by_concept["Assets"].reference == "a1"
        assert by_concept["NetIncomeLoss"].span == "annual"
        assert by_concept["NetIncomeLoss"].period_start == date(2019, 1, 1)

    def test_concepts_filter_limits_parsing(self):
        payload = {
            "facts": {
                "us-gaap": {"Assets": {"units": {"USD": [_fact()]}}, "Liabilities": {"units": {"USD": [_fact()]}}}
            }
        }
        facts = _parse_facts(payload, concepts=("Assets",))
        assert {f.concept for f in facts} == {"Assets"}

    def test_an_unspanned_duration_fact_is_dropped(self):
        payload = {
            "facts": {
                "us-gaap": {
                    "Weird": {
                        "units": {
                            "USD": [
                                {
                                    "val": 1.0,
                                    "accn": "a",
                                    "form": "10-Q",
                                    "filed": "2020-01-01",
                                    "end": "2020-01-20",
                                    "start": "2020-01-01",
                                }
                            ]
                        }
                    }
                }
            }
        }
        assert _parse_facts(payload) == []


class TestParseItem202:
    def test_parse_item_202_is_a_thin_wrapper_over_the_block_parser(self):
        block = {
            "accessionNumber": ["a1"],
            "filingDate": ["2024-01-01"],
            "form": ["8-K"],
            "items": ["2.02"],
        }
        assert _parse_item_202({"filings": {"recent": block}}) == _parse_item_202_block(block)

    def test_keeps_only_8k_filings_with_item_2_02(self):
        payload = {
            "filings": {
                "recent": {
                    "accessionNumber": ["a1", "a2", "a3"],
                    "filingDate": ["2024-01-01", "2024-02-01", "2024-03-01"],
                    "form": ["8-K", "8-K", "10-Q"],
                    "items": ["2.02,9.01", "5.02", "2.02"],
                }
            }
        }
        got = _parse_item_202(payload)
        assert [f.accession for f in got] == ["a1"]
        assert got[0].items == ("2.02", "9.01")

    def test_no_recent_block_is_an_empty_list(self):
        assert _parse_item_202({"filings": {}}) == []


class TestEightKAsOf:
    def test_only_filings_known_by_as_of_are_kept_and_sorted(self):
        filings = [
            EightKFiling(date(2024, 3, 1), "later", ("2.02",)),
            EightKFiling(date(2024, 1, 1), "earlier", ("2.02",)),
        ]
        got = eight_k_as_of(filings, date(2024, 2, 1))
        assert [f.accession for f in got] == ["earlier"]


class TestSecEdgarClient:
    def test_cik_lookup_maps_dot_class_shares_to_sec_dash_form(self):
        client, session, _ = make_client([FakeResponse(200, TICKERS_BODY)])
        sec = SecEdgar("ua", http=client)
        assert sec._cik("BRK.B") == "0001067983"
        assert session.calls[0][2]["User-Agent"] == "ua"

    def test_cik_lookups_download_the_ticker_file_once(self):
        # One response only: a second download would pop an empty list and fail the second lookup.
        client, session, _ = make_client([FakeResponse(200, TICKERS_BODY)])
        sec = SecEdgar("ua", http=client)
        assert sec._cik("BRK.B") == "0001067983"
        assert sec._cik("brk-b") == "0001067983"
        with pytest.raises(NoData):
            sec._cik("ZZZZ")  # a miss is answered from the same download too
        assert len(session.calls) == 1

    def test_unknown_ticker_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(200, TICKERS_BODY)])
        sec = SecEdgar("ua", http=client)
        with pytest.raises(NoData):
            sec._cik("ZZZZ")

    def test_empty_user_agent_raises_not_configured_without_a_request(self):
        client, session, _ = make_client([])
        sec = SecEdgar("", http=client)
        with pytest.raises(NotConfigured):
            sec.company_facts("AAPL", date(2024, 1, 1))
        assert session.calls == []

    def test_404_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(200, TICKERS_BODY), FakeResponse(404)])
        sec = SecEdgar("ua", http=client)
        with pytest.raises(NoData):
            sec.company_facts("AAPL", date(2024, 1, 1))

    def test_a_bare_403_latches_as_soft_banned(self):
        client, _, _ = make_client([FakeResponse(403)])
        sec = SecEdgar("ua", http=client)
        with pytest.raises(SoftBanned):
            sec._cik("AAPL")

    def test_500_raises_unavailable_after_bounded_retries(self):
        client, session, _ = make_client([FakeResponse(500)] * 10)
        sec = SecEdgar("ua", http=client)
        with pytest.raises(Unavailable):
            sec._cik("AAPL")
        assert len(session.calls) == 4

    def test_company_facts_end_to_end_resolves_cik_then_fetches_and_cuts(self):
        companyfacts = {
            "facts": {
                "us-gaap": {
                    "Assets": {
                        "units": {
                            "USD": [
                                {"val": 1.0, "accn": "a", "form": "10-K", "filed": "2024-01-01", "end": "2023-12-31"}
                            ]
                        }
                    }
                }
            }
        }
        client, _, _ = make_client([FakeResponse(200, TICKERS_BODY), FakeResponse(200, companyfacts)])
        sec = SecEdgar("ua", http=client)
        got = sec.company_facts("AAPL", date(2024, 6, 1))
        assert len(got) == 1
        assert got[0].concept == "Assets"

    def test_item_202_filings_resolves_cik_then_fetches_submissions(self):
        submissions = {
            "filings": {
                "recent": {
                    "accessionNumber": ["a1"],
                    "filingDate": ["2024-01-01"],
                    "form": ["8-K"],
                    "items": ["2.02"],
                }
            }
        }
        client, session, _ = make_client([FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions)])
        sec = SecEdgar("ua", http=client)
        got = sec.item_202_filings("AAPL", since=date(2023, 1, 1))  # recent's own floor already covers it
        assert [f.accession for f in got] == ["a1"]
        assert len(session.calls) == 2  # no filings.files page fetched


def _block(rows: list[tuple[str, str, str, str]]) -> dict:
    """A `filings.recent`/`filings.files`-page-shaped block from (accession, filed, form, items) rows."""
    return {
        "accessionNumber": [r[0] for r in rows],
        "filingDate": [r[1] for r in rows],
        "form": [r[2] for r in rows],
        "items": [r[3] for r in rows],
    }


class TestOldestFilingDate:
    def test_scans_rather_than_trusting_array_order(self):
        # filingDate deliberately out of order: the real recent/files blocks are too.
        block = _block([("a", "2024-03-01", "10-Q", ""), ("b", "2024-01-15", "8-K", "2.02")])
        assert _oldest_filing_date(block) == date(2024, 1, 15)

    def test_an_empty_block_has_no_oldest_date(self):
        assert _oldest_filing_date({}) is None


class TestItem202Pagination:
    """`SecEdgar.item_202_filings(ticker, since)` falls back to `filings.files`
    (the older-filings archive) only as far as `since` needs, never further.
    """

    def _submissions(self, recent_rows, files=None):
        body = {"filings": {"recent": _block(recent_rows)}}
        if files is not None:
            body["filings"]["files"] = files
        return body

    def test_no_extra_fetch_when_recent_already_covers_since(self):
        recent = [("r1", "2025-06-01", "8-K", "2.02"), ("r2", "2024-01-01", "10-Q", "")]
        submissions = self._submissions(
            recent, files=[{"name": "page1.json", "filingFrom": "2020-01-01", "filingTo": "2023-12-31"}]
        )
        client, session, _ = make_client([FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions)])
        sec = SecEdgar("ua", http=client)
        got = sec.item_202_filings("AAPL", since=date(2024, 1, 1))
        assert [f.accession for f in got] == ["r1"]
        assert len(session.calls) == 2  # tickers + submissions root only; no page fetched

    def test_fetches_exactly_one_older_page_when_recent_falls_short(self):
        recent = [("r1", "2025-06-01", "8-K", "2.02")]  # oldest in recent: 2025-06-01, after `since`
        files = [{"name": "page1.json", "filingFrom": "2025-01-01", "filingTo": "2025-05-31"}]
        page1 = _block([("p1", "2025-02-01", "8-K", "2.02")])
        submissions = self._submissions(recent, files=files)
        client, session, _ = make_client(
            [FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions), FakeResponse(200, page1)]
        )
        sec = SecEdgar("ua", http=client)
        got = sec.item_202_filings("AAPL", since=date(2025, 1, 15))
        assert {f.accession for f in got} == {"r1", "p1"}
        assert len(session.calls) == 3  # tickers + submissions root + exactly one page
        assert session.calls[2][0] == "https://data.sec.gov/submissions/page1.json"

    def test_stops_as_soon_as_the_window_is_covered_never_fetching_more_than_needed(self):
        recent = [("r1", "2025-06-01", "8-K", "2.02")]
        files = [
            {"name": "page1.json", "filingFrom": "2025-01-01", "filingTo": "2025-05-31"},  # covers `since` already
            {"name": "page2.json", "filingFrom": "2020-01-01", "filingTo": "2024-12-31"},  # must not be fetched
        ]
        page1 = _block([("p1", "2025-02-01", "8-K", "2.02")])
        submissions = self._submissions(recent, files=files)
        client, session, _ = make_client(
            [FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions), FakeResponse(200, page1)]
        )
        sec = SecEdgar("ua", http=client)
        got = sec.item_202_filings("AAPL", since=date(2025, 3, 1))
        assert {f.accession for f in got} == {"r1", "p1"}
        assert len(session.calls) == 3  # page2 never requested

    def test_a_failed_page_raises_unavailable_not_a_silently_partial_list(self):
        recent = [("r1", "2025-06-01", "8-K", "2.02")]
        files = [{"name": "page1.json", "filingFrom": "2025-01-01", "filingTo": "2025-05-31"}]
        submissions = self._submissions(recent, files=files)
        responses = [FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions), *([FakeResponse(500)] * 10)]
        client, _, _ = make_client(responses)
        sec = SecEdgar("ua", http=client)
        with pytest.raises(Unavailable):
            sec.item_202_filings("AAPL", since=date(2025, 1, 15))
