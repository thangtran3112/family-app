import pytest

from ai_trading_common.errors import NoData, NotConfigured, SoftBanned, Unavailable
from ai_trading_common.fallback import first_success


def raiser(exc):
    def _call():
        raise exc

    return _call


class TestHappyPath:
    def test_the_primary_calls_result_is_marked_primary(self):
        result, is_primary = first_success([lambda: "primary"])
        assert result == "primary"
        assert is_primary is True

    def test_a_later_calls_result_is_marked_not_primary(self):
        result, is_primary = first_success([raiser(Unavailable("p1", "down")), lambda: "secondary"])
        assert result == "secondary"
        assert is_primary is False

    def test_never_calls_after_one_succeeds(self):
        calls = []

        def third():
            calls.append("third")
            return "unreached"

        first_success([lambda: calls.append("first") or "primary", third])
        assert calls == ["first"]


class TestFallThrough:
    @pytest.mark.parametrize("exc", [NotConfigured("p", "no key"), Unavailable("p", "down"), SoftBanned("p", "banned")])
    def test_transient_errors_fall_through_to_the_next_call(self, exc):
        result, is_primary = first_success([raiser(exc), lambda: "secondary"])
        assert result == "secondary"
        assert is_primary is False


class TestFailureModes:
    def test_every_call_no_data_raises_no_data(self):
        with pytest.raises(NoData):
            first_success([raiser(NoData("p1", "none")), raiser(NoData("p2", "none"))])

    def test_a_transient_failure_is_reported_over_a_later_no_data(self):
        # The brief's rule: an outage must not be hidden behind "no data".
        with pytest.raises(Unavailable):
            first_success([raiser(Unavailable("p1", "down")), raiser(NoData("p2", "none"))])

    def test_a_transient_failure_is_reported_even_when_it_came_first(self):
        with pytest.raises(SoftBanned):
            first_success([raiser(SoftBanned("p1", "banned")), raiser(NoData("p2", "none"))])

    def test_empty_call_list_is_a_programming_error(self):
        with pytest.raises(ValueError):
            first_success([])
