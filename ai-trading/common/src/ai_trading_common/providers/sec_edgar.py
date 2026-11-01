"""SEC EDGAR: point-in-time CompanyFacts and 8-K Item 2.02 announcement dates.

Modified from TradingAgents `tradingagents/dataflows/vendors/sec_edgar.py`
(Apache License 2.0, upstream commit `1394a3f72aa4393e1a98f51b382434c4b4c2d972`;
see THIRD_PARTY_NOTICES.md). Compared with `ai-trading/packages/market-data/sec.py`
(ours, open-source lane): kept that file's CIK lookup (`BRK.B` -> `BRK-B`) and
its 404-as-empty handling; kept TradingAgents' span classification
(`_span_index`/`_SPANS`/`_YEAR_TO_DATE`, renamed `_classify_span`) and its
amendment rule ("a period reported more than once takes its latest filing on
or before the date"). Changes from both: this returns typed `Fact` rows, not
a rendered statement or a flattened label map, so a caller (valuation, a
chart) picks its own concepts and aggregation; the point-in-time cut is its
own pure `facts_as_of(facts, as_of)` function (now in `ai_trading_common.types`),
so it is testable and reusable without a network call per cut; errors map to
this package's shared `ProviderError` hierarchy instead of TradingAgents'
`NoMarketDataError`/`VendorUnavailableError`; and the 8-K Item 2.02 reader is
new (ai-hedge-fund `hedge_fund/signals/pead.py`'s "the 8-K is the announcement
date, not the 10-Q" pattern -- idea only, no code copied).

No key or account: SEC requires only a declared User-Agent identifying the
caller (`SEC_USER_AGENT`), and refuses an unidentified request with 403.

`SecEdgarSource` adapts this raw client to `FundamentalsSource`
(`facts`) and `EarningsAnnouncementsSource` (`announcements`), mapping its own
`EightKFiling` records into the shared `EarningsAnnouncement` type (02j §4).
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any

from ai_trading_common._provider import Provider
from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.types import EarningsAnnouncement, Fact, Span, facts_as_of

PROVIDER_NAME = "sec_edgar"

# SEC's fair-access policy rate-limits sec.gov as one site-wide bucket (10
# requests/second), not per-subdomain, so www.sec.gov and data.sec.gov share
# one host key and one throttle bucket here.
HOST_KEY = "sec_edgar"
MIN_INTERVAL_S = 1.0 / 10.0

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
#: How long a downloaded ticker -> CIK map is trusted. New listings are rare and a miss is a clean `NoData`, so a
#: new ticker is found at most this long after SEC publishes it.
TICKERS_TTL_S = 6 * 3600.0
FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
# An older filings.files page (`{"name": "CIK...-submissions-NNN.json", ...}`)
# is a flat document at this sibling path to the root submissions URL — same
# column-array shape as `filings.recent` itself, not nested under "filings".
SUBMISSIONS_PAGE_URL = "https://data.sec.gov/submissions/{name}"

# (low days, high days, span) a duration fact's start-to-end length falls
# into. From TradingAgents' `_SPANS`/`_YEAR_TO_DATE`: a quarter runs ~90 days;
# a 10-Q's cash-flow table is often filed only year-to-date under the same end
# date a quarter would use (a 6- or 9-month column); a fiscal year runs ~365.
# A span outside every bucket is dropped (`_classify_span` returns None)
# rather than guessed — matching a figure from a filing it does not describe
# would misreport the period, not just the number.
_SPAN_RANGES: tuple[tuple[int, int, Span], ...] = (
    (60, 115, "quarterly"),
    (150, 200, "ytd_6m"),
    (240, 290, "ytd_9m"),
    (300, 400, "annual"),
)


def _classify_span(start: date | None, end: date) -> Span | None:
    """Which bucket a duration fact's [start, end] falls in; "instant" for a balance."""
    if start is None:
        return "instant"
    days = (end - start).days
    for low, high, span in _SPAN_RANGES:
        if low <= days <= high:
            return span
    return None


@dataclass(frozen=True)
class EightKFiling:
    """An 8-K filing and the items it covers (SEC-internal; `announcements()` maps this into
    the shared `EarningsAnnouncement`, which has no `items` field -- not every provider can
    report the broader set of form items an 8-K carries)."""

    filed: date
    accession: str
    items: tuple[str, ...]


