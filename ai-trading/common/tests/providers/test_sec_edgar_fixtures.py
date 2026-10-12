"""Contract tests against real SEC EDGAR responses recorded by scripts/record.py.

No network: each fixture is a `{"params": ..., "body": ...}` JSON file under
tests/fixtures/sec_edgar/, replayed through a fake session.
"""

import json
from datetime import date, timedelta
from pathlib import Path

from ai_trading_common.providers.sec_edgar import SecEdgar, SecEdgarSource, eight_k_as_of
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent.parent / "fixtures" / "sec_edgar"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def sec_for(*fixture_names: str) -> tuple[SecEdgar, object]:
    responses = [FakeResponse(200, load(name)["body"]) for name in fixture_names]
    client, session, _ = make_client(responses)
    return SecEdgar("ai-trading-common/0.1 (test)", http=client), session


class TestCompanyFactsFixture:
    def test_a_real_restated_fact_is_seen_only_from_its_own_filed_date(self):
        # MSFT NetIncomeLoss for 2015-07-01..2015-09-30: first filed 4,620M
        # (2015-10-22), later restated to 4,902M by a filing on 2016-04-21.
        # The client caches nothing, so each `company_facts` call needs its
        # own pair of fixtures (ticker map, then CompanyFacts).
        before_sec, _ = sec_for("company_tickers", "companyfacts_msft")
        after_sec, _ = sec_for("company_tickers", "companyfacts_msft")
        before = before_sec.company_facts("MSFT", date(2015, 12, 1))
        after = after_sec.company_facts("MSFT", date(2016, 5, 1))
        period = (date(2015, 7, 1), date(2015, 9, 30))
        before_val = next(f.value for f in before if (f.period_start, f.period_end) == period)
        after_val = next(f.value for f in after if (f.period_start, f.period_end) == period)
        assert before_val == 4_620_000_000.0
        assert after_val == 4_902_000_000.0

    def test_an_instant_assets_fact_has_no_period_start(self):
        sec, _ = sec_for("company_tickers", "companyfacts_aapl")
        facts = sec.company_facts("AAPL", date(2026, 1, 1), concepts=("Assets",))
        assert facts and all(f.period_start is None and f.span == "instant" for f in facts)
        assert all(f.provider == "sec_edgar" and f.quality == "eod" for f in facts)


class TestSubmissionsFixture:
    # The recorded AAPL fixture's `filings.recent` window reaches back to
    # 2025-07-25 (its oldest kept row); `since` at that exact floor needs no
    # `filings.files` page.
    AAPL_RECENT_FLOOR = date(2025, 7, 25)

    def test_item_202_filings_are_the_8k_rows_only(self):
        sec, _ = sec_for("company_tickers", "submissions_aapl")
        got = sec.item_202_filings("AAPL", since=self.AAPL_RECENT_FLOOR)
        assert got  # the recorded window has at least one
        assert all("2.02" in f.items for f in got)

    def test_filings_are_known_from_their_own_filed_date_not_before(self):
        sec, _ = sec_for("company_tickers", "submissions_aapl")
        all_filings = sec.item_202_filings("AAPL", since=self.AAPL_RECENT_FLOOR)
        earliest = min(f.filed for f in all_filings)
        assert eight_k_as_of(all_filings, earliest - timedelta(days=1)) == []
        assert any(f.filed == earliest for f in eight_k_as_of(all_filings, earliest))


class TestJpmPagingFixture:
    """JPMorgan (CIK 0000019617): a heavy filer whose `filings.recent` is large
    (26,293 rows, live-confirmed) but still only reaches back to 2025-10-10 —
    about a year, not the "last ~1,000 filings" AAPL/MSFT's much smaller
    `recent` suggested (see REPORT-P2.md). A `since` before that floor needs
    one `filings.files` page.
    """

    RECENT_FLOOR = date(2025, 10, 10)

    def test_a_since_before_recents_floor_fetches_exactly_one_older_page(self):
        sec, session = sec_for("company_tickers", "submissions_jpm", "submissions_jpm_page1")
        got = sec.item_202_filings("JPM", since=date(2025, 9, 10))
        # Live-confirmed: JPM's filings.files page 001 (2025-09-08..2025-10-08)
        # happened to carry no Item 2.02 8-K of its own (no earnings release
        # fell in that window) — a correct, non-partial empty contribution,
        # not evidence the page was skipped or the mechanism broken.
        assert all(f.filed >= self.RECENT_FLOOR for f in got)
        assert len(session.calls) == 3  # tickers + submissions root + exactly one page

    def test_at_or_after_recents_floor_needs_no_page(self):
        sec, session = sec_for("company_tickers", "submissions_jpm")
        sec.item_202_filings("JPM", since=self.RECENT_FLOOR)
        assert len(session.calls) == 2  # no filings.files page fetched


class TestSecEdgarSourceAdapter:
    """Maps the recorded fixtures into the shared neutral types (02j §9: "Adapters")."""

    def test_facts_returns_shared_fact_type(self):
        sec, _ = sec_for("company_tickers", "companyfacts_aapl")
        source = SecEdgarSource(sec)
        facts = source.facts("AAPL", as_of=date(2026, 1, 1), concepts=("Assets",))
        assert facts
        assert all(f.provider == "sec_edgar" and f.quality == "eod" for f in facts)

    def test_announcements_maps_8k_filings_into_earnings_announcements(self):
        sec, _ = sec_for("company_tickers", "submissions_aapl")
        source = SecEdgarSource(sec)
        got = source.announcements("AAPL", since=TestSubmissionsFixture.AAPL_RECENT_FLOOR)
        assert got
        assert all(a.symbol == "AAPL" and a.provider == "sec_edgar" and a.quality == "eod" for a in got)
        assert all(isinstance(a.reference, str) and a.announced_on for a in got)
