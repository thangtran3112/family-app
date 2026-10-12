"""Eulerpool: analyst estimates, earnings calendar/surprises, and targets/recommendations.

API discovered from <https://eulerpool.com/llms-full.txt> (the marketing
site itself returns HTTP 403 to any non-browser `GET`, including this
project's `webfetch`/`curl` -- a Cloudflare bot gate, same shape as Stooq's;
the `/llms-full.txt` endpoint and the API host `api.eulerpool.com` are not
behind it). Endpoints used (base `https://api.eulerpool.com/api/1`),
confirmed live against a real key (2026-10-11), all free on a brand-new key
with no entitlement upgrade:

- `GET /equity/estimates/{identifier}` -- consensus EPS/revenue/EBIT by
  fiscal period, with per-metric analyst counts. No 7/30/90-day revision
  snapshots (02f §4's own design computes those from the Desk's daily
  snapshots, not from a provider field, so this is not a gap).
- `GET /calendar/earnings-by-symbol/{symbol}` -- historical and upcoming
  earnings dates with EPS/revenue estimate and actual (actual is absent
  until reported).
- `GET /calendar/earnings-surprises/{symbol}` -- a dedicated surprise
  history (estimate, actual, difference, percent) by quarter.
- `GET /research/recommendations/{ticker}` -- buy/hold/sell counts *and*
  the mean/median/high/low consensus target in one response, by month.
  `GET /equity/price-target-consensus/{identifier}` duplicates the target
  fields with no rating counts and no new information, so it is not used
  here (one call already covers everything `AnalystTargets` needs).

`identifier`/`ticker` accepts a plain ticker (`AAPL`), not just an ISIN --
confirmed live; ISIN also works but adds a lookup step this lane doesn't need.

Error mapping, confirmed live: a bad key is HTTP 401
(``{"error": "Invalid API key. ..."}}``); an unknown security is HTTP 404
(``{"error": "Security not found"}``) on `/equity/*` paths or
``{"error": "No recommendations for <symbol>"}`` on `/research/*`; a known
security with no coverage for one data class (an uncommon shape, confirmed
live for Berkshire's EPS estimates: BRK.B/BRK.A/its ISIN all give `[]`,
while its earnings calendar and recommendations do have data) is HTTP 200
with an empty array, not an error either.

No documented per-minute rate limit was found (only the "100,000
requests/month, non-commercial" plan ceiling); `MIN_INTERVAL_S` is this
lane's own conservative choice, not a published number.

`EulerpoolSource` adapts the raw client to `ConsensusSource`, `EarningsSource`,
and `TargetsSource`. Its `earnings_results` joins Eulerpool's own earnings-
calendar and earnings-surprises endpoints (see `_merge_by_period` below) --
purely an Eulerpool-internal join, not cross-provider fallback (that lives in
`registry.py`).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Any

import pandas as pd

from ai_trading_common._provider import Provider
from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.types import AnalystTargets, ConsensusSnapshot, EarningsResult

PROVIDER_NAME = "eulerpool"
BASE = "https://api.eulerpool.com/api/1"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"
HOST_KEY = "eulerpool"

# No published per-minute limit; a polite default well under the 100k/month
# free ceiling even at full daily-batch volume (02f §4's "snapshot once a
# day per symbol" workload is nowhere near this).
MIN_INTERVAL_S = 0.1


@dataclass(frozen=True)
class EstimatePeriod:
    symbol: str
    period_end: date
    fiscal_year: int | None
    fiscal_quarter: int | None
    eps_mean: float | None
    eps_high: float | None
    eps_low: float | None
    eps_analyst_count: int | None
    revenue_mean: float | None
    revenue_high: float | None
    revenue_low: float | None
    revenue_analyst_count: int | None


@dataclass(frozen=True)
class CalendarEntry:
    symbol: str
    report_date: date
    eps_estimate: float | None
    eps_actual: float | None
    revenue_estimate: float | None
    revenue_actual: float | None


@dataclass(frozen=True)
class EarningsSurprise:
    symbol: str
    period_end: date
    fiscal_year: int | None
    fiscal_quarter: int | None
    eps_estimate: float | None
    eps_actual: float | None
    eps_difference: float | None
    surprise_percent: float | None


@dataclass(frozen=True)
class Recommendation:
    symbol: str
    period: date
    strong_buy: int
    buy: int
    hold: int
    sell: int
    strong_sell: int
    target_mean: float | None
    target_median: float | None
    target_high: float | None
    target_low: float | None


class EulerpoolClient:
    """Analyst estimates, earnings calendar/surprises, and targets/recommendations."""

    def __init__(self, api_key: str, *, http: ThrottledClient | None = None) -> None:
        self.api_key = api_key
        self._http = http or ThrottledClient()

    def estimates(self, symbol: str) -> list[EstimatePeriod]:
        rows = self._get(f"/equity/estimates/{symbol}", not_found=f"no estimates coverage for {symbol!r}")
        if not rows:
            raise NoData(PROVIDER_NAME, f"no estimates for {symbol!r}")
        return [_to_estimate_period(symbol, r) for r in rows]

    def earnings_calendar(self, symbol: str) -> list[CalendarEntry]:
        rows = self._get(f"/calendar/earnings-by-symbol/{symbol}", not_found=f"no earnings calendar for {symbol!r}")
        if not rows:
            raise NoData(PROVIDER_NAME, f"no earnings-calendar entries for {symbol!r}")
        return [_to_calendar_entry(r) for r in rows]

    def earnings_surprises(self, symbol: str) -> list[EarningsSurprise]:
        rows = self._get(f"/calendar/earnings-surprises/{symbol}", not_found=f"no earnings surprises for {symbol!r}")
        if not rows:
            raise NoData(PROVIDER_NAME, f"no earnings surprises for {symbol!r}")
        return [_to_surprise(r) for r in rows]

    def recommendations(self, symbol: str) -> list[Recommendation]:
        rows = self._get(f"/research/recommendations/{symbol}", not_found=f"no recommendations for {symbol!r}")
        if not rows:
            raise NoData(PROVIDER_NAME, f"no recommendations for {symbol!r}")
        return [_to_recommendation(symbol, r) for r in rows]

    def _get(self, path: str, *, not_found: str) -> Any:
        if not self.api_key:
            raise NotConfigured(PROVIDER_NAME, "no API key configured")
        response = self._http.get(
            f"{BASE}{path}",
            provider=PROVIDER_NAME,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params={"token": self.api_key},
        )
        if response.status_code == 401:
            raise NotConfigured(PROVIDER_NAME, "key rejected (HTTP 401)")
        if response.status_code == 404:
            raise NoData(PROVIDER_NAME, not_found)
        if response.status_code != 200:
            raise Unavailable(PROVIDER_NAME, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER_NAME, f"malformed JSON body: {exc}") from exc


def _to_estimate_period(symbol: str, row: dict[str, Any]) -> EstimatePeriod:
    return EstimatePeriod(
        symbol=symbol,
        period_end=date.fromisoformat(row["period"]),
        fiscal_year=row.get("year"),
        fiscal_quarter=row.get("quarter"),
        eps_mean=row.get("epsEstimate"),
        eps_high=row.get("epsHigh"),
        eps_low=row.get("epsLow"),
        eps_analyst_count=row.get("epsAnalysts"),
        revenue_mean=row.get("revenueEstimate"),
        revenue_high=row.get("revenueHigh"),
        revenue_low=row.get("revenueLow"),
        revenue_analyst_count=row.get("revenueAnalysts"),
    )


def _to_calendar_entry(row: dict[str, Any]) -> CalendarEntry:
    return CalendarEntry(
        symbol=row["symbol"],
        report_date=date.fromisoformat(row["date"]),
        eps_estimate=row.get("epsEstimate"),
        eps_actual=row.get("epsActual"),
        revenue_estimate=row.get("revenueEstimate"),
        revenue_actual=row.get("revenueActual"),
    )


def _to_surprise(row: dict[str, Any]) -> EarningsSurprise:
    return EarningsSurprise(
        symbol=row["symbol"],
        period_end=date.fromisoformat(row["date"]),
        fiscal_year=row.get("year"),
        fiscal_quarter=row.get("quarter"),
        eps_estimate=row.get("epsEstimate"),
        eps_actual=row.get("epsActual"),
        eps_difference=row.get("epsDifference"),
        surprise_percent=row.get("surprisePercent"),
    )


def _to_recommendation(symbol: str, row: dict[str, Any]) -> Recommendation:
    return Recommendation(
        symbol=symbol,
        period=date.fromisoformat(row["period"]),
        strong_buy=row["strongBuy"],
        buy=row["buy"],
        hold=row["hold"],
        sell=row["sell"],
        strong_sell=row["strongSell"],
        target_mean=row.get("targetMean"),
        target_median=row.get("targetMedian"),
        target_high=row.get("targetHigh"),
        target_low=row.get("targetLow"),
    )


def _from_calendar(row: CalendarEntry, *, as_of: pd.Timestamp) -> EarningsResult:
    """`period_end` starts `None`: the calendar carries only the report date, never the fiscal
    period it reports on; `_merge_by_period` fills it in once (if) this row is joined to a
    surprise row that does carry it."""
    return EarningsResult(
        symbol=row.symbol,
        period_end=None,
        fiscal_year=None,
        fiscal_quarter=None,
        report_date=row.report_date,
        report_time=None,
        eps_estimate=row.eps_estimate,
        eps_actual=row.eps_actual,
        surprise=None,
        surprise_percent=None,
        provider=PROVIDER_NAME,
        quality="eod",
        as_of=as_of,
    )


def _from_surprise(row: EarningsSurprise, *, as_of: pd.Timestamp) -> EarningsResult:
    """`report_date` starts `None`: the surprise history carries only the fiscal period end,
    never the report date; `_merge_by_period` fills it in once (if) this row is joined to a
    calendar row that does carry it."""
    return EarningsResult(
        symbol=row.symbol,
        period_end=row.period_end,
        fiscal_year=row.fiscal_year,
        fiscal_quarter=row.fiscal_quarter,
        report_date=None,
        report_time=None,
        eps_estimate=row.eps_estimate,
        eps_actual=row.eps_actual,
        surprise=row.eps_difference,
        surprise_percent=row.surprise_percent,
        provider=PROVIDER_NAME,
        quality="eod",
        as_of=as_of,
    )


#: A report always follows its own fiscal period's end, and the next quarter's report lands
#: about 110 days or more later (quarters run ~90 days, plus a reporting lag) -- so a 90-day
#: lookahead window joins a period to its own report without ever reaching into the next one's.
_REPORT_WINDOW = timedelta(days=90)


def _merge_by_period(calendar: list[EarningsResult], surprises: list[EarningsResult]) -> list[EarningsResult]:
    """Eulerpool's calendar carries each report's filing date (`report_date`) but not the fiscal
    period it reports on; its surprise history carries the period (`period_end`, `fiscal_year`,
    `fiscal_quarter`) but not the report date. Neither can be the join key by itself -- joins each
    surprise to the first calendar row (in list order) whose `report_date` falls in
    `(period_end, period_end + 90 days]`, a window chosen so a period always finds its own report
    and never the next period's. A calendar row joins at most one surprise.

    A merged row takes `period_end`/`fiscal_year`/`fiscal_quarter` from the surprise and
    `report_date` from the calendar; `eps_estimate`/`eps_actual`/`surprise`/`surprise_percent` come
    from the surprise when present, else the calendar. An unmatched surprise keeps
    `report_date=None`; an unmatched calendar row (older history the surprise endpoint doesn't
    reach, or the upcoming undated-actual entry) keeps `period_end=None`.
    """
    used = set()
    merged: list[EarningsResult] = []
    for surprise in surprises:
        window_end = surprise.period_end + _REPORT_WINDOW
        match = next(
            (
                c
                for c in calendar
                if id(c) not in used and c.report_date is not None and surprise.period_end < c.report_date <= window_end
            ),
            None,
        )
        if match is None:
            merged.append(surprise)
            continue
        used.add(id(match))
        merged.append(
            replace(
                surprise,
                report_date=match.report_date,
                eps_estimate=surprise.eps_estimate if surprise.eps_estimate is not None else match.eps_estimate,
                eps_actual=surprise.eps_actual if surprise.eps_actual is not None else match.eps_actual,
                surprise=surprise.surprise if surprise.surprise is not None else match.surprise,
                surprise_percent=surprise.surprise_percent
                if surprise.surprise_percent is not None
                else match.surprise_percent,
            )
        )
    unmatched_calendar = [c for c in calendar if id(c) not in used]
    return sorted(merged + unmatched_calendar, key=lambda r: r.period_end or r.report_date)


class EulerpoolSource:
    """Adapts `EulerpoolClient` to `ConsensusSource`, `EarningsSource`, and `TargetsSource`."""

    def __init__(self, client: EulerpoolClient) -> None:
        self._client = client

    def consensus(self, symbol: str, *, now: pd.Timestamp) -> list[ConsensusSnapshot]:
        rows = self._client.estimates(symbol)
        return [
            ConsensusSnapshot(
                symbol=r.symbol,
                period_end=r.period_end,
                period_kind="quarter" if r.fiscal_quarter else "annual",
                fiscal_year=r.fiscal_year,
                fiscal_quarter=r.fiscal_quarter,
                eps_mean=r.eps_mean,
                eps_high=r.eps_high,
                eps_low=r.eps_low,
                analyst_count=r.eps_analyst_count,
                provider=PROVIDER_NAME,
                quality="eod",
                as_of=now,
            )
            for r in rows
        ]

    def earnings_results(self, symbol: str, *, now: pd.Timestamp) -> list[EarningsResult]:
        calendar = [_from_calendar(r, as_of=now) for r in self._client.earnings_calendar(symbol)]
        surprises = [_from_surprise(r, as_of=now) for r in self._client.earnings_surprises(symbol)]
        return _merge_by_period(calendar, surprises)

    def analyst_targets(self, symbol: str, *, now: pd.Timestamp) -> AnalystTargets:
        rows = self._client.recommendations(symbol)
        latest = max(rows, key=lambda r: r.period)
        return AnalystTargets(
            symbol=latest.symbol,
            target_mean=latest.target_mean,
            target_median=latest.target_median,
            target_high=latest.target_high,
            target_low=latest.target_low,
            strong_buy=latest.strong_buy,
            buy=latest.buy,
            hold=latest.hold,
            sell=latest.sell,
            strong_sell=latest.strong_sell,
            provider=PROVIDER_NAME,
            quality="eod",
            as_of=now,
        )


def _build(env: Mapping[str, str], http: ThrottledClient) -> EulerpoolSource:
    client = EulerpoolClient(env.get("EULERPOOL_API_KEY", ""), http=http)
    return EulerpoolSource(client)


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("consensus", "earnings", "targets"), build=_build)
