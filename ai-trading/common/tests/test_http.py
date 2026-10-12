import pytest
import requests

from ai_trading_common.errors import SoftBanned, Unavailable
from ai_trading_common.testing import FakeResponse, make_client


class TestThrottling:
    def test_consecutive_calls_to_one_bucket_are_spaced_at_least_min_interval_apart(self):
        client, _, clock = make_client([FakeResponse(200, {"ok": 1})] * 3)
        for _ in range(3):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", min_interval=5.0)
        # Three calls at min_interval=5 span at least two intervals.
        assert clock.now() >= 10.0

    def test_distinct_buckets_dont_block_each_other(self):
        client, _, clock = make_client([FakeResponse(200, {"ok": 1})] * 2)
        client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", min_interval=5.0)
        client.get("https://x/", provider="p", host_key="host-b", user_agent="ua", min_interval=5.0)
        assert clock.now() == 0.0  # neither call waited on the other's bucket


class TestSoftBan:
    def test_429_latches_the_host_and_blocks_the_next_call_without_sending_it(self):
        client, session, clock = make_client([FakeResponse(429, headers={"Retry-After": "30"})])
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert len(session.calls) == 1
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert len(session.calls) == 1  # the second call never hit the network

    def test_latch_honors_retry_after_and_expires(self):
        responses = [FakeResponse(429, headers={"Retry-After": "30"}), FakeResponse(200, {"ok": 1})]
        client, session, clock = make_client(responses)
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        clock.t += 29.0
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        clock.t += 2.0  # now past the 30s cooldown
        client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert len(session.calls) == 2

    def test_403_latches_only_when_the_caller_declares_the_host_ban_prone(self):
        client, _, _ = make_client([FakeResponse(403)])
        response = client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", ban_prone=False)
        assert response.status_code == 403  # not latched; caller maps it itself

        client, _, _ = make_client([FakeResponse(403)])
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", ban_prone=True)

    def test_403_latch_falls_back_to_default_cooldown_without_retry_after(self):
        client, session, clock = make_client([FakeResponse(403), FakeResponse(200, {"ok": 1})])
        kwargs = dict(provider="p", host_key="host-a", user_agent="ua", ban_prone=True, default_cooldown=10.0)
        with pytest.raises(SoftBanned):
            client.get("https://x/", **kwargs)
        clock.t += 10.0
        client.get("https://x/", **kwargs)
        assert len(session.calls) == 2


class TestRetries:
    def test_retries_are_bounded_on_repeated_5xx(self):
        client, session, clock = make_client([FakeResponse(500)] * 10)
        with pytest.raises(Unavailable):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", retries=2)
        assert len(session.calls) == 3  # 1 initial + 2 retries, never more

    def test_succeeds_after_a_transient_connection_error(self):
        client, session, clock = make_client([requests.ConnectionError("boom"), FakeResponse(200, {"ok": 1})])
        response = client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert response.status_code == 200
        assert len(session.calls) == 2

    def test_timeout_exhausts_retries_and_raises_unavailable(self):
        client, session, _ = make_client([requests.Timeout("slow")] * 10)
        with pytest.raises(Unavailable):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", retries=1)
        assert len(session.calls) == 2

    def test_unavailable_never_carries_the_failing_url_or_its_query_key(self):
        leak = requests.ConnectionError("Max retries exceeded with url: /v1/x?token=SECRET123")
        client, _, _ = make_client([leak] * 3)
        with pytest.raises(Unavailable) as caught:
            client.get("https://x/v1/x", provider="p", host_key="host-a", user_agent="ua", retries=1)
        assert "SECRET123" not in str(caught.value)
        assert caught.value.__cause__ is None and caught.value.__suppress_context__

    def test_a_4xx_other_than_429_403_is_returned_without_retry(self):
        client, session, _ = make_client([FakeResponse(404)])
        response = client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert response.status_code == 404
        assert len(session.calls) == 1


class TestGetJson:
    def test_decodes_json_body(self):
        client, _, _ = make_client([FakeResponse(200, {"bars": [1, 2]})])
        assert client.get_json("https://x/", provider="p", host_key="host-a", user_agent="ua") == {"bars": [1, 2]}

    def test_malformed_json_raises_unavailable(self):
        client, _, _ = make_client([FakeResponse(200, "not-json")])
        with pytest.raises(Unavailable):
            client.get_json("https://x/", provider="p", host_key="host-a", user_agent="ua")
