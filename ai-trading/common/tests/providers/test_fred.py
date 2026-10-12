from datetime import date

import pytest

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.providers.fred import Fred
from ai_trading_common.testing import FakeResponse, make_client
from ai_trading_common.types import Observation

# Live-probed FRED error bodies (see REPORT-P2.md): a 400 always carries a
# JSON `error_message`, distinguished by which variable name it names.
BAD_KEY_BODY = {
    "error_code": 400,
    "error_message": "Bad Request.  The value for variable api_key is not a 32 character alpha-numeric "
    "lower-case string.",
}
UNKNOWN_SERIES_BODY = {
    "error_code": 400,
    "error_message": "Bad Request.  Invalid value for variable series_id.  Series IDs should be 25 or less "
    "alphanumeric characters.",
}


def obs(date_str, value, pit):
    return {"realtime_start": pit, "realtime_end": pit, "date": date_str, "value": value}


class TestObservations:
    def test_parses_observations_at_the_pinned_vintage(self):
        body = {"observations": [obs("2020-01-01", "258.82", "2020-06-01")]}
        client, session, _ = make_client([FakeResponse(200, body)])
        fred = Fred("key", http=client)
        got = fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 6, 1))
        assert got == [
            Observation(
                series_id="CPIAUCSL",
                date=date(2020, 1, 1),
                value=258.82,
                realtime_start=date(2020, 6, 1),
                realtime_end=date(2020, 6, 1),
                provider="fred",
                quality="eod",
            )
        ]
        params = session.calls[0][1]
        assert params["realtime_start"] == params["realtime_end"] == "2020-06-01"

    def test_freds_own_missing_marker_is_filtered_not_parsed_as_a_value(self):
        body = {"observations": [obs("2020-01-01", ".", "2020-02-01")]}
        client, _, _ = make_client([FakeResponse(200, body)])
        fred = Fred("key", http=client)
        with pytest.raises(NoData):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 2, 1))

    def test_an_empty_range_raises_no_data(self):
        # Live-probed: FRED answers 200 with an empty list, not an error.
        client, _, _ = make_client([FakeResponse(200, {"observations": []})])
        fred = Fred("key", http=client)
        with pytest.raises(NoData):
            fred.observations("CPIAUCSL", date(2099, 1, 1), date(2099, 2, 1), as_of=date(2099, 1, 1))

    def test_empty_key_raises_not_configured_without_a_request(self):
        client, session, _ = make_client([])
        fred = Fred("", http=client)
        with pytest.raises(NotConfigured):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))
        assert session.calls == []

    def test_a_rejected_key_raises_not_configured(self):
        client, _, _ = make_client([FakeResponse(400, BAD_KEY_BODY)])
        fred = Fred("bogus", http=client)
        with pytest.raises(NotConfigured):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))

    def test_an_unknown_series_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(400, UNKNOWN_SERIES_BODY)])
        fred = Fred("key", http=client)
        with pytest.raises(NoData):
            fred.observations("NOT_A_SERIES", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))

    def test_an_unclassified_400_raises_unavailable(self):
        client, _, _ = make_client([FakeResponse(400, {"error_message": "Bad Request. Something else."})])
        fred = Fred("key", http=client)
        with pytest.raises(Unavailable):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))

    def test_500_raises_unavailable_after_bounded_retries(self):
        client, session, _ = make_client([FakeResponse(500)] * 10)
        fred = Fred("key", http=client)
        with pytest.raises(Unavailable):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))
        assert len(session.calls) == 4


class TestReleaseDates:
    def test_resolves_the_release_then_lists_its_dates(self):
        release_body = {"releases": [{"id": 10, "name": "Consumer Price Index"}]}
        dates_body = {
            "release_dates": [{"release_id": 10, "date": "2024-02-13"}, {"release_id": 10, "date": "2024-01-11"}]
        }
        client, session, _ = make_client([FakeResponse(200, release_body), FakeResponse(200, dates_body)])
        fred = Fred("key", http=client)
        got = fred.release_dates("CPIAUCSL")
        assert got == [date(2024, 1, 11), date(2024, 2, 13)]
        assert session.calls[1][1]["release_id"] == 10

    def test_as_of_keeps_only_dates_known_by_then(self):
        release_body = {"releases": [{"id": 10}]}
        dates_body = {"release_dates": [{"date": "2024-02-13"}, {"date": "2024-01-11"}]}
        client, _, _ = make_client([FakeResponse(200, release_body), FakeResponse(200, dates_body)])
        fred = Fred("key", http=client)
        got = fred.release_dates("CPIAUCSL", as_of=date(2024, 1, 15))
        assert got == [date(2024, 1, 11)]

    def test_no_release_found_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(200, {"releases": []})])
        fred = Fred("key", http=client)
        with pytest.raises(NoData):
            fred.release_dates("NOT_A_SERIES")
