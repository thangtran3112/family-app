"""The one shape every alert-delivery channel implements (02a §5, 02c Shared Interfaces)."""

from typing import Any, Protocol, runtime_checkable

from ai_trading.runtime_flags import alerts_runtime_enabled

#: Integration fix: the default HTTP call every `Channel` implementation makes is
#: `requests.post(url, json=payload, timeout=DEFAULT_POST_TIMEOUT_SECONDS)`, never a bare
#: `post(url, payload)` (which sends `payload` as form data via `requests`' own `data=` default
#: positional parameter, and has no timeout at all). Shared by `telegram.py`/`slack.py`.
DEFAULT_POST_TIMEOUT_SECONDS = 10.0


class ChannelError(Exception):
    """Raised by a Channel.send failure. __str__ must never contain a secret (redact.py)."""


class ChannelNotConnected(ChannelError):
    """The channel cannot send right now and retrying will not change that (alerts are off, or no chat is linked).
    `dispatch_pending` records the delivery as `no_channel` at once instead of retrying it."""


@runtime_checkable
class Channel(Protocol):
    name: str  # "telegram" | "slack"

    def send(self, *, title: str, body: str, severity: str) -> None: ...


class RuntimeGated:
    """Wraps a real channel so nothing leaves while `alerts_runtime_enabled()` is off (02m §b5 item 6): the
    inbox is the only delivery until the owner turns the alert runtime on. The flag is read on every send."""

    def __init__(self, inner: Channel) -> None:
        self._inner = inner
        self.name = inner.name

    def send(self, **message: Any) -> None:
        if not alerts_runtime_enabled():
            raise ChannelNotConnected("alerts are not turned on for this Desk")
        self._inner.send(**message)
