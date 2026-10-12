import requests

from ai_trading.notify.channel import DEFAULT_POST_TIMEOUT_SECONDS, ChannelError
from ai_trading.notify.slack import SlackChannel

_WEBHOOK_URL = "https://example.test/webhook/FAKE-SECRET-4"


class _Response:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


def test_send_posts_to_the_webhook_and_succeeds_on_2xx():
    calls = []

    def post(url: str, payload: dict):
        calls.append((url, payload))
        return _Response(200, "ok")

    SlackChannel(_WEBHOOK_URL, post=post).send(title="ORB breakout", body="MES broke overnight high", severity="info")

    [(url, payload)] = calls
    assert url == _WEBHOOK_URL
    assert "ORB breakout" in payload["text"]


def test_send_raises_channel_error_on_non_2xx_response():
    def post(url: str, payload: dict):
        return _Response(404, "no_service")

    try:
        SlackChannel(_WEBHOOK_URL, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert "404" in str(exc)


def test_send_raises_channel_error_on_a_request_exception():
    def post(url: str, payload: dict):
        raise requests.Timeout("timed out")

    try:
        SlackChannel(_WEBHOOK_URL, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError:
        pass


def test_send_never_leaks_the_webhook_url_on_a_non_2xx_response():
    def post(url: str, payload: dict):
        return _Response(400, f"invalid_payload for {url}")

    try:
        SlackChannel(_WEBHOOK_URL, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert _WEBHOOK_URL not in str(exc)
        assert "[redacted]" in str(exc)


def test_default_post_sends_json_body_with_a_10_second_timeout(monkeypatch):
    # Integration fix: the default `post` must call `requests.post(url, json=payload,
    # timeout=...)`, never `requests.post(url, payload)` (form data, no timeout).
    calls = []

    def fake_requests_post(url, **kwargs):
        calls.append((url, kwargs))
        return _Response(200, "ok")

    monkeypatch.setattr("ai_trading.notify.slack.requests.post", fake_requests_post)

    SlackChannel(_WEBHOOK_URL).send(title="t", body="b", severity="info")

    [(url, kwargs)] = calls
    assert url == _WEBHOOK_URL
    assert "data" not in kwargs
    assert "text" in kwargs["json"]
    assert kwargs["timeout"] == DEFAULT_POST_TIMEOUT_SECONDS == 10.0


def test_send_never_leaks_the_webhook_url_on_a_connection_error():
    def post(url: str, payload: dict):
        raise requests.exceptions.ConnectionError(
            f"HTTPSConnectionPool(host='hooks.slack.com', port=443): Max retries exceeded "
            f"with url: {url} (Caused by NewConnectionError('...'))"
        )

    try:
        SlackChannel(_WEBHOOK_URL, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert _WEBHOOK_URL not in str(exc)
