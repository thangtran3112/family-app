"""Alpaca bars: daily (eod), hourly and 1-minute (delayed-15m) history; plus the screener universe
(assets, most-actives, movers), latest quotes (02m §b4 items 1 and 2), and trade prints (`/trades`).

Adapted from `ai-trading/packages/market-data/alpaca.py` (ours; open-source lane) and
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

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Literal
from urllib.parse import quote

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.bars import ET, Bars, Timeframe, drop_unclosed, to_utc, validate
from ai_trading_common.errors import NoData, NotConfigured, ProviderError, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.quality import Quality
from ai_trading_common.trades import Trades, empty_trades_frame
from ai_trading_common.types import ActiveSymbol, Mover, Quote, UniverseAsset

PROVIDER_NAME = "alpaca"
BASE = "https://data.alpaca.markets/v2/stocks"
SCREENER_BASE = "https://data.alpaca.markets/v1beta1/screener/stocks"
#: The asset list is a trading-API call; a data-only (paper) key pair works against the paper host.
DEFAULT_TRADING_URL = "https://paper-api.alpaca.markets"
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

    def __init__(
        self,
        key_id: str,
        secret: str,
        *,
        http: ThrottledClient | None = None,
        trading_url: str = DEFAULT_TRADING_URL,
    ) -> None:
        self.key_id = key_id
        self.secret = secret
        self._http = http or ThrottledClient()
        self._trading_url = trading_url.rstrip("/")

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
        """Closed bars inside `[start, end]`, capped to the SIP embargo and `drop_unclosed`-filtered.

        For "1d" the range is applied by New York trading date, since a daily bar is stamped at
        midnight ET of its date rather than at the session's open: a window covering exactly one
        session returns that session's bar (see `_within_trading_dates`).
        """
        if not (self.key_id and self.secret):
            raise NotConfigured(PROVIDER_NAME, "no API key configured")

        start_utc, end_utc, now_utc = to_utc(start), to_utc(end), to_utc(now)
        capped_end = min(end_utc, now_utc - SIP_EMBARGO)
        quality = _QUALITY[timeframe]
        if capped_end < start_utc:
            return Bars(frame=_empty_frame(timeframe), source=PROVIDER_NAME, quality=quality)

        # A "1d" bar is stamped at midnight America/New_York of its trading date, i.e. before
        # that session's 04:00 ET extended open, and Alpaca filters bars by that stamp. Callers
        # pass whole sessions (`extended_open`..`extended_close`), so their `start` sits *after*
        # the first day's own stamp: a one-session window returned nothing (NoData) and a wider
        # one silently lost its first session. Pad the request back to the first day's midnight;
        # the frame is re-sliced to the caller's trading dates below, so nothing outside the
        # window leaks out. Intraday bars are stamped at their own start, inside the window, and
        # keep the exact requested range.
        request_start = start_utc
        if timeframe == "1d":
            request_start = min(start_utc, start_utc.tz_convert(ET).normalize()).tz_convert("UTC")

        params = {
            "timeframe": _ALPACA_TIMEFRAME[timeframe],
            "start": request_start.isoformat(),
            "end": capped_end.isoformat(),
            "adjustment": adjustment,
            "feed": "sip",
            "limit": "10000",
        }
        rows = self._paged(symbol, "bars", params, "bars")

        if not rows:
            raise NoData(PROVIDER_NAME, f"no bars for {symbol!r} between {start_utc} and {capped_end}")

        frame = _to_frame(rows, timeframe)
        frame = validate(frame, timeframe)
        if timeframe == "1d":
            frame = _within_trading_dates(frame, start_utc, capped_end)
        frame = drop_unclosed(frame, timeframe, now_utc)
        return Bars(frame=frame, source=PROVIDER_NAME, quality=quality)

    def trades(
        self,
        symbol: str,
        start: pd.Timestamp | datetime,
        end: pd.Timestamp | datetime,
        *,
        feed: Literal["sip", "iex"] = "sip",
        now: pd.Timestamp | datetime | None = None,
    ) -> Trades:
        """Every print between `start` and `end` on `feed`. The SIP end is capped to the embargo, as bars are;
        an empty window is an empty `Trades`, not `NoData`."""
        if not (self.key_id and self.secret):
            raise NotConfigured(PROVIDER_NAME, "no API key configured")

        start_utc, end_utc = to_utc(start), to_utc(end)
        if feed == "sip":
            now_utc = pd.Timestamp.now(tz="UTC") if now is None else to_utc(now)
            end_utc = min(end_utc, now_utc - SIP_EMBARGO)
        if end_utc < start_utc:
            return Trades(frame=empty_trades_frame(), source=PROVIDER_NAME, feed=feed)

        params = {"start": start_utc.isoformat(), "end": end_utc.isoformat(), "feed": feed, "limit": "10000"}
        rows = self._paged(symbol, "trades", params, "trades")
        return Trades(frame=_to_trades_frame(rows), source=PROVIDER_NAME, feed=feed)

    def _paged(self, symbol: str, path: str, params: dict, key: str) -> list[dict]:
        """Every page of `body[key]` from `/{symbol}/{path}`, following `next_page_token` until it runs out."""
        rows: list[dict] = []
        page_token: str | None = None
        while True:
            page = {**params, "page_token": page_token} if page_token else params
            body = self._get_path(symbol, path, page)
            rows.extend(body.get(key) or [])
            page_token = body.get("next_page_token")
            if not page_token:
                return rows

    def _get_path(self, symbol: str, path: str, params: dict) -> dict:
        url = f"{BASE}/{quote(symbol)}/{path}"
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

    def assets(self) -> list[UniverseAsset]:
        """Every active, tradable US equity or ETF (`/v2/assets`): symbol, name, exchange."""
        body = self._get_url(
            f"{self._trading_url}/v2/assets", {"status": "active", "asset_class": "us_equity"}, "universe"
        )
        if not isinstance(body, list):
            raise ProviderError(PROVIDER_NAME, "malformed asset list")
        return [
            UniverseAsset(
                symbol=str(row["symbol"]),
                name=str(row.get("name") or row["symbol"]),
                exchange=str(row.get("exchange") or ""),
                provider=PROVIDER_NAME,
                quality="eod",
            )
            for row in body
            if isinstance(row, dict) and row.get("symbol") and row.get("tradable", True)
        ]

    def most_actives(self, by: Literal["volume", "trades"], top: int) -> list[ActiveSymbol]:
        body = self._get_url(f"{SCREENER_BASE}/most-actives", {"by": by, "top": str(top)}, "universe")
        return [
            ActiveSymbol(
                symbol=str(row["symbol"]),
                volume=_number(row.get("volume")),
                trade_count=None if row.get("trade_count") is None else int(row["trade_count"]),
                provider=PROVIDER_NAME,
                quality="delayed-15m",
            )
            for row in body.get("most_actives") or []
            if row.get("symbol")
        ]

    def movers(self, top: int) -> list[Mover]:
        body = self._get_url(f"{SCREENER_BASE}/movers", {"top": str(top)}, "universe")
        out: list[Mover] = []
        for key, side in (("gainers", "gainer"), ("losers", "loser")):
            for row in body.get(key) or []:
                if row.get("symbol"):
                    out.append(
                        Mover(
                            symbol=str(row["symbol"]),
                            side=side,
                            change_pct=_number(row.get("percent_change")),
                            price=_number(row.get("price")),
                            provider=PROVIDER_NAME,
                            quality="delayed-15m",
                        )
                    )
        return out

    def latest(self, symbols: Sequence[str], *, now: pd.Timestamp | datetime) -> list[Quote]:
        """The close of each symbol's newest closed 1-minute bar inside the SIP embargo (so 15 minutes
        old at best, `delayed-15m`). A symbol with no bar in the last week is left out, not an error."""
        if not (self.key_id and self.secret):
            raise NotConfigured(PROVIDER_NAME, "no API key configured")
        now_utc = to_utc(now)
        end = now_utc - SIP_EMBARGO
        out: list[Quote] = []
        for symbol in symbols:
            params = {
                "timeframe": "1Min",
                "start": (end - pd.Timedelta(days=7)).isoformat(),
                "end": end.isoformat(),
                "adjustment": "all",
                "feed": "sip",
                "sort": "desc",
                "limit": "1",
            }
            try:
                body = self._get_path(symbol, "bars", params)
            except NoData:
                continue
            rows = body.get("bars") or []
            if rows:
                out.append(
                    Quote(
                        symbol=symbol,
                        price=float(rows[0]["c"]),
                        as_of=pd.Timestamp(rows[0]["t"]).tz_convert("UTC"),
                        provider=PROVIDER_NAME,
                        quality="delayed-15m",
                    )
                )
        return out

    def _get_url(self, url: str, params: dict, host_key: str) -> dict | list:
        """A keyed GET returning decoded JSON; `host_key` separates the trading and screener hosts' throttles."""
        if not (self.key_id and self.secret):
            raise NotConfigured(PROVIDER_NAME, "no API key configured")
        response = self._http.get(
            url,
            provider=PROVIDER_NAME,
            host_key=f"{HOST_KEY}-{host_key}",
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=params,
            headers={"APCA-API-KEY-ID": self.key_id, "APCA-API-SECRET-KEY": self.secret},
        )
        if response.status_code in (401, 403):
            raise NotConfigured(PROVIDER_NAME, f"key rejected (HTTP {response.status_code})")
        if response.status_code != 200:
            raise Unavailable(PROVIDER_NAME, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER_NAME, f"malformed JSON body: {exc}") from exc


