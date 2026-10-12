"""Finnhub: earnings calendar, company news, and whichever of EPS estimates,
earnings surprises, recommendation trends, and price targets the free plan
actually serves.

Probed live against a real key (2026-10-11):
- `calendar/earnings` (with or without a `symbol` filter), `company-news`,
  `stock/earnings` (surprises, 4 quarters), and `stock/recommendation`
  (buy/hold/sell trend counts) are free -- HTTP 200 with real data.
- `stock/dividend` and `stock/price-target` answer HTTP 403
  (``{"error": "You don't have access to this resource."}``) on the free
  plan -- confirmed dead ends, so no `dividends()` method is built here
  (controller ruling: it can never work on the free plans). `calendar/dividend`
  (the broad, market-wide variant) answers HTTP 200 with an empty `{}` body
  for any symbol/date range tried -- not an error, just no free dividends
  data either way. `stock/eps-estimate` (Finnhub's one source of consensus
  EPS mean/high/low) is 403 too, matching `consensus-eps-sources.md`'s
  "Premium" note.
- A bad key is HTTP 401 (``{"error": "Invalid API key"}``); an unknown
  symbol or an empty date range is HTTP 200 with an empty array `[]`.

`FinnhubSource` adapts the raw client to `NewsSource`, `EarningsCalendarSource`,
and (partially) `EarningsSource`/`TargetsSource`. Its targets adapter returns
the real buy/hold/sell counts with every target price `None`: Finnhub's free
plan has no price-target endpoint (confirmed live) -- a partial substitute,
not an equally-complete alternative, which is why it is listed after Eulerpool
in `DEFAULT_CHAINS["targets"]` rather than merged with it (02j §6: "Out of
scope: merging fields across providers").
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.types import AnalystTargets, EarningsEvent, EarningsResult, NewsItem, Timing

PROVIDER_NAME = "finnhub"
BASE = "https://finnhub.io/api/v1"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"
HOST_KEY = "finnhub"

# The free plan allows 60 calls a minute (brief, confirmed by Finnhub's own docs).
MIN_INTERVAL_S = 60.0 / 60.0

_TIMING: dict[str, Timing] = {"bmo": "before_open", "amc": "after_close"}


@dataclass(frozen=True)
class EarningsCalendarEntry:
    symbol: str
    report_date: date
    hour: str  # Finnhub's own code: "bmo" / "amc" / "" (unknown)
    fiscal_year: int | None
    fiscal_quarter: int | None
    eps_estimate: float | None
    eps_actual: float | None
    revenue_estimate: float | None
    revenue_actual: float | None


@dataclass(frozen=True)
class RecommendationTrend:
    symbol: str
    period: date
    strong_buy: int
    buy: int
    hold: int
    sell: int
    strong_sell: int


@dataclass(frozen=True)
class EarningsSurprise:
    symbol: str
    period_end: date
    fiscal_year: int | None
    fiscal_quarter: int | None
    eps_estimate: float | None
    eps_actual: float | None
    surprise: float | None
    surprise_percent: float | None


class FinnhubClient:
    """Earnings calendar, company news, surprises, and recommendation trends."""

    def __init__(self, api_key: str, *, http: ThrottledClient | None = None) -> None:
        self.api_key = api_key
        self._http = http or ThrottledClient()

    def earnings_calendar(self, symbol: str, start: date, end: date) -> list[EarningsCalendarEntry]:
        body = self._get("/calendar/earnings", {"symbol": symbol, "from": start.isoformat(), "to": end.isoformat()})
        rows = body.get("earningsCalendar") or []
        if not rows:
            raise NoData(PROVIDER_NAME, f"no earnings-calendar entries for {symbol!r} between {start} and {end}")
        return [_to_calendar_entry(r) for r in rows]

    def company_news(self, symbol: str, start: date, end: date) -> list[NewsItem]:
        body = self._get("/company-news", {"symbol": symbol, "from": start.isoformat(), "to": end.isoformat()})
        if not body:
            raise NoData(PROVIDER_NAME, f"no news for {symbol!r} between {start} and {end}")
        return [_to_news_item(r) for r in body]

    def recommendation_trends(self, symbol: str) -> list[RecommendationTrend]:
        body = self._get("/stock/recommendation", {"symbol": symbol})
        if not body:
            raise NoData(PROVIDER_NAME, f"no recommendation trend for {symbol!r}")
        return [_to_recommendation(r) for r in body]

    def earnings_surprises(self, symbol: str) -> list[EarningsSurprise]:
        body = self._get("/stock/earnings", {"symbol": symbol})
        if not body:
            raise NoData(PROVIDER_NAME, f"no earnings surprises for {symbol!r}")
        return [_to_surprise(r) for r in body]

    def _get(self, path: str, params: dict[str, str]) -> Any:
        if not self.api_key:
            raise NotConfigured(PROVIDER_NAME, "no API key configured")
        merged = dict(params)
        merged["token"] = self.api_key
        response = self._http.get(
            f"{BASE}{path}",
            provider=PROVIDER_NAME,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=merged,
        )
        if response.status_code == 401:
            raise NotConfigured(PROVIDER_NAME, "key rejected (HTTP 401)")
        if response.status_code == 403:
            raise NotConfigured(PROVIDER_NAME, f"{path} not entitled on this plan (HTTP 403)")
        if response.status_code != 200:
            raise Unavailable(PROVIDER_NAME, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER_NAME, f"malformed JSON body: {exc}") from exc


def _to_calendar_entry(row: dict[str, Any]) -> EarningsCalendarEntry:
    return EarningsCalendarEntry(
        symbol=row["symbol"],
        report_date=date.fromisoformat(row["date"]),
        hour=row.get("hour") or "",
        fiscal_year=row.get("year"),
        fiscal_quarter=row.get("quarter"),
        eps_estimate=row.get("epsEstimate"),
        eps_actual=row.get("epsActual"),
        revenue_estimate=row.get("revenueEstimate"),
        revenue_actual=row.get("revenueActual"),
    )


def _to_news_item(row: dict[str, Any]) -> NewsItem:
    return NewsItem(
        symbol=row.get("related") or "",
        headline=row["headline"],
        publisher=row.get("source") or "",
        url=row.get("url") or "",
        published_at=pd.Timestamp(row["datetime"], unit="s", tz="UTC"),
        provider=PROVIDER_NAME,
        quality="eod",
    )


def _to_recommendation(row: dict[str, Any]) -> RecommendationTrend:
    return RecommendationTrend(
        symbol=row["symbol"],
        period=date.fromisoformat(row["period"]),
        strong_buy=row["strongBuy"],
        buy=row["buy"],
        hold=row["hold"],
        sell=row["sell"],
        strong_sell=row["strongSell"],
    )


def _to_surprise(row: dict[str, Any]) -> EarningsSurprise:
    return EarningsSurprise(
        symbol=row["symbol"],
        period_end=date.fromisoformat(row["period"]),
        fiscal_year=row.get("year"),
        fiscal_quarter=row.get("quarter"),
        eps_estimate=row.get("estimate"),
        eps_actual=row.get("actual"),
        surprise=row.get("surprise"),
        surprise_percent=row.get("surprisePercent"),
    )


class FinnhubSource:
    """Adapts `FinnhubClient` to `NewsSource`, `EarningsCalendarSource`, and partially to
    `EarningsSource`/`TargetsSource`."""

    def __init__(self, client: FinnhubClient) -> None:
        self._client = client

    def news(self, symbol: str, start: date, end: date) -> list[NewsItem]:
        return self._client.company_news(symbol, start, end)

    def earnings_calendar(self, symbol: str, start: date, end: date) -> list[EarningsEvent]:
        entries = self._client.earnings_calendar(symbol, start, end)
        return [
            EarningsEvent(
                symbol=e.symbol,
                report_date=e.report_date,
                timing=_TIMING.get(e.hour, "unknown"),
                fiscal_year=e.fiscal_year,
                fiscal_quarter=e.fiscal_quarter,
                eps_estimate=e.eps_estimate,
                eps_actual=e.eps_actual,
                revenue_estimate=e.revenue_estimate,
                revenue_actual=e.revenue_actual,
                provider=PROVIDER_NAME,
                quality="eod",
            )
            for e in entries
        ]

    def earnings_results(self, symbol: str, *, now: pd.Timestamp) -> list[EarningsResult]:
        surprises = self._client.earnings_surprises(symbol)
        return [
            EarningsResult(
                symbol=s.symbol,
                period_end=s.period_end,
                fiscal_year=s.fiscal_year,
                fiscal_quarter=s.fiscal_quarter,
                report_date=None,  # /stock/earnings gives only the fiscal period end, not when it was reported
                report_time=None,
                eps_estimate=s.eps_estimate,
                eps_actual=s.eps_actual,
                surprise=s.surprise,
                surprise_percent=s.surprise_percent,
                provider=PROVIDER_NAME,
                quality="eod",
                as_of=now,
            )
            for s in surprises
        ]

    def analyst_targets(self, symbol: str, *, now: pd.Timestamp) -> AnalystTargets:
        """Counts only: Finnhub's free plan has no price-target endpoint (confirmed live)."""
        rows = self._client.recommendation_trends(symbol)
        latest = max(rows, key=lambda r: r.period)
        return AnalystTargets(
            symbol=latest.symbol,
            target_mean=None,
            target_median=None,
            target_high=None,
            target_low=None,
            strong_buy=latest.strong_buy,
            buy=latest.buy,
            hold=latest.hold,
            sell=latest.sell,
            strong_sell=latest.strong_sell,
            provider=PROVIDER_NAME,
            quality="eod",
            as_of=now,
        )


def _build(env: Mapping[str, str], http: ThrottledClient) -> FinnhubSource:
    client = FinnhubClient(env.get("FINNHUB_API_KEY", ""), http=http)
    return FinnhubSource(client)


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("news", "earnings_calendar", "earnings", "targets"), build=_build)