def _parse_facts(payload: dict, *, concepts: tuple[str, ...] | None = None) -> list[Fact]:
    """Every us-gaap fact SEC has ever reported for this filer, span-classified.

    Not point-in-time yet: every amendment of every period is present.
    `facts_as_of` is the pure selector that cuts this to what was known at a
    given date. `concepts`, when given, limits parsing to those us-gaap tags
    (a trimmed fixture, or a caller that only wants a few line items).
    """
    us_gaap = (payload.get("facts") or {}).get("us-gaap") or {}
    wanted = us_gaap if concepts is None else {c: us_gaap[c] for c in concepts if c in us_gaap}
    out: list[Fact] = []
    for concept, body in wanted.items():
        for unit, entries in (body.get("units") or {}).items():
            for entry in entries:
                end = date.fromisoformat(entry["end"])
                start = date.fromisoformat(entry["start"]) if "start" in entry else None
                span = _classify_span(start, end)
                if span is None:
                    continue
                out.append(
                    Fact(
                        concept=concept,
                        unit=unit,
                        value=float(entry["val"]),
                        period_start=start,
                        period_end=end,
                        span=span,
                        fiscal_year=entry.get("fy"),
                        fiscal_period=entry.get("fp"),
                        form=entry["form"],
                        filed=date.fromisoformat(entry["filed"]),
                        reference=entry["accn"],
                        provider=PROVIDER_NAME,
                        quality="eod",
                    )
                )
    return out


def _parse_item_202_block(block: dict) -> list[EightKFiling]:
    """8-K filings carrying Item 2.02 ("Results of Operations and Financial Condition")
    out of one flat column-array block: either `filings.recent` or the body of
    one `filings.files` page (same shape, flat rather than nested).
    """
    forms = block.get("form") or []
    items_column = block.get("items") or []
    out = []
    for i, form in enumerate(forms):
        if form != "8-K":
            continue
        items = tuple(x for x in (items_column[i] or "").split(",") if x)
        if "2.02" not in items:
            continue
        out.append(
            EightKFiling(
                filed=date.fromisoformat(block["filingDate"][i]),
                accession=block["accessionNumber"][i],
                items=items,
            )
        )
    return out


def _parse_item_202(payload: dict) -> list[EightKFiling]:
    """8-K Item 2.02 filings out of the submissions feed's `filings.recent` block.

    Only `filings.recent` is read here: SEC's own rolling window of the
    filer's most recent filings. `SecEdgar.item_202_filings` is the method
    that also follows `filings.files` when `recent` doesn't reach far enough
    back; this function stays a pure, single-block parser.
    """
    return _parse_item_202_block(((payload.get("filings") or {}).get("recent")) or {})


def _oldest_filing_date(block: dict) -> date | None:
    """The earliest `filingDate` in a flat column-array block, or `None` when empty.

    `filingDate` is not reliably sorted within a block (filing types can
    interleave), so this scans rather than trusting the first/last entry.
    """
    dates = block.get("filingDate") or []
    if not dates:
        return None
    return min(date.fromisoformat(d) for d in dates)


def eight_k_as_of(filings: list[EightKFiling], as_of: date) -> list[EightKFiling]:
    """Pure selector: filings known by `as_of` (a filing's own date is its announcement)."""
    return sorted((f for f in filings if f.filed <= as_of), key=lambda f: f.filed)


