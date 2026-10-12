"""The one shape every alert-delivery channel implements (02a §5, 02c Shared Interfaces)."""

from typing import Protocol, runtime_checkable

#: Integration fix: the default HTTP call every `Channel` implementation makes is
#: `requests.post(url, json=payload, timeout=DEFAULT_POST_TIMEOUT_SECONDS)`, never a bare
#: `post(url, payload)` (which sends `payload` as form data via `requests`' own `data=` default
#: positional parameter, and has no timeout at all). Shared by `telegram.py`/`slack.py`.
DEFAULT_POST_TIMEOUT_SECONDS = 10.0


class ChannelError(Exception):
    """Raised by a Channel.send failure. __str__ must never contain a secret (redact.py)."""


@runtime_checkable
class Channel(Protocol):
    name: str  # "telegram" | "slack"

    def send(self, *, title: str, body: str, severity: str) -> None: ...
