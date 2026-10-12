"""Throttled HTTP: per-host minimum spacing, bounded retries, and a soft-ban latch.

Adapted from Vibe-Trading `agent/backtest/loaders/_http.py`
(`HostThrottle`/`throttled_get_json`, upstream commit `d402c2df9bc6162f314df5bc5d06ba30ebc3332d`,
MIT License; see THIRD_PARTY_NOTICES.md). Changes from upstream:
- dropped the environment-variable lookups and `positive_env_float`: callers pass
  `min_interval` explicitly;
- callers must pass a `user_agent` (several providers, including SEC, require one
  declared per request rather than a shared default);
- added bounded retries with backoff for timeouts, connection errors, and 5xx,
  raising `ai_trading_common.errors.Unavailable` once exhausted;
- added a soft-ban latch per host key: a 429, or a 403 on a host the caller
  declares `ban_prone`, latches that host until `Retry-After` elapses (or a
  default cooldown), raising `ai_trading_common.errors.SoftBanned`. While
  latched, no request is sent.
- the clock and sleep are injectable, so tests pin the throttle's timing with a
  fake clock instead of a real sleep.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from collections.abc import Callable
from typing import Any

import requests

from ai_trading_common.errors import SoftBanned, Unavailable

logger = logging.getLogger(__name__)

# Upper bound on the random jitter (seconds) added on top of the configured
# minimum interval, so parallel callers de-synchronize instead of all firing the
# instant the interval elapses (unchanged from upstream).
_JITTER_MAX_S = 0.4

DEFAULT_COOLDOWN_S = 60.0
DEFAULT_RETRY_BACKOFFS = (1.0, 2.0, 4.0)


class HostThrottle:
    """Minimum-spacing gate keyed by an arbitrary host bucket, plus a soft-ban latch.

    `wait(bucket, min_interval)` blocks until at least `min_interval` seconds
    (plus jitter) have elapsed since the last request tagged with the same
    `bucket`; distinct buckets never block each other. `latch`/`banned_until`
    implement the soft-ban: a banned bucket is checked and raises before any
    request is attempted.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        jitter: Callable[[float, float], float] = random.uniform,
    ) -> None:
        self._clock = clock
        self._sleep = sleep
        self._jitter = jitter
        self._lock = threading.Lock()
        self._last: dict[str, float] = {}
        self._banned_until: dict[str, float] = {}

    def latch(self, bucket: str, cooldown: float) -> None:
        with self._lock:
            self._banned_until[bucket] = self._clock() + max(cooldown, 0.0)

    def banned_for(self, bucket: str) -> float:
        """Seconds left on `bucket`'s ban, or 0 when it is not (or no longer) banned."""
        with self._lock:
            until = self._banned_until.get(bucket)
        if until is None:
            return 0.0
        return max(until - self._clock(), 0.0)

    def wait(self, bucket: str, min_interval: float) -> None:
        if min_interval <= 0:
            return
        with self._lock:
            now = self._clock()
            last = self._last.get(bucket)
            if last is None or now >= last + min_interval:
                fire_at = now
            else:
                fire_at = last + min_interval + self._jitter(0.0, _JITTER_MAX_S)
            self._last[bucket] = fire_at
        sleep_for = fire_at - self._clock()
        if sleep_for > 0:
            self._sleep(sleep_for)


def _retry_after_seconds(response: requests.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


class ThrottledClient:
    """A `requests.Session` gated by `HostThrottle`, with bounded retries.

    One instance per process is enough: `host_key` buckets separate providers
    (and, within a provider, separate ban-prone sub-hosts) in the same throttle
    and ban state.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        jitter: Callable[[float, float], float] = random.uniform,
        session: requests.Session | None = None,
    ) -> None:
        self.throttle = HostThrottle(clock=clock, sleep=sleep, jitter=jitter)
        self._sleep = sleep
        self._session = session or requests.Session()

    def get(
        self,
        url: str,
        *,
        provider: str,
        host_key: str,
        user_agent: str,
        min_interval: float = 0.0,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 15.0,
        ban_prone: bool = False,
        default_cooldown: float = DEFAULT_COOLDOWN_S,
        retries: int = len(DEFAULT_RETRY_BACKOFFS),
    ) -> requests.Response:
        """GET `url`, honoring the throttle and the soft-ban latch.

        Raises `SoftBanned` immediately (no request sent) while `host_key` is
        latched, or on a 429 (any host) or a 403 on a `ban_prone` host, which
        also latches it for `Retry-After` seconds or `default_cooldown`.
        Raises `Unavailable` after `retries` bounded retries on a timeout,
        connection error, or 5xx. Any other status is returned to the caller to
        interpret (an unknown symbol, a bad key, and so on are provider-specific).
        """
        banned_for = self.throttle.banned_for(host_key)
        if banned_for > 0:
            raise SoftBanned(provider, f"{host_key} is soft-banned for {banned_for:.0f}s more")

        merged_headers = {"User-Agent": user_agent}
        if headers:
            merged_headers.update(headers)

        attempt = 0
        while True:
            self.throttle.wait(host_key, min_interval)
            try:
                response = self._session.get(url, params=params, headers=merged_headers, timeout=timeout)
            except (requests.ConnectionError, requests.Timeout) as exc:
                if attempt >= retries:
                    # requests' message carries the full URL, and some providers put the key in the query
                    message = f"{host_key} unreachable after {attempt + 1} attempt(s): {type(exc).__name__}"
                    raise Unavailable(provider, message) from None
                self._sleep(DEFAULT_RETRY_BACKOFFS[min(attempt, len(DEFAULT_RETRY_BACKOFFS) - 1)])
                attempt += 1
                continue

            if response.status_code == 429 or (response.status_code == 403 and ban_prone):
                cooldown = _retry_after_seconds(response) or default_cooldown
                self.throttle.latch(host_key, cooldown)
                raise SoftBanned(provider, f"{host_key} returned {response.status_code}; latched for {cooldown:.0f}s")

            if response.status_code >= 500:
                if attempt >= retries:
                    message = f"{host_key} returned {response.status_code} after {attempt + 1} attempt(s)"
                    raise Unavailable(provider, message)
                self._sleep(DEFAULT_RETRY_BACKOFFS[min(attempt, len(DEFAULT_RETRY_BACKOFFS) - 1)])
                attempt += 1
                continue

            return response

    def get_json(self, url: str, *, provider: str, **kwargs: Any) -> Any:
        """`get`, then decode the body as JSON (`Unavailable` on malformed JSON)."""
        response = self.get(url, provider=provider, **kwargs)
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(provider, f"malformed JSON body: {exc}") from exc