class SecEdgar:
    """SEC EDGAR: ticker -> CIK, point-in-time CompanyFacts, and 8-K Item 2.02 dates."""

    def __init__(self, user_agent: str, *, http: ThrottledClient | None = None) -> None:
        self.user_agent = user_agent
        self._http = http or ThrottledClient()
        #: `(fetched_at, normalized ticker -> raw cik_str)` from `company_tickers.json`, or None before the first
        #: lookup. One tuple, replaced whole, so threads sharing this client never see a half-built index.
        self._cik_index: tuple[float, dict[str, Any]] | None = None

    def company_facts(self, ticker: str, as_of: date, *, concepts: tuple[str, ...] | None = None) -> list[Fact]:
        """CompanyFacts as known at `as_of`: amendments resolved, un-spanned facts dropped."""
        cik = self._cik(ticker)
        payload = self._get_json(FACTS_URL.format(cik=cik))
        return facts_as_of(_parse_facts(payload, concepts=concepts), as_of)

    def item_202_filings(self, ticker: str, since: date) -> list[EightKFiling]:
        """8-K Item 2.02 filings back through `since`.

        `filings.recent` often doesn't reach that far: for a heavy filer such
        as JPMorgan (daily prospectus supplements), it covers roughly the
        trailing year regardless of the filing count — live-confirmed at
        26,293 rows reaching only back to 2025-10-10 (see REPORT-P2.md).
        When `recent`'s own oldest filing is still after `since`, the older
        `filings.files` pages are fetched one at a time, newest first (by
        `filingTo` descending), stopping as soon as a fetched page's own
        `filingFrom` reaches `since` — decided from the `files` directory
        metadata already in hand, so never more pages than needed. Each page
        goes through the same throttle and error mapping as every other
        request (`_get_json`): a failed page raises `Unavailable` rather than
        silently returning a partial list.
        """
        cik = self._cik(ticker)
        root = self._get_json(SUBMISSIONS_URL.format(cik=cik))
        recent = ((root.get("filings") or {}).get("recent")) or {}
        found = _parse_item_202_block(recent)

        oldest = _oldest_filing_date(recent)
        if oldest is None or oldest > since:
            pages = sorted((root.get("filings") or {}).get("files") or [], key=lambda f: f["filingTo"], reverse=True)
            for page in pages:
                page_payload = self._get_json(SUBMISSIONS_PAGE_URL.format(name=page["name"]))
                found.extend(_parse_item_202_block(page_payload))
                if date.fromisoformat(page["filingFrom"]) <= since:
                    break
        return sorted(found, key=lambda f: f.filed)

    def _cik(self, ticker: str) -> str:
        wanted = ticker.strip().upper().replace(".", "-")  # SEC lists class shares as BRK-B
        cached = self._cik_index
        if cached is None or time.monotonic() - cached[0] > TICKERS_TTL_S:
            # One download and one pass over the ~10k-entry file per TTL, not per lookup: every `company_facts` and
            # `item_202_filings` call used to refetch and rescan it. Failures raise before anything is cached.
            index: dict[str, Any] = {}
            for entry in self._get_json(TICKERS_URL).values():
                index.setdefault(entry.get("ticker", "").upper(), entry.get("cik_str"))  # first match wins, as before
            cached = self._cik_index = (time.monotonic(), index)
        cik = cached[1].get(wanted)
        if cik is None:
            raise NoData(PROVIDER_NAME, f"{ticker!r} is not a US SEC filer")
        return f"{int(cik):010d}"

    def _get_json(self, url: str) -> dict:
        if not self.user_agent:
            raise NotConfigured(PROVIDER_NAME, "no SEC_USER_AGENT configured")
        response = self._http.get(
            url,
            provider=PROVIDER_NAME,
            host_key=HOST_KEY,
            user_agent=self.user_agent,
            min_interval=MIN_INTERVAL_S,
            ban_prone=True,  # an unidentified or malformed User-Agent gets a latching 403
        )
        if response.status_code == 404:
            raise NoData(PROVIDER_NAME, f"SEC has nothing at {url}")
        if response.status_code != 200:
            raise Unavailable(PROVIDER_NAME, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER_NAME, f"malformed JSON body: {exc}") from exc


class SecEdgarSource:
    """Adapts `SecEdgar` to `FundamentalsSource` and `EarningsAnnouncementsSource`."""

    def __init__(self, client: SecEdgar) -> None:
        self._client = client

    def facts(self, symbol: str, *, as_of: date, concepts: tuple[str, ...] | None = None) -> list[Fact]:
        return self._client.company_facts(symbol, as_of, concepts=concepts)

    def announcements(self, symbol: str, *, since: date) -> list[EarningsAnnouncement]:
        filings = self._client.item_202_filings(symbol, since)
        return [
            EarningsAnnouncement(
                symbol=symbol,
                announced_on=filing.filed,
                reference=filing.accession,
                provider=PROVIDER_NAME,
                quality="eod",
            )
            for filing in filings
        ]


def _build(env: Mapping[str, str], http: ThrottledClient) -> SecEdgarSource:
    client = SecEdgar(env.get("SEC_USER_AGENT", ""), http=http)
    return SecEdgarSource(client)


PROVIDER = Provider(name=PROVIDER_NAME, kinds=("fundamentals", "earnings_announcements"), build=_build)
