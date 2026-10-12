"""FRED: vintage-pinned observations and release dates for the macro calendar.

Modified from TradingAgents `tradingagents/dataflows/vendors/fred.py` (Apache
License 2.0, upstream commit `1394a3f72aa4393e1a98f51b382434c4b4c2d972`; see
THIRD_PARTY_NOTICES.md). Kept: pinning both `realtime_start` and
`realtime_end` to the as-of date (ALFRED's vintage mechanism) so a backtest
dated in the past sees the value as first published, not a later revision.
Dropped: the markdown-report rendering, the friendly-alias table, and the
trailing look-back-day window — callers here pass an explicit `start`/`end`
and get typed `Observation` rows, not prose; dropped the `pytz`/America-
Chicago "FRED's own today" clamp (`_fred_today`), since this client's
`as_of` always names a historical date chosen by the caller (a backtest day),
never "now" read off the wall clock. Errors map to this package's shared
`ProviderError` hierarchy instead of raising `ValueError`/a vendor-specific
`NotConfiguredError`.

`Fred` already returns `Observation` from `ai_trading_common.types` and its
own `release_dates` returns plain `list[date]`, so it *is* this module's
`MacroSource` adapter -- no separate wrapper class.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from ai_trading_common._provider import Provider
from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.types import Observation

PROVIDER_NAME = "fred"
HOST_KEY = "fred"
BASE = "https://api.stlouisfed.org/fred"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"

# FRED's free tier allows 120 requests/minute.
MIN_INTERVAL_S = 60.0 / 120.0

# FRED's own marker for "nothing published for this date at this vintage"
# (as opposed to a real `0`).
_MISSING_VALUE = "."


class Fred:
    """FRED macro series: vintage-pinned observations and a series' release dates."""

    def __init__(self, api_key: str, *, http: ThrottledClient | None = None) -> None:
        self.api_key = api_key
        self._http = http or ThrottledClient()

    def observations(self, series_id: str, start: date, end: date, *, as_of: date) -> list[Observation]:
        """Observations in `[start, end]`, at the vintage known on `as_of`.

        Both `realtime_start` and `realtime_end` are pinned to `as_of`: FRED
        otherwise defaults both to today, serving the latest revision of
        every observation, which would leak a later restatement into a
        backtest dated before it happened (seen live: CPIAUCSL for 2019-06
        read 255.305 at its first realtime window and had been revised to
        255.213 by 2024).
        """
        payload = self._get(
            "series/observations",
            {
                "series_id": series_id,
                "observation_start": start.isoformat(),
                "observation_end": end.isoformat(),
                "realtime_start": as_of.isoformat(),
                "realtime_end": as_of.isoformat(),
            },
        )
        rows = payload.get("observations") or []
        out = [
            Observation(
                series_id=series_id,
                date=date.fromisoformat(row["date"]),
                value=float(row["value"]),
                realtime_start=date.fromisoformat(row["realtime_start"]),
                realtime_end=date.fromisoformat(row["realtime_end"]),
                provider=PROVIDER_NAME,
                quality="eod",
            )
            for row in rows
            if row.get("value") != _MISSING_VALUE
        ]
        if not out:
            raise NoData(PROVIDER_NAME, f"no {series_id} observations in [{start}, {end}] at the {as_of} vintage")
        return out

    def release_dates(self, series_id: str, *, as_of: date | None = None) -> list[date]:
        """Dates of the release `series_id` belongs to (e.g. "Consumer Price Index").

        One release covers several series and shares one schedule. `as_of`,
        when given, keeps only dates on or before it — a backtest must not
        see a release date that had not yet been announced.
        """
        release_payload = self._get("series/release", {"series_id": series_id})
        releases = release_payload.get("releases") or []
        if not releases:
            raise NoData(PROVIDER_NAME, f"no release found for series {series_id!r}")
        release_id = releases[0]["id"]

        dates_payload = self._get("release/dates", {"release_id": release_id})
        dates = sorted(date.fromisoformat(row["date"]) for row in dates_payload.get("release_dates") or [])
        if not dates:
            raise NoData(PROVIDER_NAME, f"no release dates for series {series_id!r}")
        return dates if as_of is None else [d for d in dates if d <= as_of]

    def _get(self, path: str, params: dict) -> dict:
        if not self.api_key:
            raise NotConfigured(PROVIDER_NAME, "no FRED_API_KEY configured")
        response = self._http.get(
            f"{BASE}/{path}",
            provider=PROVIDER_NAME,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params={**params, "api_key": self.api_key, "file_type": "json"},
        )
        if response.status_code == 400:
            raise self._error_for_400(response)
        if response.status_code != 200:
            raise Unavailable(PROVIDER_NAME, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER_NAME, f"malformed JSON body: {exc}") from exc

    def _error_for_400(self, response) -> Exception:
        """FRED answers every bad request with HTTP 400 and a JSON error_message.

        Live-probed: a rejected key names `api_key` ("...value for variable
        api_key is not a 32 character..."); an unknown or malformed series ID
        names `series_id` ("Invalid value for variable series_id..."). An
        empty result range is not an error at all — FRED returns 200 with an
        empty `observations` list, handled as `NoData` in `observations`
        above, not here.
        """
        try:
            message = response.json().get("error_message", "")
        except ValueError:
            message = response.text
        lowered = message.lower()
        if "api_key" in lowered:
            return NotConfigured(PROVIDER_NAME, f"key rejected: {message}")
        if "series_id" in lowered:
            return NoData(PROVIDER_NAME, f"unknown series: {message}")
        return Unavailable(PROVIDER_NAME, f"HTTP 400: {message}")


def _build(env: Mapping[str, str], http: ThrottledClient) -> Fred:
    return Fred(env.get("FRED_API_KEY", ""), http=http)


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("macro",), build=_build)
