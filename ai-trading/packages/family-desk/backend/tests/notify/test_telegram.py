import requests

from ai_trading.notify.channel import DEFAULT_POST_TIMEOUT_SECONDS, ChannelError
from ai_trading.notify.telegram import TelegramChannel

_BOT_TOKEN = "123456789:FAKEtestTOKENnotreal00000000000"
_CHAT_ID = "-100555"


class _Response:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


def test_send_posts_to_the_bot_api_and_succeeds_on_2xx():
    calls = []

    def post(url: str, payload: dict):
        calls.append((url, payload))
        return _Response(200)

    TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="Breakout", body="AAPL crossed VWAP", severity="info")

    [(url, payload)] = calls
    assert url == f"https://api.telegram.org/bot{_BOT_TOKEN}/sendMessage"
    assert payload["chat_id"] == _CHAT_ID
    assert "Breakout" in payload["text"]


def test_send_raises_channel_error_on_non_2xx_response():
    def post(url: str, payload: dict):
        return _Response(400, "Bad Request: chat not found")

    try:
        TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert "400" in str(exc)


def test_send_raises_channel_error_on_a_request_exception():
    def post(url: str, payload: dict):
        raise requests.ConnectionError("connection refused")

    try:
        TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError:
        pass


def test_send_never_leaks_the_bot_token_on_a_non_2xx_response():
    def post(url: str, payload: dict):
        # Some APIs echo the request URL (with its credential-shaped path segment) in an error body.
        return _Response(403, f"Forbidden: bad token in {url}")

    try:
        TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert _BOT_TOKEN not in str(exc)
        assert "/bot[redacted]/" in str(exc) or "[redacted]" in str(exc)


def test_default_post_sends_json_body_with_a_10_second_timeout(monkeypatch):
    # Integration fix: the default `post` must call `requests.post(url, json=payload,
    # timeout=...)`, never `requests.post(url, payload)` (form data, no timeout).
    calls = []

    def fake_requests_post(url, **kwargs):
        calls.append((url, kwargs))
        return _Response(200)

    monkeypatch.setattr("ai_trading.notify.telegram.requests.post", fake_requests_post)

    TelegramChannel(_BOT_TOKEN, _CHAT_ID).send(title="t", body="b", severity="info")

    [(url, kwargs)] = calls
    assert url == f"https://api.telegram.org/bot{_BOT_TOKEN}/sendMessage"
    assert "data" not in kwargs
    assert kwargs["json"]["chat_id"] == _CHAT_ID
    assert kwargs["timeout"] == DEFAULT_POST_TIMEOUT_SECONDS == 10.0


def test_send_never_leaks_the_bot_token_on_a_request_exception():
    def post(url: str, payload: dict):
        raise requests.ConnectionError(f"Failed to establish a new connection: {url}")

    try:
        TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert _BOT_TOKEN not in str(exc)
        assert _CHAT_ID not in str(exc)
