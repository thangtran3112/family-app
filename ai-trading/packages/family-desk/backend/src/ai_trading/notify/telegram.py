"""A Telegram bot message channel (02a §5: "Telegram bot message or Slack incoming webhook")."""

from collections.abc import Callable

import requests

from ai_trading.notify.channel import DEFAULT_POST_TIMEOUT_SECONDS, ChannelError, ChannelNotConnected
from ai_trading.notify.redact import redact

_API_BASE = "https://api.telegram.org"
_MAX_TEXT = 4096  # Telegram refuses a longer message outright ("message is too long")


def _default_post(url: str, payload: dict) -> requests.Response:
    """Integration fix: JSON body, with a timeout -- not `requests.post(url, payload)` (form
    data, no timeout)."""
    return requests.post(url, json=payload, timeout=DEFAULT_POST_TIMEOUT_SECONDS)


class TelegramChannel:
    name = "telegram"

    def __init__(
        self,
        bot_token: str,
        chat_id: str | None = None,
        *,
        post: Callable[[str, dict], requests.Response] = _default_post,
    ) -> None:
        self._bot_token = bot_token
        self._chat_id = chat_id
        self._post = post

    def send(self, *, title: str, body: str, severity: str, chat_id: str | None = None) -> None:
        """`chat_id` sends to that chat instead of the configured one (a user's own linked chat). With neither,
        nothing is sent: no chat is connected."""
        target = chat_id or self._chat_id
        if not target:
            raise ChannelNotConnected("no Telegram chat is linked")
        url = f"{_API_BASE}/bot{self._bot_token}/sendMessage"
        text = f"[{severity.upper()}] {title}\n\n{body}"[:_MAX_TEXT]
        payload = {"chat_id": target, "text": text}
        try:
            response = self._post(url, payload)
        except requests.RequestException as exc:
            raise ChannelError(redact(str(exc), self._bot_token, target)) from exc
        if not 200 <= response.status_code < 300:
            message = f"telegram responded {response.status_code}: {response.text}"
            raise ChannelError(redact(message, self._bot_token, target))
