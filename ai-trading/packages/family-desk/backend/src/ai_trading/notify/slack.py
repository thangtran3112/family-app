"""A Slack incoming-webhook channel (02a §5: "Telegram bot message or Slack incoming webhook")."""

from collections.abc import Callable

import requests

from ai_trading.notify.channel import DEFAULT_POST_TIMEOUT_SECONDS, ChannelError
from ai_trading.notify.redact import redact


def _default_post(url: str, payload: dict) -> requests.Response:
    """Integration fix: JSON body, with a timeout -- not `requests.post(url, payload)` (form
    data, no timeout). Slack's real incoming-webhook endpoint expects `Content-Type:
    application/json`."""
    return requests.post(url, json=payload, timeout=DEFAULT_POST_TIMEOUT_SECONDS)


class SlackChannel:
    name = "slack"

    def __init__(
        self,
        webhook_url: str,
        *,
        post: Callable[[str, dict], requests.Response] = _default_post,
    ) -> None:
        self._webhook_url = webhook_url
        self._post = post

    def send(self, *, title: str, body: str, severity: str) -> None:
        payload = {"text": f"*[{severity.upper()}] {title}*\n{body}"}
        try:
            response = self._post(self._webhook_url, payload)
        except requests.RequestException as exc:
            raise ChannelError(redact(str(exc), self._webhook_url)) from exc
        if not 200 <= response.status_code < 300:
            message = f"slack responded {response.status_code}: {response.text}"
            raise ChannelError(redact(message, self._webhook_url))
