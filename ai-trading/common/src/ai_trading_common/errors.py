"""Provider error taxonomy shared by every ai-trading data client.

One hierarchy so callers (a fallback chain, a strategy evaluator) react by
*behavior*, not by provider:

    ProviderError
    ├── NotConfigured   no key, or the key was rejected
    ├── Unavailable     unreachable, timed out, 5xx, or malformed after bounded retries
    │   └── SoftBanned  the host's soft-ban latch is set; no request was sent
    └── NoData          the provider answered and has nothing for this request

``NotConfigured``, ``Unavailable``, and ``SoftBanned`` say nothing about the
instrument and should fall through to the next provider in a chain. ``NoData``
is a real answer (unknown symbol, no filings) and must not be hidden behind a
fallback's result (pattern: TradingAgents ``dataflows/router.py``).
"""

from __future__ import annotations


class ProviderError(Exception):
    """Base for any condition where a provider could not return usable data."""

    def __init__(self, provider: str, message: str) -> None:
        self.provider = provider
        super().__init__(f"{provider}: {message}")


class NotConfigured(ProviderError):
    """No key was supplied, or the provider rejected it."""


class Unavailable(ProviderError):
    """Unreachable, timed out, returned 5xx, or malformed after bounded retries."""


class SoftBanned(Unavailable):
    """The host's soft-ban latch is set, so no request was sent."""


class NoData(ProviderError):
    """The provider answered and has nothing for this request (not an outage)."""
