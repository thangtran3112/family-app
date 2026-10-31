"""Tradier: latest equity quotes and option chains from Tradier's brokerage market-data REST API (02b §4c).

Serves two kinds, both with the token `TRADIER_ACCESS_TOKEN` (Firestore `ai-trading/market-data`):

- `quotes`: `GET /v1/markets/quotes?symbols=AAPL,MSFT`, one request for the whole list. Each quote is the last trade
  (`last`, stamped `as_of` the trade's `trade_date`); a symbol with no trade, or one Tradier lists under
  `unmatched_symbols`, is left out rather than raised.
- `option_chain`: `GET /v1/markets/options/expirations` once, then `GET /v1/markets/options/chains?symbol=X&
  expiration=YYYY-MM-DD&greeks=true` for each expiry inside the window (the chain endpoint takes one expiry), so a
  chain costs `1 + expiries` requests. More than `MAX_EXPIRATIONS` expiries in the window is an error, never a
  silently short chain: narrow it with `max_dte`. Strike bounds are applied here, since the endpoint has no strike
  filter.

Environment: `TRADIER_ENVIRONMENT` is `production` (default) or `sandbox` (`https://sandbox.tradier.com/v1/`, for
development); a token works only in the environment it was issued for (a mismatch is HTTP 401). Production data is
real-time for Tradier brokerage account holders, so production quotes are stamped `realtime`; sandbox data is delayed
15 minutes and stamped `delayed-15m`.

Greeks are stale by design: Tradier refreshes them hourly (from about 10:15 ET), so a contract's `delta` and `iv` can be
up to an hour older than its `bid` and `ask`. `OptionContract` carries one time, `as_of`, which here is the newer of
the bid and ask times, not the greeks' (`greeks.updated_at`). Every contract is stamped `delayed-15m` for that
reason and as `alpaca_options` does: the chain is a screening snapshot, and moving it to `realtime` is a deliberate
later decision. `iv` is Tradier's `mid_iv` (a zero means it could not solve one, so it reads as None); `delta` is
None on the sandbox, which sends no greeks.

Rate limit: 120 requests a minute on market data, held by the shared `ThrottledClient` at 0.5 s spacing. Tradier
answers an exceeded quota with HTTP 400 and a "Quota Violation" body, not 429, so that is mapped here to the same
latch the client sets on a 429: `SoftBanned`, fail-fast, for the default cooldown.

Unconfirmed as of 2026-10-30 (02b §4c): whether a Lite account is enough for real-time options, and whether the
equity feed is SIP or one venue. Nothing here activates until a key exists.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.bars import to_utc
from ai_trading_common.errors import NotConfigured, ProviderError, SoftBanned, Unavailable
from ai_trading_common.http import DEFAULT_COOLDOWN_S, ThrottledClient
from ai_trading_common.quality import Quality
from ai_trading_common.types import OptionContract, OptionRight, Quote

PROVIDER_NAME = "tradier"
BASES = {"production": "https://api.tradier.com/v1", "sandbox": "https://sandbox.tradier.com/v1"}
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"
HOST_KEY = "tradier"

# Market data allows 120 requests a minute.
MIN_INTERVAL_S = 60.0 / 120.0

CHAIN_QUALITY: Quality = "delayed-15m"
MAX_EXPIRATIONS = 12


class Tradier:
    """Latest quotes and option chains from Tradier's market-data API."""

    def __init__(self, token: str, *, http: ThrottledClient | None = None, environment: str = "production") -> None:
        self.token = token
        self.environment = environment
        self._http = http or ThrottledClient()

    def latest(self, symbols: Sequence[str], *, now: pd.Timestamp | datetime) -> list[Quote]:
        """The last trade of each symbol. A symbol with no trade yet or unknown to Tradier is left out, not an error."""
        base = self._base()
        if not symbols:
            return []
        body = self._get(base, "/markets/quotes", {"symbols": ",".join(symbols)})
        quality: Quality = "realtime" if self.environment == "production" else "delayed-15m"
        out: list[Quote] = []
        for row in _as_list((body.get("quotes") or {}).get("quote")):
            price = _number(row.get("last")) if isinstance(row, dict) else None
            traded = _number(row.get("trade_date")) if isinstance(row, dict) else None
            if price is None or not traded or not row.get("symbol"):
                continue
            out.append(
                Quote(
                    symbol=str(row["symbol"]),
                    price=price,
                    as_of=pd.Timestamp(traded, unit="ms", tz="UTC"),
                    provider=PROVIDER_NAME,
                    quality=quality,
                )
            )
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
        base = self._base()
        if not 0 <= min_dte <= max_dte:
            raise ValueError(f"need 0 <= min_dte <= max_dte, got {min_dte} and {max_dte}")

        today = to_utc(now).tz_convert("America/New_York").date()
        first, last = today + timedelta(days=min_dte), today + timedelta(days=max_dte)
        expiries = [d for d in self._expirations(base, symbol) if first <= d <= last]
        if len(expiries) > MAX_EXPIRATIONS:
            raise Unavailable(PROVIDER_NAME, f"{len(expiries)} expiries in the window; narrow it with max_dte")

        root = re.sub(r"[^A-Z0-9]", "", symbol.upper())  # BRK/B trades its options as BRKB
        out: list[OptionContract] = []
        for expiry in expiries:
            body = self._get(
                base,
                "/markets/options/chains",
                {"symbol": symbol, "expiration": expiry.isoformat(), "greeks": "true"},
            )
            for row in _as_list((body.get("options") or {}).get("option")):
                contract = _to_contract(row, symbol, root, right, today, min_strike, max_strike)
                if contract is not None:
                    out.append(contract)
        return sorted(out, key=lambda c: (c.expiry, c.strike))

    def _expirations(self, base: str, symbol: str) -> list[date]:
        body = self._get(base, "/markets/options/expirations", {"symbol": symbol})
        try:
            return [date.fromisoformat(d) for d in _as_list((body.get("expirations") or {}).get("date"))]
        except (TypeError, ValueError) as exc:
            raise ProviderError(PROVIDER_NAME, f"malformed expiration: {exc}") from exc

    def _base(self) -> str:
        """The environment's base URL, once there is a token and the environment is one Tradier has."""
        if not self.token:
            raise NotConfigured(PROVIDER_NAME, "no access token configured")
        if self.environment not in BASES:
            raise NotConfigured(PROVIDER_NAME, f"unknown Tradier environment {self.environment!r}")
        return BASES[self.environment]

    def _get(self, base: str, path: str, params: dict[str, str]) -> dict:
        response = self._http.get(
            f"{base}{path}",
            provider=PROVIDER_NAME,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=params,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"},
        )
        try:
            body = response.json()
        except ValueError:
            body = None
        if response.status_code in (401, 403):
            raise NotConfigured(
                PROVIDER_NAME,
                f"token rejected on the {self.environment} environment (HTTP {response.status_code});"
                " a token only works in the environment it was issued for",
            )
        if response.status_code == 400 and "quota" in str(body).lower():
            self._http.throttle.latch(HOST_KEY, DEFAULT_COOLDOWN_S)
            raise SoftBanned(PROVIDER_NAME, f"quota violation (HTTP 400); latched for {DEFAULT_COOLDOWN_S:.0f}s")
        if response.status_code != 200:
            raise Unavailable(PROVIDER_NAME, f"HTTP {response.status_code}")
        if not isinstance(body, dict):
            raise Unavailable(PROVIDER_NAME, "malformed JSON body")
        return body


