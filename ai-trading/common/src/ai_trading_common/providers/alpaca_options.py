"""Alpaca option chains: a delayed, read-only snapshot of one underlying's calls or puts (02n §d, 02g §3).

Two GETs per chain, both with the key pair the `quotes` kind already uses (`ALPACA_API_KEY_ID` and
`ALPACA_API_SECRET_KEY`, Firestore `ai-trading/market-data`):

- market data `/v1beta1/options/snapshots/{underlying}`: the latest bid and ask, model delta and implied volatility;
- trading `/v2/options/contracts` (the paper host, as `AlpacaBars.assets` reaches it): open interest, which snapshots
  leave out.

The free Basic plan serves the `indicative` feed, a free derivative of OPRA whose quotes are not real OPRA quotes.
Every contract is stamped `delayed-15m` on either feed, as the `quotes` kind is: moving to real time is a
deliberate later decision, not something a feed name implies. `ALPACA_OPTIONS_FEED=opra` switches the feed once the
$99 Algo Trader Plus tier is bought (02b §4b); nothing else changes.

Rate limits: the free plan allows 200 requests a minute. Every request goes through the shared `ThrottledClient`
(0.3 s spacing per host, bounded backoff on a timeout or 5xx, and a latch on a 429 that fails fast with
`SoftBanned` until `Retry-After` passes). A chain is at most `MAX_PAGES` pages per call; a longer one is an error,
never a silently short chain, so narrow it with the strike or expiry window.
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping
from datetime import date, datetime, timedelta
from urllib.parse import quote

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.bars import to_utc
from ai_trading_common.errors import NoData, NotConfigured, ProviderError, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.providers.alpaca import DEFAULT_TRADING_URL, HOST_KEY, MIN_INTERVAL_S, USER_AGENT
from ai_trading_common.quality import Quality
from ai_trading_common.types import OptionContract, OptionRight

PROVIDER_NAME = "alpaca_options"
SNAPSHOTS_URL = "https://data.alpaca.markets/v1beta1/options/snapshots"
CONTRACTS_PATH = "/v2/options/contracts"
FEEDS = ("indicative", "opra")
QUALITY: Quality = "delayed-15m"

SNAPSHOT_PAGE_SIZE = 1000  # the endpoint's maximum
CONTRACT_PAGE_SIZE = 10000  # the endpoint's maximum
MAX_PAGES = 10

# `AAPL251121C00230000`: root, YYMMDD, C or P, strike x 1000 in eight digits.
_OCC = re.compile(r"^(?P<root>[A-Z0-9]+?)(?P<day>\d{6})(?P<right>[CP])(?P<strike>\d{8})$")


class AlpacaOptionChain:
    """Option chains from Alpaca's market data and trading APIs."""

    def __init__(
        self,
        key_id: str,
        secret: str,
        *,
        http: ThrottledClient | None = None,
        trading_url: str = DEFAULT_TRADING_URL,
        feed: str = "indicative",
    ) -> None:
        self.key_id = key_id
        self.secret = secret
        self.feed = feed
        self._http = http or ThrottledClient()
        self._trading_url = trading_url.rstrip("/")

    def option_chain(
        self,
        symbol: str,
        *,
        now: pd.Timestamp | datetime,
        right: OptionRight = "C",
        min_dte: int = 0,
        max_dte: int,
        min_strike: float | None = None,
        max_strike: float | None = None,
    ) -> list[OptionContract]:
        """Contracts expiring `min_dte` to `max_dte` calendar days after `now`'s New York date, by expiry then strike.

        A contract with no usable quote (no bid or ask, a zero ask, or a crossed pair) is left out: it cannot be
        priced. So is one on an adjusted root (a non-standard deliverable, e.g. `AAPL1`). An empty window is `[]`."""
        if not (self.key_id and self.secret):
            raise NotConfigured(PROVIDER_NAME, "no API key configured")
        if self.feed not in FEEDS:
            raise NotConfigured(PROVIDER_NAME, f"unknown options feed {self.feed!r}")
        if not 0 <= min_dte <= max_dte:
            raise ValueError(f"need 0 <= min_dte <= max_dte, got {min_dte} and {max_dte}")

        today = to_utc(now).tz_convert("America/New_York").date()
        window = {
            "type": "call" if right == "C" else "put",
            "expiration_date_gte": (today + timedelta(days=min_dte)).isoformat(),
            "expiration_date_lte": (today + timedelta(days=max_dte)).isoformat(),
        }
        if min_strike is not None:
            window["strike_price_gte"] = str(min_strike)
        if max_strike is not None:
            window["strike_price_lte"] = str(max_strike)

        snapshots: dict[str, object] = {}
        params = {"feed": self.feed, "limit": str(SNAPSHOT_PAGE_SIZE), **window}
        for body in self._pages(f"{SNAPSHOTS_URL}/{quote(symbol)}", params, HOST_KEY):
            page = body.get("snapshots") or {}
            if not isinstance(page, dict):
                raise Unavailable(PROVIDER_NAME, "malformed snapshots")
            snapshots.update(page)
        if not snapshots:
            return []

        open_interest = self._open_interest(symbol, window)
        root = re.sub(r"[^A-Z0-9]", "", symbol.upper())  # BRK.B trades its options as BRKB
        out = []
        for occ, snapshot in snapshots.items():
            contract = _to_contract(occ, snapshot, symbol, root, right, today, open_interest.get(occ))
            if contract is not None:
                out.append(contract)
        return sorted(out, key=lambda c: (c.expiry, c.strike))

    def _open_interest(self, symbol: str, window: Mapping[str, str]) -> dict[str, int | None]:
        params = {"underlying_symbols": symbol, "status": "active", "limit": str(CONTRACT_PAGE_SIZE), **window}
        found: dict[str, int | None] = {}
        for body in self._pages(f"{self._trading_url}{CONTRACTS_PATH}", params, f"{HOST_KEY}-contracts"):
            for row in body.get("option_contracts") or []:
                if isinstance(row, dict) and row.get("symbol"):
                    found[str(row["symbol"])] = _count(row.get("open_interest"))
        return found

    def _pages(self, url: str, params: dict[str, str], host_key: str) -> Iterator[dict]:
        """Each page's body, following `next_page_token` until it runs out; more than `MAX_PAGES` is an error."""
        token: str | None = None
        for _ in range(MAX_PAGES):
            body = self._get(url, {**params, "page_token": token} if token else params, host_key)
            yield body
            token = body.get("next_page_token")
            if not token:
                return
        raise Unavailable(PROVIDER_NAME, f"more than {MAX_PAGES} pages; narrow the strike or expiry window")

    def _get(self, url: str, params: dict[str, str], host_key: str) -> dict:
        response = self._http.get(
            url,
            provider=PROVIDER_NAME,
            host_key=host_key,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=params,
            headers={"APCA-API-KEY-ID": self.key_id, "APCA-API-SECRET-KEY": self.secret},
        )
        if response.status_code in (401, 403):
            raise NotConfigured(PROVIDER_NAME, f"key rejected on the {self.feed} feed (HTTP {response.status_code})")
        if response.status_code == 404:
            raise NoData(PROVIDER_NAME, "unknown underlying symbol")
        if response.status_code != 200:
            raise Unavailable(PROVIDER_NAME, f"HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER_NAME, f"malformed JSON body: {exc}") from exc
        if not isinstance(body, dict):
            raise Unavailable(PROVIDER_NAME, "malformed body")
        return body


def _to_contract(
    occ: str,
    snapshot: object,
    underlying: str,
    root: str,
    right: OptionRight,
    today: date,
    open_interest: int | None,
) -> OptionContract | None:
    """One snapshot row as an `OptionContract`, or None for a row that cannot be priced or is nonstandard."""
    parsed = _OCC.match(occ)
    if parsed is None or parsed["root"] != root or parsed["right"] != right or not isinstance(snapshot, dict):
        return None
    latest = snapshot.get("latestQuote")
    if not isinstance(latest, dict) or latest.get("t") is None:
        return None
    bid, ask = _number(latest.get("bp")), _number(latest.get("ap"))
    if bid is None or ask is None or bid < 0 or ask <= 0 or ask < bid:
        return None
    day = parsed["day"]
    try:
        expiry = date(2000 + int(day[:2]), int(day[2:4]), int(day[4:]))
        as_of = pd.Timestamp(latest["t"]).tz_convert("UTC")
    except (TypeError, ValueError) as exc:
        raise ProviderError(PROVIDER_NAME, f"malformed option quote: {exc}") from exc
    greeks = snapshot.get("greeks")
    return OptionContract(
        underlying=underlying,
        symbol=occ,
        right=right,
        expiry=expiry,
        strike=int(parsed["strike"]) / 1000,
        dte=(expiry - today).days,
        bid=bid,
        ask=ask,
        delta=_number(greeks.get("delta")) if isinstance(greeks, dict) else None,
        iv=_number(snapshot.get("impliedVolatility")),
        open_interest=open_interest,
        as_of=as_of,
        provider=PROVIDER_NAME,
        quality=QUALITY,
    )


def _number(value: object) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _count(value: object) -> int | None:
    number = _number(value)
    return None if number is None else int(number)


def _build(env: Mapping[str, str], http: ThrottledClient) -> AlpacaOptionChain:
    return AlpacaOptionChain(
        env.get("ALPACA_API_KEY_ID", ""),
        env.get("ALPACA_API_SECRET_KEY", ""),
        http=http,
        trading_url=env.get("ALPACA_TRADING_URL") or DEFAULT_TRADING_URL,
        feed=env.get("ALPACA_OPTIONS_FEED") or "indicative",
    )


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("option_chain",), build=_build)
