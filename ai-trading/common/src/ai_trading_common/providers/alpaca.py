"""Alpaca bars: daily (eod), hourly and 1-minute (delayed-15m) history.

Adapted from `ai-trading/market-data/alpaca.py` (ours; open-source lane) and
moved here per the Phase 2 reuse map (02a §11, "move"). No attribution notice
needed: same author, not an upstream project. Changes: the throttled HTTP
layer and bar hygiene guards from this package, the shared `Timeframe`s
("1d"/"1h"/"1m" instead of just daily), and the free plan's two guards (the SIP
embargo and the 200-requests-a-minute throttle).

`AlpacaBars` already returns `Bars` -- the shared, vendor-neutral type -- so it
*is* this module's `BarsSource` adapter; no separate wrapper class is added
(02j §2: "Where a raw client already returns vendor-neutral types ... the
client class itself may be the `<Name>Source`").
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from urllib.parse import quote

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.bars import Bars, Timeframe, drop_unclosed, to_utc, validate
from ai_trading_common.errors import NoData, NotConfigured, ProviderError, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.quality import Quality

PROVIDER_NAME = "alpaca"
BASE = "https://data.alpaca.markets/v2/stocks"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"
HOST_KEY = "alpaca"

# The free Basic plan allows 200 requests a minute (02b §2 finding 4).
MIN_INTERVAL_S = 60.0 / 200.0

# The free plan withholds the latest 15 minutes of consolidated data; a request
# ending inside that window is capped to its edge.
SIP_EMBARGO = pd.Timedelta(minutes=15)

_ALPACA_TIMEFRAME = {"1d": "1Day", "1h": "1Hour", "1m": "1Min"}
_QUALITY: dict[Timeframe, Quality] = {"1d": "eod", "1h": "delayed-15m", "1m": "delayed-15m"}


class AlpacaBars:
    """Daily, hourly, and 1-minute bars from Alpaca's `/v2/stocks` market data API."""

    def __init__(self, key_id: str, secret: str, *, http: ThrottledClient | None = None) -> None:
        self.key_id = key_id
        self.secret = secret
        self._http = http or ThrottledClient()

    def bars(
        self,
        symbol: str,
        timeframe: Timeframe,
        start: pd.Timestamp | datetime,
        end: pd.Timestamp | datetime,
        *,
        now: pd.Timestamp | datetime,
        adjustment: str = "all",
    ) -> Bars:
        if not (self.key_id and self.secret):
            raise NotConfigured(PROVIDER_NAME, "no API key configured")

        start_utc, end_utc, now_utc = to_utc(start), to_utc(end), to_utc(now)
        capped_end = min(end_utc, now_utc - SIP_EMBARGO)
        quality = _QUALITY[timeframe]
        if capped_end < start_utc:
            return Bars(frame=_empty_frame(timeframe), source=PROVIDER_NAME, quality=quality)

        params = {
            "timeframe": _ALPACA_TIMEFRAME[timeframe],
            "start": start_utc.isoformat(),
            "end": capped_end.isoformat(),
            "adjustment": adjustment,
            "feed": "sip",
            "limit": "10000",
        }
        rows: list[dict] = []
        page_token: str | None = None
        while True:
            if page_token:
                params["page_token"] = page_token
            else:
                params.pop("page_token", None)
            body = self._get(symbol, params)
            rows.extend(body.get("bars") or [])
            page_token = body.get("next_page_token")
            if not page_token:
                break

        if not rows:
            raise NoData(PROVIDER_NAME, f"no bars for {symbol!r} between {start_utc} and {capped_end}")

        frame = _to_frame(rows, timeframe)
        frame = validate(frame, timeframe)
        frame = drop_unclosed(frame, timeframe, now_utc)
        return Bars(frame=frame, source=PROVIDER_NAME, quality=quality)

    def _get(self, symbol: str, params: dict) -> dict:
        url = f"{BASE}/{quote(symbol)}/bars"
        headers = {"APCA-API-KEY-ID": self.key_id, "APCA-API-SECRET-KEY": self.secret}
        response = self._http.get(
            url,
            provider=PROVIDER_NAME,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=params,
            headers=headers,
        )
        if response.status_code in (401, 403):
            raise NotConfigured(PROVIDER_NAME, f"key rejected (HTTP {response.status_code})")
        if response.status_code == 404:
            raise NoData(PROVIDER_NAME, f"unknown symbol {symbol!r}")
        if response.status_code != 200:
            raise Unavailable(PROVIDER_NAME, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER_NAME, f"malformed JSON body: {exc}") from exc


def _empty_frame(timeframe: Timeframe) -> pd.DataFrame:
    columns = ("open", "high", "low", "close", "volume")
    index = pd.Index([], dtype=object) if timeframe == "1d" else pd.DatetimeIndex([], tz="UTC")
    return pd.DataFrame({c: pd.Series(dtype="float64") for c in columns}, index=index)


def _to_frame(rows: list[dict], timeframe: Timeframe) -> pd.DataFrame:
    """Alpaca's `{t, o, h, l, c, v}` bars into the shared OHLCV shape.

    `t` is an RFC3339 UTC timestamp of the bar's start. A "1d" bar is reindexed
    to its America/New_York trading date (not sliced from the string): Alpaca
    timestamps a daily bar at that session's open in UTC, whose date can differ
    from the UTC calendar date depending on the time of year.
    """
    try:
        raw = pd.DataFrame(
            {
                "open": [float(r["o"]) for r in rows],
                "high": [float(r["h"]) for r in rows],
                "low": [float(r["l"]) for r in rows],
                "close": [float(r["c"]) for r in rows],
                "volume": [float(r["v"]) for r in rows],
            },
            index=pd.to_datetime([r["t"] for r in rows], utc=True),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ProviderError(PROVIDER_NAME, f"malformed bar: {exc}") from exc

    if timeframe == "1d":
        raw.index = raw.index.tz_convert("America/New_York").date
    return raw


def _build(env: Mapping[str, str], http: ThrottledClient) -> AlpacaBars:
    return AlpacaBars(env.get("ALPACA_API_KEY_ID", ""), env.get("ALPACA_API_SECRET_KEY", ""), http=http)


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("bars",), build=_build)