def _to_contract(
    row: object,
    underlying: str,
    root: str,
    right: OptionRight,
    today: date,
    min_strike: float | None,
    max_strike: float | None,
) -> OptionContract | None:
    """One chain row as an `OptionContract`, or None for a row that cannot be priced, is nonstandard, or is outside
    the requested right and strike band."""
    if not isinstance(row, dict) or row.get("option_type") != ("call" if right == "C" else "put"):
        return None
    if row.get("root_symbol", root) != root:
        return None
    bid, ask = _number(row.get("bid")), _number(row.get("ask"))
    if bid is None or ask is None or bid < 0 or ask <= 0 or ask < bid:
        return None
    quoted = max(_number(row.get("bid_date")) or 0, _number(row.get("ask_date")) or 0)
    if not quoted:
        return None
    try:
        expiry = date.fromisoformat(row["expiration_date"])
        strike = float(row["strike"])
        symbol = str(row["symbol"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ProviderError(PROVIDER_NAME, f"malformed option row: {exc}") from exc
    if (min_strike is not None and strike < min_strike) or (max_strike is not None and strike > max_strike):
        return None
    greeks = row.get("greeks")
    greeks = greeks if isinstance(greeks, dict) else {}
    iv = _number(greeks.get("mid_iv"))
    return OptionContract(
        underlying=underlying,
        symbol=symbol,
        right=right,
        expiry=expiry,
        strike=strike,
        dte=(expiry - today).days,
        bid=bid,
        ask=ask,
        delta=_number(greeks.get("delta")),
        iv=iv if iv and iv > 0 else None,
        open_interest=_count(row.get("open_interest")),
        as_of=pd.Timestamp(quoted, unit="ms", tz="UTC"),
        provider=PROVIDER_NAME,
        quality=CHAIN_QUALITY,
    )


def _as_list(value: object) -> list:
    """Tradier sends a one-item list as a bare object and an empty one as null."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _number(value: object) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _count(value: object) -> int | None:
    number = _number(value)
    return None if number is None else int(number)


def _build(env: Mapping[str, str], http: ThrottledClient) -> Tradier:
    return Tradier(
        env.get("TRADIER_ACCESS_TOKEN", ""),
        http=http,
        environment=env.get("TRADIER_ENVIRONMENT") or "production",
    )


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("quotes", "option_chain"), build=_build)
