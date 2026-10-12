"""Contract tests against real FRED responses recorded by scripts/record.py."""

import json
from datetime import date
from pathlib import Path

from ai_trading_common.providers.fred import Fred
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent.parent / "fixtures" / "fred"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def fred_for(*fixture_names: str) -> Fred:
    responses = [FakeResponse(200, load(name)["body"]) for name in fixture_names]
    client, _, _ = make_client(responses)
    return Fred("key", http=client)


class TestVintagePinning:
    def test_cpiaucsl_2019_06_reads_as_first_published_not_the_later_revision(self):
        fred = fred_for("cpiaucsl_early")
        got = fred.observations("CPIAUCSL", date(2019, 6, 1), date(2019, 6, 1), as_of=date(2019, 7, 20))
        assert got[0].value == 255.305

    def test_cpiaucsl_2019_06_reads_as_revised_at_a_later_vintage(self):
        fred = fred_for("cpiaucsl_revised")
        got = fred.observations("CPIAUCSL", date(2019, 6, 1), date(2019, 6, 1), as_of=date(2024, 3, 1))
        assert got[0].value == 255.213
        assert got[0].value != 255.305  # the real, live-confirmed revision

    def test_unrate_2019_06_also_differs_across_vintages(self):
        early = fred_for("unrate_early").observations(
            "UNRATE", date(2019, 6, 1), date(2019, 6, 1), as_of=date(2019, 8, 1)
        )
        revised = fred_for("unrate_revised").observations(
            "UNRATE", date(2019, 6, 1), date(2019, 6, 1), as_of=date(2021, 2, 1)
        )
        assert early[0].value == 3.7
        assert revised[0].value == 3.6


class TestReleaseDatesFixture:
    def test_release_dates_parse_into_sorted_dates(self):
        release_body = load("cpi_release")["body"]
        dates_body = load("cpi_release_dates")["body"]
        responses = [FakeResponse(200, release_body), FakeResponse(200, dates_body)]
        client, _, _ = make_client(responses)
        fred = Fred("key", http=client)
        got = fred.release_dates("CPIAUCSL")
        assert got == sorted(got)
        assert len(got) == len(dates_body["release_dates"])
