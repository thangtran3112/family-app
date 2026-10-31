"""The bridge: the market-data bridge as one more registry provider (02t §4.1).

Registered as `bridge` and selectable with `DATA_PROVIDERS_<KIND>`, in **no** default chain at
stage B2 (02t §2.3): the Desk keeps serving from the direct Python providers while the bridge is
shadowed by `bridge_shadow`. Nothing here knows a repository path -- the service address is
`MARKET_DATA_BRIDGE_URL` from the environment (Firestore `ai-trading/desk`), and the wire shape is
the Connect unary-JSON contract the bridge already serves: lowerCamelCase fields, proto enum names
(`DELAYED_15M`, `HEALTH_STATE_OK`), int64 values as JSON strings.

Transport is `ThrottledClient.post_json` (02t §11 Q2 ruling): no protobuf runtime, no code
generation, one HTTP dependency the package already has.

Records stay truthful: a `Quote`'s `provider` and a `Bars`' `source` carry the **serving vendor**
(`alpaca`, `ibkr`), never `bridge`, and `quality` is that vendor's own -- so the seam never
relabels an answer, and a chain result labeled `fallback` is telling the truth about the chain.

Error mapping (02t §4.1): `unauthenticated` -> `NotConfigured`; `unavailable`, `deadline_exceeded`,
`internal`, or a 5xx/connection failure left to `ThrottledClient` -> `Unavailable`;
`resource_exhausted` -> `SoftBanned`; `not_found` -> `NoData`; `unimplemented` -> `NotConfigured`
(the RPC is not on this build yet: `GetOptionChain` answers UNIMPLEMENTED before B6);
`invalid_argument` and `permission_denied` -> `ProviderError`, a caller error that must never be
mistaken for an outage or for an empty answer.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.bars import Bars, Timeframe, validate
from ai_trading_common.errors import NoData, NotConfigured, ProviderError, SoftBanned, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.quality import Quality
from ai_trading_common.types import (
    ClassRouting,
    GatewayStatus,
    OptionContract,
    ProviderHealth,
    Quote,
    Routing,
)

PROVIDER_NAME = "bridge"

#: The Connect service path prefix on the bridge's own port (convertible to gRPC unchanged).
SERVICE = "familyapp.marketdata.v1.MarketData"

#: The bridge is a sibling container: no third-party rate limit, so spacing exists only to keep one
#: noisy caller from stampeding it (a request per 50 ms).
MIN_INTERVAL_S = 0.05

HOST_KEY = "market-data-bridge"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"
DEFAULT_TIMEOUT_S = 10.0

_TIMEFRAME = {"1d": "DAY_1", "1h": "HOUR_1", "1m": "MINUTE_1"}
_ADJUSTMENT = {"all": "ALL", "split": "SPLIT", "raw": "RAW"}
_QUALITY: dict[str, Quality] = {
    "REALTIME": "realtime",
    "DELAYED_15M": "delayed-15m",
    "EOD": "eod",
}
_CLASS = {
    "equity_quotes": "EQUITY_QUOTES",
    "equity_bars": "EQUITY_BARS",
    "option_chain": "OPTION_CHAIN",
}
_RIGHT = {"C": "CALL", "P": "PUT"}

#: Connect error code -> the taxonomy class that raises it (built below, so the mapping stays lazy).
#: `failed_precondition` is the bridge's "no provider answered" -- a real outage at B0..B2 (nothing is
#: serving it), so a chain falls through to its next rung instead of stopping on it.
_ERROR_CLASSES = {
    "unauthenticated": NotConfigured,
    "unavailable": Unavailable,
    "deadline_exceeded": Unavailable,
    "internal": Unavailable,
    "unknown": Unavailable,
    "canceled": Unavailable,
    "failed_precondition": Unavailable,
    "resource_exhausted": SoftBanned,
    "not_found": NoData,
    "unimplemented": NotConfigured,
    "invalid_argument": ProviderError,
    "permission_denied": ProviderError,
    "already_exists": ProviderError,
}


def enabled(env: Mapping[str, str]) -> bool:
    """The provider switch 02t §4.1 pins: on only once `MARKET_DATA_BRIDGE_URL` is set, so the
    registry leaves `bridge` out of every chain (and the direct providers stay primary and
    unlabeled) until the Desk profile names the bridge."""
    return bool(env.get("MARKET_DATA_BRIDGE_URL"))


def _quality(raw: str | None) -> Quality:
    return _QUALITY.get(raw or "", "unavailable")


def _ts(raw: str | None) -> pd.Timestamp | None:
    return None if raw is None else pd.Timestamp(raw).tz_convert("UTC")


def _upper(table: Mapping[str, str], value: str) -> str:
    try:
        return table[value]
    except KeyError:
        raise ValueError(f"bridge: unknown {value!r}") from None


class BridgeClient:
    """Connect unary JSON against the bridge: data (`quotes`, `bars`, `option_chain`), the health and
    routing surfaces the Settings card reads, and `gateway_status()` for the status bar.

    One instance per process (the registry builds at most one per `from_env`), sharing the process's
    `ThrottledClient` so the bridge's host bucket is throttled and latched like every other host.
    """

    def __init__(
        self,
        url: str,
        token: str,
        admin_token: str = "",
        *,
        http: ThrottledClient | None = None,
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        self.url = url.rstrip("/")
        self._token = token
        self._admin_token = admin_token
        self._http = http or ThrottledClient()
        self._timeout = timeout

    # -- transport ------------------------------------------------------------------------------

    def _call(self, rpc: str, body: Mapping[str, Any], *, admin: bool = False, provider: str = PROVIDER_NAME):
        if not self._token:
            raise NotConfigured(provider, "no bridge token configured")
        headers = {"Authorization": f"Bearer {self._token}"}
        if admin:
            if not self._admin_token:
                raise NotConfigured(provider, "no bridge admin token configured")
            headers["X-Admin-Token"] = self._admin_token
        response = self._http.post(
            f"{self.url}/{SERVICE}/{rpc}",
            provider=provider,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            json_body=dict(body),
            headers=headers,
            timeout=self._timeout,
        )
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if response.status_code >= 400:
            self._raise(response.status_code, payload if isinstance(payload, dict) else {}, provider)
        if not isinstance(payload, dict):
            raise Unavailable(provider, f"{rpc}: malformed JSON body")
        return payload

    @staticmethod
    def _raise(status: int, payload: Mapping[str, Any], provider: str) -> None:
        code = str(payload.get("code") or "")
        message = str(payload.get("message") or f"HTTP {status}")
        error = _ERROR_CLASSES.get(code)
        if error is None:
            error = Unavailable if status >= 500 else ProviderError
        raise error(provider, f"{code or status}: {message}")

    # -- gating ---------------------------------------------------------------------------------

    def healthz(self) -> bool:
        """The bridge process is up (`GET /healthz`, 02t §3.1). Never provider health: a gateway that
        is off must not make this look down."""
        try:
            response = self._http.get(
                f"{self.url}/healthz",
                provider=PROVIDER_NAME,
                host_key=HOST_KEY,
                user_agent=USER_AGENT,
                min_interval=MIN_INTERVAL_S,
                timeout=self._timeout,
                retries=0,
            )
        except (Unavailable, SoftBanned):
            return False
        return response.status_code == 200

    # -- data -----------------------------------------------------------------------------------

    def latest(self, symbols: Sequence[str], *, now: pd.Timestamp | datetime) -> list[Quote]:
        return self.pinned_quotes(symbols, now=now)

    def pinned_quotes(
        self,
        symbols: Sequence[str],
        *,
        now: pd.Timestamp | datetime,
        provider: str | None = None,
    ) -> list[Quote]:
        """`GetQuotes` for `symbols`; with `provider`, that provider only and no fallback
        (`pin_provider`, 02t §3.5 -- the shadow job's direct-vs-bridge comparison)."""
        del now  # the bridge answers a snapshot; the caller's clock does not shape the request
        body: dict[str, Any] = {"symbols": list(symbols)}
        if provider:
            body["pinProvider"] = provider
        payload = self._call("GetQuotes", body)
        rows = payload.get("quotes") or []
        quotes = [
            Quote(
                symbol=str(row["symbol"]),
                price=float(row["last"]),
                as_of=_ts(row.get("asOf")) or pd.Timestamp.now(tz="UTC"),
                provider=str(row.get("provider") or ""),
                quality=_quality(row.get("quality")),
            )
            for row in rows
        ]
        if not quotes:
            raise NoData(PROVIDER_NAME, "no quotes in the bridge's answer")
        return quotes

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
        body = {
            "symbol": symbol,
            "timeframe": _upper(_TIMEFRAME, timeframe),
            "start": pd.Timestamp(start).tz_convert("UTC").isoformat(),
            "end": pd.Timestamp(end).tz_convert("UTC").isoformat(),
            "adjustment": _upper(_ADJUSTMENT, adjustment),
        }
        payload = self._call("GetBars", body)
        rows = payload.get("bars") or []
        frame = _frame(rows, timeframe)
        if frame.empty:
            raise NoData(PROVIDER_NAME, f"no bars for {symbol!r} in the bridge's answer")
        served = payload.get("served") or {}
        return Bars(
            frame=validate(frame, timeframe),
            source=str(served.get("provider") or ""),
            quality=_quality(served.get("quality")),
        )

    def option_chain(
        self,
        symbol: str,
        *,
        now: pd.Timestamp | datetime,
        right: str = "C",
        min_dte: int = 0,
        max_dte: int,
        min_strike: float | None = None,
        max_strike: float | None = None,
    ) -> list[OptionContract]:
        """B6. Until then the bridge answers UNIMPLEMENTED, which maps to `NotConfigured`."""
        body: dict[str, Any] = {
            "underlying": symbol,
            "right": _upper(_RIGHT, right),
            "now": pd.Timestamp(now).tz_convert("UTC").isoformat(),
            "minDte": min_dte,
            "maxDte": max_dte,
        }
        if min_strike is not None:
            body["minStrike"] = min_strike
        if max_strike is not None:
            body["maxStrike"] = max_strike
        payload = self._call("GetOptionChain", body)
        contracts = payload.get("contracts") or []
        out: list[OptionContract] = []
        for row in contracts:
            as_of = _ts(row.get("asOf"))
            if as_of is None:
                continue
            out.append(
                OptionContract(
                    underlying=str(row.get("underlying") or symbol),
                    symbol=str(row["symbol"]),
                    right="C" if row.get("right") == "CALL" else "P",
                    expiry=pd.Timestamp(str(row["expiry"])).date(),
                    strike=float(row["strike"]),
                    dte=int(row.get("dte") or 0),
                    bid=float(row.get("bid") or 0.0),
                    ask=float(row.get("ask") or 0.0),
                    delta=None if row.get("delta") is None else float(row["delta"]),
                    iv=None if row.get("iv") is None else float(row["iv"]),
                    open_interest=None if row.get("openInterest") is None else int(row["openInterest"]),
                    as_of=as_of,
                    quality=_quality(row.get("quality")),
                    provider=str(row.get("provider") or ""),
                )
            )
        if not out:
            raise NoData(PROVIDER_NAME, f"no option contracts for {symbol!r} in the bridge's answer")
        return out

    # -- status and routing (the RoutingSource / GatewayStatusSource surfaces) --------------------

    def providers(self) -> list[ProviderHealth]:
        """`ListProviders`: every provider the bridge knows, with its classes and cached health."""
        payload = self._call("ListProviders", {})
        return [_health(row) for row in payload.get("providers") or []]

    def routing(self) -> Routing:
        """`GetStatus.routing`: the cached preference per class and who would answer it now."""
        return _routing(self._call("GetStatus", {}).get("routing") or {})

    def set_routing(self, preferences: Mapping[str, str], version: int) -> Routing:
        """`SetRouting` (admin token): one preference per class, `""` clearing it. The bridge's own
        ladder is the allowlist, so a provider it does not offer is rejected there too."""
        body = {
            "preferences": [
                {"dataClass": _upper(_CLASS, data_class), "provider": provider}
                for data_class, provider in preferences.items()
            ],
            "version": str(int(version)),
        }
        return _routing(self._call("SetRouting", body, admin=True))

    def gateway_status(self) -> GatewayStatus:
        """The IBKR gateway's state as the bridge reports it, in the four `GatewayState` values the
        status bar already speaks (02t §4.1), with its own reason vocabulary passed through."""
        try:
            health = {row.provider: row for row in self.providers()}.get("ibkr")
        except (ProviderError, NotConfigured):
            return GatewayStatus("down", None, None, reason="bridge_unreachable")
        if health is None or not health.configured:
            return GatewayStatus("not_configured", None, None, reason=health.reason if health else None)
        state = {"ok": "connected", "degraded": "connected", "down": "down", "off": "not_configured"}
        mapped = state.get(health.state, "down")
        if health.state == "off":
            # Outside the gateway's own hours: expected, not an incident (02t §5.4).
            return GatewayStatus(
                "not_configured",
                health.quality,
                health.newest_tick,
                lines_used=health.lines_used,
                reason=health.reason or "off",
            )
        return GatewayStatus(
            mapped,  # type: ignore[arg-type]
            health.quality,
            health.newest_tick,
            lines_used=health.lines_used,
            reason=health.reason,
        )


def _frame(rows: Sequence[Mapping[str, Any]], timeframe: Timeframe) -> pd.DataFrame:
    """The shared bar frame from Connect JSON: a `date` index for "1d", a UTC `DatetimeIndex`
    otherwise (the shape `bars.validate` enforces)."""
    records: list[dict[str, Any]] = []
    index: list[Any] = []
    for row in rows:
        started = _ts(row.get("start"))
        if started is None:
            continue
        index.append(started.tz_convert("America/New_York").date() if timeframe == "1d" else started)
        records.append(
            {
                "open": float(row.get("open") or 0.0),
                "high": float(row.get("high") or 0.0),
                "low": float(row.get("low") or 0.0),
                "close": float(row.get("close") or 0.0),
                "volume": float(row.get("volume") or 0),
            }
        )
    columns = ("open", "high", "low", "close", "volume")
    if timeframe == "1d":
        return pd.DataFrame(records, columns=columns, index=pd.Index(index, dtype=object))
    return pd.DataFrame(records, columns=columns, index=pd.DatetimeIndex(index, tz="UTC"))


def _health(row: Mapping[str, Any]) -> ProviderHealth:
    counters = row.get("counters") or {}
    return ProviderHealth(
        provider=str(row.get("provider") or ""),
        classes=tuple(str(name).lower() for name in row.get("classes") or []),
        configured=bool(row.get("configured")),
        state=str(row.get("state") or "HEALTH_STATE_UNSPECIFIED").removeprefix("HEALTH_STATE_").lower(),
        reason=str(row.get("reason") or "") or None,
        quality=_quality(row.get("quality")),
        last_ok=_ts(row.get("lastOk")),
        newest_tick=_ts(row.get("newestTick")),
        lines_used=int(row.get("linesUsed") or 0),
        lines_max=int(row.get("linesMax") or 0),
        p95_ms=int(counters.get("p95Ms") or 0),
    )


def _routing(payload: Mapping[str, Any]) -> Routing:
    classes = tuple(
        ClassRouting(
            data_class=str(row.get("dataClass") or "").lower(),
            preferred=str(row.get("preferred") or ""),
            ladder=tuple(str(name) for name in row.get("ladder") or []),
            serving=str(row.get("serving") or ""),
        )
        for row in payload.get("classes") or []
    )
    return Routing(
        classes=classes,
        version=int(payload.get("version") or 0),
        source={"ENV_DEFAULT": "env_default", "DESK": "desk"}.get(str(payload.get("source") or ""), "unspecified"),
    )


def _build(env: Mapping[str, str], http: ThrottledClient) -> BridgeClient:
    return BridgeClient(
        env.get("MARKET_DATA_BRIDGE_URL", ""),
        env.get("MARKET_DATA_BRIDGE_TOKEN", ""),
        env.get("MARKET_DATA_BRIDGE_ADMIN_TOKEN", ""),
        http=http,
    )


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("quotes", "bars", "option_chain"), build=_build, enabled=enabled)
