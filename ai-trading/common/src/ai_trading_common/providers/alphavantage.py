"""Alpha Vantage: `EARNINGS_ESTIMATES` (consensus + revisions) and `EARNINGS`
(reported vs. estimated, surprise).

Probed live against a real key (2026-10-11), spending 15 of this lane's ~20
call budget (the controller had already spent 1 of the plan's 25/day):

- `EARNINGS_ESTIMATES` and `EARNINGS` are free and return real data -- and
  `EARNINGS_ESTIMATES` carries exactly the revision fields
  `consensus-eps-sources.md` flagged as "verify": `eps_estimate_average_7
  /30/60/90_days_ago` and `eps_estimate_revision_up/down_trailing_7/30_days`.
- `OVERVIEW` (the only source of an analyst target/rating on this provider)
  answers HTTP 200 with ``{"Information": "... This is a premium endpoint
  ..."}`` on *this* key -- contradicting `consensus-eps-sources.md`'s
  "OVERVIEW: mean target + StrongBuy/Buy/Hold/Sell/StrongSell free" note.
  Confirmed dead on the free plan (controller ruling): no `overview_targets`
  method is built here. Analyst targets/ratings are unavailable from Alpha
  Vantage on this account either way; see `REPORT-P3.md`.
- A bad/demo key, a premium-gated endpoint, and the 25-calls/day or
  roughly-1-request/second limit are *all* HTTP 200 with an `"Information"`
  key -- AV never signals any of these with a 4xx status. The free-tier
  limit note's wording ("Please consider spreading out your free API
  requests more sparingly (1 request per second) ... 25 requests per day")
  is identical whether the burst or the daily cap was hit, so the two
  cannot be told apart by text; `QuotaExceeded` covers both.
- An unrecognized symbol is HTTP 200 with an empty object `{}` (confirmed
  live for `EARNINGS`) -- no `"Error Message"`, no `"Information"`.

`AlphaVantageSource` adapts the raw client to `ConsensusSource` and
`EarningsSource`. Alpha Vantage is never in `DEFAULT_CHAINS["targets"]` --
no free target/rating field exists on this provider at all.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.types import ConsensusSnapshot, EarningsResult

PROVIDER_NAME = "alphavantage"
BASE = "https://www.alphavantage.co/query"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"
HOST_KEY = "alphavantage"

# The free plan's documented burst limit is roughly 1 request/second; this
# package has no notion of a calendar day, so staying under the 25-a-day cap
# is the caller's job (02f §4: one snapshot a day per symbol) -- this only
# protects the per-second burst, confirmed live when 3 near-simultaneous
# calls all came back as `QuotaExceeded` with the per-second wording.
MIN_INTERVAL_S = 1.0


class QuotaExceeded(Unavailable):
    """AV answered HTTP 200 with a rate-limit note (daily cap or per-second burst).

    Not promoted to `ai_trading_common.errors` because this lane doesn't
    touch that module (02c's "describe a core change, don't make it"); a
    controller adding a consensus-EPS phase for real may want to promote it
    there, since any AV caller needs the same distinction from `NotConfigured`
    (no key / not entitled) to decide whether retrying tomorrow could help.
    """


@dataclass(frozen=True)
class EpsEstimate:
    symbol: str
    period_end: pd.Timestamp
    horizon: str  # AV's own wording: "fiscal year" | "fiscal quarter" | "next fiscal year" | ...
    fiscal_year: int | None
    fiscal_quarter: int | None
    eps_mean: float | None
    eps_high: float | None
    eps_low: float | None
    analyst_count: int | None
    eps_mean_7d_ago: float | None
    eps_mean_30d_ago: float | None
    eps_mean_60d_ago: float | None
    eps_mean_90d_ago: float | None
    revisions_up_7d: int | None
    revisions_down_7d: int | None
    revisions_up_30d: int | None
    revisions_down_30d: int | None


@dataclass(frozen=True)
class ReportedEarnings:
    symbol: str
    fiscal_date_ending: pd.Timestamp
    reported_date: pd.Timestamp | None
    reported_eps: float | None
    estimated_eps: float | None
    surprise: float | None
    surprise_percent: float | None
    report_time: str | None


class AlphaVantageClient:
    """`EARNINGS_ESTIMATES` and `EARNINGS`."""

    def __init__(self, api_key: str, *, http: ThrottledClient | None = None) -> None:
        self.api_key = api_key
        self._http = http or ThrottledClient()

    def earnings_estimates(self, symbol: str) -> list[EpsEstimate]:
        body = self._get("EARNINGS_ESTIMATES", symbol)
        rows = body.get("estimates") or []
        if not rows:
            raise NoData(PROVIDER_NAME, f"no earnings estimates for {symbol!r}")
        return [_to_eps_estimate(symbol, r) for r in rows]

    def earnings(self, symbol: str) -> list[ReportedEarnings]:
        body = self._get("EARNINGS", symbol)
        rows = body.get("quarterlyEarnings") or []
        if not rows:
            raise NoData(PROVIDER_NAME, f"no reported earnings for {symbol!r}")
        return [_to_reported(symbol, r) for r in rows]

    def _get(self, function: str, symbol: str) -> dict[str, Any]:
        if not self.api_key:
            raise NotConfigured(PROVIDER_NAME, "no API key configured")
        params = {"function": function, "symbol": symbol, "apikey": self.api_key}
        response = self._http.get(
            BASE,
            provider=PROVIDER_NAME,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=params,
        )
        if response.status_code != 200:
            raise Unavailable(PROVIDER_NAME, f"HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER_NAME, f"malformed JSON body: {exc}") from exc
        note = body.get("Information") if isinstance(body, dict) else None
        if note:
            lowered = note.lower()
            # Checked before the "premium endpoint" catch-all below: the rate-limit
            # note's own wording also contains "premium endpoints" ("... to lift the
            # free key rate limit ... and instantly unlock all premium endpoints"),
            # so a substring check for that phrase alone would misclassify it.
            if "request" in lowered and ("per second" in lowered or "per day" in lowered):
                raise QuotaExceeded(PROVIDER_NAME, "rate limit reached (daily cap or per-second burst; see docstring)")
            if "demo" in lowered:
                raise NotConfigured(PROVIDER_NAME, "demo API key is not a real entitlement")
            if "premium endpoint" in lowered:
                raise NotConfigured(PROVIDER_NAME, f"{function} not entitled on this plan")
            raise Unavailable(PROVIDER_NAME, f"unrecognized Information note: {note!r}")
        return body


def _to_float(value: Any) -> float | None:
    if value in (None, "None", "-", ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    as_float = _to_float(value)
    return None if as_float is None else int(as_float)


def _to_eps_estimate(symbol: str, row: dict[str, Any]) -> EpsEstimate:
    return EpsEstimate(
        symbol=symbol,
        period_end=pd.Timestamp(row["date"]),
        horizon=row.get("horizon") or "",
        fiscal_year=pd.Timestamp(row["date"]).year,
        fiscal_quarter=None if row.get("horizon") == "fiscal year" else pd.Timestamp(row["date"]).quarter,
        eps_mean=_to_float(row.get("eps_estimate_average")),
        eps_high=_to_float(row.get("eps_estimate_high")),
        eps_low=_to_float(row.get("eps_estimate_low")),
        analyst_count=_to_int(row.get("eps_estimate_analyst_count")),
        eps_mean_7d_ago=_to_float(row.get("eps_estimate_average_7_days_ago")),
        eps_mean_30d_ago=_to_float(row.get("eps_estimate_average_30_days_ago")),
        eps_mean_60d_ago=_to_float(row.get("eps_estimate_average_60_days_ago")),
        eps_mean_90d_ago=_to_float(row.get("eps_estimate_average_90_days_ago")),
        revisions_up_7d=_to_int(row.get("eps_estimate_revision_up_trailing_7_days")),
        revisions_down_7d=_to_int(row.get("eps_estimate_revision_down_trailing_7_days")),
        revisions_up_30d=_to_int(row.get("eps_estimate_revision_up_trailing_30_days")),
        revisions_down_30d=_to_int(row.get("eps_estimate_revision_down_trailing_30_days")),
    )


def _to_reported(symbol: str, row: dict[str, Any]) -> ReportedEarnings:
    reported_date = row.get("reportedDate")
    return ReportedEarnings(
        symbol=symbol,
        fiscal_date_ending=pd.Timestamp(row["fiscalDateEnding"]),
        reported_date=pd.Timestamp(reported_date) if reported_date else None,
        reported_eps=_to_float(row.get("reportedEPS")),
        estimated_eps=_to_float(row.get("estimatedEPS")),
        surprise=_to_float(row.get("surprise")),
        surprise_percent=_to_float(row.get("surprisePercentage")),
        report_time=row.get("reportTime"),
    )


class AlphaVantageSource:
    """Adapts `AlphaVantageClient` to `ConsensusSource` and `EarningsSource`."""

    def __init__(self, client: AlphaVantageClient) -> None:
        self._client = client

    def consensus(self, symbol: str, *, now: pd.Timestamp) -> list[ConsensusSnapshot]:
        rows = self._client.earnings_estimates(symbol)
        return [
            ConsensusSnapshot(
                symbol=r.symbol,
                period_end=r.period_end.date(),
                period_kind="annual" if r.horizon == "fiscal year" else "quarter",
                fiscal_year=r.fiscal_year,
                fiscal_quarter=r.fiscal_quarter,
                eps_mean=r.eps_mean,
                eps_high=r.eps_high,
                eps_low=r.eps_low,
                analyst_count=r.analyst_count,
                provider=PROVIDER_NAME,
                quality="eod",
                as_of=now,
            )
            for r in rows
        ]

    def earnings_results(self, symbol: str, *, now: pd.Timestamp) -> list[EarningsResult]:
        rows = self._client.earnings(symbol)
        return [
            EarningsResult(
                symbol=r.symbol,
                period_end=r.fiscal_date_ending.date(),
                fiscal_year=r.fiscal_date_ending.year,
                fiscal_quarter=r.fiscal_date_ending.quarter,
                report_date=r.reported_date.date() if r.reported_date is not None else None,
                report_time=r.report_time,
                eps_estimate=r.estimated_eps,
                eps_actual=r.reported_eps,
                surprise=r.surprise,
                surprise_percent=r.surprise_percent,
                provider=PROVIDER_NAME,
                quality="eod",
                as_of=now,
            )
            for r in rows
        ]


def _build(env: Mapping[str, str], http: ThrottledClient) -> AlphaVantageSource:
    client = AlphaVantageClient(env.get("ALPHA_VANTAGE_API_KEY", ""), http=http)
    return AlphaVantageSource(client)


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("consensus", "earnings"), build=_build)