def _number(value: object) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _empty_frame(timeframe: Timeframe) -> pd.DataFrame:
    columns = ("open", "high", "low", "close", "volume")
    index = pd.Index([], dtype=object) if timeframe == "1d" else pd.DatetimeIndex([], tz="UTC")
    return pd.DataFrame({c: pd.Series(dtype="float64") for c in columns}, index=index)


def _within_trading_dates(frame: pd.DataFrame, start_utc: pd.Timestamp, end_utc: pd.Timestamp) -> pd.DataFrame:
    """Keep the "1d" bars whose New York trading date is inside the caller's window dates.

    The requested window is one or more whole sessions, and a bar belongs to the session of its
    New York date, so comparing dates (rather than the bar's midnight stamp) is what makes a
    window that opens at a session's extended open include that session.
    """
    first, last = start_utc.tz_convert(ET).date(), end_utc.tz_convert(ET).date()
    return frame[[first <= day <= last for day in frame.index]]


def _to_frame(rows: list[dict], timeframe: Timeframe) -> pd.DataFrame:
    """Alpaca's `{t, o, h, l, c, v}` bars into the shared OHLCV shape.

    `t` is an RFC3339 UTC timestamp. For "1h"/"1m" it is the bar's start. A "1d" bar is stamped
    at **midnight America/New_York** of its trading date (`04:00Z` in EDT, `05:00Z` in EST) --
    earlier than that session's 04:00 ET extended open, which is what made a window starting at
    `extended_open` miss its own day -- so a "1d" bar is reindexed to its New York trading date
    (not sliced from the string).
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


def _to_trades_frame(rows: list[dict]) -> pd.DataFrame:
    """Alpaca's `{t, x, p, s, c}` prints into the shared trades shape. `c` is a list of condition codes, joined
    with no separator. A print with a non-positive price or size is dropped (the same bad-row rule as bars);
    the rest sort by print time, stably, so prints at the same instant keep their order."""
    if not rows:
        return empty_trades_frame()
    try:
        frame = pd.DataFrame(
            {
                # pandas picks the resolution from the strings (`us` for whole seconds); the shared shape is ns.
                "t": pd.to_datetime([r["t"] for r in rows], utc=True, format="ISO8601").astype("datetime64[ns, UTC]"),
                "p": [float(r["p"]) for r in rows],
                "s": [int(r["s"]) for r in rows],
                "x": [str(r.get("x") or "") for r in rows],
                "c": ["".join(r.get("c") or []) for r in rows],
            }
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ProviderError(PROVIDER_NAME, f"malformed trade: {exc}") from exc
    if frame["t"].isna().any():
        raise ProviderError(PROVIDER_NAME, "malformed trade: missing print time")
    frame = frame[(frame["p"] > 0) & (frame["s"] > 0)]
    return frame.sort_values("t", kind="stable").reset_index(drop=True)


def _build(env: Mapping[str, str], http: ThrottledClient) -> AlpacaBars:
    return AlpacaBars(
        env.get("ALPACA_API_KEY_ID", ""),
        env.get("ALPACA_API_SECRET_KEY", ""),
        http=http,
        trading_url=env.get("ALPACA_TRADING_URL") or DEFAULT_TRADING_URL,
    )


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("bars", "universe", "quotes", "trades"), build=_build)
