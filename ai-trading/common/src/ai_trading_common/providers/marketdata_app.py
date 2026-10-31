"""marketdata.app: latest equity quotes and option chains with greeks (02b §4c).

Serves two kinds, both with the token `MARKETDATA_APP_TOKEN` (Firestore `ai-trading/market-data`), sent as
`Authorization: Bearer <token>` as the vendor documents:

- `quotes`: `GET /v1/stocks/quotes/{symbol}/`, one request per symbol (a credit each). The last trade (`last`) is
  stamped `as_of` the quote's `updated` time, read as Unix seconds, as the chain's is. A symbol with no quote is left
  out, not an error.
- `option_chain`: `GET /v1/options/chain/{underlying}/?side=call&from=YYYY-MM-DD&to=YYYY-MM-DD`. The response is one
  column per field (`optionSymbol`, `bid`, `ask`, `iv`, `delta`, `openInterest`, `updated`, ...), parallel by index;
  the contract's right, strike and expiry come from the OCC `optionSymbol`, as in `alpaca_options`. Strike bounds are
  applied here. The vendor answers `no_data` (HTTP 404) for an unknown underlying and for an empty window alike, so
  both are `[]`, as the `OptionChainSource` contract wants for an empty window.

How old the data is depends on the account, and the response does not say: a non-professional who has signed the
exchange agreements gets 15-minute-delayed data, real-time needs the top plan plus an OPRA entitlement, and anyone
else gets data a day old. So the stamp is a setting, `MARKETDATA_APP_QUALITY`: `eod` (default, the free tier's honest
floor), `delayed-15m` (the $30 Starter plan) or `realtime`. Moving up a plan is the token plus that variable, nothing
in code; `as_of` always shows the quote's real age.

Limits are per plan, not per minute: 100 credits a day on the free plan (10,000 on Starter), a credit per quote and
per option symbol in a chain, and at most 50 requests in flight. A spent credit window answers HTTP 429, which the
shared `ThrottledClient` latches (`SoftBanned`) until `Retry-After`; HTTP 402 (a plan that does not cover the
request) reads as `NotConfigured`. HTTP 403 means a second device used the key, which the vendor clears after five
minutes, so it latches for that long. Cache-tier answers come as HTTP 203, which is success. Narrow every chain with
`max_dte` and the strike bounds: a wide chain spends the free day's credits at once.

Nothing here activates until a token exists.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta
from urllib.parse import quote

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.bars import to_utc
from ai_trading_common.errors import NoData, NotConfigured, ProviderError, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.quality import Quality
from ai_trading_common.types import OptionContract, OptionRight, Quote

PROVIDER_NAME = "marketdata_app"
BASE = "https://api.marketdata.app/v1"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"
HOST_KEY = "marketdata_app"

# There is no per-minute cap (the limits are daily credits and 50 requests in flight), so this only spaces calls.
MIN_INTERVAL_S = 0.2
# A 403 means a second device used the key; the vendor says to wait five minutes.
SECOND_DEVICE_COOLDOWN_S = 300.0

QUALITIES: tuple[Quality, ...] = ("eod", "delayed-15m", "realtime")

# `AAPL271217C00005000`: root, YYMMDD, C or P, strike x 1000 in eight digits.
_OCC = re.compile(r"^(?P<root>[A-Z0-9]+?)(?P<day>\d{6})(?P<right>[CP])(?P<strike>\d{8})$")


class MarketDataApp:
    """Latest quotes and option chains from marketdata.app."""

    def __init__(self, token: str, *, http: ThrottledClient | None = None, quality: str = "eod") -> None:
        self.token = token
        self.quality = quality
        self._http = http or ThrottledClient()

    def latest(self, symbols: Sequence[str], *, now: pd.Timestamp | datetime) -> list[Quote]:
        """The last trade of each symbol. A symbol with no quote is left out, not an error."""
        quality = self._quality()
        out: list[Quote] = []
        for symbol in symbols:
            try:
                body = self._get(f"/stocks/quotes/{quote(symbol)}/", {})
            except NoData:
                continue
            price, updated = _first(body, "last"), _first(body, "updated")
            if price is None or updated is None:
                continue
            try:
                as_of = pd.Timestamp(updated, unit="s", tz="UTC")
            except (TypeError, ValueError) as exc:
                raise ProviderError(PROVIDER_NAME, f"malformed quote time: {exc}") from exc
            out.append(Quote(symbol=symbol, price=float(price), as_of=as_of, provider=PROVIDER_NAME, quality=quality))
        return out

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
        quality = self._quality()
        if not 0 <= min_dte <= max_dte:
            raise ValueError(f"need 0 <= min_dte <= max_dte, got {min_dte} and {max_dte}")

        today = to_utc(now).tz_convert("America/New_York").date()
        params = {
            "side": "call" if right == "C" else "put",
            "from": (today + timedelta(days=min_dte)).isoformat(),
            "to": (today + timedelta(days=max_dte)).isoformat(),
        }
        try:
            body = self._get(f"/options/chain/{quote(symbol)}/", params)
        except NoData:
            return []

        occ = body.get("optionSymbol") or []
        columns = {
            name: _column(body, name, len(occ)) for name in ("bid", "ask", "iv", "delta", "openInterest", "updated")
        }
        root = re.sub(r"[^A-Z0-9]", "", symbol.upper())  # BRK.B trades its options as BRKB
        out = []
        for i, name in enumerate(occ):
            contract = _to_contract(
                name, {key: column[i] for key, column in columns.items()}, symbol, root, right, today, quality
            )
            if contract is not None and _in_band(contract.strike, min_strike, max_strike):
                out.append(contract)
        return sorted(out, key=lambda c: (c.expiry, c.strike))

    def _quality(self) -> Quality:
        """The stamp, once there is a token and the setting is one of ours."""
        if not self.token:
            raise NotConfigured(PROVIDER_NAME, "no API token configured")
        if self.quality not in QUALITIES:
            raise NotConfigured(PROVIDER_NAME, f"unknown MARKETDATA_APP_QUALITY {self.quality!r}")
        return self.quality  # type: ignore[return-value]

    def _get(self, path: str, params: dict[str, str]) -> dict:
        response = self._http.get(
            f"{BASE}{path}",
            provider=PROVIDER_NAME,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=params,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"},
            ban_prone=True,
            default_cooldown=SECOND_DEVICE_COOLDOWN_S,
        )
        status = response.status_code
        if status == 401:
            raise NotConfigured(PROVIDER_NAME, "token missing or rejected (HTTP 401)")
        if status == 402:
            raise NotConfigured(PROVIDER_NAME, "not covered by this plan (HTTP 402)")
        if status in (204, 404):
            raise NoData(PROVIDER_NAME, "no data for this request")
        if status not in (200, 203):
            raise Unavailable(PROVIDER_NAME, f"HTTP {status}")
        try:
            body = response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER_NAME, f"malformed JSON body: {exc}") from exc
        if not isinstance(body, dict):
            raise Unavailable(PROVIDER_NAME, "malformed body")
        if body.get("s") == "no_data":
            raise NoData(PROVIDER_NAME, "no data for this request")
        if body.get("s") != "ok":
            raise Unavailable(PROVIDER_NAME, f"error status: {str(body.get('errmsg'))[:200]}")
        return body


def _to_contract(
    occ: object,
    row: dict[str, object],
    underlying: str,
    root: str,
    right: OptionRight,
    today: date,
    quality: Quality,
) -> OptionContract | None:
    """One chain index as an `OptionContract`, or None for a row that cannot be priced or is nonstandard."""
    parsed = _OCC.match(occ) if isinstance(occ, str) else None
    if parsed is None or parsed["root"] != root or parsed["right"] != right or row["updated"] is None:
        return None
    bid, ask = _number(row["bid"]), _number(row["ask"])
    if bid is None or ask is None or bid < 0 or ask <= 0 or ask < bid:
        return None
    day = parsed["day"]
    try:
        expiry = date(2000 + int(day[:2]), int(day[2:4]), int(day[4:]))
        as_of = pd.Timestamp(row["updated"], unit="s", tz="UTC")
    except (TypeError, ValueError) as exc:
        raise ProviderError(PROVIDER_NAME, f"malformed option quote: {exc}") from exc
    return OptionContract(
        underlying=underlying,
        symbol=str(occ),
        right=right,
        expiry=expiry,
        strike=int(parsed["strike"]) / 1000,
        dte=(expiry - today).days,
        bid=bid,
        ask=ask,
        delta=_number(row["delta"]),
        iv=_number(row["iv"]),
        open_interest=_count(row["openInterest"]),
        as_of=as_of,
        provider=PROVIDER_NAME,
        quality=quality,
    )


def _first(body: Mapping[str, object], name: str) -> object | None:
    """The first entry of a column in a single-symbol response."""
    column = body.get(name)
    return column[0] if isinstance(column, list) and column else None


def _column(body: Mapping[str, object], name: str, length: int) -> list:
    """A chain column, one entry per contract; an absent one is all None, a ragged one is an error."""
    column = body.get(name)
    if column is None:
        return [None] * length
    if not isinstance(column, list) or len(column) != length:
        raise Unavailable(PROVIDER_NAME, f"malformed chain: column {name!r} does not match optionSymbol")
    return column


def _in_band(strike: float, low: float | None, high: float | None) -> bool:
    return (low is None or strike >= low) and (high is None or strike <= high)


def _number(value: object) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _count(value: object) -> int | None:
    number = _number(value)
    return None if number is None else int(number)


def _build(env: Mapping[str, str], http: ThrottledClient) -> MarketDataApp:
    return MarketDataApp(
        env.get("MARKETDATA_APP_TOKEN", ""),
        http=http,
        quality=env.get("MARKETDATA_APP_QUALITY") or "eod",
    )


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("quotes", "option_chain"), build=_build)
