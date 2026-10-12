"""The as-of selectors (02j §4): `facts_as_of`, `announcements_as_of`, `news_as_of`.

Pure functions on `types.py` objects -- no network, no provider fixture needed. Each provider's
own parsing into these types is covered by its own `tests/providers/test_<name>.py`.
"""

from datetime import date

import pandas as pd

from ai_trading_common.types import EarningsAnnouncement, Fact, NewsItem, announcements_as_of, facts_as_of, news_as_of


def _fact(period_end, filed, value=1.0, concept="Assets", unit="USD", span="instant", reference="a") -> Fact:
    return Fact(
        concept=concept,
        unit=unit,
        value=value,
        period_start=None,
        period_end=period_end,
        span=span,
        fiscal_year=None,
        fiscal_period=None,
        form="10-K",
        filed=filed,
        reference=reference,
        provider="sec_edgar",
        quality="eod",
    )


class TestFactsAsOf:
    def test_a_fact_filed_after_as_of_is_unknown(self):
        facts = [_fact(date(2020, 1, 1), date(2020, 2, 1))]
        assert facts_as_of(facts, date(2020, 1, 15)) == []

    def test_a_later_amendment_wins_only_from_its_own_filed_date(self):
        end, concept, span = date(2007, 9, 29), "NetIncomeLoss", "annual"
        original = _fact(end, date(2009, 10, 27), value=3496.0, concept=concept, span=span, reference="orig")
        amendment = _fact(end, date(2010, 1, 25), value=3495.0, concept=concept, span=span, reference="amend")
        facts = [original, amendment]
        assert [f.value for f in facts_as_of(facts, date(2009, 12, 1))] == [3496.0]
        assert [f.value for f in facts_as_of(facts, date(2010, 2, 1))] == [3495.0]

    def test_different_spans_of_the_same_period_end_are_kept_separately(self):
        end = date(2020, 3, 31)
        quarterly = _fact(end, date(2020, 4, 1), value=10.0, concept="Revenues", span="quarterly")
        annual = _fact(end, date(2020, 5, 1), value=40.0, concept="Revenues", span="annual", reference="b")
        assert len(facts_as_of([quarterly, annual], date(2020, 6, 1))) == 2


class TestAnnouncementsAsOf:
    def test_only_announcements_known_by_as_of_are_kept_and_sorted(self):
        announcements = [
            EarningsAnnouncement(
                symbol="AAPL", announced_on=date(2024, 3, 1), reference="later", provider="sec_edgar", quality="eod"
            ),
            EarningsAnnouncement(
                symbol="AAPL", announced_on=date(2024, 1, 1), reference="earlier", provider="sec_edgar", quality="eod"
            ),
        ]
        got = announcements_as_of(announcements, date(2024, 2, 1))
        assert [a.reference for a in got] == ["earlier"]


class TestNewsAsOf:
    def test_drops_anything_published_after_the_cutoff(self):
        early = NewsItem(
            symbol="AAPL",
            headline="early",
            publisher="x",
            url="",
            published_at=pd.Timestamp("2026-01-01T00:00:00Z"),
            provider="finnhub",
            quality="eod",
        )
        late = NewsItem(
            symbol="AAPL",
            headline="late",
            publisher="x",
            url="",
            published_at=pd.Timestamp("2026-01-02T00:00:00Z"),
            provider="finnhub",
            quality="eod",
        )
        got = news_as_of([early, late], pd.Timestamp("2026-01-01T12:00:00Z"))
        assert got == [early]
