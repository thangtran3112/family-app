"""Re-record fixtures for provider clients, from live calls, secrets stripped.

Usage (from `ai-trading/common/`, with keys from Firestore):

    cd /Users/tobytran/personal/family-app && \\
        CLOUDSDK_ACTIVE_CONFIG_NAME=personal python3 common/config/family_config.py run ai-trading/desk -- \\
        sh -c 'cd ai-trading/common && uv run python scripts/record.py alpaca'


Fixtures hold only response bodies (never request headers), trimmed to the
smallest sample that exercises the behavior, written to tests/fixtures/<provider>/.
Any `token`/`apikey`/`api_key` query parameter is stripped from the recorded
params before they are written.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"

_SECRET_PARAM_NAMES = {"token", "apikey", "api_key"}


def _strip_secrets(params: dict) -> dict:
    return {k: v for k, v in params.items() if k.lower() not in _SECRET_PARAM_NAMES}


def _write(path: Path, params: dict, body: object) -> None:
    payload = {"params": _strip_secrets(params), "body": body}
    path.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True))


def record_alpaca() -> None:
    headers = {
        "APCA-API-KEY-ID": os.environ["ALPACA_API_KEY_ID"],
        "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET_KEY"],
        "User-Agent": USER_AGENT,
    }
    out = FIXTURES / "alpaca"
    out.mkdir(parents=True, exist_ok=True)

    # (fixture name, symbol, Alpaca timeframe, start, end, a small `limit` to force pagination)
    # The DST windows straddle the gap tightly (last minutes before the 2026-03-06
    # close, first minutes after the 2026-03-09 open) rather than covering every
    # session in between, so the fixture stays small but still shows the UTC offset
    # change across the two sessions.
    cases = [
        ("daily_range_aapl", "AAPL", "1Day", "2026-01-01T00:00:00Z", "2026-01-15T00:00:00Z", None),
        ("daily_range_spy", "SPY", "1Day", "2026-01-01T00:00:00Z", "2026-01-15T00:00:00Z", None),
        ("hourly_dst_change", "AAPL", "1Hour", "2026-03-06T15:00:00Z", "2026-03-09T17:00:00Z", None),
        ("minute_dst_change", "AAPL", "1Min", "2026-03-06T20:45:00Z", "2026-03-09T14:00:00Z", None),
        ("hourly_half_day", "AAPL", "1Hour", "2025-11-28T00:00:00Z", "2025-11-29T00:00:00Z", None),
        ("minute_half_day", "AAPL", "1Min", "2025-11-28T17:45:00Z", "2025-11-28T18:15:00Z", None),
        # A tiny limit forces Alpaca to hand back `next_page_token` on the first page.
        ("minute_paginated", "SPY", "1Min", "2026-01-05T14:30:00Z", "2026-01-05T15:00:00Z", 5),
    ]

    for name, symbol, timeframe, start, end, limit in cases:
        params = {"timeframe": timeframe, "start": start, "end": end, "adjustment": "all", "feed": "sip"}
        if limit:
            params["limit"] = str(limit)
        url = f"https://data.alpaca.markets/v2/stocks/{quote(symbol)}/bars"
        response = requests.get(url, params=params, headers=headers, timeout=30)
        response.raise_for_status()
        body = response.json()
        _write(out / f"{name}.json", params, body)
        print(name, "bars:", len(body.get("bars") or []), "next_page_token:", body.get("next_page_token"))

        # Follow every page so the fixture set has no dangling next_page_token;
        # bounded so a misbehaving recording can't loop forever.
        page, page_params, token = 2, params, body.get("next_page_token")
        while token and page <= 10:
            page_params = dict(page_params, page_token=token)
            response_n = requests.get(url, params=page_params, headers=headers, timeout=30)
            response_n.raise_for_status()
            body_n = response_n.json()
            _write(out / f"{name}_page{page}.json", page_params, body_n)
            print(name, f"page{page} bars:", len(body_n.get("bars") or []), "next:", body_n.get("next_page_token"))
            token = body_n.get("next_page_token")
            page += 1


def record_sec() -> None:
    """SEC EDGAR fixtures: the ticker map (trimmed), CompanyFacts for AAPL/MSFT
    (trimmed to the concepts tests exercise), and each filer's submissions
    feed (trimmed to its 8-K rows, the only ones `item_202_filings` reads).
    """
    headers = {"User-Agent": os.environ["SEC_USER_AGENT"]}
    out = FIXTURES / "sec_edgar"
    out.mkdir(parents=True, exist_ok=True)

    tickers = requests.get("https://www.sec.gov/files/company_tickers.json", headers=headers, timeout=30)
    tickers.raise_for_status()
    wanted = {"AAPL", "MSFT", "BRK-B"}
    trimmed_tickers = {str(i): row for i, row in enumerate(tickers.json().values()) if row["ticker"] in wanted}
    _write(out / "company_tickers.json", {}, trimmed_tickers)
    print("company_tickers: kept", sorted(r["ticker"] for r in trimmed_tickers.values()))

    concepts = ("Assets", "NetIncomeLoss")
    # Only facts for periods ending in 2015 or later: still spans several real
    # value-changing amendments for both symbols (confirmed live), without the
    # full multi-decade history neither test nor the valuation phase needs yet.
    min_end = "2015-01-01"
    for symbol, cik in (("AAPL", "0000320193"), ("MSFT", "0000789019")):
        facts = requests.get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json", headers=headers, timeout=30)
        facts.raise_for_status()
        body = facts.json()
        us_gaap = (body.get("facts") or {}).get("us-gaap") or {}
        trimmed_body = {
            "cik": body.get("cik"),
            "entityName": body.get("entityName"),
            "facts": {
                "us-gaap": {
                    c: {
                        **us_gaap[c],
                        "units": {
                            unit: [row for row in rows if row["end"] >= min_end]
                            for unit, rows in us_gaap[c]["units"].items()
                        },
                    }
                    for c in concepts
                    if c in us_gaap
                }
            },
        }
        _write(out / f"companyfacts_{symbol.lower()}.json", {}, trimmed_body)
        print(symbol, "companyfacts concepts kept:", list(trimmed_body["facts"]["us-gaap"]))

        subs = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json", headers=headers, timeout=30)
        subs.raise_for_status()
        sub_body = subs.json()
        recent = sub_body["filings"]["recent"]
        n = len(recent["form"])
        keep_cols = ("accessionNumber", "filingDate", "form", "items")
        # Every 8-K row, plus a handful of non-8-K rows so the parser's form
        # filter is actually exercised against the fixture, not just absent.
        idxs = [i for i in range(n) if recent["form"][i] == "8-K"][:10] + [
            i for i in range(n) if recent["form"][i] != "8-K"
        ][:3]
        trimmed_recent = {col: [recent[col][i] for i in idxs] for col in keep_cols}
        trimmed_sub = {"cik": sub_body.get("cik"), "name": sub_body.get("name"), "filings": {"recent": trimmed_recent}}
        _write(out / f"submissions_{symbol.lower()}.json", {}, trimmed_sub)
        item_202 = sum(1 for items in trimmed_recent["items"] if "2.02" in (items or "").split(","))
        print(symbol, "submissions rows kept:", len(idxs), "of which Item 2.02 8-Ks:", item_202)


def _trim_submissions_block(block: dict) -> dict:
    """A `filings.recent`/`filings.files`-page block, trimmed to its Item 2.02
    8-Ks, a handful of other rows, and (always) the row with the earliest
    `filingDate` — so a trimmed fixture still reports its true oldest-filing
    floor, which `item_202_filings` relies on to decide whether to page back
    further.
    """
    keep_cols = ("accessionNumber", "filingDate", "form", "items")
    n = len(block["form"])
    item_202_idxs = [
        i for i in range(n) if block["form"][i] == "8-K" and "2.02" in (block["items"][i] or "").split(",")
    ]
    oldest_idx = min(range(n), key=lambda i: block["filingDate"][i])
    other_idxs = [i for i in range(n) if block["form"][i] != "8-K"][:5]
    idxs = sorted(set(item_202_idxs) | {oldest_idx} | set(other_idxs))
    return {col: [block[col][i] for i in idxs] for col in keep_cols}


def record_jpm_paging() -> None:
    """JPMorgan (CIK 0000019617): a heavy filer whose `filings.recent` is much
    larger than AAPL/MSFT's but still only reaches back about a year. One
    `filings.files` page demonstrates `item_202_filings`' pagination against a
    real heavy filer.
    """
    headers = {"User-Agent": os.environ["SEC_USER_AGENT"]}
    out = FIXTURES / "sec_edgar"
    out.mkdir(parents=True, exist_ok=True)
    cik = "0000019617"

    # Merge a JPM row into the existing ticker-map fixture rather than
    # re-running record_sec: that would re-fetch live CompanyFacts for
    # AAPL/MSFT too, and while already-filed historical facts don't change,
    # which rows land in the trimmed "most recent" window could drift and
    # invalidate the dates already pinned in test_sec_edgar_fixtures.py.
    tickers_path = out / "company_tickers.json"
    tickers_fixture = json.loads(tickers_path.read_text())
    if not any(row["ticker"] == "JPM" for row in tickers_fixture["body"].values()):
        tickers = requests.get("https://www.sec.gov/files/company_tickers.json", headers=headers, timeout=30)
        tickers.raise_for_status()
        jpm_row = next(r for r in tickers.json().values() if r["ticker"] == "JPM")
        tickers_fixture["body"]["jpm"] = jpm_row  # a key distinct from the numeric ones already present
        _write(tickers_path, {}, tickers_fixture["body"])
        print("company_tickers: added JPM", jpm_row)

    subs = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json", headers=headers, timeout=30)
    subs.raise_for_status()
    sub_body = subs.json()
    recent = sub_body["filings"]["recent"]
    print(
        "JPM filings.recent (untrimmed): rows",
        len(recent["form"]),
        "reaches back to",
        min(recent["filingDate"]),
        "newest",
        max(recent["filingDate"]),
    )
    trimmed_recent = _trim_submissions_block(recent)

    # Only the newest archived page's own metadata is needed to demonstrate
    # the stop condition: item_202_filings decides from `files` metadata
    # already in hand, without fetching a page it won't need.
    page1_meta = sub_body["filings"]["files"][0]
    trimmed_sub = {
        "cik": sub_body.get("cik"),
        "name": sub_body.get("name"),
        "filings": {"recent": trimmed_recent, "files": [page1_meta]},
    }
    _write(out / "submissions_jpm.json", {}, trimmed_sub)
    item_202 = sum(1 for items in trimmed_recent["items"] if "2.02" in (items or "").split(","))
    print("JPM recent rows kept:", len(trimmed_recent["form"]), "oldest kept:", min(trimmed_recent["filingDate"]))
    print("JPM recent Item 2.02 8-Ks:", item_202)

    page = requests.get(f"https://data.sec.gov/submissions/{page1_meta['name']}", headers=headers, timeout=30)
    page.raise_for_status()
    page_body = page.json()
    print("JPM page1 (untrimmed): rows", len(page_body["form"]), page1_meta["filingFrom"], "..", page1_meta["filingTo"])
    trimmed_page = _trim_submissions_block(page_body)
    _write(out / "submissions_jpm_page1.json", {}, trimmed_page)
    page_item_202 = sum(1 for items in trimmed_page["items"] if "2.02" in (items or "").split(","))
    print("JPM page1 rows kept:", len(trimmed_page["form"]), "Item 2.02 8-Ks in page1:", page_item_202)


def record_fred() -> None:
    """FRED fixtures: two vintages each of CPIAUCSL and UNRATE that differ (a
    live-confirmed revision), and one release-dates sample.
    """
    key = os.environ["FRED_API_KEY"]
    out = FIXTURES / "fred"
    out.mkdir(parents=True, exist_ok=True)
    base = "https://api.stlouisfed.org/fred"

    def get(path, params):
        response = requests.get(f"{base}/{path}", params={**params, "api_key": key, "file_type": "json"}, timeout=30)
        response.raise_for_status()
        return response

    # Live-confirmed revisions (see REPORT-P2.md): CPIAUCSL's 2019-06-01 value
    # moved from 255.305 (first published) to 255.213 (by the 2024 vintage);
    # UNRATE's 2019-06-01 value moved from 3.7 to 3.6 in the 2021 vintage.
    cases = [
        ("cpiaucsl_early", "CPIAUCSL", "2019-06-01", "2019-06-01", "2019-07-20"),
        ("cpiaucsl_revised", "CPIAUCSL", "2019-06-01", "2019-06-01", "2024-03-01"),
        ("unrate_early", "UNRATE", "2019-06-01", "2019-06-01", "2019-08-01"),
        ("unrate_revised", "UNRATE", "2019-06-01", "2019-06-01", "2021-02-01"),
    ]
    for name, series_id, start, end, pit in cases:
        params = {
            "series_id": series_id,
            "observation_start": start,
            "observation_end": end,
            "realtime_start": pit,
            "realtime_end": pit,
        }
        response = get("series/observations", params)
        _write(out / f"{name}.json", params, response.json())
        print(name, response.json().get("observations"))

    release = get("series/release", {"series_id": "CPIAUCSL"})
    release_id = release.json()["releases"][0]["id"]
    release_dates = get("release/dates", {"release_id": release_id, "limit": 6, "sort_order": "desc"})
    _write(out / "cpi_release.json", {"series_id": "CPIAUCSL"}, release.json())
    _write(out / "cpi_release_dates.json", {"release_id": release_id}, release_dates.json())
    print("release dates kept:", len(release_dates.json().get("release_dates") or []))


def record_finnhub() -> None:
    key = os.environ["FINNHUB_API_KEY"]
    out = FIXTURES / "finnhub"
    out.mkdir(parents=True, exist_ok=True)

    def get(path: str, params: dict) -> requests.Response:
        merged = dict(params, token=key)
        response = requests.get(f"https://finnhub.io/api/v1{path}", params=merged, timeout=30)
        return response

    cases = [
        ("calendar_earnings_aapl", "/calendar/earnings", {"symbol": "AAPL", "from": "2026-01-01", "to": "2026-12-31"}),
        ("calendar_earnings_empty", "/calendar/earnings", {"from": "1990-01-01", "to": "1990-01-02"}),
        ("company_news_aapl", "/company-news", {"symbol": "AAPL", "from": "2026-10-01", "to": "2026-10-11"}),
        ("company_news_empty", "/company-news", {"symbol": "AAPL", "from": "2026-10-12", "to": "2026-10-12"}),
        ("stock_earnings_aapl", "/stock/earnings", {"symbol": "AAPL"}),
        ("stock_recommendation_aapl", "/stock/recommendation", {"symbol": "AAPL"}),
        # `/stock/dividend` is not recorded: confirmed 403 on every free plan
        # key (controller ruling -- it can never work on the free plans, so no
        # `dividends()` client method exists to exercise against it).
    ]
    for name, path, params in cases:
        response = get(path, params)
        _write(out / f"{name}.json", params, response.json())
        print(name, "HTTP", response.status_code)

    bad_response = requests.get(
        "https://finnhub.io/api/v1/stock/earnings", params={"symbol": "AAPL", "token": "not-a-real-key"}, timeout=30
    )
    _write(out / "bad_key_401.json", {}, bad_response.json())
    print("bad_key_401 HTTP", bad_response.status_code)


def record_alphavantage() -> None:
    """Re-records Alpha Vantage fixtures live. **Costs real daily-quota calls**
    (2 per symbol for `earnings_estimates`/`earnings`): the free plan allows
    25 calls a day total, so only run this with a fresh day's budget in mind.
    """
    key = os.environ["ALPHA_VANTAGE_API_KEY"]
    out = FIXTURES / "alphavantage"
    out.mkdir(parents=True, exist_ok=True)

    def get(function: str, symbol: str, api_key: str) -> requests.Response:
        params = {"function": function, "symbol": symbol, "apikey": api_key}
        return requests.get("https://www.alphavantage.co/query", params=params, timeout=30)

    symbol = "AAPL"
    estimates = get("EARNINGS_ESTIMATES", symbol, key)
    _write(out / "earnings_estimates_aapl.json", {"function": "EARNINGS_ESTIMATES", "symbol": symbol}, estimates.json())
    print("earnings_estimates_aapl HTTP", estimates.status_code)
    time.sleep(2)

    earnings = get("EARNINGS", symbol, key)
    _write(out / "earnings_aapl.json", {"function": "EARNINGS", "symbol": symbol}, earnings.json())
    print("earnings_aapl HTTP", earnings.status_code)
    # `OVERVIEW` (the analyst-target/rating endpoint) is not recorded: confirmed
    # premium-gated on every key tried (controller ruling -- it can never work
    # on the free plans, so no `overview_targets()` client method exists to
    # exercise against it).


def record_eulerpool() -> None:
    key = os.environ["EULERPOOL_API_KEY"]
    out = FIXTURES / "eulerpool"
    out.mkdir(parents=True, exist_ok=True)

    def get(path: str) -> requests.Response:
        return requests.get(f"https://api.eulerpool.com/api/1{path}", params={"token": key}, timeout=30)

    cases = [
        ("estimates_aapl", "/equity/estimates/AAPL"),
        ("estimates_empty_brkb", "/equity/estimates/BRK.B"),
        ("calendar_aapl", "/calendar/earnings-by-symbol/AAPL"),
        ("surprises_aapl", "/calendar/earnings-surprises/AAPL"),
        ("recommendations_aapl", "/research/recommendations/AAPL"),
    ]
    for name, path in cases:
        response = get(path)
        _write(out / f"{name}.json", {}, response.json())
        print(name, "HTTP", response.status_code)

    bad = requests.get(
        "https://api.eulerpool.com/api/1/equity/estimates/AAPL", params={"token": "not-a-real-key"}, timeout=30
    )
    _write(out / "bad_key_401.json", {}, bad.json())
    print("bad_key_401 HTTP", bad.status_code)

    unknown = requests.get(
        "https://api.eulerpool.com/api/1/equity/estimates/ZZZZINVALIDXYZ", params={"token": key}, timeout=30
    )
    _write(out / "unknown_symbol_404.json", {}, unknown.json())
    print("unknown_symbol_404 HTTP", unknown.status_code)

    unknown_rec = requests.get(
        "https://api.eulerpool.com/api/1/research/recommendations/ZZZZINVALIDXYZ", params={"token": key}, timeout=30
    )
    _write(out / "unknown_recommendations_404.json", {}, unknown_rec.json())
    print("unknown_recommendations_404 HTTP", unknown_rec.status_code)


def record_eulerpool_dividends_probe() -> None:
    """Report-only live probe (controller ruling 3): is there a free Eulerpool
    endpoint with ex-dividend dates? Prints HTTP status and a trimmed body
    shape for `/equity/dividends`, `/equity/dividend-quality`, and
    `/equity/dividends-by-fy`; writes no fixture and builds no client --
    see REPORT-FINAL.md for the finding.
    """
    key = os.environ["EULERPOOL_API_KEY"]
    for path in ("equity/dividends/AAPL", "equity/dividend-quality/AAPL", "equity/dividends-by-fy/AAPL"):
        response = requests.get(f"https://api.eulerpool.com/api/1/{path}", params={"token": key}, timeout=30)
        print(path, "HTTP", response.status_code, json.dumps(response.json())[:300])


_RECORDERS = {
    "alpaca": record_alpaca,
    "sec": record_sec,
    "sec_jpm": record_jpm_paging,
    "fred": record_fred,
    "finnhub": record_finnhub,
    "alphavantage": record_alphavantage,
    "eulerpool": record_eulerpool,
    "eulerpool_dividends_probe": record_eulerpool_dividends_probe,
}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in _RECORDERS:
        print(f"usage: record.py <{'|'.join(_RECORDERS)}>", file=sys.stderr)
        raise SystemExit(2)
    _RECORDERS[sys.argv[1]]()


if __name__ == "__main__":
    main()
