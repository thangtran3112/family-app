# Phase 2a: Data Foundation Without IBKR

Part of [02c-desk-v1-implementation-plan.md](../02c-desk-v1-implementation-plan.md). Read its Global Constraints, Review Focus, and Shared Interfaces first. Builds on [Phase 1c](phase-1c-technicals-and-futures.md) and [Phase 1d](phase-1d-research-math.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents work in a `.worktrees/` worktree on their own `feature/*` branch; the main session merges that branch into `feature/toby` (root `AGENTS.md`).

**Goal:** give the Desk every free (non-IBKR) data source it needs — Alpaca bars, SEC EDGAR fundamentals, FRED macro, and the consensus-EPS fallback chain (Eulerpool, Finnhub, Alpha Vantage) — in a new shared package, `ai-trading/common`, plus the Desk's own Postgres schema, bar store, futures roll map, and streaming-slot allocator. The IBKR client (2b) and every table beyond `bars_1d`/`bars_1h`/`bars_1m`/`futures_rolls` wait for their own phase. No deploy; nothing here runs in production yet.

**Architecture:**
- **`ai-trading/common/`** (new uv project, import package `ai_trading_common`, shared by every ai-trading app, never importing the Desk): `errors.py` (the provider-error taxonomy), `quality.py` (the `Quality` label), `http.py` (a throttled, soft-ban-aware HTTP client, adapted from Vibe-Trading), `bars.py` (the shared `Bars` shape and closed-bar guards, adapted from TradingAgents' hygiene rules), `fallback.py` (one generic fallback-chaining helper), `testing.py` (network-free test doubles, exported so the Desk's own tests can reuse them), `alpaca.py` (daily/hourly/minute bars), `sec_edgar.py` (point-in-time CompanyFacts and 8-K Item 2.02 dates, adapted from TradingAgents), `fred.py` (vintage-pinned observations and release dates, adapted from TradingAgents), `finnhub.py`, `alphavantage.py`, `eulerpool.py` (consensus-EPS providers), and `consensus.py` (the normalized types and fallback chains over all three).
- **The Desk (`packages/family-desk/backend`)** depends on `ai-trading-common` as an editable path source from `ai_trading.data.backfill` only — the one module that imports both packages. `ai_trading.db` gets a minimal SQLAlchemy 2 engine/session helper, four typed models (`bars_1d`, `bars_1h`, `bars_1m`, `futures_rolls`), and an Alembic migration (`0001`). `ai_trading.data` gets the bar store (`bars.py`: closed-bar-only upserts, as-of reads, backfill planning, 1-minute retention), the futures roll map (`rolls.py`: contiguous windows and a difference-back-adjusted continuous series), the streaming-slot allocator (`slots.py`), and the Alpaca backfill glue (`backfill.py`).
- CI's `desk` job gains a `postgres:17` service and a new step that runs `ai-trading/common`'s own suite before the existing Contracts/Backend steps.
- Stooq (the daily pre-2016 fallback 02b §5 originally planned) is dropped: its CSV endpoint is gated behind a JS proof-of-work challenge with no API key offered (ruling D8). The Desk's effective history start is 2016-01-01 (Alpaca's free Basic plan) unless IBKR backfills further back in 2b.

**Tech Stack:** Python 3.12, uv, pandas, `requests`, `exchange-calendars` (common); SQLAlchemy 2, Alembic, `psycopg[binary]` 3, PostgreSQL 17 (Desk `ai_trading.db`/`ai_trading.data`). No new frontend dependency.

**Spec:**
- [02c](../02c-desk-v1-implementation-plan.md) Global Constraints, Review Focus, Shared Interfaces, Phase 2 outline
- [02b §5](../02b-desk-market-data-options.md): the hybrid store — what's kept, what's fetched live, and refresh rules
- [02a §7](../02a-desk-v1-strategies-design.md): streaming slots (priority order, failure handling); [02a §11](../02a-desk-v1-strategies-design.md): the reuse map's Phase 2 rows
- [02f §4](../02f-desk-indicators-and-ai-daily-design.md): consensus EPS — the fields, the pilot, the fallback
- `ai-trading/AGENTS.md`: secrets, Firestore, upstream rules, "Our Code"

Source reports (not committed; the prototype trail behind this plan): `ai-trading/temp/p2a-proto/final/REPORT-FINAL.md`, `ai-trading/temp/p2a-proto/common/REPORT-P1.md`, `common-p2/REPORT-P2.md`, `common-p3/REPORT-P3.md`, `common-p3/PILOT-EULERPOOL.md`, `family-desk/REPORT-P4.md`, and `ai-trading/temp/plan-writing-ledger-2a.md` (D1–D11 and every ruling).

## Global Constraints

- Everything in 02c's Global Constraints applies.
- **Python:** 3.12 (`requires-python = ">=3.12,<3.13"`), uv, ruff (line length 120, lint rules `E, F, I, B, UP`), pytest. Tests never touch the network: every client takes an injectable `ThrottledClient`, and tests feed it recorded fixtures or a fake session.
- **Time:** timestamps in UTC. Exchange days and sessions on America/New_York, through `exchange_calendars` (XNYS for stocks).
- **Unknown data never fires or guesses.** An outage must never look like "no data", and "no data" must never look like an outage.
- **Secrets (AGENTS.md):** keys are read only through `python3 common/config/family_config.py run ai-trading/desk -- <cmd>` from the repository root, with `CLOUDSDK_ACTIVE_CONFIG_NAME=personal` set. Never print, log, or save a key, a token, or the SEC `User-Agent` value. Recorded fixtures hold only response bodies (never request headers); any `token`/`apikey`/`api_key` query parameter is stripped before a fixture is written.
- **Fixtures are already committed** on `feature/toby` (commit `ae6ec0f`; the Eulerpool calendar fixture re-recorded in `c602b52`) under `ai-trading/common/tests/fixtures/` and `ai-trading/packages/family-desk/backend/tests/fixtures/`. Every task below references them by path; none are embedded in this plan.
- **Attribution:** code adapted from an upstream app gets a header (upstream path, commit, license, what changed) and a row in the receiving package's `THIRD_PARTY_NOTICES.md`. Apache-2.0 files (TradingAgents) are marked as modified, with the full upstream `LICENSE` text. A "pattern" reuse (an idea, no code copied) needs no notice. Nothing from MiroFish.
- **Layout:** `ai-trading/common` never imports the Desk or any other ai-trading package. The Desk depends on it only through `[tool.uv.sources] ai-trading-common = { path = "../../../common", editable = true }`, and only `ai_trading.data.backfill` imports `ai_trading_common`.
- `ai_trading.core` (unchanged by this phase) still does no I/O and reads no clock; `ai_trading.data` and `ai_trading.db` are this phase's first I/O-performing modules.
- Commits are one line, with no trailer. Do not push.

## Decisions for Owner Review

The ledger's D1–D11 first, then every consequential prototype decision from the lane reports, most consequential first, grouped by the module that carries it.

**Ledger rulings (D1–D11):**

1. **D1 — `ai-trading/common` is a uv project named `ai-trading-common`, import package `ai_trading_common` under `src/`.** The Desk depends on it as an editable path source (`[tool.uv.sources]`), never a published package. Alternative: a namespace package shared by editing `sys.path`. Reason: a real uv project gets its own lockfile, its own CI step, and is independently installable by any future ai-trading app without the Desk's `pyproject.toml` in the loop. (2a.1, 2a.7)
2. **D2 — `ai-trading/market-data/` (the open-source lane's existing Alpaca/SEC client) is left untouched.** `alpaca.py` is moved into `ai_trading_common`, not deleted from `market-data/`; the open-source lane switches to the common package on its own schedule. Reason: this phase's brief is scoped to the Desk; touching another lane's working code without its own review is out of scope. (2a.2)
3. **D3 — Phase 2a creates only `bars_1d`, `bars_1h`, `bars_1m`, and `futures_rolls`.** Every other table in 02c's Shared Interfaces (`consensus_snapshots`, `earnings_results`, `analyst_targets`, the strategy/alert/order tables, and so on) is added by the phase that first needs it, not reserved here. Alternative: create every table 02c lists for Phase 2 up front. Reason: 02c's own Phase 2 outline said "every table" without specifying which phase adds which; an owner review narrowed this to "tables arrive per phase," so a table's migration lands with the code that writes and reads it, not months before. (2a.7)
4. **D4 — the Postgres role and schema init under `deploy/postgres/` moves to Phase 3**, where `desk-postgres` first joins the deploy compose file. Alternative: stand up the role/schema init now, unused until Phase 3. Reason: there is no deployed Postgres to initialize until Phase 3; building init scripts for infrastructure that does not exist yet is speculative work with no test that can exercise it for real. (not in this phase's scope)
5. **D5 — DB tests key off `DESK_TEST_DATABASE_URL`: skipped locally when unset, a hard failure in CI (`DESK_REQUIRE_DB=1`) so a broken database story never silently reports green.** `scripts/test-db.sh` starts a throwaway `postgres:17` container for a local, no-flags-needed run. Alternative: mock the database in every test. Reason: the bar store and migration tests are exactly the code whose correctness depends on a real Postgres (upsert semantics, constraint names, `compare_metadata` drift) — a mock would test the mock, not the store. (2a.7)
6. **D6 — continuous futures are difference back-adjusted at each roll; the latest segment stays unadjusted, at real prices.** Alternative: ratio (percentage) back-adjustment, or no adjustment at all (a raw stitch with a visible gap). Reason: 02a's Review Focus 4 requires "indicators and levels must not see a fake gap between contracts" when the front month changes; difference adjustment (the industry-standard "Jones" method) achieves that while an unadjusted stitch would show a fake overnight gap exactly at every roll, and the latest segment staying at real prices means a live position's P&L is never computed against an adjusted price it didn't actually trade at. (2a.8)
7. **D7 — read models and typed evidence snapshots for tools and card backs move to the phases that consume them (3, 5, 7), not built in 2a.** Alternative: build a generic "evidence snapshot" type now, speculatively. Reason: 02h's typed evidence snapshot shape is driven by what each consuming tool actually needs; building it before any consumer exists risks guessing a shape that has to change once Phase 3/5/7 start, for no present benefit. (not in this phase's scope)
8. **D8 — Stooq is dropped; there is no pre-2016 daily fallback in 2a.** Live-checked first (`curl` against `stooq.com`, `stooq.pl`, and a `static.stooq.com` guess, with and without a browser `User-Agent`): every host answers either a JavaScript proof-of-work challenge page or HTTP 404, with no API key offered anywhere. Per the brief's own rule ("if it needs a key or a captcha now, stop that part and report; never build a scraper"), this is exactly that case. The Desk's effective daily-history start is 2016-01-01 (Alpaca's free Basic plan); IBKR can backfill further back in Phase 2b if the owner wants it, with no new provider added here. (2a.2, 2a.8; see 02b §5 and 02d edits below)
9. **D9 — Alpaca snapshots for the 15-minute swing/long-term list refresh move to Phase 3**, with the scheduler job that actually uses them. Not built in 2a. (not in this phase's scope)
10. **D10 — Finnhub's dividend endpoint and Alpha Vantage's `OVERVIEW` (analyst target/rating) endpoint are dropped; ex-dividend dates wait on IBKR's dividends tick (2b) or a possible free Eulerpool path (Phase 5 probes once).** Live-confirmed dead on the free plans used here: Finnhub's `stock/dividend` answers HTTP 403 on every attempt; Alpha Vantage's `OVERVIEW` answers HTTP 200 with an `"Information": "...premium endpoint..."` note on three separate attempts, contradicting the (stale) research notes that had called it free. Neither was ever called from `consensus.py`'s fallback chains, so dropping them costs no behavior that existed. (2a.5, 2a.6)
11. **D11 — fallback is per data class, with one necessary per-field exception for analyst targets; the one shared fallback-chaining helper is generic over its return type (`first_success[T]`), not `Bars`-specific.** `ConsensusSnapshot` and `EarningsResult` fall back per whole record set (Eulerpool primary). `AnalystTargets` cannot: Finnhub's free plan has rating counts but no target price, and Alpha Vantage's only target field is premium-gated — so a Finnhub-sourced fallback carries real counts and `None` targets rather than refusing the whole record or guessing a price, matching 02f §4's own prediction for this path ("analyst targets are then unavailable," scoped to the target fields). The prototype's first pass had two near-duplicate fallback helpers (`fallback.with_fallback`, typed to `Bars`, and a local `consensus.py` copy of the same precedence rule for other types); this plan keeps only the generic one, `first_success[T](calls) -> tuple[T, bool]`, and a caller relabels its own result type (`dataclasses.replace(result, quality="fallback")`) using the returned `is_primary` flag. Alternative: keep two near-identical helpers. Reason: one generic helper is less code than two copies of the same precedence rule, with no loss of type safety at the call site (every caller already knows its own return type). (2a.1, 2a.6)

**`http.py` (2a.1):**

12. **`ThrottledClient.get` returns every non-{429, 403-ban-prone, 5xx, timeout} status as-is, rather than mapping every HTTP status itself.** `http.py` has no idea what a 401 or 404 means to a specific provider (Alpaca: bad key / unknown symbol; SEC: unidentified request / nothing at this CIK); that mapping belongs in each client. Keeps `http.py` provider-agnostic, matching Vibe-Trading's original scope.
13. **A soft-ban latch fires on a 429 from any host, or a 403 only on a host the caller declares `ban_prone`.** SEC returns a bare HTML 403 for an unidentified `User-Agent` and should latch; Alpaca's 403 means a rejected key and must not latch (a caller fixing its key would otherwise wait out a needless cooldown). The caller, not `http.py`, knows which is which.
14. **`Unavailable`'s message never carries the failing URL or its query string.** A `requests.ConnectionError`'s own text includes the full URL, and several providers (FRED, Finnhub, Eulerpool, Alpha Vantage) put the API key in the query string — so the exception is built from the error's type name alone, raised `from None`, never from the caught exception's own text. Pinned by `test_unavailable_never_carries_the_failing_url_or_its_query_key`.
15. **Clock, sleep, and jitter are all injectable**, so tests pin the throttle's exact timing with a fake clock rather than a real `time.sleep`.

**`bars.py` and `alpaca.py` (2a.1, 2a.2):**

16. **`validate` drops a bad row, not the whole frame.** Alternative: reject the whole frame on any bad row (TradingAgents' own stale-frame check is frame-level, but its row-cleaning functions already drop rows, not frames). Reason: a vendor's one malformed print (a zero close, a `high < low` tick) is common and should not blank out an otherwise-good day of bars; a vendor with no good rows at all still ends up empty, which the caller's existing `NoData` path already covers.
17. **`drop_unclosed`'s 1h session-close cap only applies when a bar starts inside the regular session.** Alternative (a literal reading of "a session's short last hour closes early"): always cap an hourly bar at the session's regular close. Reason: a real Alpaca fixture (the 2025-11-28 half day, 13:00 ET close) has an hourly bar starting at 16:00 ET, in the post-market session, three hours after the regular close already passed. The literal rule would cap that bar's close at 13:00 ET — already in the past relative to its own 16:00 start — marking it "closed" the instant it starts: a repainting risk in the opposite direction (serving a forming extended-hours bar as final). The cap only fires when `session_open <= start < session_close`; an extended-hours bar always gets its own full 60 minutes. Pinned by `test_1h_post_close_extended_hours_bar_still_needs_its_own_60_minutes`, found from the live fixture, not invented.
18. **An unknown Alpaca symbol is mapped from *either* an empty `bars` array or HTTP 404 to `NoData`.** Live-tested behavior for a genuinely bad ticker was not risked against the real account; both documented/plausible shapes are handled defensively.
19. **`is_stale` is not built in this phase** (no caller needs it yet — the Desk's own staleness check is `ai_trading.data.bars.read_bars`'s as-of cut, not a separate freshness probe). `bars.py` ships `validate` and `drop_unclosed` only.

**`sec_edgar.py` (2a.3):**

20. **An unrecognized duration span (outside the quarterly/YTD/annual day-count buckets) is dropped, not guessed or widened to the nearest bucket.** A span that fits no bucket is far more likely a data artifact than a new kind of real period; matching it to the nearest bucket would silently mislabel, say, a 7-month fact as a 6-month one.
21. **A later amendment of the same period wins only from its own filed date — never before.** Example, live-confirmed: Apple's fiscal-2007 net income read $3,496M from the original 10-K (filed 2009-10-27) until a 10-K/A (filed 2010-01-25) restated it to $3,495M; a run as-of 2009-12-01 must still see $3,496M. Pinned by `test_a_later_amendment_wins_only_from_its_own_filed_date`.
22. **`item_202_filings(ticker, since)` pages into `filings.recent`'s older sibling, `filings.files`, only as far as `since` needs — newest page first, stopping as soon as a fetched page's own `filingFrom` reaches `since`.** Alternative: read only `filings.recent` (the brief's original, narrower scope) and accept that a heavy filer's "recent" window may not reach back far enough. Reason: live data disproved the assumption that `recent` covers "roughly the last ~1,000 filings" — JPMorgan's `recent` is 26,293 rows but still only reaches back to 2025-10-10 (about a year), the same wall-clock span as AAPL's much smaller `recent`. An earnings-reaction model needing several quarters of 8-K history for a heavy filer reliably needs this paging. The stop decision reads already-fetched `files` metadata (`filingFrom`/`filingTo`), never fetches a page "just in case." A failed page raises `Unavailable`, never a silently partial list. Pinned by `TestItem202Pagination`'s four tests.
23. **`_oldest_filing_date` scans every `filingDate` in a block rather than trusting array order or reading the last element.** The recorded AAPL fixture disproved the "sorted descending" assumption live: `filingDate` is not globally sorted (filing types interleave).
24. **SEC's two rate-limited hosts (`www.sec.gov`, `data.sec.gov`) share one throttle bucket**, since SEC's fair-access policy rate-limits `sec.gov` as one site-wide budget (10 req/s), not per-subdomain.
25. **No on-disk or in-memory cache in `SecEdgar`**, unlike `ai-trading/market-data/sec.py`'s 24-hour TTL cache. The shared `ThrottledClient`/`AlpacaBars` don't cache either; adding caching only here would be an inconsistent extra concern for this client to own. A cache is a fine later addition at the Desk's own data layer, which already owns refresh scheduling.

**`fred.py` (2a.4):**

26. **Both `realtime_start` and `realtime_end` are pinned to `as_of`, not left at FRED's own "today" default.** Live-confirmed real revisions: CPIAUCSL's 2019-06-01 observation read 255.305 at its first realtime window (2019-07-20) and 255.213 by a 2024-03-01 vintage; a backtest dated before a revision must see the value as first published, never the later number.
27. **FRED's 400 responses are disambiguated by the `error_message` text, not the status code alone** (`"api_key"` → `NotConfigured`; `"series_id"` → `NoData`; otherwise `Unavailable`), confirmed live: a bad key and an unknown series both answer HTTP 400, with only the message text naming which variable is wrong.
28. **An empty observation range after filtering FRED's `"."` missing-value marker raises `NoData`, not an empty list.** A FRED series/window genuinely has nothing else to page through (unlike `item_202_filings`' "more exists in `filings.files`" case), so an empty vintage-pinned window is the provider's complete and final answer.
29. **`release_dates` does not vintage-pin `realtime_start`/`realtime_end`**; `as_of` is a plain filter (`d <= as_of`) over the dates FRED returns. The vintage-pinning rule is about *data* revisions; a release *date* either is or isn't known yet, and the plain filter avoids relying on an unconfirmed assumption about how `release/dates`'s own realtime parameters behave.

**`finnhub.py`, `alphavantage.py`, `eulerpool.py` (2a.5):**

30. **Finnhub's `stock/recommendation` (buy/hold/sell trend counts) is free** — confirmed live, correcting the earlier research notes that had marked it unverified/absent. This is what makes `AnalystTargets`' per-field Finnhub fallback worth having at all: without it, a Finnhub fallback would have nothing to offer `AnalystTargets`, not just a partial record.
31. **`QuotaExceeded(Unavailable)` lives in `alphavantage.py`, not in the shared `errors.py`.** Alpha Vantage signals a bad/demo key, a premium-gated endpoint, *and* its rate limit (daily cap or per-second burst — the wording is identical for both, confirmed live by firing three near-simultaneous calls) all as HTTP 200 with an `"Information"` note; distinguishing "try a different provider, maybe retry later" from "this key/endpoint will never work" needs its own subclass, kept local to the one client that needs it.
32. **Eulerpool's real API was found via `https://eulerpool.com/llms-full.txt`, not its marketing/docs site**, which returns HTTP 403 to any non-browser `GET` (a Cloudflare bot gate, the same shape as Stooq's). The actual API host (`api.eulerpool.com`) is not behind that gate; no scraping was needed.
33. **`eulerpool.py` uses `/research/recommendations/{ticker}` for `AnalystTargets`, not also `/equity/price-target-consensus/{id}`.** Live-checked: `recommendations` already returns buy/hold/sell counts *and* mean/median/high/low targets in one response; the other endpoint duplicates only the target fields with no new information.

**`consensus.py` (2a.6):**

34. **`_merge_by_period` joins Eulerpool's calendar and surprise rows by date proximity, not by equal dates — they carry different dates for the same event.** The calendar's `date` is the report's filing date; the surprise's `date` is the fiscal period it reports on (the period end), confirmed live for AAPL (period end 2026-06-30 reported 2026-07-30, a 30-day gap): treating them as the same key, as an earlier pass did, produced duplicate rows and mislabeled a period end as a report date. The fix: `EarningsResult.period_end` becomes `date | None`; each surprise row joins the first calendar row (in list order) whose `report_date` falls in `(period_end, period_end + 90 days]` — long enough that a period always finds its own report (filed within weeks), short enough that it never reaches the next quarter's report (filed 110+ days after the prior period's end); a calendar row joins at most one surprise. A merged row takes `period_end`/`fiscal_year`/`fiscal_quarter` from the surprise and `report_date` from the calendar, with `eps_estimate`/`eps_actual`/`surprise`/`surprise_percent` from the surprise when present, else the calendar. An unmatched surprise keeps `report_date=None`; an unmatched calendar row (older history, or the upcoming undated-actual entry) keeps `period_end=None`. Sorting and every other `period_end` use now tolerate `None` (`r.period_end or r.report_date`, since every row has at least one). Pinned by `test_fixture_calendar_and_surprises_merge_into_one_row_per_period_with_both_dates_right` (real re-recorded AAPL data), `test_an_unmatched_surprise_has_no_report_date`, `test_an_unmatched_calendar_row_has_no_period_end`, and `test_the_90_day_join_window_boundary` (exactly 90 days matches, 91 does not).

**`ai_trading.data.bars` and `backfill.py` (2a.7, 2a.8):**

35. **`upsert_bars` validates every row before writing any of them (whole-frame atomicity): it raises `ValueError` — and writes nothing — if any row has not closed by `now`.** Alternative: silently drop just the unclosed rows. A forming bar must never be stored at all (Review Focus 2); silently dropping rows could let a caller believe a partial write succeeded when the input was bad.
36. **`read_bars` recomputes each row's close time against `as_of` at read time, not from write-time.** A bar can be closed and stored *now* yet still be "in the future" relative to an earlier `as_of` a backtest or chat tool replays against (Review Focus 6: no look-ahead). Pinned by `test_read_as_of_ignores_a_later_mutation_of_a_future_bar`: mutating an already-stored, already-closed-by-`now` bar must not change what an earlier `as_of` sees.
37. **`missing_sessions` for an intraday timeframe treats a whole session with *any* stored bar as present**, even with gaps inside it: "quiet minutes are normal," but a session with zero bars at all is a real gap.
38. **Contract symbols are `<product><month code><last digit of year>`** (e.g. `ESZ6` for December 2026), the shortest form `futures._extract_product`'s suffix regex accepts — matching how CME itself abbreviates a front-month symbol. Alternative: a 4-digit year (`ESZ2026`); either form parses.
39. **Backfill's contiguous-range grouping uses the exchange calendar, not list adjacency**: `_contiguous_ranges` checks `previous_session(asset, day) == <last day in the current range>`, so a session that is already stored (sitting between two missing ones) correctly splits the fetch into two ranges instead of bridging a gap that is not actually missing-contiguous. Pinned by `TestProviderErrorMidway`.
40. **A provider error propagates with its own type, carrying a note naming where it stopped** (`exc.add_note(...)`, stdlib Python 3.11+), rather than being wrapped in a new exception type. A caller's `except Unavailable` still works, and "where did it stop" is answered without inventing a wrapper.
41. **`backfill` and `upsert_bars` never commit.** Matches the store's existing contract: a caller that catches a mid-backfill error and commits keeps every range written before the failure, exactly as `TestProviderErrorMidway` demonstrates.
42. **Slot allocation grants one `SlotDecision` per symbol, not per demand.** A symbol's priority kind is its highest-priority demand's kind; ties within a kind use the earliest `since`, then the symbol — so the final order (and the cap cutoff) is `(priority, since, symbol)`, fully deterministic regardless of input order. Pinned by `test_allocation_is_deterministic_regardless_of_input_order`.

## Review Focus

1. **A forming bar must never be stored, and a stored bar must never be served to an earlier `as_of` than it actually closed at.** Pinned by `test_upsert_raises_on_a_bar_not_yet_closed` and `test_read_as_of_ignores_a_later_mutation_of_a_future_bar` (Task 2a.8).
2. **An outage must never look like "no data", and "no data" must never look like an outage — across every provider, not just one.** Pinned by each client's own `NotConfigured`/`Unavailable`/`SoftBanned` vs. `NoData` tests (Tasks 2a.2–2a.6) and `first_success`'s own precedence tests (`test_a_transient_failure_is_reported_over_a_later_no_data`, Task 2a.1).
3. **A secret (an API key, the SEC `User-Agent`) must never leak into an exception message, a recorded fixture, or a log line.** Pinned by `test_unavailable_never_carries_the_failing_url_or_its_query_key` (Task 2a.1) and every `scripts/record.py` recorder's own `_strip_secrets` call (Tasks 2a.2–2a.6).
4. **The futures roll must never show a fake price gap between contracts, and must raise rather than guess when two contracts share no bar near the roll.** Pinned by `test_continuous_back_adjusts_by_the_difference_at_each_roll` and `test_continuous_raises_when_contracts_share_no_bar_near_the_roll` (Task 2a.8).
5. **A mid-backfill provider failure must leave every range already written intact, and must say where it stopped — never a silent partial state and never a wrapped, untyped exception.** Pinned by `TestProviderErrorMidway` (Task 2a.8).
6. **An intraday bar edge (a half day's early close, a DST change, a post-market bar after the regular close) must never be mis-closed in either direction** — serving a forming bar as final, or withholding an already-closed one. Pinned by `test_1h_post_close_extended_hours_bar_still_needs_its_own_60_minutes`, `test_1h_caps_the_last_bin_at_the_session_close`, and the DST-change fixture tests (Tasks 2a.1–2a.2).

## Integration notes for later phases

These modules are complete and tested in isolation; the phases that actually schedule and run them in the Desk still have work to do.

**Phase 3 (runtime and alerts):**
- Schedules `ai_trading.data.bars.prune_1m` and `ai_trading.data.rolls.store_roll_windows` on a job cadence — this phase only ships them as callable functions, nothing calls them yet.
- Adds Alpaca snapshots for the 15-minute swing/long-term list refresh (ruling D9), and brings up `desk-postgres` in the deploy compose file, with the role/schema init this phase deliberately deferred (ruling D4).
- Starts the daily consensus-EPS snapshot job (`consensus_snapshots`/`earnings_results`/`analyst_targets`, run once per symbol after 16:30 ET per 02f §4) — `ai-trading-common`'s `consensus.py` only computes a snapshot when called; nothing stores one yet, so revision history (7/30/90-day) only starts accruing once this job exists.

**Phase 5 (long-term, covered calls, Desk AI):**
- Gets the us-gaap concept list `ai_trading.core.valuation` needs, and maps it onto `SecEdgar.company_facts(concepts=...)` — this phase's client is shaped to serve that call but builds no valuation-input mapping itself (`NetIncomeLoss`, a depreciation/amortization tag, `PaymentsToAcquirePropertyPlantAndEquipment`, `NetCashProvidedByUsedInOperatingActivities`, `Assets`/`AssetsCurrent`, `Liabilities`/`LiabilitiesCurrent`, `CashAndCashEquivalentsAtCarryingValue`, a debt tag, and `StockholdersEquity`).
- Gets ex-dividend dates, from either Eulerpool's `/equity/dividend-quality/{identifier}` `lastExDate` field (confirmed free and live, AAPL: `"lastExDate":"2026-08-10"` — but only the *most recent* ex-date, not a history) or IBKR's dividends tick (2b). `/equity/dividends/{identifier}`'s `period` field has a full per-payment history but its exact meaning (declaration vs. record vs. ex-date) was not resolved from a single live check; confirming it against a known dividend calendar is this phase's job if full ex-dividend history is wanted, not 2a's.

**2b (the IBKR client):**
- Can backfill daily history before 2016-01-01 if the owner wants it (ruling D8); no new provider is added for this in 2a.

**Everywhere a future bars fallback chain is added:**
- `first_success[T]`'s generic signature drops the automatic `Bars`-specific relabeling `fallback.with_fallback` used to do; any future bars fallback chain (e.g. a second intraday provider) needs its own one-line `dataclasses.replace(bars, quality="fallback")`, the same pattern `consensus.py` already uses three times.
- `backend/tests/fixtures/alpaca/daily_range_aapl.json` duplicates `common/tests/fixtures/alpaca/daily_range_aapl.json` by necessity (`ai_trading_common`'s own `tests/` directory is not part of the installed package, so the Desk's `backfill` tests need their own copy of the fixture body and their own `FakeResponse`/`FakeSession`/`make_client` doubles, which live in `ai_trading_common.testing` and are imported directly rather than duplicated as Python — only the JSON fixture itself is duplicated).

## Parallel execution lanes

Four lanes, usable as separate subagent/worktree tasks once their dependency is merged:

| Lane | Tasks | Depends on | Appends to |
|---|---|---|---|
| **Common core** | 2a.1 | nothing | — |
| **Common providers** | 2a.2 → 2a.3 → 2a.4 → 2a.5 → 2a.6, in order | 2a.1 | `scripts/record.py` (each task inserts its own recorder function and extends `_RECORDERS`, always anchored on the current `_RECORDERS` block), `THIRD_PARTY_NOTICES.md` (each task anchors its own row/section insertion), `.github/workflows/ai-trading-ci.yml`'s uv cache glob (2a.1 only) |
| **Desk database** | 2a.7 | nothing (can start from the start, in parallel with 2a.1–2a.6) | `.github/workflows/ai-trading-ci.yml`'s `desk` job (the `postgres:17` service and the Backend step's env, independent of the Common-core step 2a.1 adds) |
| **Desk data layer** | 2a.8 | 2a.2 (Alpaca client) and 2a.7 (db models) | — |

2a.2–2a.6 cannot parallelize *inside* the Common-providers lane: each task's `scripts/record.py` edit is anchored on the previous task's `_RECORDERS` dict, so they must land in order. 2a.3, 2a.4, and 2a.5 are otherwise independent of each other's *client* code (SEC/FRED/consensus-EPS providers share no state) — a team with more throttle budget to spend on separate owner-approved fixture-recording sessions could write their client+test content in parallel and resolve the `scripts/record.py`/`THIRD_PARTY_NOTICES.md` merge by hand at the end, but this plan assumes the simpler in-order path. 2a.7 has no dependency on common at all (the Desk's own models/migrations need no provider client) and can run fully in parallel with the whole Common-providers lane. 2a.8 is the one task that needs both lanes finished: it imports `ai_trading_common.alpaca` (2a.2) into a module built on `ai_trading.db.models` (2a.7).

Per-task test-count deltas (common baseline 0; backend baseline 525, the count before this phase, with every Phase 1/1b/1c/1d test passing and no DB test existing yet) are given in each task's own Step. Every count was re-run against the finished prototype (`ai-trading/temp/p2a-proto/final/`) to confirm it: common's full suite is 150 passed in 0.4s; the backend's full suite is 556 passed with a real Postgres (`scripts/test-db.sh`) in about 19s, or 541 passed + 15 skipped without one (`DESK_TEST_DATABASE_URL` unset); both suites are ruff-clean (`ruff check .` and `ruff format --check .`).

All paths below are relative to `ai-trading/` unless they start with a repository-root path. Commands run in the directory a step names.

---

### Task 2a.1: Common core — errors, quality, HTTP, bars, fallback, testing doubles

**Files:**
- Create: `common/pyproject.toml`, `common/src/ai_trading_common/__init__.py`, `common/src/ai_trading_common/errors.py`, `common/src/ai_trading_common/quality.py`, `common/src/ai_trading_common/http.py`, `common/src/ai_trading_common/bars.py`, `common/src/ai_trading_common/fallback.py`, `common/src/ai_trading_common/testing.py`
- Create: `common/tests/test_errors.py`, `common/tests/test_bars.py`, `common/tests/test_http.py`, `common/tests/test_fallback.py`
- Create: `common/THIRD_PARTY_NOTICES.md`
- Modify: `.github/workflows/ai-trading-ci.yml`

**Interfaces:**
- Consumes: nothing (first task in the package).
- Produces (every later common task relies on these):
  - `ai_trading_common.errors.{ProviderError, NotConfigured, Unavailable, SoftBanned, NoData}`
  - `ai_trading_common.quality.Quality` (`Literal["realtime", "delayed-15m", "eod", "fallback", "unavailable"]`)
  - `ai_trading_common.http.{HostThrottle, ThrottledClient}`, with `ThrottledClient.get(url, *, provider, host_key, user_agent, min_interval=0.0, params=None, headers=None, timeout=15.0, ban_prone=False, default_cooldown=60.0, retries=3) -> requests.Response` and `.get_json(url, *, provider, **kwargs) -> Any`
  - `ai_trading_common.bars.{Bars, Timeframe, BarValidationError, COLUMNS, to_utc, validate, drop_unclosed, is_stale}`
  - `ai_trading_common.fallback.first_success[T](calls: Sequence[Callable[[], T]]) -> tuple[T, bool]`
  - `ai_trading_common.testing.{FakeClock, FakeResponse, FakeSession, make_client}`

- [ ] **Step 1: Create the package skeleton.**

`common/pyproject.toml`:

```toml
[project]
name = "ai-trading-common"
version = "0.1.0"
description = "Shared provider errors, quality labels, throttled HTTP, and bar hygiene for ai-trading"
requires-python = ">=3.12,<3.13"
dependencies = [
    "exchange-calendars>=4.13",
    "pandas>=2.3",
    "requests>=2.32",
]

[dependency-groups]
dev = [
    "pytest>=9.0",
    "ruff>=0.17",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/ai_trading_common"]

[tool.ruff]
line-length = 120

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`common/src/ai_trading_common/__init__.py`:

```python
"""Shared provider errors, quality labels, throttled HTTP, and bar hygiene for ai-trading."""
```

- [ ] **Step 2: Write the failing tests for `errors.py`.** `common/tests/test_errors.py`:

```python
import pytest

from ai_trading_common.errors import NoData, NotConfigured, ProviderError, SoftBanned, Unavailable


def test_provider_error_carries_the_provider():
    error = ProviderError("alpaca", "boom")
    assert error.provider == "alpaca"
    assert "alpaca" in str(error)
    assert "boom" in str(error)


@pytest.mark.parametrize("cls", [NotConfigured, Unavailable, SoftBanned, NoData])
def test_every_variant_is_a_provider_error(cls):
    assert issubclass(cls, ProviderError)


def test_soft_banned_is_an_unavailable():
    assert issubclass(SoftBanned, Unavailable)
```

- [ ] **Step 3: Run it and watch it fail.**

Run (in `common/`): `uv sync && uv run pytest -q tests/test_errors.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.errors'`.

- [ ] **Step 4: Implement `errors.py`.**

```python
"""Provider error taxonomy shared by every ai-trading data client.

One hierarchy so callers (a fallback chain, a strategy evaluator) react by
*behavior*, not by provider:

    ProviderError
    ├── NotConfigured   no key, or the key was rejected
    ├── Unavailable     unreachable, timed out, 5xx, or malformed after bounded retries
    │   └── SoftBanned  the host's soft-ban latch is set; no request was sent
    └── NoData          the provider answered and has nothing for this request

``NotConfigured``, ``Unavailable``, and ``SoftBanned`` say nothing about the
instrument and should fall through to the next provider in a chain. ``NoData``
is a real answer (unknown symbol, no filings) and must not be hidden behind a
fallback's result (pattern: TradingAgents ``dataflows/router.py``).
"""

from __future__ import annotations


class ProviderError(Exception):
    """Base for any condition where a provider could not return usable data."""

    def __init__(self, provider: str, message: str) -> None:
        self.provider = provider
        super().__init__(f"{provider}: {message}")


class NotConfigured(ProviderError):
    """No key was supplied, or the provider rejected it."""


class Unavailable(ProviderError):
    """Unreachable, timed out, returned 5xx, or malformed after bounded retries."""


class SoftBanned(Unavailable):
    """The host's soft-ban latch is set, so no request was sent."""


class NoData(ProviderError):
    """The provider answered and has nothing for this request (not an outage)."""
```

- [ ] **Step 5: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_errors.py`
Expected: `6 passed`.

- [ ] **Step 6: Write the failing test for `quality.py`, folded into `bars.py`'s test file below (Step 8)** — `Quality` is a type alias with nothing to unit-test on its own; it is exercised by every client test from Task 2a.2 on.

Implement `common/src/ai_trading_common/quality.py`:

```python
"""Data-quality labels shown on every number the Desk displays (02 Global Constraints)."""

from __future__ import annotations

from typing import Literal

Quality = Literal["realtime", "delayed-15m", "eod", "fallback", "unavailable"]
```

- [ ] **Step 7: Write the failing tests for `bars.py`.** `common/tests/test_bars.py`:

```python
from datetime import date

import pandas as pd
import pytest

from ai_trading_common.bars import BarValidationError, drop_unclosed, is_stale, validate


def _ohlcv(closes):
    return {
        "open": closes,
        "high": [c + 1 for c in closes],
        "low": [c - 1 for c in closes],
        "close": closes,
        "volume": 100.0,
    }


def daily_frame(days, closes):
    return pd.DataFrame(_ohlcv(closes), index=pd.Index(days))


def intraday_frame(starts, closes):
    has_tz = isinstance(starts, pd.DatetimeIndex) and starts.tz is not None
    index = starts if has_tz else pd.DatetimeIndex(starts, tz="UTC")
    return pd.DataFrame(_ohlcv(closes), index=index)


class TestValidate:
    def test_drops_a_bad_row_but_keeps_the_rest(self):
        frame = daily_frame([date(2026, 1, 2), date(2026, 1, 5)], [10.0, 20.0])
        frame.loc[date(2026, 1, 2), "high"] = 5.0  # high < low
        out = validate(frame, "1d")
        assert list(out.index) == [date(2026, 1, 5)]

    def test_drops_a_non_positive_price(self):
        frame = daily_frame([date(2026, 1, 2)], [0.0])
        assert validate(frame, "1d").empty

    def test_sorts_and_dedupes_the_index(self):
        frame = daily_frame([date(2026, 1, 5), date(2026, 1, 2), date(2026, 1, 2)], [20.0, 9.0, 10.0])
        out = validate(frame, "1d")
        assert list(out.index) == [date(2026, 1, 2), date(2026, 1, 5)]
        assert out.loc[date(2026, 1, 2), "close"] == 10.0  # last wins on a duplicate

    def test_rejects_missing_columns(self):
        with pytest.raises(BarValidationError):
            validate(pd.DataFrame({"open": [1.0]}, index=[date(2026, 1, 2)]), "1d")

    def test_rejects_daily_frame_with_timestamp_index(self):
        frame = pd.DataFrame(
            {"open": [1.0], "high": [1.0], "low": [1.0], "close": [1.0], "volume": [1.0]},
            index=pd.DatetimeIndex(["2026-01-02"], tz="UTC"),
        )
        with pytest.raises(BarValidationError):
            validate(frame, "1d")

    def test_intraday_frame_converted_to_utc(self):
        starts = pd.date_range("2026-01-02 14:30", periods=2, freq="1h", tz="America/New_York")
        frame = intraday_frame(starts, [1.0, 2.0])
        out = validate(frame, "1h")
        assert str(out.index.tz) == "UTC"


class TestDropUnclosed:
    def test_1m_keeps_only_bars_closed_by_now(self):
        starts = pd.date_range("2026-01-02 14:30", periods=3, freq="1min", tz="UTC")
        frame = intraday_frame(starts, [1.0, 2.0, 3.0])
        now = starts[1] + pd.Timedelta(minutes=1)  # the second bar has just closed
        out = drop_unclosed(frame, "1m", now)
        assert list(out.index) == list(starts[:2])

    def test_1h_caps_the_last_bin_at_the_session_close(self):
        # XNYS regular close on 2026-03-09 (post-DST) is 16:00 ET = 20:00 UTC.
        # A 1h bar starting 15:30 ET would normally run to 16:30 ET, but the
        # session ends at 16:00 ET, so it closes 30 minutes early.
        start = pd.Timestamp("2026-03-09 15:30", tz="America/New_York").tz_convert("UTC")
        frame = intraday_frame([start], [1.0])
        before_session_close = start + pd.Timedelta(minutes=20)
        after_session_close = start + pd.Timedelta(minutes=35)
        assert drop_unclosed(frame, "1h", before_session_close).empty
        assert not drop_unclosed(frame, "1h", after_session_close).empty

    def test_1h_post_close_extended_hours_bar_still_needs_its_own_60_minutes(self):
        # A real Alpaca half-day fixture (2025-11-28, 13:00 ET close) includes an
        # hourly bar starting at 16:00 ET = 21:00 UTC, in the post-market session.
        # It must not be capped at the already-past 13:00 ET regular close, which
        # would mark it "closed" the instant it starts.
        start = pd.Timestamp("2025-11-28 21:00", tz="UTC")
        frame = intraday_frame([start], [1.0])
        assert drop_unclosed(frame, "1h", start + pd.Timedelta(minutes=30)).empty
        assert not drop_unclosed(frame, "1h", start + pd.Timedelta(minutes=61)).empty

    def test_1h_half_day_closes_at_13_00_et(self):
        # 2025-11-28 (day after Thanksgiving) is a half day: close 13:00 ET = 18:00 UTC.
        start = pd.Timestamp("2025-11-28 12:30", tz="America/New_York").tz_convert("UTC")
        frame = intraday_frame([start], [1.0])
        assert drop_unclosed(frame, "1h", start + pd.Timedelta(minutes=20)).empty
        assert not drop_unclosed(frame, "1h", start + pd.Timedelta(minutes=35)).empty

    def test_1d_half_day_closes_at_13_00_et(self):
        frame = daily_frame([date(2025, 11, 28)], [10.0])
        before_close = pd.Timestamp("2025-11-28 12:59", tz="America/New_York").tz_convert("UTC")
        after_close = pd.Timestamp("2025-11-28 13:00", tz="America/New_York").tz_convert("UTC")
        assert drop_unclosed(frame, "1d", before_close).empty
        assert not drop_unclosed(frame, "1d", after_close).empty

    def test_1d_drops_a_non_trading_day(self):
        frame = daily_frame([date(2026, 3, 7)], [10.0])  # a Saturday
        assert drop_unclosed(frame, "1d", pd.Timestamp("2030-01-01", tz="UTC")).empty

    def test_requires_tz_aware_now(self):
        frame = daily_frame([date(2026, 1, 2)], [10.0])
        with pytest.raises(BarValidationError):
            drop_unclosed(frame, "1d", pd.Timestamp("2026-01-05"))


class TestIsStale:
    def test_empty_frame_is_not_stale(self):
        assert is_stale(daily_frame([], []), pd.Timestamp("2026-01-05", tz="UTC"), pd.Timedelta(days=1)) is False

    def test_daily_frame_stale_past_max_age(self):
        frame = daily_frame([date(2026, 1, 2)], [10.0])
        assert is_stale(frame, pd.Timestamp("2026-01-20", tz="UTC"), pd.Timedelta(days=10)) is True
        assert is_stale(frame, pd.Timestamp("2026-01-05", tz="UTC"), pd.Timedelta(days=10)) is False
```

- [ ] **Step 8: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_bars.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.bars'`.

- [ ] **Step 9: Implement `bars.py`.**

```python
"""Bar hygiene: the shared frame shape, and guards against a repainting or stale bar.

Modified from (no code copied; see THIRD_PARTY_NOTICES.md): TradingAgents
``dataflows/vendors/yahoo/ohlcv.py``'s ``_assert_ohlcv_not_stale`` and
``market.py`` (Apache License 2.0, upstream commit
``1394a3f72aa4393e1a98f51b382434c4b4c2d972``). Their rules carry over as rules,
reworked for this package's frame shape: inclusive ends belong to each
client's own request range, not here; stale-frame rejection is ``is_stale``
below, parameterized by a caller-supplied ``max_age`` instead of their fixed
``MAX_OHLCV_STALE_DAYS``; a bad row is dropped rather than failing the whole
frame, the same choice their ``_fill_price_gaps``/``_clean_dataframe`` make.
``drop_unclosed`` follows ai-hedge-fund ``hedge_fund/data/cached.py``'s rule in
spirit ("never cache a trading day that has not closed"; pattern reuse, no
notice needed), generalized to the 1h/1m bar edges the Desk's core needs.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from functools import cache
from typing import Literal
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import pandas as pd

from ai_trading_common.quality import Quality

Timeframe = Literal["1d", "1h", "1m"]

COLUMNS = ("open", "high", "low", "close", "volume")

ET = ZoneInfo("America/New_York")

# A fixed range so results don't drift as the wall clock advances (same choice as
# the Desk's core/calendar.py).
_CALENDAR_START = "2000-01-01"
_CALENDAR_END = "2035-12-31"


@cache
def _xnys() -> xcals.ExchangeCalendar:
    return xcals.get_calendar("XNYS", start=_CALENDAR_START, end=_CALENDAR_END)


@dataclass(frozen=True)
class Bars:
    frame: pd.DataFrame
    source: str
    quality: Quality


class BarValidationError(ValueError):
    """`validate` or a guard was given a frame or timestamp it cannot use."""


def to_utc(value: pd.Timestamp | datetime) -> pd.Timestamp:
    """A tz-aware timestamp as UTC; rejects a naive timestamp (ambiguous local time).

    Shared by every provider client's `now`/`start`/`end` arguments, not just the
    guards below.
    """
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        raise BarValidationError("timestamp must be tz-aware")
    return ts.tz_convert("UTC")


def validate(frame: pd.DataFrame, timeframe: Timeframe) -> pd.DataFrame:
    """Enforce the shared bar shape and drop rows that cannot be trusted.

    - exactly the columns open/high/low/close/volume, coerced numeric;
    - "1d": index of plain `date` objects (the Desk's core convention; see
      `ai_trading.core.backtest.SymbolBars`), unique and sorted;
    - "1h"/"1m": a tz-aware `DatetimeIndex` of bar starts, converted to UTC,
      unique and sorted;
    - a row with a non-positive price, `high < low`, or a NaN is dropped, not
      the whole frame — one bad print should not blank out an otherwise-good
      history. (Decision, not TradingAgents' whole-frame reject: a vendor's
      occasional malformed row is common; a vendor with no good rows at all
      still ends up empty, which the caller's `NoData` path already covers.)

    Raises `BarValidationError` when the shape itself is unusable (missing
    columns, or an index of the wrong kind) — row content does not get here.
    """
    missing = [c for c in COLUMNS if c not in frame.columns]
    if missing:
        raise BarValidationError(f"missing columns: {missing}")
    frame = frame[list(COLUMNS)].copy()
    for column in COLUMNS:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    if timeframe == "1d":
        if not all(isinstance(value, date) and not isinstance(value, datetime) for value in frame.index):
            raise BarValidationError("1d bars must be indexed by plain date objects")
    else:
        if not isinstance(frame.index, pd.DatetimeIndex) or frame.index.tz is None:
            raise BarValidationError(f"{timeframe} bars must have a tz-aware DatetimeIndex")
        if str(frame.index.tz) != "UTC":
            frame.index = frame.index.tz_convert("UTC")

    if not frame.index.is_monotonic_increasing:
        frame = frame.sort_index()
    if frame.index.has_duplicates:
        frame = frame[~frame.index.duplicated(keep="last")]

    good = (
        frame[list(COLUMNS)].notna().all(axis=1)
        & (frame["open"] > 0)
        & (frame["high"] > 0)
        & (frame["low"] > 0)
        & (frame["close"] > 0)
        & (frame["high"] >= frame["low"])
        & (frame["volume"] >= 0)
    )
    return frame[good]


def drop_unclosed(frame: pd.DataFrame, timeframe: Timeframe, now: pd.Timestamp | datetime) -> pd.DataFrame:
    """Drop any bar whose period has not closed by `now` (no repainting).

    - "1m": the bar closes one minute after its start.
    - "1h": the bar closes 60 minutes after its start, or at the session's
      close when that is earlier (a session's short last hour, or a half day).
    - "1d": the bar (indexed by trading day) closes at that day's XNYS close
      (16:00 ET on a regular day, 13:00 ET on a half day).

    A day in a "1d" frame that XNYS does not recognize as a session is dropped:
    it cannot be anything but a vendor error, since a closed exchange has no
    close to compare against.
    """
    now_utc = to_utc(now)
    calendar = _xnys()

    if timeframe == "1d":
        keep = []
        for day in frame.index:
            label = pd.Timestamp(day)
            if not calendar.is_session(label):
                keep.append(False)
                continue
            keep.append(calendar.session_close(label) <= now_utc)
        return frame[keep]

    if timeframe == "1m":
        return frame[frame.index + pd.Timedelta(minutes=1) <= now_utc]

    # "1h"
    keep = []
    for start in frame.index:
        label = pd.Timestamp(start.tz_convert(ET).date())
        close_cap = start + pd.Timedelta(minutes=60)
        if calendar.is_session(label):
            session_open, session_close = calendar.session_open(label), calendar.session_close(label)
            # Only shorten the bin when `start` is inside the *regular* session:
            # an extended-hours (pre/post-market) bar that starts after the
            # regular close has no session boundary to borrow, and still needs
            # its own full 60 minutes — capping it at the already-past regular
            # close would mark it closed the instant it starts (repainting risk).
            if session_open <= start < session_close:
                close_cap = min(close_cap, session_close)
        keep.append(close_cap <= now_utc)
    return frame[keep]


def is_stale(frame: pd.DataFrame, now: pd.Timestamp | datetime, max_age: pd.Timedelta) -> bool:
    """Whether `frame`'s latest bar is older than `max_age` before `now`.

    An empty frame is not stale: "no data" is the distinct, already-explicit
    `NoData` state, not a frame that quietly looks current.
    """
    if frame.empty:
        return False
    now_utc = to_utc(now)
    last = frame.index[-1]
    if isinstance(last, date) and not isinstance(last, datetime):
        last_ts = pd.Timestamp(last, tz="UTC")
    else:
        last_ts = pd.Timestamp(last).tz_convert("UTC")
    return now_utc - last_ts > max_age
```

- [ ] **Step 10: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_bars.py`
Expected: `15 passed`.

- [ ] **Step 11: Write the failing tests for `http.py`, using the `testing.py` doubles.** First, `common/src/ai_trading_common/testing.py`:

```python
"""Network-free test doubles for `ThrottledClient` users; the common and Desk suites both import them."""

from __future__ import annotations

from ai_trading_common.http import ThrottledClient


class FakeClock:
    """A controllable clock: sleep() advances it, instead of a real sleep."""

    def __init__(self, start: float = 0.0) -> None:
        self.t = start

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


class FakeResponse:
    def __init__(self, status_code: int, body=None, headers=None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.headers = headers or {}

    def json(self):
        if self._body == "not-json":
            raise ValueError("not json")
        return self._body


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[tuple[str, dict | None, dict | None]] = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, params, headers))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def make_client(responses, clock: FakeClock | None = None) -> tuple[ThrottledClient, FakeSession, FakeClock]:
    clock = clock or FakeClock()
    session = FakeSession(responses)
    client = ThrottledClient(clock=clock.now, sleep=clock.sleep, jitter=lambda a, b: 0.0, session=session)
    return client, session, clock
```

This references `ThrottledClient` before it exists; that is expected to fail collection in the next step, same as every other TDD cycle in this task.

`common/tests/test_http.py`:

```python
import pytest
import requests

from ai_trading_common.errors import SoftBanned, Unavailable
from ai_trading_common.testing import FakeResponse, make_client


class TestThrottling:
    def test_consecutive_calls_to_one_bucket_are_spaced_at_least_min_interval_apart(self):
        client, _, clock = make_client([FakeResponse(200, {"ok": 1})] * 3)
        for _ in range(3):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", min_interval=5.0)
        # Three calls at min_interval=5 span at least two intervals.
        assert clock.now() >= 10.0

    def test_distinct_buckets_dont_block_each_other(self):
        client, _, clock = make_client([FakeResponse(200, {"ok": 1})] * 2)
        client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", min_interval=5.0)
        client.get("https://x/", provider="p", host_key="host-b", user_agent="ua", min_interval=5.0)
        assert clock.now() == 0.0  # neither call waited on the other's bucket


class TestSoftBan:
    def test_429_latches_the_host_and_blocks_the_next_call_without_sending_it(self):
        client, session, clock = make_client([FakeResponse(429, headers={"Retry-After": "30"})])
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert len(session.calls) == 1
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert len(session.calls) == 1  # the second call never hit the network

    def test_latch_honors_retry_after_and_expires(self):
        responses = [FakeResponse(429, headers={"Retry-After": "30"}), FakeResponse(200, {"ok": 1})]
        client, session, clock = make_client(responses)
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        clock.t += 29.0
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        clock.t += 2.0  # now past the 30s cooldown
        client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert len(session.calls) == 2

    def test_403_latches_only_when_the_caller_declares_the_host_ban_prone(self):
        client, _, _ = make_client([FakeResponse(403)])
        response = client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", ban_prone=False)
        assert response.status_code == 403  # not latched; caller maps it itself

        client, _, _ = make_client([FakeResponse(403)])
        with pytest.raises(SoftBanned):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", ban_prone=True)

    def test_403_latch_falls_back_to_default_cooldown_without_retry_after(self):
        client, session, clock = make_client([FakeResponse(403), FakeResponse(200, {"ok": 1})])
        kwargs = dict(provider="p", host_key="host-a", user_agent="ua", ban_prone=True, default_cooldown=10.0)
        with pytest.raises(SoftBanned):
            client.get("https://x/", **kwargs)
        clock.t += 10.0
        client.get("https://x/", **kwargs)
        assert len(session.calls) == 2


class TestRetries:
    def test_retries_are_bounded_on_repeated_5xx(self):
        client, session, clock = make_client([FakeResponse(500)] * 10)
        with pytest.raises(Unavailable):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", retries=2)
        assert len(session.calls) == 3  # 1 initial + 2 retries, never more

    def test_succeeds_after_a_transient_connection_error(self):
        client, session, clock = make_client([requests.ConnectionError("boom"), FakeResponse(200, {"ok": 1})])
        response = client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert response.status_code == 200
        assert len(session.calls) == 2

    def test_timeout_exhausts_retries_and_raises_unavailable(self):
        client, session, _ = make_client([requests.Timeout("slow")] * 10)
        with pytest.raises(Unavailable):
            client.get("https://x/", provider="p", host_key="host-a", user_agent="ua", retries=1)
        assert len(session.calls) == 2

    def test_unavailable_never_carries_the_failing_url_or_its_query_key(self):
        leak = requests.ConnectionError("Max retries exceeded with url: /v1/x?token=SECRET123")
        client, _, _ = make_client([leak] * 3)
        with pytest.raises(Unavailable) as caught:
            client.get("https://x/v1/x", provider="p", host_key="host-a", user_agent="ua", retries=1)
        assert "SECRET123" not in str(caught.value)
        assert caught.value.__cause__ is None and caught.value.__suppress_context__

    def test_a_4xx_other_than_429_403_is_returned_without_retry(self):
        client, session, _ = make_client([FakeResponse(404)])
        response = client.get("https://x/", provider="p", host_key="host-a", user_agent="ua")
        assert response.status_code == 404
        assert len(session.calls) == 1


class TestGetJson:
    def test_decodes_json_body(self):
        client, _, _ = make_client([FakeResponse(200, {"bars": [1, 2]})])
        assert client.get_json("https://x/", provider="p", host_key="host-a", user_agent="ua") == {"bars": [1, 2]}

    def test_malformed_json_raises_unavailable(self):
        client, _, _ = make_client([FakeResponse(200, "not-json")])
        with pytest.raises(Unavailable):
            client.get_json("https://x/", provider="p", host_key="host-a", user_agent="ua")
```

- [ ] **Step 12: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_http.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.http'`.

- [ ] **Step 13: Implement `http.py`.**

```python
"""Throttled HTTP: per-host minimum spacing, bounded retries, and a soft-ban latch.

Adapted from Vibe-Trading `agent/backtest/loaders/_http.py`
(`HostThrottle`/`throttled_get_json`, upstream commit `d402c2df9bc6162f314df5bc5d06ba30ebc3332d`,
MIT License; see THIRD_PARTY_NOTICES.md). Changes from upstream:
- dropped the environment-variable lookups and `positive_env_float`: callers pass
  `min_interval` explicitly;
- callers must pass a `user_agent` (several providers, including SEC, require one
  declared per request rather than a shared default);
- added bounded retries with backoff for timeouts, connection errors, and 5xx,
  raising `ai_trading_common.errors.Unavailable` once exhausted;
- added a soft-ban latch per host key: a 429, or a 403 on a host the caller
  declares `ban_prone`, latches that host until `Retry-After` elapses (or a
  default cooldown), raising `ai_trading_common.errors.SoftBanned`. While
  latched, no request is sent.
- the clock and sleep are injectable, so tests pin the throttle's timing with a
  fake clock instead of a real sleep.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from collections.abc import Callable
from typing import Any

import requests

from ai_trading_common.errors import SoftBanned, Unavailable

logger = logging.getLogger(__name__)

# Upper bound on the random jitter (seconds) added on top of the configured
# minimum interval, so parallel callers de-synchronize instead of all firing the
# instant the interval elapses (unchanged from upstream).
_JITTER_MAX_S = 0.4

DEFAULT_COOLDOWN_S = 60.0
DEFAULT_RETRY_BACKOFFS = (1.0, 2.0, 4.0)


class HostThrottle:
    """Minimum-spacing gate keyed by an arbitrary host bucket, plus a soft-ban latch.

    `wait(bucket, min_interval)` blocks until at least `min_interval` seconds
    (plus jitter) have elapsed since the last request tagged with the same
    `bucket`; distinct buckets never block each other. `latch`/`banned_until`
    implement the soft-ban: a banned bucket is checked and raises before any
    request is attempted.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        jitter: Callable[[float, float], float] = random.uniform,
    ) -> None:
        self._clock = clock
        self._sleep = sleep
        self._jitter = jitter
        self._lock = threading.Lock()
        self._last: dict[str, float] = {}
        self._banned_until: dict[str, float] = {}

    def latch(self, bucket: str, cooldown: float) -> None:
        with self._lock:
            self._banned_until[bucket] = self._clock() + max(cooldown, 0.0)

    def banned_for(self, bucket: str) -> float:
        """Seconds left on `bucket`'s ban, or 0 when it is not (or no longer) banned."""
        with self._lock:
            until = self._banned_until.get(bucket)
        if until is None:
            return 0.0
        return max(until - self._clock(), 0.0)

    def wait(self, bucket: str, min_interval: float) -> None:
        if min_interval <= 0:
            return
        with self._lock:
            now = self._clock()
            last = self._last.get(bucket)
            if last is None or now >= last + min_interval:
                fire_at = now
            else:
                fire_at = last + min_interval + self._jitter(0.0, _JITTER_MAX_S)
            self._last[bucket] = fire_at
        sleep_for = fire_at - self._clock()
        if sleep_for > 0:
            self._sleep(sleep_for)


def _retry_after_seconds(response: requests.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


class ThrottledClient:
    """A `requests.Session` gated by `HostThrottle`, with bounded retries.

    One instance per process is enough: `host_key` buckets separate providers
    (and, within a provider, separate ban-prone sub-hosts) in the same throttle
    and ban state.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        jitter: Callable[[float, float], float] = random.uniform,
        session: requests.Session | None = None,
    ) -> None:
        self.throttle = HostThrottle(clock=clock, sleep=sleep, jitter=jitter)
        self._sleep = sleep
        self._session = session or requests.Session()

    def get(
        self,
        url: str,
        *,
        provider: str,
        host_key: str,
        user_agent: str,
        min_interval: float = 0.0,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 15.0,
        ban_prone: bool = False,
        default_cooldown: float = DEFAULT_COOLDOWN_S,
        retries: int = len(DEFAULT_RETRY_BACKOFFS),
    ) -> requests.Response:
        """GET `url`, honoring the throttle and the soft-ban latch.

        Raises `SoftBanned` immediately (no request sent) while `host_key` is
        latched, or on a 429 (any host) or a 403 on a `ban_prone` host, which
        also latches it for `Retry-After` seconds or `default_cooldown`.
        Raises `Unavailable` after `retries` bounded retries on a timeout,
        connection error, or 5xx. Any other status is returned to the caller to
        interpret (an unknown symbol, a bad key, and so on are provider-specific).
        """
        banned_for = self.throttle.banned_for(host_key)
        if banned_for > 0:
            raise SoftBanned(provider, f"{host_key} is soft-banned for {banned_for:.0f}s more")

        merged_headers = {"User-Agent": user_agent}
        if headers:
            merged_headers.update(headers)

        attempt = 0
        while True:
            self.throttle.wait(host_key, min_interval)
            try:
                response = self._session.get(url, params=params, headers=merged_headers, timeout=timeout)
            except (requests.ConnectionError, requests.Timeout) as exc:
                if attempt >= retries:
                    # requests' message carries the full URL, and some providers put the key in the query
                    message = f"{host_key} unreachable after {attempt + 1} attempt(s): {type(exc).__name__}"
                    raise Unavailable(provider, message) from None
                self._sleep(DEFAULT_RETRY_BACKOFFS[min(attempt, len(DEFAULT_RETRY_BACKOFFS) - 1)])
                attempt += 1
                continue

            if response.status_code == 429 or (response.status_code == 403 and ban_prone):
                cooldown = _retry_after_seconds(response) or default_cooldown
                self.throttle.latch(host_key, cooldown)
                raise SoftBanned(provider, f"{host_key} returned {response.status_code}; latched for {cooldown:.0f}s")

            if response.status_code >= 500:
                if attempt >= retries:
                    message = f"{host_key} returned {response.status_code} after {attempt + 1} attempt(s)"
                    raise Unavailable(provider, message)
                self._sleep(DEFAULT_RETRY_BACKOFFS[min(attempt, len(DEFAULT_RETRY_BACKOFFS) - 1)])
                attempt += 1
                continue

            return response

    def get_json(self, url: str, *, provider: str, **kwargs: Any) -> Any:
        """`get`, then decode the body as JSON (`Unavailable` on malformed JSON)."""
        response = self.get(url, provider=provider, **kwargs)
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(provider, f"malformed JSON body: {exc}") from exc
```

- [ ] **Step 14: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_http.py`
Expected: `13 passed`.

- [ ] **Step 15: Write the failing tests for `fallback.py`.** `common/tests/test_fallback.py`:

```python
import pytest

from ai_trading_common.errors import NoData, NotConfigured, SoftBanned, Unavailable
from ai_trading_common.fallback import first_success


def raiser(exc):
    def _call():
        raise exc

    return _call


class TestHappyPath:
    def test_the_primary_calls_result_is_marked_primary(self):
        result, is_primary = first_success([lambda: "primary"])
        assert result == "primary"
        assert is_primary is True

    def test_a_later_calls_result_is_marked_not_primary(self):
        result, is_primary = first_success([raiser(Unavailable("p1", "down")), lambda: "secondary"])
        assert result == "secondary"
        assert is_primary is False

    def test_never_calls_after_one_succeeds(self):
        calls = []

        def third():
            calls.append("third")
            return "unreached"

        first_success([lambda: calls.append("first") or "primary", third])
        assert calls == ["first"]


class TestFallThrough:
    @pytest.mark.parametrize("exc", [NotConfigured("p", "no key"), Unavailable("p", "down"), SoftBanned("p", "banned")])
    def test_transient_errors_fall_through_to_the_next_call(self, exc):
        result, is_primary = first_success([raiser(exc), lambda: "secondary"])
        assert result == "secondary"
        assert is_primary is False


class TestFailureModes:
    def test_every_call_no_data_raises_no_data(self):
        with pytest.raises(NoData):
            first_success([raiser(NoData("p1", "none")), raiser(NoData("p2", "none"))])

    def test_a_transient_failure_is_reported_over_a_later_no_data(self):
        # The brief's rule: an outage must not be hidden behind "no data".
        with pytest.raises(Unavailable):
            first_success([raiser(Unavailable("p1", "down")), raiser(NoData("p2", "none"))])

    def test_a_transient_failure_is_reported_even_when_it_came_first(self):
        with pytest.raises(SoftBanned):
            first_success([raiser(SoftBanned("p1", "banned")), raiser(NoData("p2", "none"))])

    def test_empty_call_list_is_a_programming_error(self):
        with pytest.raises(ValueError):
            first_success([])
```

- [ ] **Step 16: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_fallback.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.fallback'`.

- [ ] **Step 17: Implement `fallback.py`.**

```python
"""Provider fallback: try data sources in order, reacting by behavior, not by vendor.

Pattern adapted from TradingAgents `dataflows/router.py`'s `route_to_vendor`
(Apache-2.0; idea only, no code copied — 02a §11 "pattern"): `NotConfigured`,
`Unavailable`, and `SoftBanned` say nothing about the instrument and fall
through to the next call. `NoData` is a real answer but must not be the final
word when some other call in the chain was actually unreachable — an outage
must never look like "no data" (the brief's rule), so a transient failure
anywhere in the chain is reported ahead of a `NoData` collected from another
call, the same precedence `route_to_vendor` gives `VendorUnavailableError`
over `NoMarketDataError`.

This is the one fallback helper for the package: generic over the return
type, so a bars chain, a consensus-EPS chain, or anything else composes the
same precedence without each caller re-deriving it. A caller that needs a
quality label (e.g. `Bars.quality`) relabels the result itself using the
returned `is_primary` flag — the label is a per-type concern this helper
does not know about.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from ai_trading_common.errors import NoData, NotConfigured, ProviderError, SoftBanned, Unavailable


def first_success[T](calls: Sequence[Callable[[], T]]) -> tuple[T, bool]:
    """Try each call in order; returns `(result, is_primary)`.

    `calls` are zero-argument callables, each a closure over one real call.
    `is_primary` is `True` only when `calls[0]` itself succeeded; every later
    success reports `False`, so a caller that labels non-primary results
    (e.g. `quality="fallback"`) knows which one it got.

    Raises the chain's most informative failure once every call has failed:
    - a `NotConfigured`/`Unavailable`/`SoftBanned` from any call, if one
      occurred (an outage must not be reported as "no data");
    - otherwise the first `NoData` seen, when every call genuinely answered
      "nothing here".
    """
    if not calls:
        raise ValueError("first_success needs at least one call")

    first_no_data: NoData | None = None
    last_transient: ProviderError | None = None
    for index, call in enumerate(calls):
        try:
            return call(), index == 0
        except NoData as exc:
            first_no_data = first_no_data or exc
        except (NotConfigured, Unavailable, SoftBanned) as exc:
            last_transient = exc

    if last_transient is not None:
        raise last_transient
    assert first_no_data is not None  # calls is non-empty: one branch always set a result
    raise first_no_data
```

- [ ] **Step 18: Run everything and lint.**

Run (in `common/`): `uv lock && uv run pytest -q -rs && uv run ruff check . && uv run ruff format --check .`
Expected: `44 passed` (6 + 15 + 13 + 10), ruff clean, 0 skipped. (`testing.py` is collected only as a module import, not a test file — it carries no `test_*` functions of its own.)

- [ ] **Step 19: Write `THIRD_PARTY_NOTICES.md`.**

```markdown
# Third-Party Notices

`ai-trading/common` adapts the code below. Each adapted file says so in its header.

## Vibe-Trading

Source: https://github.com/HKUDS/Vibe-Trading (pinned as `ai-trading/packages/vibe-trading`), commit `d402c2df9bc6162f314df5bc5d06ba30ebc3332d`.

| Common file | Adapted from | Changes |
|---|---|---|
| `src/ai_trading_common/http.py` (`HostThrottle`, `ThrottledClient`) | `agent/backtest/loaders/_http.py` (`HostThrottle`, `throttled_get_json`) | Dropped the environment-variable lookups and `positive_env_float`; callers pass `min_interval` and `user_agent` explicitly instead of a shared default; added bounded retries with backoff for timeouts, connection errors, and 5xx; added a soft-ban latch per host key (429, or a 403 on a caller-declared ban-prone host, raises `SoftBanned` and blocks further requests until `Retry-After` or a default cooldown); the clock and sleep are injectable so tests use a fake clock instead of a real sleep |

```text
MIT License

Copyright (c) 2026 Vibe-Trading Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## TradingAgents

Source: https://github.com/TauricResearch/TradingAgents (pinned as `ai-trading/packages/trading-agents`), commit `1394a3f72aa4393e1a98f51b382434c4b4c2d972`.

Attribution: TradingAgents (TauricResearch/TradingAgents). Apache License 2.0. The repository has no separate NOTICE file. The adapted file is marked as modified in its own header, per section 4(b) of the license.

| Common file | Adapted from | Changes |
|---|---|---|
| `src/ai_trading_common/bars.py` (`drop_unclosed`, `is_stale`) | `tradingagents/dataflows/vendors/yahoo/ohlcv.py` (`_assert_ohlcv_not_stale`), `market.py` | No code copied (a different frame shape: the Desk's shared `open/high/low/close/volume` bars, not yfinance's daily `Date`-indexed rows); kept the ideas of inclusive ends (each client's own request range, not this module) and stale-frame rejection (`is_stale`, parameterized by a caller-supplied `max_age` instead of the fixed `MAX_OHLCV_STALE_DAYS`); "partial-bar refresh" became `drop_unclosed`'s close-time guard (never keep a bar whose period has not closed), generalized to 1d/1h/1m bar edges and the XNYS half-day close that ohlcv.py's daily-only rule does not need |

The complete, verbatim upstream LICENSE (`ai-trading/packages/trading-agents/LICENSE`):

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
```

- [ ] **Step 20: Add the CI step that runs this package's suite, and widen the uv cache glob.** In `.github/workflows/ai-trading-ci.yml`, replace:

```yaml
      - uses: astral-sh/setup-uv@v10.3.0  # no floating major tag; Dependabot bumps it
        with:
          enable-cache: true
          cache-dependency-glob: ai-trading/packages/family-desk/backend/uv.lock
      - name: Contracts (Zod, fixtures, JSON Schema drift)
```

with:

```yaml
      - uses: astral-sh/setup-uv@v10.3.0  # no floating major tag; Dependabot bumps it
        with:
          enable-cache: true
          cache-dependency-glob: |
            ai-trading/packages/family-desk/backend/uv.lock
            ai-trading/common/uv.lock
      - name: Common (providers, throttle, bar hygiene)
        working-directory: ai-trading/common
        run: |
          uv sync --locked
          uv run ruff check .
          uv run ruff format --check .
          uv run pytest -q
      - name: Contracts (Zod, fixtures, JSON Schema drift)
```

- [ ] **Step 21: Commit.**

```bash
git add ai-trading/common/pyproject.toml ai-trading/common/uv.lock ai-trading/common/src/ai_trading_common/__init__.py ai-trading/common/src/ai_trading_common/errors.py ai-trading/common/src/ai_trading_common/quality.py ai-trading/common/src/ai_trading_common/http.py ai-trading/common/src/ai_trading_common/bars.py ai-trading/common/src/ai_trading_common/fallback.py ai-trading/common/src/ai_trading_common/testing.py ai-trading/common/tests/test_errors.py ai-trading/common/tests/test_bars.py ai-trading/common/tests/test_http.py ai-trading/common/tests/test_fallback.py ai-trading/common/THIRD_PARTY_NOTICES.md .github/workflows/ai-trading-ci.yml
git commit -m "feat(ai-trading): ai-trading-common core -- errors, quality, throttled HTTP, bar hygiene, fallback"
```

---

### Task 2a.2: Alpaca bars, and `scripts/record.py`

**Files:**
- Create: `common/src/ai_trading_common/alpaca.py`, `common/scripts/record.py`
- Create: `common/tests/test_alpaca.py`, `common/tests/test_alpaca_fixtures.py`
- Modify: `common/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: `ai_trading_common.bars.{Bars, Timeframe, drop_unclosed, to_utc, validate}` (2a.1), `ai_trading_common.errors.{NoData, NotConfigured, ProviderError, Unavailable}` (2a.1), `ai_trading_common.http.ThrottledClient` (2a.1), `ai_trading_common.testing.{FakeResponse, make_client}` (2a.1).
- Produces: `ai_trading_common.alpaca.AlpacaBars(key_id, secret, *, http=None).bars(symbol, timeframe, start, end, *, now, adjustment="all") -> Bars`.

Fixture paths used (already committed, `ae6ec0f`): `common/tests/fixtures/alpaca/{daily_range_aapl,daily_range_spy,hourly_dst_change,minute_dst_change,hourly_half_day,minute_half_day,minute_paginated,minute_paginated_page{2..7}}.json`.

- [ ] **Step 1: Write the failing tests.** `common/tests/test_alpaca.py`:

```python
import pandas as pd
import pytest

from ai_trading_common.alpaca import AlpacaBars
from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.testing import FakeResponse, make_client


def bar(t, c, v=100):
    return {"t": t, "o": c - 1, "h": c + 1, "l": c - 2, "c": c, "v": v}


NOW = pd.Timestamp("2026-01-10 12:00", tz="UTC")
START = pd.Timestamp("2026-01-01", tz="UTC")
END = pd.Timestamp("2026-01-08", tz="UTC")


class TestDailyBars:
    def test_maps_bars_to_the_shared_shape_with_eod_quality(self):
        body = {"bars": [bar("2026-01-02T05:00:00Z", 10), bar("2026-01-05T05:00:00Z", 11)]}
        client, session, _ = make_client([FakeResponse(200, body)])
        alpaca = AlpacaBars("kid", "sec", http=client)
        got = alpaca.bars("AAPL", "1d", START, END, now=NOW)
        assert got.source == "alpaca"
        assert got.quality == "eod"
        assert list(got.frame.index) == [pd.Timestamp("2026-01-02").date(), pd.Timestamp("2026-01-05").date()]
        assert got.frame.loc[pd.Timestamp("2026-01-02").date(), "close"] == 10.0
        headers = session.calls[0][2]
        assert headers["APCA-API-KEY-ID"] == "kid"
        assert headers["APCA-API-SECRET-KEY"] == "sec"

    def test_follows_pagination(self):
        client, session, _ = make_client(
            [
                FakeResponse(200, {"bars": [bar("2026-01-02T05:00:00Z", 10)], "next_page_token": "p2"}),
                FakeResponse(200, {"bars": [bar("2026-01-05T05:00:00Z", 11)], "next_page_token": None}),
            ]
        )
        alpaca = AlpacaBars("kid", "sec", http=client)
        got = alpaca.bars("AAPL", "1d", START, END, now=NOW)
        assert len(got.frame) == 2
        assert len(session.calls) == 2

    def test_no_bars_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(200, {"bars": []})])
        alpaca = AlpacaBars("kid", "sec", http=client)
        with pytest.raises(NoData):
            alpaca.bars("ZZZZ", "1d", START, END, now=NOW)

    def test_404_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(404)])
        alpaca = AlpacaBars("kid", "sec", http=client)
        with pytest.raises(NoData):
            alpaca.bars("ZZZZ", "1d", START, END, now=NOW)

    def test_401_raises_not_configured(self):
        client, _, _ = make_client([FakeResponse(401)])
        alpaca = AlpacaBars("bad", "key", http=client)
        with pytest.raises(NotConfigured):
            alpaca.bars("AAPL", "1d", START, END, now=NOW)

    def test_empty_key_raises_not_configured_without_a_request(self):
        client, session, _ = make_client([])
        alpaca = AlpacaBars("", "", http=client)
        with pytest.raises(NotConfigured):
            alpaca.bars("AAPL", "1d", START, END, now=NOW)
        assert session.calls == []

    def test_500_raises_unavailable_after_bounded_retries(self):
        client, session, clock = make_client([FakeResponse(500)] * 10)
        alpaca = AlpacaBars("kid", "sec", http=client)
        with pytest.raises(Unavailable):
            alpaca.bars("AAPL", "1d", START, END, now=NOW)
        assert len(session.calls) == 4  # the http layer's default retry bound


class TestIntradayBars:
    def test_hourly_and_minute_bars_are_delayed_15m(self):
        for timeframe in ("1h", "1m"):
            client, _, _ = make_client([FakeResponse(200, {"bars": [bar("2026-01-02T14:30:00Z", 10)]})])
            alpaca = AlpacaBars("kid", "sec", http=client)
            got = alpaca.bars("AAPL", timeframe, START, END, now=NOW)
            assert got.quality == "delayed-15m"
            assert str(got.frame.index.tz) == "UTC"

    def test_sip_embargo_caps_the_request_end_15_minutes_before_now(self):
        now = pd.Timestamp("2026-01-10 12:00:00", tz="UTC")
        client, session, _ = make_client([FakeResponse(200, {"bars": [bar("2026-01-10T11:00:00Z", 10)]})])
        alpaca = AlpacaBars("kid", "sec", http=client)
        alpaca.bars("AAPL", "1m", pd.Timestamp("2026-01-10 10:00", tz="UTC"), now, now=now)
        params = session.calls[0][1]
        assert params["end"] == (now - pd.Timedelta(minutes=15)).isoformat()

    def test_capped_end_before_start_returns_empty_without_a_request(self):
        now = pd.Timestamp("2026-01-10 10:00:00", tz="UTC")
        start = pd.Timestamp("2026-01-10 09:58", tz="UTC")  # inside the 15-minute embargo
        client, session, _ = make_client([])
        alpaca = AlpacaBars("kid", "sec", http=client)
        got = alpaca.bars("AAPL", "1m", start, now, now=now)
        assert got.frame.empty
        assert session.calls == []
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_alpaca.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.alpaca'`.

- [ ] **Step 3: Implement `alpaca.py`.**

```python
"""Alpaca bars: daily (eod), hourly and 1-minute (delayed-15m) history.

Adapted from `ai-trading/market-data/alpaca.py` (ours; open-source lane) and
moved here per the Phase 2 reuse map (02a §11, "move"). No attribution notice
needed: same author, not an upstream project. Changes: the throttled HTTP
layer and bar hygiene guards from this package, the shared `Timeframe`s
("1d"/"1h"/"1m" instead of just daily), and the free plan's two guards (the SIP
embargo and the 200-requests-a-minute throttle).
"""

from __future__ import annotations

from datetime import datetime
from urllib.parse import quote

import pandas as pd

from ai_trading_common.bars import Bars, Timeframe, drop_unclosed, to_utc, validate
from ai_trading_common.errors import NoData, NotConfigured, ProviderError, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.quality import Quality

PROVIDER = "alpaca"
BASE = "https://data.alpaca.markets/v2/stocks"
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

    def __init__(self, key_id: str, secret: str, *, http: ThrottledClient | None = None) -> None:
        self.key_id = key_id
        self.secret = secret
        self._http = http or ThrottledClient()

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
        if not (self.key_id and self.secret):
            raise NotConfigured(PROVIDER, "no API key configured")

        start_utc, end_utc, now_utc = to_utc(start), to_utc(end), to_utc(now)
        capped_end = min(end_utc, now_utc - SIP_EMBARGO)
        quality = _QUALITY[timeframe]
        if capped_end < start_utc:
            return Bars(frame=_empty_frame(timeframe), source=PROVIDER, quality=quality)

        params = {
            "timeframe": _ALPACA_TIMEFRAME[timeframe],
            "start": start_utc.isoformat(),
            "end": capped_end.isoformat(),
            "adjustment": adjustment,
            "feed": "sip",
            "limit": "10000",
        }
        rows: list[dict] = []
        page_token: str | None = None
        while True:
            if page_token:
                params["page_token"] = page_token
            else:
                params.pop("page_token", None)
            body = self._get(symbol, params)
            rows.extend(body.get("bars") or [])
            page_token = body.get("next_page_token")
            if not page_token:
                break

        if not rows:
            raise NoData(PROVIDER, f"no bars for {symbol!r} between {start_utc} and {capped_end}")

        frame = _to_frame(rows, timeframe)
        frame = validate(frame, timeframe)
        frame = drop_unclosed(frame, timeframe, now_utc)
        return Bars(frame=frame, source=PROVIDER, quality=quality)

    def _get(self, symbol: str, params: dict) -> dict:
        url = f"{BASE}/{quote(symbol)}/bars"
        headers = {"APCA-API-KEY-ID": self.key_id, "APCA-API-SECRET-KEY": self.secret}
        response = self._http.get(
            url,
            provider=PROVIDER,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=params,
            headers=headers,
        )
        if response.status_code in (401, 403):
            raise NotConfigured(PROVIDER, f"key rejected (HTTP {response.status_code})")
        if response.status_code == 404:
            raise NoData(PROVIDER, f"unknown symbol {symbol!r}")
        if response.status_code != 200:
            raise Unavailable(PROVIDER, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER, f"malformed JSON body: {exc}") from exc


def _empty_frame(timeframe: Timeframe) -> pd.DataFrame:
    columns = ("open", "high", "low", "close", "volume")
    index = pd.Index([], dtype=object) if timeframe == "1d" else pd.DatetimeIndex([], tz="UTC")
    return pd.DataFrame({c: pd.Series(dtype="float64") for c in columns}, index=index)


def _to_frame(rows: list[dict], timeframe: Timeframe) -> pd.DataFrame:
    """Alpaca's `{t, o, h, l, c, v}` bars into the shared OHLCV shape.

    `t` is an RFC3339 UTC timestamp of the bar's start. A "1d" bar is reindexed
    to its America/New_York trading date (not sliced from the string): Alpaca
    timestamps a daily bar at that session's open in UTC, whose date can differ
    from the UTC calendar date depending on the time of year.
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
        raise ProviderError(PROVIDER, f"malformed bar: {exc}") from exc

    if timeframe == "1d":
        raw.index = raw.index.tz_convert("America/New_York").date
    return raw
```

- [ ] **Step 4: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_alpaca.py`
Expected: `10 passed`.

- [ ] **Step 5: Write the failing fixture-contract tests.** `common/tests/test_alpaca_fixtures.py`:

```python
"""Contract tests against real Alpaca responses recorded by scripts/record.py.

No network: each fixture is a `{"params": ..., "body": ...}` JSON file under
tests/fixtures/alpaca/, replayed through a fake session so the client code path
(pagination, bar mapping, hygiene) runs on real response shapes.
"""

import json
from pathlib import Path

import pandas as pd

from ai_trading_common.alpaca import AlpacaBars
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent / "fixtures" / "alpaca"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def alpaca_for(*fixture_names: str) -> tuple[AlpacaBars, object]:
    responses = [FakeResponse(200, load(name)["body"]) for name in fixture_names]
    client, session, _ = make_client(responses)
    return AlpacaBars("kid", "sec", http=client), session


class TestDailyFixture:
    def test_daily_range_round_trips_through_validate_and_drop_unclosed(self):
        alpaca, _ = alpaca_for("daily_range_aapl")
        now = pd.Timestamp("2026-02-01", tz="UTC")
        start, end = pd.Timestamp("2026-01-01", tz="UTC"), pd.Timestamp("2026-01-15", tz="UTC")
        got = alpaca.bars("AAPL", "1d", start, end, now=now)
        assert got.quality == "eod"
        assert len(got.frame) == 9
        assert list(got.frame.columns) == ["open", "high", "low", "close", "volume"]
        assert all(isinstance(day, type(got.frame.index[0])) for day in got.frame.index)


class TestDstChangeFixture:
    def test_hourly_bars_span_the_dst_gap_with_a_consistent_utc_index(self):
        alpaca, _ = alpaca_for("hourly_dst_change")
        now = pd.Timestamp("2026-03-10", tz="UTC")
        got = alpaca.bars(
            "AAPL", "1h", pd.Timestamp("2026-03-06T15:00:00Z"), pd.Timestamp("2026-03-09T17:00:00Z"), now=now
        )
        assert str(got.frame.index.tz) == "UTC"
        # Bars exist both before (2026-03-06, EST) and after (2026-03-09, EDT) the
        # transition; the index stays a plain, monotonic UTC DatetimeIndex either side.
        assert got.frame.index.min().date().isoformat() == "2026-03-06"
        assert got.frame.index.max().date().isoformat() == "2026-03-09"
        assert got.frame.index.is_monotonic_increasing

    def test_minute_bars_cross_the_weekend_and_dst_gap_cleanly(self):
        alpaca, _ = alpaca_for("minute_dst_change")
        now = pd.Timestamp("2026-03-10", tz="UTC")
        got = alpaca.bars(
            "AAPL", "1m", pd.Timestamp("2026-03-06T20:45:00Z"), pd.Timestamp("2026-03-09T14:00:00Z"), now=now
        )
        assert not got.frame.empty
        assert got.frame.index.is_monotonic_increasing
        # The weekend (plus the DST-change Sunday) leaves the largest gap in the
        # index by a wide margin over any ordinary overnight gap.
        gaps = got.frame.index.to_series().diff().dropna()
        assert gaps.max() > pd.Timedelta(hours=24)


class TestHalfDayFixture:
    def test_hourly_half_day_includes_a_post_close_extended_hours_bar(self):
        alpaca, _ = alpaca_for("hourly_half_day")
        now = pd.Timestamp("2025-11-29", tz="UTC")
        got = alpaca.bars(
            "AAPL", "1h", pd.Timestamp("2025-11-28T00:00:00Z"), pd.Timestamp("2025-11-29T00:00:00Z"), now=now
        )
        # The regular session on a half day closes 13:00 ET (18:00 UTC); Alpaca's
        # sip feed still reports post-market hourly bars after that, which must
        # survive drop_unclosed once their own 60 minutes have actually elapsed.
        assert (got.frame.index >= pd.Timestamp("2025-11-28T18:00:00Z")).any()

    def test_minute_half_day_bars_keep_their_real_minute_closes(self):
        alpaca, _ = alpaca_for("minute_half_day")
        now = pd.Timestamp("2025-11-29", tz="UTC")
        got = alpaca.bars(
            "AAPL", "1m", pd.Timestamp("2025-11-28T17:45:00Z"), pd.Timestamp("2025-11-28T18:15:00Z"), now=now
        )
        assert len(got.frame) > 0
        assert got.frame.index.max() <= pd.Timestamp("2025-11-28T18:15:00Z")


class TestPaginationFixture:
    def test_every_page_is_followed_and_concatenated_in_order(self):
        names = ["minute_paginated"] + [f"minute_paginated_page{n}" for n in range(2, 8)]
        alpaca, session = alpaca_for(*names)
        now = pd.Timestamp("2026-01-06", tz="UTC")
        got = alpaca.bars(
            "SPY", "1m", pd.Timestamp("2026-01-05T14:30:00Z"), pd.Timestamp("2026-01-05T15:00:00Z"), now=now
        )
        assert len(session.calls) == 7
        assert len(got.frame) == 31  # 6 pages of 5 bars plus a final page of 1
        assert got.frame.index.is_monotonic_increasing
```

- [ ] **Step 6: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_alpaca_fixtures.py`
Expected: `6 passed`.

- [ ] **Step 7: Write `scripts/record.py`.**

```python
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


_RECORDERS = {
    "alpaca": record_alpaca,
}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in _RECORDERS:
        print(f"usage: record.py <{'|'.join(_RECORDERS)}>", file=sys.stderr)
        raise SystemExit(2)
    _RECORDERS[sys.argv[1]]()


if __name__ == "__main__":
    main()
```

- [ ] **Step 8: Add the "ours, moved" notice.** Append this new section to `THIRD_PARTY_NOTICES.md`, after the TradingAgents section's closing ` ```` ` fence:

```markdown

## `ai-trading/market-data/` (ours; open-source lane)

Not a third party: `alpaca.py` was moved here from `ai-trading/market-data/` per
the Phase 2 reuse map (02a §11, "move"). Same author, no license notice needed.
See `src/ai_trading_common/alpaca.py`'s module docstring for what changed.
```

- [ ] **Step 9: Run everything and lint.**

Run (in `common/`): `uv run pytest -q -rs && uv run ruff check . && uv run ruff format --check .`
Expected: `60 passed` (44 + 10 + 6), ruff clean, 0 skipped.

- [ ] **Step 10: Commit.**

```bash
git add ai-trading/common/src/ai_trading_common/alpaca.py ai-trading/common/scripts/record.py ai-trading/common/tests/test_alpaca.py ai-trading/common/tests/test_alpaca_fixtures.py ai-trading/common/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): Alpaca bars client and the fixture recorder script"
```

---

### Task 2a.3: SEC EDGAR, including 8-K paging

**Files:**
- Create: `common/src/ai_trading_common/sec_edgar.py`
- Create: `common/tests/test_sec_edgar.py`, `common/tests/test_sec_edgar_fixtures.py`
- Modify: `common/scripts/record.py`, `common/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: `ai_trading_common.errors.{NoData, NotConfigured, Unavailable}`, `ai_trading_common.http.ThrottledClient`, `ai_trading_common.testing.{FakeResponse, make_client}` (2a.1).
- Produces: `ai_trading_common.sec_edgar.{Fact, EightKFiling, Span, facts_as_of, eight_k_as_of, SecEdgar}`, with `SecEdgar(user_agent, *, http=None).company_facts(ticker, as_of, *, concepts=None) -> list[Fact]` and `.item_202_filings(ticker, since) -> list[EightKFiling]`.

Fixture paths used (already committed): `common/tests/fixtures/sec_edgar/{company_tickers,companyfacts_aapl,companyfacts_msft,submissions_aapl,submissions_msft,submissions_jpm,submissions_jpm_page1}.json`.

- [ ] **Step 1: Write the failing tests.** `common/tests/test_sec_edgar.py`:

```python
from datetime import date

import pytest

from ai_trading_common.errors import NoData, NotConfigured, SoftBanned, Unavailable
from ai_trading_common.sec_edgar import (
    EightKFiling,
    Fact,
    SecEdgar,
    _classify_span,
    _oldest_filing_date,
    _parse_facts,
    _parse_item_202,
    _parse_item_202_block,
    eight_k_as_of,
    facts_as_of,
)
from ai_trading_common.testing import FakeResponse, make_client

TICKERS_BODY = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 1067983, "ticker": "BRK-B", "title": "BERKSHIRE HATHAWAY INC"},
}


class TestClassifySpan:
    def test_instant_fact_has_no_start(self):
        assert _classify_span(None, date(2024, 1, 1)) == "instant"

    @pytest.mark.parametrize(
        "days,expected",
        [(91, "quarterly"), (180, "ytd_6m"), (270, "ytd_9m"), (365, "annual")],
    )
    def test_duration_fact_classified_by_span_length(self, days, expected):
        start = date(2024, 1, 1)
        end = date.fromordinal(start.toordinal() + days)
        assert _classify_span(start, end) == expected

    def test_an_unrecognized_span_is_dropped_not_guessed(self):
        assert _classify_span(date(2024, 1, 1), date(2024, 1, 20)) is None  # 19 days: no bucket fits


def _fact(concept="NetIncomeLoss", unit="USD", val=1.0, filed="2020-01-01", form="10-K", end="2019-12-31"):
    return {"val": val, "accn": f"accn-{filed}", "fy": 2019, "fp": "FY", "form": form, "filed": filed, "end": end}


class TestParseFacts:
    def test_parses_an_instant_and_a_duration_fact(self):
        payload = {
            "facts": {
                "us-gaap": {
                    "Assets": {
                        "units": {
                            "USD": [
                                {"val": 100.0, "accn": "a1", "form": "10-K", "filed": "2020-01-01", "end": "2019-12-31"}
                            ]
                        }
                    },
                    "NetIncomeLoss": {
                        "units": {
                            "USD": [
                                {
                                    "val": 5.0,
                                    "accn": "a2",
                                    "form": "10-K",
                                    "filed": "2020-01-01",
                                    "end": "2019-12-31",
                                    "start": "2019-01-01",
                                    "fy": 2019,
                                    "fp": "FY",
                                }
                            ]
                        }
                    },
                }
            }
        }
        facts = _parse_facts(payload)
        by_concept = {f.concept: f for f in facts}
        assert by_concept["Assets"].span == "instant"
        assert by_concept["Assets"].period_start is None
        assert by_concept["NetIncomeLoss"].span == "annual"
        assert by_concept["NetIncomeLoss"].period_start == date(2019, 1, 1)

    def test_concepts_filter_limits_parsing(self):
        payload = {
            "facts": {
                "us-gaap": {"Assets": {"units": {"USD": [_fact()]}}, "Liabilities": {"units": {"USD": [_fact()]}}}
            }
        }
        facts = _parse_facts(payload, concepts=("Assets",))
        assert {f.concept for f in facts} == {"Assets"}

    def test_an_unspanned_duration_fact_is_dropped(self):
        payload = {
            "facts": {
                "us-gaap": {
                    "Weird": {
                        "units": {
                            "USD": [
                                {
                                    "val": 1.0,
                                    "accn": "a",
                                    "form": "10-Q",
                                    "filed": "2020-01-01",
                                    "end": "2020-01-20",
                                    "start": "2020-01-01",
                                }
                            ]
                        }
                    }
                }
            }
        }
        assert _parse_facts(payload) == []


class TestFactsAsOf:
    def test_a_fact_filed_after_as_of_is_unknown(self):
        facts = [
            Fact("Assets", "USD", 1.0, None, date(2020, 1, 1), "instant", None, None, "10-K", date(2020, 2, 1), "a1")
        ]
        assert facts_as_of(facts, date(2020, 1, 15)) == []

    def test_a_later_amendment_wins_only_from_its_own_filed_date(self):
        original = Fact(
            "NetIncomeLoss",
            "USD",
            3496.0,
            date(2006, 10, 1),
            date(2007, 9, 29),
            "annual",
            2009,
            "FY",
            "10-K",
            date(2009, 10, 27),
            "orig",
        )
        amendment = Fact(
            "NetIncomeLoss",
            "USD",
            3495.0,
            date(2006, 10, 1),
            date(2007, 9, 29),
            "annual",
            2009,
            "FY",
            "10-K/A",
            date(2010, 1, 25),
            "amend",
        )
        facts = [original, amendment]
        assert [f.value for f in facts_as_of(facts, date(2009, 12, 1))] == [3496.0]
        assert [f.value for f in facts_as_of(facts, date(2010, 2, 1))] == [3495.0]

    def test_different_spans_of_the_same_period_end_are_kept_separately(self):
        quarterly = Fact(
            "Revenues",
            "USD",
            10.0,
            date(2020, 1, 1),
            date(2020, 3, 31),
            "quarterly",
            2020,
            "Q1",
            "10-Q",
            date(2020, 4, 1),
            "a",
        )
        annual = Fact(
            "Revenues",
            "USD",
            40.0,
            date(2019, 4, 1),
            date(2020, 3, 31),
            "annual",
            2020,
            "FY",
            "10-K",
            date(2020, 5, 1),
            "b",
        )
        assert len(facts_as_of([quarterly, annual], date(2020, 6, 1))) == 2


class TestParseItem202:
    def test_parse_item_202_is_a_thin_wrapper_over_the_block_parser(self):
        block = {
            "accessionNumber": ["a1"],
            "filingDate": ["2024-01-01"],
            "form": ["8-K"],
            "items": ["2.02"],
        }
        assert _parse_item_202({"filings": {"recent": block}}) == _parse_item_202_block(block)

    def test_keeps_only_8k_filings_with_item_2_02(self):
        payload = {
            "filings": {
                "recent": {
                    "accessionNumber": ["a1", "a2", "a3"],
                    "filingDate": ["2024-01-01", "2024-02-01", "2024-03-01"],
                    "form": ["8-K", "8-K", "10-Q"],
                    "items": ["2.02,9.01", "5.02", "2.02"],
                }
            }
        }
        got = _parse_item_202(payload)
        assert [f.accession for f in got] == ["a1"]
        assert got[0].items == ("2.02", "9.01")

    def test_no_recent_block_is_an_empty_list(self):
        assert _parse_item_202({"filings": {}}) == []


class TestEightKAsOf:
    def test_only_filings_known_by_as_of_are_kept_and_sorted(self):
        filings = [
            EightKFiling(date(2024, 3, 1), "later", ("2.02",)),
            EightKFiling(date(2024, 1, 1), "earlier", ("2.02",)),
        ]
        got = eight_k_as_of(filings, date(2024, 2, 1))
        assert [f.accession for f in got] == ["earlier"]


class TestSecEdgarClient:
    def test_cik_lookup_maps_dot_class_shares_to_sec_dash_form(self):
        client, session, _ = make_client([FakeResponse(200, TICKERS_BODY)])
        sec = SecEdgar("ua", http=client)
        assert sec._cik("BRK.B") == "0001067983"
        assert session.calls[0][2]["User-Agent"] == "ua"

    def test_unknown_ticker_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(200, TICKERS_BODY)])
        sec = SecEdgar("ua", http=client)
        with pytest.raises(NoData):
            sec._cik("ZZZZ")

    def test_empty_user_agent_raises_not_configured_without_a_request(self):
        client, session, _ = make_client([])
        sec = SecEdgar("", http=client)
        with pytest.raises(NotConfigured):
            sec.company_facts("AAPL", date(2024, 1, 1))
        assert session.calls == []

    def test_404_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(200, TICKERS_BODY), FakeResponse(404)])
        sec = SecEdgar("ua", http=client)
        with pytest.raises(NoData):
            sec.company_facts("AAPL", date(2024, 1, 1))

    def test_a_bare_403_latches_as_soft_banned(self):
        client, _, _ = make_client([FakeResponse(403)])
        sec = SecEdgar("ua", http=client)
        with pytest.raises(SoftBanned):
            sec._cik("AAPL")

    def test_500_raises_unavailable_after_bounded_retries(self):
        client, session, _ = make_client([FakeResponse(500)] * 10)
        sec = SecEdgar("ua", http=client)
        with pytest.raises(Unavailable):
            sec._cik("AAPL")
        assert len(session.calls) == 4

    def test_company_facts_end_to_end_resolves_cik_then_fetches_and_cuts(self):
        companyfacts = {
            "facts": {
                "us-gaap": {
                    "Assets": {
                        "units": {
                            "USD": [
                                {"val": 1.0, "accn": "a", "form": "10-K", "filed": "2024-01-01", "end": "2023-12-31"}
                            ]
                        }
                    }
                }
            }
        }
        client, _, _ = make_client([FakeResponse(200, TICKERS_BODY), FakeResponse(200, companyfacts)])
        sec = SecEdgar("ua", http=client)
        got = sec.company_facts("AAPL", date(2024, 6, 1))
        assert len(got) == 1
        assert got[0].concept == "Assets"

    def test_item_202_filings_resolves_cik_then_fetches_submissions(self):
        submissions = {
            "filings": {
                "recent": {
                    "accessionNumber": ["a1"],
                    "filingDate": ["2024-01-01"],
                    "form": ["8-K"],
                    "items": ["2.02"],
                }
            }
        }
        client, session, _ = make_client([FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions)])
        sec = SecEdgar("ua", http=client)
        got = sec.item_202_filings("AAPL", since=date(2023, 1, 1))  # recent's own floor already covers it
        assert [f.accession for f in got] == ["a1"]
        assert len(session.calls) == 2  # no filings.files page fetched


def _block(rows: list[tuple[str, str, str, str]]) -> dict:
    """A `filings.recent`/`filings.files`-page-shaped block from (accession, filed, form, items) rows."""
    return {
        "accessionNumber": [r[0] for r in rows],
        "filingDate": [r[1] for r in rows],
        "form": [r[2] for r in rows],
        "items": [r[3] for r in rows],
    }


class TestOldestFilingDate:
    def test_scans_rather_than_trusting_array_order(self):
        # filingDate deliberately out of order: the real recent/files blocks are too.
        block = _block([("a", "2024-03-01", "10-Q", ""), ("b", "2024-01-15", "8-K", "2.02")])
        assert _oldest_filing_date(block) == date(2024, 1, 15)

    def test_an_empty_block_has_no_oldest_date(self):
        assert _oldest_filing_date({}) is None


class TestItem202Pagination:
    """`SecEdgar.item_202_filings(ticker, since)` falls back to `filings.files`
    (the older-filings archive) only as far as `since` needs, never further.
    """

    def _submissions(self, recent_rows, files=None):
        body = {"filings": {"recent": _block(recent_rows)}}
        if files is not None:
            body["filings"]["files"] = files
        return body

    def test_no_extra_fetch_when_recent_already_covers_since(self):
        recent = [("r1", "2025-06-01", "8-K", "2.02"), ("r2", "2024-01-01", "10-Q", "")]
        submissions = self._submissions(
            recent, files=[{"name": "page1.json", "filingFrom": "2020-01-01", "filingTo": "2023-12-31"}]
        )
        client, session, _ = make_client([FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions)])
        sec = SecEdgar("ua", http=client)
        got = sec.item_202_filings("AAPL", since=date(2024, 1, 1))
        assert [f.accession for f in got] == ["r1"]
        assert len(session.calls) == 2  # tickers + submissions root only; no page fetched

    def test_fetches_exactly_one_older_page_when_recent_falls_short(self):
        recent = [("r1", "2025-06-01", "8-K", "2.02")]  # oldest in recent: 2025-06-01, after `since`
        files = [{"name": "page1.json", "filingFrom": "2025-01-01", "filingTo": "2025-05-31"}]
        page1 = _block([("p1", "2025-02-01", "8-K", "2.02")])
        submissions = self._submissions(recent, files=files)
        client, session, _ = make_client(
            [FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions), FakeResponse(200, page1)]
        )
        sec = SecEdgar("ua", http=client)
        got = sec.item_202_filings("AAPL", since=date(2025, 1, 15))
        assert {f.accession for f in got} == {"r1", "p1"}
        assert len(session.calls) == 3  # tickers + submissions root + exactly one page
        assert session.calls[2][0] == "https://data.sec.gov/submissions/page1.json"

    def test_stops_as_soon_as_the_window_is_covered_never_fetching_more_than_needed(self):
        recent = [("r1", "2025-06-01", "8-K", "2.02")]
        files = [
            {"name": "page1.json", "filingFrom": "2025-01-01", "filingTo": "2025-05-31"},  # covers `since` already
            {"name": "page2.json", "filingFrom": "2020-01-01", "filingTo": "2024-12-31"},  # must not be fetched
        ]
        page1 = _block([("p1", "2025-02-01", "8-K", "2.02")])
        submissions = self._submissions(recent, files=files)
        client, session, _ = make_client(
            [FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions), FakeResponse(200, page1)]
        )
        sec = SecEdgar("ua", http=client)
        got = sec.item_202_filings("AAPL", since=date(2025, 3, 1))
        assert {f.accession for f in got} == {"r1", "p1"}
        assert len(session.calls) == 3  # page2 never requested

    def test_a_failed_page_raises_unavailable_not_a_silently_partial_list(self):
        recent = [("r1", "2025-06-01", "8-K", "2.02")]
        files = [{"name": "page1.json", "filingFrom": "2025-01-01", "filingTo": "2025-05-31"}]
        submissions = self._submissions(recent, files=files)
        responses = [FakeResponse(200, TICKERS_BODY), FakeResponse(200, submissions), *([FakeResponse(500)] * 10)]
        client, _, _ = make_client(responses)
        sec = SecEdgar("ua", http=client)
        with pytest.raises(Unavailable):
            sec.item_202_filings("AAPL", since=date(2025, 1, 15))
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_sec_edgar.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.sec_edgar'`.

- [ ] **Step 3: Implement `sec_edgar.py`.**

```python
"""SEC EDGAR: point-in-time CompanyFacts and 8-K Item 2.02 announcement dates.

Adapted from TradingAgents `tradingagents/dataflows/vendors/sec_edgar.py`
(Apache License 2.0, upstream commit `1394a3f72aa4393e1a98f51b382434c4b4c2d972`;
see THIRD_PARTY_NOTICES.md). Compared with `ai-trading/market-data/sec.py`
(ours, open-source lane): kept that file's CIK lookup (`BRK.B` -> `BRK-B`) and
its 404-as-empty handling; kept TradingAgents' span classification
(`_span_index`/`_SPANS`/`_YEAR_TO_DATE`, renamed `_classify_span`) and its
amendment rule ("a period reported more than once takes its latest filing on
or before the date"). Changes from both: this returns typed `Fact` rows, not
a rendered statement or a flattened label map, so a caller (valuation, a
chart) picks its own concepts and aggregation; the point-in-time cut is its
own pure `facts_as_of(facts, as_of)` function, so it is testable and reusable
without a network call per cut; errors map to this package's shared
`ProviderError` hierarchy instead of TradingAgents' `NoMarketDataError`/
`VendorUnavailableError`; and the 8-K Item 2.02 reader is new (ai-hedge-fund
`hedge_fund/signals/pead.py`'s "the 8-K is the announcement date, not the
10-Q" pattern — idea only, no code copied).

No key or account: SEC requires only a declared User-Agent identifying the
caller (`SEC_USER_AGENT`), and refuses an unidentified request with 403.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient

PROVIDER = "sec_edgar"

# SEC's fair-access policy rate-limits sec.gov as one site-wide bucket (10
# requests/second), not per-subdomain, so www.sec.gov and data.sec.gov share
# one host key and one throttle bucket here.
HOST_KEY = "sec_edgar"
MIN_INTERVAL_S = 1.0 / 10.0

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
# An older filings.files page (`{"name": "CIK...-submissions-NNN.json", ...}`)
# is a flat document at this sibling path to the root submissions URL — same
# column-array shape as `filings.recent` itself, not nested under "filings".
SUBMISSIONS_PAGE_URL = "https://data.sec.gov/submissions/{name}"

Span = Literal["instant", "quarterly", "ytd_6m", "ytd_9m", "annual"]

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
class Fact:
    """One us-gaap fact as SEC reported it: a value, its span, and when it was filed."""

    concept: str
    unit: str
    value: float
    period_start: date | None  # None for an instant fact (a balance-sheet line)
    period_end: date
    span: Span
    fiscal_year: int | None
    fiscal_period: str | None  # "Q1".."Q4", "FY"
    form: str
    filed: date
    accession: str


@dataclass(frozen=True)
class EightKFiling:
    """An 8-K filing and the items it covers."""

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
                        accession=entry["accn"],
                    )
                )
    return out


def facts_as_of(facts: list[Fact], as_of: date) -> list[Fact]:
    """Pure point-in-time selector: only facts filed on or before `as_of`.

    A period reported more than once (an amendment) keeps only its latest
    filing on or before `as_of` — an amendment counts from the day it was
    filed, never before. Example seen live: Apple's fiscal 2007 net income
    read $3,496M from the original 10-K (filed 2009-10-27) until a 10-K/A
    (filed 2010-01-25) restated it to $3,495M; a run `as_of` 2009-12-01 must
    still see $3,496M.
    """
    known = [f for f in facts if f.filed <= as_of]
    latest: dict[tuple[str, str, date, Span], Fact] = {}
    for fact in sorted(known, key=lambda f: f.filed):
        key = (fact.concept, fact.unit, fact.period_end, fact.span)
        latest[key] = fact  # later filings sort last and overwrite earlier ones
    return sorted(latest.values(), key=lambda f: (f.concept, f.period_end))


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
        payload = self._get_json(TICKERS_URL)
        wanted = ticker.strip().upper().replace(".", "-")  # SEC lists class shares as BRK-B
        for entry in payload.values():
            if entry.get("ticker", "").upper() == wanted:
                return f"{int(entry['cik_str']):010d}"
        raise NoData(PROVIDER, f"{ticker!r} is not a US SEC filer")

    def _get_json(self, url: str) -> dict:
        if not self.user_agent:
            raise NotConfigured(PROVIDER, "no SEC_USER_AGENT configured")
        response = self._http.get(
            url,
            provider=PROVIDER,
            host_key=HOST_KEY,
            user_agent=self.user_agent,
            min_interval=MIN_INTERVAL_S,
            ban_prone=True,  # an unidentified or malformed User-Agent gets a latching 403
        )
        if response.status_code == 404:
            raise NoData(PROVIDER, f"SEC has nothing at {url}")
        if response.status_code != 200:
            raise Unavailable(PROVIDER, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER, f"malformed JSON body: {exc}") from exc
```

- [ ] **Step 4: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_sec_edgar.py`
Expected: `30 passed`.

- [ ] **Step 5: Write the failing fixture-contract tests.** `common/tests/test_sec_edgar_fixtures.py`:

```python
"""Contract tests against real SEC EDGAR responses recorded by scripts/record.py.

No network: each fixture is a `{"params": ..., "body": ...}` JSON file under
tests/fixtures/sec_edgar/, replayed through a fake session.
"""

import json
from datetime import date
from pathlib import Path

from ai_trading_common.sec_edgar import SecEdgar
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent / "fixtures" / "sec_edgar"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def sec_for(*fixture_names: str) -> tuple[SecEdgar, object]:
    responses = [FakeResponse(200, load(name)["body"]) for name in fixture_names]
    client, session, _ = make_client(responses)
    return SecEdgar("ai-trading-common/0.1 (test)", http=client), session


class TestCompanyFactsFixture:
    def test_a_real_restated_fact_is_seen_only_from_its_own_filed_date(self):
        # MSFT NetIncomeLoss for 2015-07-01..2015-09-30: first filed 4,620M
        # (2015-10-22), later restated to 4,902M by a filing on 2016-04-21.
        # The client caches nothing, so each `company_facts` call needs its
        # own pair of fixtures (ticker map, then CompanyFacts).
        before_sec, _ = sec_for("company_tickers", "companyfacts_msft")
        after_sec, _ = sec_for("company_tickers", "companyfacts_msft")
        before = before_sec.company_facts("MSFT", date(2015, 12, 1))
        after = after_sec.company_facts("MSFT", date(2016, 5, 1))
        period = (date(2015, 7, 1), date(2015, 9, 30))
        before_val = next(f.value for f in before if (f.period_start, f.period_end) == period)
        after_val = next(f.value for f in after if (f.period_start, f.period_end) == period)
        assert before_val == 4_620_000_000.0
        assert after_val == 4_902_000_000.0

    def test_an_instant_assets_fact_has_no_period_start(self):
        sec, _ = sec_for("company_tickers", "companyfacts_aapl")
        facts = sec.company_facts("AAPL", date(2026, 1, 1), concepts=("Assets",))
        assert facts and all(f.period_start is None and f.span == "instant" for f in facts)


class TestSubmissionsFixture:
    # The recorded AAPL fixture's `filings.recent` window reaches back to
    # 2025-07-25 (its oldest kept row); `since` at that exact floor needs no
    # `filings.files` page.
    AAPL_RECENT_FLOOR = date(2025, 7, 25)

    def test_item_202_filings_are_the_8k_rows_only(self):
        sec, _ = sec_for("company_tickers", "submissions_aapl")
        got = sec.item_202_filings("AAPL", since=self.AAPL_RECENT_FLOOR)
        assert got  # the recorded window has at least one
        assert all("2.02" in f.items for f in got)

    def test_filings_are_known_from_their_own_filed_date_not_before(self):
        from datetime import timedelta

        from ai_trading_common.sec_edgar import eight_k_as_of

        sec, _ = sec_for("company_tickers", "submissions_aapl")
        all_filings = sec.item_202_filings("AAPL", since=self.AAPL_RECENT_FLOOR)
        earliest = min(f.filed for f in all_filings)
        assert eight_k_as_of(all_filings, earliest - timedelta(days=1)) == []
        assert any(f.filed == earliest for f in eight_k_as_of(all_filings, earliest))


class TestJpmPagingFixture:
    """JPMorgan (CIK 0000019617): a heavy filer whose `filings.recent` is large
    (26,293 rows, live-confirmed) but still only reaches back to 2025-10-10 —
    about a year, not the "last ~1,000 filings" AAPL/MSFT's much smaller
    `recent` suggested (see REPORT-P2.md). A `since` before that floor needs
    one `filings.files` page.
    """

    RECENT_FLOOR = date(2025, 10, 10)

    def test_a_since_before_recents_floor_fetches_exactly_one_older_page(self):
        sec, session = sec_for("company_tickers", "submissions_jpm", "submissions_jpm_page1")
        got = sec.item_202_filings("JPM", since=date(2025, 9, 10))
        # Live-confirmed: JPM's filings.files page 001 (2025-09-08..2025-10-08)
        # happened to carry no Item 2.02 8-K of its own (no earnings release
        # fell in that window) — a correct, non-partial empty contribution,
        # not evidence the page was skipped or the mechanism broken.
        assert all(f.filed >= self.RECENT_FLOOR for f in got)
        assert len(session.calls) == 3  # tickers + submissions root + exactly one page

    def test_at_or_after_recents_floor_needs_no_page(self):
        sec, session = sec_for("company_tickers", "submissions_jpm")
        sec.item_202_filings("JPM", since=self.RECENT_FLOOR)
        assert len(session.calls) == 2  # no filings.files page fetched
```

- [ ] **Step 6: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_sec_edgar_fixtures.py`
Expected: `6 passed`.

- [ ] **Step 7: Add the SEC recorder functions.** In `scripts/record.py`, replace:

```python
_RECORDERS = {
    "alpaca": record_alpaca,
}
```

with:

```python
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


_RECORDERS = {
    "alpaca": record_alpaca,
    "sec": record_sec,
    "sec_jpm": record_jpm_paging,
}
```

- [ ] **Step 8: Add the SEC EDGAR row and the market-data comparison note.** In `THIRD_PARTY_NOTICES.md`, replace:

```markdown
| `src/ai_trading_common/bars.py` (`drop_unclosed`, `is_stale`) | `tradingagents/dataflows/vendors/yahoo/ohlcv.py` (`_assert_ohlcv_not_stale`), `market.py` | No code copied (a different frame shape: the Desk's shared `open/high/low/close/volume` bars, not yfinance's daily `Date`-indexed rows); kept the ideas of inclusive ends (each client's own request range, not this module) and stale-frame rejection (`is_stale`, parameterized by a caller-supplied `max_age` instead of the fixed `MAX_OHLCV_STALE_DAYS`); "partial-bar refresh" became `drop_unclosed`'s close-time guard (never keep a bar whose period has not closed), generalized to 1d/1h/1m bar edges and the XNYS half-day close that ohlcv.py's daily-only rule does not need |
```

with:

```markdown
| `src/ai_trading_common/bars.py` (`drop_unclosed`, `is_stale`) | `tradingagents/dataflows/vendors/yahoo/ohlcv.py` (`_assert_ohlcv_not_stale`), `market.py` | No code copied (a different frame shape: the Desk's shared `open/high/low/close/volume` bars, not yfinance's daily `Date`-indexed rows); kept the ideas of inclusive ends (each client's own request range, not this module) and stale-frame rejection (`is_stale`, parameterized by a caller-supplied `max_age` instead of the fixed `MAX_OHLCV_STALE_DAYS`); "partial-bar refresh" became `drop_unclosed`'s close-time guard (never keep a bar whose period has not closed), generalized to 1d/1h/1m bar edges and the XNYS half-day close that ohlcv.py's daily-only rule does not need |
| `src/ai_trading_common/sec_edgar.py` | `tradingagents/dataflows/vendors/sec_edgar.py` | Kept the CIK-lookup shape, the span classification idea (`_span_index`/`_SPANS`/`_YEAR_TO_DATE`, renamed `_classify_span`/`_SPAN_RANGES`), and the amendment rule ("a period reported more than once takes its latest filing on or before the date"). Changed: returns typed `Fact` rows instead of a rendered statement string or a flattened label map, so a caller picks its own concepts; the point-in-time cut is a separate pure `facts_as_of(facts, as_of)` function instead of being inlined in the fetch; errors map to this package's `ProviderError` hierarchy instead of `NoMarketDataError`/`VendorUnavailableError`; no on-disk cache (the shared `ThrottledClient` has none either); the 8-K Item 2.02 reader (`item_202_filings`, `_parse_item_202`, `eight_k_as_of`) is new, not present upstream |
```

Then, in the same file, replace:

```markdown
## `ai-trading/market-data/` (ours; open-source lane)

Not a third party: `alpaca.py` was moved here from `ai-trading/market-data/` per
the Phase 2 reuse map (02a §11, "move"). Same author, no license notice needed.
See `src/ai_trading_common/alpaca.py`'s module docstring for what changed.
```

with:

```markdown
## `ai-trading/market-data/` (ours; open-source lane)

Not a third party: `alpaca.py` was moved here from `ai-trading/market-data/` per
the Phase 2 reuse map (02a §11, "move"). Same author, no license notice needed.
See `src/ai_trading_common/alpaca.py`'s module docstring for what changed.

`sec_edgar.py` also compares its design with `ai-trading/market-data/sec.py`
(ours; left untouched) and keeps that file's ticker-to-CIK lookup (including
the `BRK.B` -> `BRK-B` mapping) and its "404 means nothing here" handling,
alongside TradingAgents' span classification and amendment rule above. Same
author, no license notice needed; see `src/ai_trading_common/sec_edgar.py`'s
module docstring.
```

- [ ] **Step 9: Run everything and lint.**

Run (in `common/`): `uv run pytest -q -rs && uv run ruff check . && uv run ruff format --check .`
Expected: `96 passed` (60 + 30 + 6), ruff clean, 0 skipped.

- [ ] **Step 10: Commit.**

```bash
git add ai-trading/common/src/ai_trading_common/sec_edgar.py ai-trading/common/tests/test_sec_edgar.py ai-trading/common/tests/test_sec_edgar_fixtures.py ai-trading/common/scripts/record.py ai-trading/common/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): SEC EDGAR client -- point-in-time CompanyFacts and 8-K Item 2.02 paging"
```

---

### Task 2a.4: FRED

**Files:**
- Create: `common/src/ai_trading_common/fred.py`
- Create: `common/tests/test_fred.py`, `common/tests/test_fred_fixtures.py`
- Modify: `common/scripts/record.py`, `common/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: `ai_trading_common.errors.{NoData, NotConfigured, Unavailable}`, `ai_trading_common.http.ThrottledClient`, `ai_trading_common.testing.{FakeResponse, make_client}` (2a.1).
- Produces: `ai_trading_common.fred.{Observation, Fred}`, with `Fred(api_key, *, http=None).observations(series_id, start, end, *, as_of) -> list[Observation]` and `.release_dates(series_id, *, as_of=None) -> list[date]`.

Fixture paths used (already committed): `common/tests/fixtures/fred/{cpiaucsl_early,cpiaucsl_revised,unrate_early,unrate_revised,cpi_release,cpi_release_dates}.json`.

- [ ] **Step 1: Write the failing tests.** `common/tests/test_fred.py`:

```python
from datetime import date

import pytest

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.fred import Fred, Observation
from ai_trading_common.testing import FakeResponse, make_client

# Live-probed FRED error bodies (see REPORT-P2.md): a 400 always carries a
# JSON `error_message`, distinguished by which variable name it names.
BAD_KEY_BODY = {
    "error_code": 400,
    "error_message": "Bad Request.  The value for variable api_key is not a 32 character alpha-numeric "
    "lower-case string.",
}
UNKNOWN_SERIES_BODY = {
    "error_code": 400,
    "error_message": "Bad Request.  Invalid value for variable series_id.  Series IDs should be 25 or less "
    "alphanumeric characters.",
}


def obs(date_str, value, pit):
    return {"realtime_start": pit, "realtime_end": pit, "date": date_str, "value": value}


class TestObservations:
    def test_parses_observations_at_the_pinned_vintage(self):
        body = {"observations": [obs("2020-01-01", "258.82", "2020-06-01")]}
        client, session, _ = make_client([FakeResponse(200, body)])
        fred = Fred("key", http=client)
        got = fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 6, 1))
        assert got == [
            Observation(
                series_id="CPIAUCSL",
                date=date(2020, 1, 1),
                value=258.82,
                realtime_start=date(2020, 6, 1),
                realtime_end=date(2020, 6, 1),
            )
        ]
        params = session.calls[0][1]
        assert params["realtime_start"] == params["realtime_end"] == "2020-06-01"

    def test_freds_own_missing_marker_is_filtered_not_parsed_as_a_value(self):
        body = {"observations": [obs("2020-01-01", ".", "2020-02-01")]}
        client, _, _ = make_client([FakeResponse(200, body)])
        fred = Fred("key", http=client)
        with pytest.raises(NoData):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 2, 1))

    def test_an_empty_range_raises_no_data(self):
        # Live-probed: FRED answers 200 with an empty list, not an error.
        client, _, _ = make_client([FakeResponse(200, {"observations": []})])
        fred = Fred("key", http=client)
        with pytest.raises(NoData):
            fred.observations("CPIAUCSL", date(2099, 1, 1), date(2099, 2, 1), as_of=date(2099, 1, 1))

    def test_empty_key_raises_not_configured_without_a_request(self):
        client, session, _ = make_client([])
        fred = Fred("", http=client)
        with pytest.raises(NotConfigured):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))
        assert session.calls == []

    def test_a_rejected_key_raises_not_configured(self):
        client, _, _ = make_client([FakeResponse(400, BAD_KEY_BODY)])
        fred = Fred("bogus", http=client)
        with pytest.raises(NotConfigured):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))

    def test_an_unknown_series_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(400, UNKNOWN_SERIES_BODY)])
        fred = Fred("key", http=client)
        with pytest.raises(NoData):
            fred.observations("NOT_A_SERIES", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))

    def test_an_unclassified_400_raises_unavailable(self):
        client, _, _ = make_client([FakeResponse(400, {"error_message": "Bad Request. Something else."})])
        fred = Fred("key", http=client)
        with pytest.raises(Unavailable):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))

    def test_500_raises_unavailable_after_bounded_retries(self):
        client, session, _ = make_client([FakeResponse(500)] * 10)
        fred = Fred("key", http=client)
        with pytest.raises(Unavailable):
            fred.observations("CPIAUCSL", date(2020, 1, 1), date(2020, 1, 1), as_of=date(2020, 1, 1))
        assert len(session.calls) == 4


class TestReleaseDates:
    def test_resolves_the_release_then_lists_its_dates(self):
        release_body = {"releases": [{"id": 10, "name": "Consumer Price Index"}]}
        dates_body = {
            "release_dates": [{"release_id": 10, "date": "2024-02-13"}, {"release_id": 10, "date": "2024-01-11"}]
        }
        client, session, _ = make_client([FakeResponse(200, release_body), FakeResponse(200, dates_body)])
        fred = Fred("key", http=client)
        got = fred.release_dates("CPIAUCSL")
        assert got == [date(2024, 1, 11), date(2024, 2, 13)]
        assert session.calls[1][1]["release_id"] == 10

    def test_as_of_keeps_only_dates_known_by_then(self):
        release_body = {"releases": [{"id": 10}]}
        dates_body = {"release_dates": [{"date": "2024-02-13"}, {"date": "2024-01-11"}]}
        client, _, _ = make_client([FakeResponse(200, release_body), FakeResponse(200, dates_body)])
        fred = Fred("key", http=client)
        got = fred.release_dates("CPIAUCSL", as_of=date(2024, 1, 15))
        assert got == [date(2024, 1, 11)]

    def test_no_release_found_raises_no_data(self):
        client, _, _ = make_client([FakeResponse(200, {"releases": []})])
        fred = Fred("key", http=client)
        with pytest.raises(NoData):
            fred.release_dates("NOT_A_SERIES")
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_fred.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.fred'`.

- [ ] **Step 3: Implement `fred.py`.**

```python
"""FRED: vintage-pinned observations and release dates for the macro calendar.

Adapted from TradingAgents `tradingagents/dataflows/vendors/fred.py` (Apache
License 2.0, upstream commit `1394a3f72aa4393e1a98f51b382434c4b4c2d972`; see
THIRD_PARTY_NOTICES.md). Kept: pinning both `realtime_start` and
`realtime_end` to the as-of date (ALFRED's vintage mechanism) so a backtest
dated in the past sees the value as first published, not a later revision.
Dropped: the markdown-report rendering, the friendly-alias table, and the
trailing look-back-day window — callers here pass an explicit `start`/`end`
and get typed `Observation` rows, not prose; dropped the `pytz`/America-
Chicago "FRED's own today" clamp (`_fred_today`), since this client's
`as_of` always names a historical date chosen by the caller (a backtest day),
never "now" read off the wall clock. Errors map to this package's shared
`ProviderError` hierarchy instead of raising `ValueError`/a vendor-specific
`NotConfiguredError`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient

PROVIDER = "fred"
HOST_KEY = "fred"
BASE = "https://api.stlouisfed.org/fred"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"

# FRED's free tier allows 120 requests/minute.
MIN_INTERVAL_S = 60.0 / 120.0

# FRED's own marker for "nothing published for this date at this vintage"
# (as opposed to a real `0`).
_MISSING_VALUE = "."


@dataclass(frozen=True)
class Observation:
    series_id: str
    date: date  # the observation period (a day, or a month's/quarter's first day)
    value: float
    realtime_start: date
    realtime_end: date


class Fred:
    """FRED macro series: vintage-pinned observations and a series' release dates."""

    def __init__(self, api_key: str, *, http: ThrottledClient | None = None) -> None:
        self.api_key = api_key
        self._http = http or ThrottledClient()

    def observations(self, series_id: str, start: date, end: date, *, as_of: date) -> list[Observation]:
        """Observations in `[start, end]`, at the vintage known on `as_of`.

        Both `realtime_start` and `realtime_end` are pinned to `as_of`: FRED
        otherwise defaults both to today, serving the latest revision of
        every observation, which would leak a later restatement into a
        backtest dated before it happened (seen live: CPIAUCSL for 2019-06
        read 255.305 at its first realtime window and had been revised to
        255.213 by 2024).
        """
        payload = self._get(
            "series/observations",
            {
                "series_id": series_id,
                "observation_start": start.isoformat(),
                "observation_end": end.isoformat(),
                "realtime_start": as_of.isoformat(),
                "realtime_end": as_of.isoformat(),
            },
        )
        rows = payload.get("observations") or []
        out = [
            Observation(
                series_id=series_id,
                date=date.fromisoformat(row["date"]),
                value=float(row["value"]),
                realtime_start=date.fromisoformat(row["realtime_start"]),
                realtime_end=date.fromisoformat(row["realtime_end"]),
            )
            for row in rows
            if row.get("value") != _MISSING_VALUE
        ]
        if not out:
            raise NoData(PROVIDER, f"no {series_id} observations in [{start}, {end}] at the {as_of} vintage")
        return out

    def release_dates(self, series_id: str, *, as_of: date | None = None) -> list[date]:
        """Dates of the release `series_id` belongs to (e.g. "Consumer Price Index").

        One release covers several series and shares one schedule. `as_of`,
        when given, keeps only dates on or before it — a backtest must not
        see a release date that had not yet been announced.
        """
        release_payload = self._get("series/release", {"series_id": series_id})
        releases = release_payload.get("releases") or []
        if not releases:
            raise NoData(PROVIDER, f"no release found for series {series_id!r}")
        release_id = releases[0]["id"]

        dates_payload = self._get("release/dates", {"release_id": release_id})
        dates = sorted(date.fromisoformat(row["date"]) for row in dates_payload.get("release_dates") or [])
        if not dates:
            raise NoData(PROVIDER, f"no release dates for series {series_id!r}")
        return dates if as_of is None else [d for d in dates if d <= as_of]

    def _get(self, path: str, params: dict) -> dict:
        if not self.api_key:
            raise NotConfigured(PROVIDER, "no FRED_API_KEY configured")
        response = self._http.get(
            f"{BASE}/{path}",
            provider=PROVIDER,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params={**params, "api_key": self.api_key, "file_type": "json"},
        )
        if response.status_code == 400:
            raise self._error_for_400(response)
        if response.status_code != 200:
            raise Unavailable(PROVIDER, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER, f"malformed JSON body: {exc}") from exc

    def _error_for_400(self, response) -> Exception:
        """FRED answers every bad request with HTTP 400 and a JSON error_message.

        Live-probed: a rejected key names `api_key` ("...value for variable
        api_key is not a 32 character..."); an unknown or malformed series ID
        names `series_id` ("Invalid value for variable series_id..."). An
        empty result range is not an error at all — FRED returns 200 with an
        empty `observations` list, handled as `NoData` in `observations`
        above, not here.
        """
        try:
            message = response.json().get("error_message", "")
        except ValueError:
            message = response.text
        lowered = message.lower()
        if "api_key" in lowered:
            return NotConfigured(PROVIDER, f"key rejected: {message}")
        if "series_id" in lowered:
            return NoData(PROVIDER, f"unknown series: {message}")
        return Unavailable(PROVIDER, f"HTTP 400: {message}")
```

- [ ] **Step 4: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_fred.py`
Expected: `11 passed`.

- [ ] **Step 5: Write the failing fixture-contract tests.** `common/tests/test_fred_fixtures.py`:

```python
"""Contract tests against real FRED responses recorded by scripts/record.py."""

import json
from datetime import date
from pathlib import Path

from ai_trading_common.fred import Fred
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent / "fixtures" / "fred"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def fred_for(*fixture_names: str) -> Fred:
    responses = [FakeResponse(200, load(name)["body"]) for name in fixture_names]
    client, _, _ = make_client(responses)
    return Fred("key", http=client)


class TestVintagePinning:
    def test_cpiaucsl_2019_06_reads_as_first_published_not_the_later_revision(self):
        fred = fred_for("cpiaucsl_early")
        got = fred.observations("CPIAUCSL", date(2019, 6, 1), date(2019, 6, 1), as_of=date(2019, 7, 20))
        assert got[0].value == 255.305

    def test_cpiaucsl_2019_06_reads_as_revised_at_a_later_vintage(self):
        fred = fred_for("cpiaucsl_revised")
        got = fred.observations("CPIAUCSL", date(2019, 6, 1), date(2019, 6, 1), as_of=date(2024, 3, 1))
        assert got[0].value == 255.213
        assert got[0].value != 255.305  # the real, live-confirmed revision

    def test_unrate_2019_06_also_differs_across_vintages(self):
        early = fred_for("unrate_early").observations(
            "UNRATE", date(2019, 6, 1), date(2019, 6, 1), as_of=date(2019, 8, 1)
        )
        revised = fred_for("unrate_revised").observations(
            "UNRATE", date(2019, 6, 1), date(2019, 6, 1), as_of=date(2021, 2, 1)
        )
        assert early[0].value == 3.7
        assert revised[0].value == 3.6


class TestReleaseDatesFixture:
    def test_release_dates_parse_into_sorted_dates(self):
        release_body = load("cpi_release")["body"]
        dates_body = load("cpi_release_dates")["body"]
        responses = [FakeResponse(200, release_body), FakeResponse(200, dates_body)]
        client, _, _ = make_client(responses)
        fred = Fred("key", http=client)
        got = fred.release_dates("CPIAUCSL")
        assert got == sorted(got)
        assert len(got) == len(dates_body["release_dates"])
```

- [ ] **Step 6: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_fred_fixtures.py`
Expected: `4 passed`.

- [ ] **Step 7: Add the FRED recorder function.** In `scripts/record.py`, replace:

```python
_RECORDERS = {
    "alpaca": record_alpaca,
    "sec": record_sec,
    "sec_jpm": record_jpm_paging,
}
```

with:

```python
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


_RECORDERS = {
    "alpaca": record_alpaca,
    "sec": record_sec,
    "sec_jpm": record_jpm_paging,
    "fred": record_fred,
}
```

- [ ] **Step 8: Add the FRED row.** In `THIRD_PARTY_NOTICES.md`, replace:

```markdown
| `src/ai_trading_common/sec_edgar.py` | `tradingagents/dataflows/vendors/sec_edgar.py` | Kept the CIK-lookup shape, the span classification idea (`_span_index`/`_SPANS`/`_YEAR_TO_DATE`, renamed `_classify_span`/`_SPAN_RANGES`), and the amendment rule ("a period reported more than once takes its latest filing on or before the date"). Changed: returns typed `Fact` rows instead of a rendered statement string or a flattened label map, so a caller picks its own concepts; the point-in-time cut is a separate pure `facts_as_of(facts, as_of)` function instead of being inlined in the fetch; errors map to this package's `ProviderError` hierarchy instead of `NoMarketDataError`/`VendorUnavailableError`; no on-disk cache (the shared `ThrottledClient` has none either); the 8-K Item 2.02 reader (`item_202_filings`, `_parse_item_202`, `eight_k_as_of`) is new, not present upstream |
```

with:

```markdown
| `src/ai_trading_common/sec_edgar.py` | `tradingagents/dataflows/vendors/sec_edgar.py` | Kept the CIK-lookup shape, the span classification idea (`_span_index`/`_SPANS`/`_YEAR_TO_DATE`, renamed `_classify_span`/`_SPAN_RANGES`), and the amendment rule ("a period reported more than once takes its latest filing on or before the date"). Changed: returns typed `Fact` rows instead of a rendered statement string or a flattened label map, so a caller picks its own concepts; the point-in-time cut is a separate pure `facts_as_of(facts, as_of)` function instead of being inlined in the fetch; errors map to this package's `ProviderError` hierarchy instead of `NoMarketDataError`/`VendorUnavailableError`; no on-disk cache (the shared `ThrottledClient` has none either); the 8-K Item 2.02 reader (`item_202_filings`, `_parse_item_202`, `eight_k_as_of`) is new, not present upstream |
| `src/ai_trading_common/fred.py` | `tradingagents/dataflows/vendors/fred.py` | Kept the ALFRED vintage-pinning idea: both `realtime_start` and `realtime_end` set to the as-of date so a past run sees the value as first published. Changed: returns typed `Observation` rows instead of a rendered markdown report; dropped the friendly-alias table, the look-back-day window, and the `pytz`/America-Chicago "FRED's own today" clamp (this client's `as_of` always names a historical date the caller chose, never "now"); errors map to this package's `ProviderError` hierarchy instead of raising bare `ValueError`/a vendor-specific `NotConfiguredError`; adds `release_dates` (new, not present upstream) |
```

- [ ] **Step 9: Run everything and lint.**

Run (in `common/`): `uv run pytest -q -rs && uv run ruff check . && uv run ruff format --check .`
Expected: `111 passed` (96 + 11 + 4), ruff clean, 0 skipped.

- [ ] **Step 10: Commit.**

```bash
git add ai-trading/common/src/ai_trading_common/fred.py ai-trading/common/tests/test_fred.py ai-trading/common/tests/test_fred_fixtures.py ai-trading/common/scripts/record.py ai-trading/common/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): FRED client -- vintage-pinned observations and release dates"
```

---

### Task 2a.5: Finnhub, Alpha Vantage, and Eulerpool clients

**Files:**
- Create: `common/src/ai_trading_common/finnhub.py`, `common/src/ai_trading_common/alphavantage.py`, `common/src/ai_trading_common/eulerpool.py`
- Create: `common/tests/test_finnhub.py`, `common/tests/test_alphavantage.py`, `common/tests/test_eulerpool.py`
- Modify: `common/scripts/record.py`

**Interfaces:**
- Consumes: `ai_trading_common.errors.{NoData, NotConfigured, Unavailable}`, `ai_trading_common.http.ThrottledClient`, `ai_trading_common.testing.{FakeResponse, make_client}` (2a.1).
- Produces (2a.6's `consensus.py` relies on all of these):
  - `ai_trading_common.finnhub.{EarningsCalendarEntry, NewsItem, RecommendationTrend, EarningsSurprise, FinnhubClient, news_as_of}`, with `FinnhubClient(api_key, *, http=None).earnings_calendar(symbol, start, end)`, `.company_news(symbol, start, end)`, `.recommendation_trends(symbol)`, `.earnings_surprises(symbol)`
  - `ai_trading_common.alphavantage.{EpsEstimate, ReportedEarnings, QuotaExceeded, AlphaVantageClient}`, with `AlphaVantageClient(api_key, *, http=None).earnings_estimates(symbol)` and `.earnings(symbol)`
  - `ai_trading_common.eulerpool.{EstimatePeriod, CalendarEntry, EarningsSurprise, Recommendation, EulerpoolClient}`, with `EulerpoolClient(api_key, *, http=None).estimates(symbol)`, `.earnings_calendar(symbol)`, `.earnings_surprises(symbol)`, `.recommendations(symbol)`

Fixture paths used (already committed): `common/tests/fixtures/finnhub/{calendar_earnings_aapl,calendar_earnings_empty,company_news_aapl,company_news_empty,stock_earnings_aapl,stock_recommendation_aapl,bad_key_401}.json`; `common/tests/fixtures/alphavantage/{earnings_estimates_aapl,earnings_aapl,quota_note,unknown_symbol_empty}.json`; `common/tests/fixtures/eulerpool/{estimates_aapl,estimates_empty_brkb,calendar_aapl,surprises_aapl,recommendations_aapl,bad_key_401,unknown_symbol_404,unknown_recommendations_404}.json`.

- [ ] **Step 1: Write the failing Finnhub tests.** `common/tests/test_finnhub.py`:

```python
"""Contract tests against real Finnhub responses recorded by scripts/record.py."""

import json
from datetime import date
from pathlib import Path

import pandas as pd

from ai_trading_common.errors import NoData, NotConfigured
from ai_trading_common.finnhub import FinnhubClient, news_as_of
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent / "fixtures" / "finnhub"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def client_for(name: str, status: int = 200) -> FinnhubClient:
    http, _, _ = make_client([FakeResponse(status, load(name)["body"])])
    return FinnhubClient("key", http=http)


class TestEarningsCalendar:
    def test_parses_a_real_calendar_entry(self):
        client = client_for("calendar_earnings_aapl")
        got = client.earnings_calendar("AAPL", date(2026, 1, 1), date(2026, 12, 31))
        assert got[0].symbol == "AAPL"
        assert got[0].hour == "amc"
        assert got[0].eps_estimate is not None

    def test_empty_calendar_is_no_data(self):
        client = client_for("calendar_earnings_empty")
        try:
            client.earnings_calendar("ZZZZ", date(1990, 1, 1), date(1990, 1, 2))
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")


class TestCompanyNews:
    def test_parses_real_news_items(self):
        client = client_for("company_news_aapl")
        got = client.company_news("AAPL", date(2026, 10, 1), date(2026, 10, 11))
        assert len(got) == 3
        assert got[0].published_at.tzinfo is not None

    def test_empty_window_is_no_data(self):
        client = client_for("company_news_empty")
        try:
            client.company_news("AAPL", date(2026, 10, 12), date(2026, 10, 12))
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")

    def test_news_as_of_drops_anything_published_after_the_cutoff(self):
        client = client_for("company_news_aapl")
        items = client.company_news("AAPL", date(2026, 10, 1), date(2026, 10, 11))
        cutoff = items[-1].published_at
        got = news_as_of(items, cutoff)
        assert all(item.published_at <= cutoff for item in got)
        assert len(got) < len(items)


class TestRecommendationTrends:
    def test_parses_real_counts(self):
        client = client_for("stock_recommendation_aapl")
        got = client.recommendation_trends("AAPL")
        assert got[0].symbol == "AAPL"
        assert got[0].strong_buy >= 0


class TestEarningsSurprises:
    def test_parses_real_surprise_rows(self):
        client = client_for("stock_earnings_aapl")
        got = client.earnings_surprises("AAPL")
        assert got[0].surprise is not None
        assert got[0].surprise_percent is not None


class TestErrors:
    def test_bad_key_is_not_configured(self):
        client = client_for("bad_key_401", status=401)
        try:
            client.earnings_surprises("AAPL")
        except NotConfigured:
            pass
        else:
            raise AssertionError("expected NotConfigured")

    def test_no_key_is_not_configured_without_a_request(self):
        client = FinnhubClient("")
        try:
            client.earnings_surprises("AAPL")
        except NotConfigured:
            pass
        else:
            raise AssertionError("expected NotConfigured")


def test_news_as_of_is_pure_and_order_preserving():
    now = pd.Timestamp("2026-10-11T00:00:00Z")
    client = client_for("company_news_aapl")
    items = client.company_news("AAPL", date(2026, 10, 1), date(2026, 10, 11))
    got = news_as_of(items, now)
    assert got == [item for item in items if item.published_at <= now]
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_finnhub.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.finnhub'`.

- [ ] **Step 3: Implement `finnhub.py`.**

```python
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
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

import pandas as pd

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient

PROVIDER = "finnhub"
BASE = "https://finnhub.io/api/v1"
USER_AGENT = "ai-trading-common/0.1 (+family-desk; https://github.com/thangtran3112/family-app)"
HOST_KEY = "finnhub"

# The free plan allows 60 calls a minute (brief, confirmed by Finnhub's own docs).
MIN_INTERVAL_S = 60.0 / 60.0


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
class NewsItem:
    symbol: str
    headline: str
    source: str
    url: str
    published_at: pd.Timestamp  # UTC


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
            raise NoData(PROVIDER, f"no earnings-calendar entries for {symbol!r} between {start} and {end}")
        return [_to_calendar_entry(r) for r in rows]

    def company_news(self, symbol: str, start: date, end: date) -> list[NewsItem]:
        body = self._get("/company-news", {"symbol": symbol, "from": start.isoformat(), "to": end.isoformat()})
        if not body:
            raise NoData(PROVIDER, f"no news for {symbol!r} between {start} and {end}")
        return [_to_news_item(r) for r in body]

    def recommendation_trends(self, symbol: str) -> list[RecommendationTrend]:
        body = self._get("/stock/recommendation", {"symbol": symbol})
        if not body:
            raise NoData(PROVIDER, f"no recommendation trend for {symbol!r}")
        return [_to_recommendation(r) for r in body]

    def earnings_surprises(self, symbol: str) -> list[EarningsSurprise]:
        body = self._get("/stock/earnings", {"symbol": symbol})
        if not body:
            raise NoData(PROVIDER, f"no earnings surprises for {symbol!r}")
        return [_to_surprise(r) for r in body]

    def _get(self, path: str, params: dict[str, str]) -> Any:
        if not self.api_key:
            raise NotConfigured(PROVIDER, "no API key configured")
        merged = dict(params)
        merged["token"] = self.api_key
        response = self._http.get(
            f"{BASE}{path}",
            provider=PROVIDER,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=merged,
        )
        if response.status_code == 401:
            raise NotConfigured(PROVIDER, "key rejected (HTTP 401)")
        if response.status_code == 403:
            raise NotConfigured(PROVIDER, f"{path} not entitled on this plan (HTTP 403)")
        if response.status_code != 200:
            raise Unavailable(PROVIDER, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER, f"malformed JSON body: {exc}") from exc


def news_as_of(items: list[NewsItem], as_of: pd.Timestamp) -> list[NewsItem]:
    """Only news published at or before `as_of` (02h, Review Focus 6: as-of discipline).

    Pattern from TradingAgents' news handling: "unavailable" (the client call
    itself failing) is kept apart from "no news" (this returning an empty
    list) -- this selector only ever narrows an already-fetched list.
    """
    return [item for item in items if item.published_at <= as_of]


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
        source=row.get("source") or "",
        url=row.get("url") or "",
        published_at=pd.Timestamp(row["datetime"], unit="s", tz="UTC"),
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
```

- [ ] **Step 4: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_finnhub.py`
Expected: `10 passed`.

- [ ] **Step 5: Write the failing Alpha Vantage tests.** `common/tests/test_alphavantage.py`:

```python
"""Contract tests against real Alpha Vantage responses recorded by scripts/record.py."""

import json
from pathlib import Path

from ai_trading_common.alphavantage import AlphaVantageClient, QuotaExceeded
from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent / "fixtures" / "alphavantage"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def client_for(name: str) -> AlphaVantageClient:
    http, _, _ = make_client([FakeResponse(200, load(name)["body"])])
    return AlphaVantageClient("key", http=http)


class TestEarningsEstimates:
    def test_parses_both_fiscal_year_and_fiscal_quarter_rows(self):
        client = client_for("earnings_estimates_aapl")
        got = client.earnings_estimates("AAPL")
        horizons = {row.horizon for row in got}
        assert horizons == {"fiscal year", "fiscal quarter"}

    def test_carries_the_revision_fields(self):
        client = client_for("earnings_estimates_aapl")
        got = client.earnings_estimates("AAPL")
        annual = next(row for row in got if row.horizon == "fiscal year")
        assert annual.eps_mean_7d_ago is not None
        assert annual.eps_mean_30d_ago is not None


class TestEarnings:
    def test_parses_reported_vs_estimated_with_surprise(self):
        client = client_for("earnings_aapl")
        got = client.earnings("AAPL")
        row = got[0]
        assert row.reported_eps is not None
        assert row.estimated_eps is not None
        assert row.surprise is not None
        assert row.report_time in {"pre-market", "post-market", None}


class TestQuotaAndEntitlement:
    def test_rate_limit_note_is_quota_exceeded_and_an_unavailable(self):
        client = client_for("quota_note")
        try:
            client.earnings("AAPL")
        except QuotaExceeded:
            pass
        else:
            raise AssertionError("expected QuotaExceeded")

    def test_quota_exceeded_is_an_unavailable_so_fallback_chains_skip_it(self):
        assert issubclass(QuotaExceeded, Unavailable)

    def test_unknown_symbol_is_no_data(self):
        client = client_for("unknown_symbol_empty")
        try:
            client.earnings("ZZZZINVALIDXYZ")
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")


def test_no_key_is_not_configured_without_a_request():
    client = AlphaVantageClient("")
    try:
        client.earnings("AAPL")
    except NotConfigured:
        pass
    else:
        raise AssertionError("expected NotConfigured")
```

- [ ] **Step 6: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_alphavantage.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.alphavantage'`.

- [ ] **Step 7: Implement `alphavantage.py`.**

```python
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
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pandas as pd

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient

PROVIDER = "alphavantage"
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
            raise NoData(PROVIDER, f"no earnings estimates for {symbol!r}")
        return [_to_eps_estimate(symbol, r) for r in rows]

    def earnings(self, symbol: str) -> list[ReportedEarnings]:
        body = self._get("EARNINGS", symbol)
        rows = body.get("quarterlyEarnings") or []
        if not rows:
            raise NoData(PROVIDER, f"no reported earnings for {symbol!r}")
        return [_to_reported(symbol, r) for r in rows]

    def _get(self, function: str, symbol: str) -> dict[str, Any]:
        if not self.api_key:
            raise NotConfigured(PROVIDER, "no API key configured")
        params = {"function": function, "symbol": symbol, "apikey": self.api_key}
        response = self._http.get(
            BASE,
            provider=PROVIDER,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params=params,
        )
        if response.status_code != 200:
            raise Unavailable(PROVIDER, f"HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER, f"malformed JSON body: {exc}") from exc
        note = body.get("Information") if isinstance(body, dict) else None
        if note:
            lowered = note.lower()
            # Checked before the "premium endpoint" catch-all below: the rate-limit
            # note's own wording also contains "premium endpoints" ("... to lift the
            # free key rate limit ... and instantly unlock all premium endpoints"),
            # so a substring check for that phrase alone would misclassify it.
            if "request" in lowered and ("per second" in lowered or "per day" in lowered):
                raise QuotaExceeded(PROVIDER, "rate limit reached (daily cap or per-second burst; see docstring)")
            if "demo" in lowered:
                raise NotConfigured(PROVIDER, "demo API key is not a real entitlement")
            if "premium endpoint" in lowered:
                raise NotConfigured(PROVIDER, f"{function} not entitled on this plan")
            raise Unavailable(PROVIDER, f"unrecognized Information note: {note!r}")
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
```

- [ ] **Step 8: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_alphavantage.py`
Expected: `7 passed`.

- [ ] **Step 9: Write the failing Eulerpool tests.** `common/tests/test_eulerpool.py`:

```python
"""Contract tests against real Eulerpool responses recorded by scripts/record.py."""

import json
from pathlib import Path

from ai_trading_common.errors import NoData, NotConfigured
from ai_trading_common.eulerpool import EulerpoolClient
from ai_trading_common.testing import FakeResponse, make_client

FIXTURES = Path(__file__).parent / "fixtures" / "eulerpool"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def client_for(name: str, status: int = 200) -> EulerpoolClient:
    http, _, _ = make_client([FakeResponse(status, load(name)["body"])])
    return EulerpoolClient("key", http=http)


class TestEstimates:
    def test_parses_real_estimate_periods(self):
        client = client_for("estimates_aapl")
        got = client.estimates("AAPL")
        assert got[0].eps_mean is not None
        assert got[0].eps_analyst_count is not None

    def test_known_security_with_no_coverage_is_no_data(self):
        # Confirmed live: BRK.B has no analyst EPS-estimate coverage on Eulerpool
        # even though its ticker/ISIN both resolve fine elsewhere (recommendations).
        client = client_for("estimates_empty_brkb")
        try:
            client.estimates("BRK.B")
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")


class TestEarningsCalendar:
    def test_parses_real_calendar_entries(self):
        client = client_for("calendar_aapl")
        got = client.earnings_calendar("AAPL")
        assert got[0].symbol == "AAPL"


class TestEarningsSurprises:
    def test_parses_real_surprise_rows(self):
        client = client_for("surprises_aapl")
        got = client.earnings_surprises("AAPL")
        assert got[0].surprise_percent is not None


class TestRecommendations:
    def test_parses_counts_and_targets_together(self):
        client = client_for("recommendations_aapl")
        got = client.recommendations("AAPL")
        row = got[0]
        assert row.buy >= 0
        assert row.target_mean is not None

    def test_unknown_symbol_is_no_data(self):
        client = client_for("unknown_recommendations_404", status=404)
        try:
            client.recommendations("ZZZZINVALIDXYZ")
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")


class TestErrors:
    def test_bad_key_is_not_configured(self):
        client = client_for("bad_key_401", status=401)
        try:
            client.estimates("AAPL")
        except NotConfigured:
            pass
        else:
            raise AssertionError("expected NotConfigured")

    def test_unknown_security_is_no_data(self):
        client = client_for("unknown_symbol_404", status=404)
        try:
            client.estimates("ZZZZINVALIDXYZ")
        except NoData:
            pass
        else:
            raise AssertionError("expected NoData")

    def test_no_key_is_not_configured_without_a_request(self):
        client = EulerpoolClient("")
        try:
            client.estimates("AAPL")
        except NotConfigured:
            pass
        else:
            raise AssertionError("expected NotConfigured")
```

- [ ] **Step 10: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_eulerpool.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.eulerpool'`.

- [ ] **Step 11: Implement `eulerpool.py`.**

```python
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
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient

PROVIDER = "eulerpool"
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
            raise NoData(PROVIDER, f"no estimates for {symbol!r}")
        return [_to_estimate_period(symbol, r) for r in rows]

    def earnings_calendar(self, symbol: str) -> list[CalendarEntry]:
        rows = self._get(f"/calendar/earnings-by-symbol/{symbol}", not_found=f"no earnings calendar for {symbol!r}")
        if not rows:
            raise NoData(PROVIDER, f"no earnings-calendar entries for {symbol!r}")
        return [_to_calendar_entry(r) for r in rows]

    def earnings_surprises(self, symbol: str) -> list[EarningsSurprise]:
        rows = self._get(f"/calendar/earnings-surprises/{symbol}", not_found=f"no earnings surprises for {symbol!r}")
        if not rows:
            raise NoData(PROVIDER, f"no earnings surprises for {symbol!r}")
        return [_to_surprise(r) for r in rows]

    def recommendations(self, symbol: str) -> list[Recommendation]:
        rows = self._get(f"/research/recommendations/{symbol}", not_found=f"no recommendations for {symbol!r}")
        if not rows:
            raise NoData(PROVIDER, f"no recommendations for {symbol!r}")
        return [_to_recommendation(symbol, r) for r in rows]

    def _get(self, path: str, *, not_found: str) -> Any:
        if not self.api_key:
            raise NotConfigured(PROVIDER, "no API key configured")
        response = self._http.get(
            f"{BASE}{path}",
            provider=PROVIDER,
            host_key=HOST_KEY,
            user_agent=USER_AGENT,
            min_interval=MIN_INTERVAL_S,
            params={"token": self.api_key},
        )
        if response.status_code == 401:
            raise NotConfigured(PROVIDER, "key rejected (HTTP 401)")
        if response.status_code == 404:
            raise NoData(PROVIDER, not_found)
        if response.status_code != 200:
            raise Unavailable(PROVIDER, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Unavailable(PROVIDER, f"malformed JSON body: {exc}") from exc


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
```

- [ ] **Step 12: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_eulerpool.py`
Expected: `9 passed`.

- [ ] **Step 13: Add the Finnhub, Alpha Vantage, and Eulerpool recorder functions.** In `scripts/record.py`, add `import time` next to the existing `import json`/`import os`/`import sys` imports (`record_alphavantage` sleeps between its two calls to respect the free plan's per-second burst limit). Then replace:

```python
_RECORDERS = {
    "alpaca": record_alpaca,
    "sec": record_sec,
    "sec_jpm": record_jpm_paging,
    "fred": record_fred,
}
```

with:

```python
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


_RECORDERS = {
    "alpaca": record_alpaca,
    "sec": record_sec,
    "sec_jpm": record_jpm_paging,
    "fred": record_fred,
    "finnhub": record_finnhub,
    "alphavantage": record_alphavantage,
    "eulerpool": record_eulerpool,
}
```

- [ ] **Step 14: Run everything and lint.**

Run (in `common/`): `uv run pytest -q -rs && uv run ruff check . && uv run ruff format --check .`
Expected: `137 passed` (111 + 10 + 7 + 9), ruff clean, 0 skipped.

- [ ] **Step 15: Add the "no notice needed" section.** Append to `THIRD_PARTY_NOTICES.md`:

```markdown

## No notice needed: `finnhub.py`, `alphavantage.py`, `eulerpool.py`, `consensus.py`

No upstream code is adapted. `finnhub.py`'s `news_as_of` reuses the *idea* of
TradingAgents' news handling -- "unavailable" (the client call itself
failing) kept apart from "no news" (an empty, successfully-fetched list) --
with no code copied, so per the brief ("A 'pattern' reuse ... needs no
notice") this file carries no entry.

`finnhub.py`, `alphavantage.py`, `eulerpool.py`, and `consensus.py` are all
written fresh against each provider's own public API documentation
(Finnhub's and Alpha Vantage's official docs; Eulerpool's
`https://eulerpool.com/llms-full.txt` endpoint reference, since the
marketing/docs site itself returns HTTP 403 to a non-browser `GET`).
```

- [ ] **Step 16: Commit.**

```bash
git add ai-trading/common/src/ai_trading_common/finnhub.py ai-trading/common/src/ai_trading_common/alphavantage.py ai-trading/common/src/ai_trading_common/eulerpool.py ai-trading/common/tests/test_finnhub.py ai-trading/common/tests/test_alphavantage.py ai-trading/common/tests/test_eulerpool.py ai-trading/common/scripts/record.py ai-trading/common/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): Finnhub, Alpha Vantage, and Eulerpool consensus-EPS clients"
```

---

### Task 2a.6: `consensus.py`, and folding the pilot into 02d

**Files:**
- Create: `common/src/ai_trading_common/consensus.py`
- Create: `common/tests/test_consensus.py`
- Modify: `common/scripts/record.py`
- Modify: `common/tests/fixtures/eulerpool/calendar_aapl.json` (re-recorded; see "Fixture note" below)
- Modify: `ai-trading/plans/subplans/02d-desk-spike-results.md`

**Interfaces:**
- Consumes: `ai_trading_common.fallback.first_success` (2a.1), `ai_trading_common.finnhub.{EarningsSurprise, FinnhubClient}` (2a.5), `ai_trading_common.alphavantage.{AlphaVantageClient, EpsEstimate, ReportedEarnings}` (2a.5), `ai_trading_common.eulerpool.{CalendarEntry, EarningsSurprise, EulerpoolClient}` (2a.5).
- Produces: `ai_trading_common.consensus.{ConsensusSnapshot, EarningsResult, AnalystTargets, consensus_snapshots, earnings_results, analyst_targets}`, used directly by Phase 3's daily snapshot job (not built here).

**Fixture note (nothing to record in this task):** `common/tests/fixtures/eulerpool/calendar_aapl.json` was re-recorded after the plan review and the new version is already committed (`c602b52`, superseding the `ae6ec0f` copy); 2a.5's tests pass on it too. Why — the originally committed sample only covered AAPL's 2001–2002 earnings calendar, with no overlap against `surprises_aapl.json`'s 2025–2026 window, so the fixture-based merge test below (Step 1, `test_fixture_calendar_and_surprises_merge_into_one_row_per_period_with_both_dates_right`) had nothing real to join. Re-recorded live (`GET /calendar/earnings-by-symbol/AAPL`) and trimmed to 7 rows: the original two oldest rows (2001-07-17, 2001-10-17, kept for the "unmatched calendar row" shape) plus the four report dates that cover `surprises_aapl.json`'s four periods (2025-10-30, 2026-01-29, 2026-04-29, 2026-07-30) and the upcoming undated-actual entry (2026-11-02). No secrets in the body (the key travels in the query string, already stripped by `scripts/record.py`'s `_strip_secrets`).

- [ ] **Step 1: Write the failing tests.** `common/tests/test_consensus.py`:

```python
"""Unit tests for the fallback chains in consensus.py.

Uses small fake clients (not fixture-driven HTTP) so the precedence and
per-field composition rules are pinned independently of any one provider's
real response shape; test_eulerpool.py/test_finnhub.py/test_alphavantage.py
already cover each client's own parsing against real fixtures.
"""

from datetime import date, timedelta

import pandas as pd
import pytest

from ai_trading_common.consensus import analyst_targets, consensus_snapshots, earnings_results
from ai_trading_common.errors import NoData, NotConfigured, Unavailable

NOW = pd.Timestamp("2026-10-11T21:00:00Z")


class FakeEulerpool:
    def __init__(self, *, estimates=None, calendar=None, surprises=None, recommendations=None, raises=None):
        self._estimates, self._calendar, self._surprises, self._recommendations = (
            estimates,
            calendar,
            surprises,
            recommendations,
        )
        self._raises = raises

    def estimates(self, symbol):
        if self._raises:
            raise self._raises
        return self._estimates

    def earnings_calendar(self, symbol):
        if self._raises:
            raise self._raises
        return self._calendar

    def earnings_surprises(self, symbol):
        if self._raises:
            raise self._raises
        return self._surprises

    def recommendations(self, symbol):
        if self._raises:
            raise self._raises
        return self._recommendations


class FakeFinnhub:
    def __init__(self, *, surprises=None, recommendations=None, raises=None):
        self._surprises, self._recommendations, self._raises = surprises, recommendations, raises

    def earnings_surprises(self, symbol):
        if self._raises:
            raise self._raises
        return self._surprises

    def recommendation_trends(self, symbol):
        if self._raises:
            raise self._raises
        return self._recommendations


class FakeAlphaVantage:
    def __init__(self, *, estimates=None, earnings=None, raises=None):
        self._estimates, self._earnings, self._raises = estimates, earnings, raises

    def earnings_estimates(self, symbol):
        if self._raises:
            raise self._raises
        return self._estimates

    def earnings(self, symbol):
        if self._raises:
            raise self._raises
        return self._earnings


def eulerpool_estimate_row(eps_mean=5.0, quarter=1):
    from ai_trading_common.eulerpool import EstimatePeriod

    return EstimatePeriod(
        symbol="AAPL",
        period_end=date(2026, 12, 31),
        fiscal_year=2026,
        fiscal_quarter=quarter,
        eps_mean=eps_mean,
        eps_high=eps_mean + 1,
        eps_low=eps_mean - 1,
        eps_analyst_count=10,
        revenue_mean=None,
        revenue_high=None,
        revenue_low=None,
        revenue_analyst_count=None,
    )


def av_estimate_row():
    from ai_trading_common.alphavantage import EpsEstimate

    return EpsEstimate(
        symbol="AAPL",
        period_end=pd.Timestamp("2026-12-31"),
        horizon="fiscal quarter",
        fiscal_year=2026,
        fiscal_quarter=4,
        eps_mean=4.5,
        eps_high=5.0,
        eps_low=4.0,
        analyst_count=8,
        eps_mean_7d_ago=4.4,
        eps_mean_30d_ago=4.3,
        eps_mean_60d_ago=None,
        eps_mean_90d_ago=None,
        revisions_up_7d=2,
        revisions_down_7d=0,
        revisions_up_30d=3,
        revisions_down_30d=1,
    )


def finnhub_recommendation_row():
    from ai_trading_common.finnhub import RecommendationTrend

    return RecommendationTrend(
        symbol="AAPL", period=date(2026, 9, 1), strong_buy=10, buy=20, hold=5, sell=1, strong_sell=0
    )


def eulerpool_recommendation_row():
    from ai_trading_common.eulerpool import Recommendation

    return Recommendation(
        symbol="AAPL",
        period=date(2026, 9, 1),
        strong_buy=12,
        buy=22,
        hold=15,
        sell=3,
        strong_sell=1,
        target_mean=340.72,
        target_median=360,
        target_high=400,
        target_low=245,
    )


class TestConsensusSnapshotsFallback:
    def test_eulerpool_primary_keeps_eod_quality(self):
        euler = FakeEulerpool(estimates=[eulerpool_estimate_row()])
        got = consensus_snapshots("AAPL", eulerpool=euler, alphavantage=None, now=NOW)
        assert got[0].quality == "eod"
        assert got[0].provider == "eulerpool"

    def test_alphavantage_fallback_is_relabeled(self):
        euler = FakeEulerpool(raises=Unavailable("eulerpool", "down"))
        av = FakeAlphaVantage(estimates=[av_estimate_row()])
        got = consensus_snapshots("AAPL", eulerpool=euler, alphavantage=av, now=NOW)
        assert got[0].quality == "fallback"
        assert got[0].provider == "alphavantage"

    def test_a_transient_failure_beats_a_later_no_data(self):
        euler = FakeEulerpool(raises=Unavailable("eulerpool", "down"))
        av = FakeAlphaVantage(raises=NoData("alphavantage", "none"))
        with pytest.raises(Unavailable):
            consensus_snapshots("AAPL", eulerpool=euler, alphavantage=av, now=NOW)

    def test_both_no_data_raises_no_data(self):
        euler = FakeEulerpool(raises=NoData("eulerpool", "none"))
        av = FakeAlphaVantage(raises=NoData("alphavantage", "none"))
        with pytest.raises(NoData):
            consensus_snapshots("AAPL", eulerpool=euler, alphavantage=av, now=NOW)


class TestEarningsResultsFallback:
    def test_eulerpool_merges_calendar_and_surprises_by_period(self):
        # The calendar's date is the report date; the surprise's date is the fiscal period end
        # that report covers -- the two must stay distinct fields on the merged row, not collapse
        # onto each other (the bug this test was rewritten to catch).
        from ai_trading_common.eulerpool import CalendarEntry, EarningsSurprise

        calendar = [
            CalendarEntry(
                symbol="AAPL",
                report_date=date(2026, 7, 30),
                eps_estimate=1.9,
                eps_actual=2.02,
                revenue_estimate=None,
                revenue_actual=None,
            )
        ]
        surprises = [
            EarningsSurprise(
                symbol="AAPL",
                period_end=date(2026, 6, 30),
                fiscal_year=2026,
                fiscal_quarter=3,
                eps_estimate=1.9,
                eps_actual=2.02,
                eps_difference=0.12,
                surprise_percent=6.3,
            )
        ]
        euler = FakeEulerpool(calendar=calendar, surprises=surprises)
        got = earnings_results("AAPL", eulerpool=euler, finnhub=None, alphavantage=None, now=NOW)
        assert len(got) == 1
        assert got[0].period_end == date(2026, 6, 30)
        assert got[0].report_date == date(2026, 7, 30)
        assert got[0].surprise == 0.12
        assert got[0].fiscal_quarter == 3

    def test_fixture_calendar_and_surprises_merge_into_one_row_per_period_with_both_dates_right(self):
        """Real recorded AAPL data: the calendar's report dates and the surprise history's period
        ends genuinely differ (a report lands about a month after its own period end), so this
        pins the join against real-world data, not just a hand-built example."""
        from pathlib import Path

        from ai_trading_common.eulerpool import EulerpoolClient
        from ai_trading_common.testing import FakeResponse, make_client

        fixtures = Path(__file__).parent / "fixtures" / "eulerpool"

        def load(name: str) -> dict:
            import json

            return json.loads((fixtures / f"{name}.json").read_text())

        client, _, _ = make_client(
            [FakeResponse(200, load("calendar_aapl")["body"]), FakeResponse(200, load("surprises_aapl")["body"])]
        )
        euler = EulerpoolClient("key", http=client)
        got = earnings_results("AAPL", eulerpool=euler, finnhub=None, alphavantage=None, now=NOW)

        matched = {r.period_end: r for r in got if r.period_end is not None}
        assert matched[date(2026, 6, 30)].report_date == date(2026, 7, 30)
        assert matched[date(2026, 3, 31)].report_date == date(2026, 4, 29)
        assert matched[date(2025, 12, 31)].report_date == date(2026, 1, 29)
        assert matched[date(2025, 9, 30)].report_date == date(2025, 10, 30)
        assert len(matched) == 4  # every recorded surprise row found its report

    def test_an_unmatched_surprise_has_no_report_date(self):
        from ai_trading_common.eulerpool import EarningsSurprise

        surprises = [
            EarningsSurprise(
                symbol="AAPL",
                period_end=date(2020, 6, 30),  # far older than any calendar row recorded here
                fiscal_year=2020,
                fiscal_quarter=3,
                eps_estimate=1.0,
                eps_actual=1.1,
                eps_difference=0.1,
                surprise_percent=10.0,
            )
        ]
        euler = FakeEulerpool(calendar=[], surprises=surprises)
        got = earnings_results("AAPL", eulerpool=euler, finnhub=None, alphavantage=None, now=NOW)
        assert len(got) == 1
        assert got[0].period_end == date(2020, 6, 30)
        assert got[0].report_date is None

    def test_an_unmatched_calendar_row_has_no_period_end(self):
        from ai_trading_common.eulerpool import CalendarEntry

        calendar = [
            CalendarEntry(
                symbol="AAPL",
                report_date=date(2001, 7, 17),  # the oldest recorded row: no surprise reaches back this far
                eps_estimate=0.0028,
                eps_actual=0.003,
                revenue_estimate=None,
                revenue_actual=None,
            )
        ]
        euler = FakeEulerpool(calendar=calendar, surprises=[])
        got = earnings_results("AAPL", eulerpool=euler, finnhub=None, alphavantage=None, now=NOW)
        assert len(got) == 1
        assert got[0].period_end is None
        assert got[0].report_date == date(2001, 7, 17)

    def test_the_90_day_join_window_boundary(self):
        from ai_trading_common.eulerpool import CalendarEntry, EarningsSurprise

        period_end = date(2026, 6, 30)
        surprises = [
            EarningsSurprise(
                symbol="AAPL",
                period_end=period_end,
                fiscal_year=2026,
                fiscal_quarter=3,
                eps_estimate=1.9,
                eps_actual=2.02,
                eps_difference=0.12,
                surprise_percent=6.3,
            )
        ]
        at_the_boundary = [
            CalendarEntry(
                symbol="AAPL",
                report_date=period_end + timedelta(days=90),  # exactly 90 days: must match
                eps_estimate=1.9,
                eps_actual=2.02,
                revenue_estimate=None,
                revenue_actual=None,
            )
        ]
        past_the_boundary = [
            CalendarEntry(
                symbol="AAPL",
                report_date=period_end + timedelta(days=91),  # one day past: must not match
                eps_estimate=1.9,
                eps_actual=2.02,
                revenue_estimate=None,
                revenue_actual=None,
            )
        ]

        matched = earnings_results(
            "AAPL",
            eulerpool=FakeEulerpool(calendar=at_the_boundary, surprises=surprises),
            finnhub=None,
            alphavantage=None,
            now=NOW,
        )
        assert len(matched) == 1
        assert matched[0].report_date == period_end + timedelta(days=90)

        unmatched = earnings_results(
            "AAPL",
            eulerpool=FakeEulerpool(calendar=past_the_boundary, surprises=surprises),
            finnhub=None,
            alphavantage=None,
            now=NOW,
        )
        assert len(unmatched) == 2  # the surprise and the calendar row both stay unmatched
        assert all(r.report_date is None for r in unmatched if r.period_end == period_end)

    def test_finnhub_tried_before_alphavantage(self):
        from ai_trading_common.finnhub import EarningsSurprise as FinnhubSurprise

        euler = FakeEulerpool(raises=Unavailable("eulerpool", "down"))
        finnhub = FakeFinnhub(
            surprises=[
                FinnhubSurprise(
                    symbol="AAPL",
                    period_end=date(2026, 7, 30),
                    fiscal_year=2026,
                    fiscal_quarter=3,
                    eps_estimate=1.9,
                    eps_actual=2.02,
                    surprise=0.12,
                    surprise_percent=6.3,
                )
            ]
        )
        av = FakeAlphaVantage(raises=AssertionError("should not be reached"))
        got = earnings_results("AAPL", eulerpool=euler, finnhub=finnhub, alphavantage=av, now=NOW)
        assert got[0].provider == "finnhub"
        assert got[0].quality == "fallback"


class TestAnalystTargetsFallback:
    def test_eulerpool_primary_carries_targets_and_counts(self):
        euler = FakeEulerpool(recommendations=[eulerpool_recommendation_row()])
        got = analyst_targets("AAPL", eulerpool=euler, finnhub=None, now=NOW)
        assert got.quality == "eod"
        assert got.target_mean == 340.72
        assert got.buy == 22

    def test_finnhub_fallback_has_counts_but_no_targets(self):
        euler = FakeEulerpool(raises=Unavailable("eulerpool", "down"))
        finnhub = FakeFinnhub(recommendations=[finnhub_recommendation_row()])
        got = analyst_targets("AAPL", eulerpool=euler, finnhub=finnhub, now=NOW)
        assert got.quality == "fallback"
        assert got.provider == "finnhub"
        assert got.buy == 20
        assert got.target_mean is None
        assert got.target_high is None

    def test_not_configured_falls_through_like_unavailable(self):
        euler = FakeEulerpool(raises=NotConfigured("eulerpool", "no key"))
        finnhub = FakeFinnhub(recommendations=[finnhub_recommendation_row()])
        got = analyst_targets("AAPL", eulerpool=euler, finnhub=finnhub, now=NOW)
        assert got.provider == "finnhub"
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `common/`): `uv run pytest -q tests/test_consensus.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading_common.consensus'`.

- [ ] **Step 3: Implement `consensus.py`.**

```python
"""Normalized consensus-EPS types and the Eulerpool-then-Finnhub/AV fallback chain.

02f §4 needs three things per symbol: EPS estimates by quarter/fiscal-year
with analyst counts (`ConsensusSnapshot`), reported-vs-estimated results
with surprise and the next earnings date (`EarningsResult`), and analyst
rating counts with the low/mean/high target (`AnalystTargets`). Each carries
its `provider` and `as_of` (02h, Review Focus 6: an as-of discipline, since
a consensus number is a point-in-time snapshot, not a live value) and a
`Quality` label (`eod` for a primary-source snapshot, `fallback` for a
secondary one -- never `realtime`/`delayed-15m`, which describe market
data, not a once-a-day consensus figure).

**Fallback granularity, decided per data class, not uniformly:**

- `ConsensusSnapshot` and `EarningsResult` fall back *per whole record set*:
  Eulerpool primary, Alpha Vantage (for estimates) or Finnhub-then-Alpha-
  Vantage (for results) secondary -- the same whole-response relabeling
  `fallback.with_fallback` already does for bars, just not reusing that
  function directly (it is typed to `Bars`; see "possible core change" below).
- `AnalystTargets` falls back *per field group*, because no single secondary
  provider can replace Eulerpool for it: Finnhub's free `stock/recommendation`
  has the buy/hold/sell counts but not a target price (`stock/price-target`
  is premium, confirmed live), and Alpha Vantage's only target field
  (`OVERVIEW`'s `AnalystTargetPrice`) is itself premium-gated on this
  lane's key (confirmed live). A Finnhub-sourced fallback therefore carries
  real counts and `None` targets, rather than refusing the whole record or
  inventing a target -- 02f §4's own prediction for this path ("Analyst
  targets are then unavailable"), scoped to the target fields specifically,
  not the whole type.

Uses the shared `ai_trading_common.fallback.first_success` for the chaining
precedence (a transient failure anywhere in the chain is reported ahead of a
`NoData` collected from another provider) -- promoted there from this
module per the controller's ruling, so a bars fallback chain and this one
share the same primitive instead of each re-deriving it.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import date, timedelta

import pandas as pd

from ai_trading_common.alphavantage import AlphaVantageClient, EpsEstimate, ReportedEarnings
from ai_trading_common.eulerpool import CalendarEntry, EulerpoolClient
from ai_trading_common.eulerpool import EarningsSurprise as EulerpoolSurprise
from ai_trading_common.fallback import first_success
from ai_trading_common.finnhub import EarningsSurprise as FinnhubSurprise
from ai_trading_common.finnhub import FinnhubClient
from ai_trading_common.quality import Quality


@dataclass(frozen=True)
class ConsensusSnapshot:
    symbol: str
    period_end: date
    period_kind: str  # "quarter" | "annual"
    fiscal_year: int | None
    fiscal_quarter: int | None
    eps_mean: float | None
    eps_high: float | None
    eps_low: float | None
    analyst_count: int | None
    provider: str
    quality: Quality
    as_of: pd.Timestamp


@dataclass(frozen=True)
class EarningsResult:
    symbol: str
    period_end: date | None  # None for a calendar row never joined to a surprise (see _merge_by_period)
    fiscal_year: int | None
    fiscal_quarter: int | None
    report_date: date | None
    report_time: str | None
    eps_estimate: float | None
    eps_actual: float | None
    surprise: float | None
    surprise_percent: float | None
    provider: str
    quality: Quality
    as_of: pd.Timestamp


@dataclass(frozen=True)
class AnalystTargets:
    symbol: str
    target_mean: float | None
    target_median: float | None
    target_high: float | None
    target_low: float | None
    strong_buy: int | None
    buy: int | None
    hold: int | None
    sell: int | None
    strong_sell: int | None
    provider: str
    quality: Quality
    as_of: pd.Timestamp


# ---- Eulerpool adapters ----------------------------------------------------


def _from_eulerpool_estimate(row, *, as_of: pd.Timestamp) -> ConsensusSnapshot:
    return ConsensusSnapshot(
        symbol=row.symbol,
        period_end=row.period_end,
        period_kind="quarter" if row.fiscal_quarter else "annual",
        fiscal_year=row.fiscal_year,
        fiscal_quarter=row.fiscal_quarter,
        eps_mean=row.eps_mean,
        eps_high=row.eps_high,
        eps_low=row.eps_low,
        analyst_count=row.eps_analyst_count,
        provider="eulerpool",
        quality="eod",
        as_of=as_of,
    )


def _from_eulerpool_calendar(row: CalendarEntry, *, as_of: pd.Timestamp) -> EarningsResult:
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
        provider="eulerpool",
        quality="eod",
        as_of=as_of,
    )


def _from_eulerpool_surprise(row: EulerpoolSurprise, *, as_of: pd.Timestamp) -> EarningsResult:
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
        provider="eulerpool",
        quality="eod",
        as_of=as_of,
    )


def _from_eulerpool_recommendation(row, *, as_of: pd.Timestamp) -> AnalystTargets:
    return AnalystTargets(
        symbol=row.symbol,
        target_mean=row.target_mean,
        target_median=row.target_median,
        target_high=row.target_high,
        target_low=row.target_low,
        strong_buy=row.strong_buy,
        buy=row.buy,
        hold=row.hold,
        sell=row.sell,
        strong_sell=row.strong_sell,
        provider="eulerpool",
        quality="eod",
        as_of=as_of,
    )


# ---- Alpha Vantage adapters -------------------------------------------------


def _from_av_estimate(row: EpsEstimate, *, as_of: pd.Timestamp) -> ConsensusSnapshot:
    return ConsensusSnapshot(
        symbol=row.symbol,
        period_end=row.period_end.date(),
        period_kind="annual" if row.horizon == "fiscal year" else "quarter",
        fiscal_year=row.fiscal_year,
        fiscal_quarter=row.fiscal_quarter,
        eps_mean=row.eps_mean,
        eps_high=row.eps_high,
        eps_low=row.eps_low,
        analyst_count=row.analyst_count,
        provider="alphavantage",
        quality="fallback",
        as_of=as_of,
    )


def _from_av_reported(row: ReportedEarnings, *, as_of: pd.Timestamp) -> EarningsResult:
    return EarningsResult(
        symbol=row.symbol,
        period_end=row.fiscal_date_ending.date(),
        fiscal_year=row.fiscal_date_ending.year,
        fiscal_quarter=row.fiscal_date_ending.quarter,
        report_date=row.reported_date.date() if row.reported_date is not None else None,
        report_time=row.report_time,
        eps_estimate=row.estimated_eps,
        eps_actual=row.reported_eps,
        surprise=row.surprise,
        surprise_percent=row.surprise_percent,
        provider="alphavantage",
        quality="fallback",
        as_of=as_of,
    )


# ---- Finnhub adapters --------------------------------------------------


def _from_finnhub_surprise(row: FinnhubSurprise, *, as_of: pd.Timestamp) -> EarningsResult:
    return EarningsResult(
        symbol=row.symbol,
        period_end=row.period_end,
        fiscal_year=row.fiscal_year,
        fiscal_quarter=row.fiscal_quarter,
        report_date=row.period_end,
        report_time=None,
        eps_estimate=row.eps_estimate,
        eps_actual=row.eps_actual,
        surprise=row.surprise,
        surprise_percent=row.surprise_percent,
        provider="finnhub",
        quality="fallback",
        as_of=as_of,
    )


def _from_finnhub_recommendation(row, *, as_of: pd.Timestamp) -> AnalystTargets:
    """Counts only: Finnhub's free plan has no price-target endpoint (confirmed live)."""
    return AnalystTargets(
        symbol=row.symbol,
        target_mean=None,
        target_median=None,
        target_high=None,
        target_low=None,
        strong_buy=row.strong_buy,
        buy=row.buy,
        hold=row.hold,
        sell=row.sell,
        strong_sell=row.strong_sell,
        provider="finnhub",
        quality="fallback",
        as_of=as_of,
    )


# ---- Fallback chains --------------------------------------------------


def consensus_snapshots(
    symbol: str,
    *,
    eulerpool: EulerpoolClient | None,
    alphavantage: AlphaVantageClient | None,
    now: pd.Timestamp,
) -> list[ConsensusSnapshot]:
    """EPS estimates by period. Eulerpool primary; Alpha Vantage secondary.

    Finnhub is not in this chain: its one source of consensus EPS
    mean/high/low, `/stock/eps-estimate`, is premium-gated on the free plan
    (confirmed live).
    """
    calls: list[Callable[[], list[ConsensusSnapshot]]] = []
    if eulerpool is not None:
        calls.append(lambda: [_from_eulerpool_estimate(r, as_of=now) for r in eulerpool.estimates(symbol)])
    if alphavantage is not None:
        calls.append(lambda: [_from_av_estimate(r, as_of=now) for r in alphavantage.earnings_estimates(symbol)])
    result, is_primary = first_success(calls)
    return result if is_primary else [replace(r, quality="fallback") for r in result]


def earnings_results(
    symbol: str,
    *,
    eulerpool: EulerpoolClient | None,
    finnhub: FinnhubClient | None,
    alphavantage: AlphaVantageClient | None,
    now: pd.Timestamp,
) -> list[EarningsResult]:
    """Reported-vs-estimated results with surprise, and the next earnings date.

    Eulerpool primary (its earnings-calendar and earnings-surprises
    endpoints, merged); Finnhub then Alpha Vantage secondary (both serve
    quarterly surprises free; the brief's order, 02f §4).
    """

    def from_eulerpool() -> list[EarningsResult]:
        calendar = [_from_eulerpool_calendar(r, as_of=now) for r in eulerpool.earnings_calendar(symbol)]
        surprises = [_from_eulerpool_surprise(r, as_of=now) for r in eulerpool.earnings_surprises(symbol)]
        return _merge_by_period(calendar, surprises)

    calls: list[Callable[[], list[EarningsResult]]] = []
    if eulerpool is not None:
        calls.append(from_eulerpool)
    if finnhub is not None:
        calls.append(lambda: [_from_finnhub_surprise(r, as_of=now) for r in finnhub.earnings_surprises(symbol)])
    if alphavantage is not None:
        calls.append(lambda: [_from_av_reported(r, as_of=now) for r in alphavantage.earnings(symbol)])
    result, is_primary = first_success(calls)
    return result if is_primary else [replace(r, quality="fallback") for r in result]


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


def analyst_targets(
    symbol: str,
    *,
    eulerpool: EulerpoolClient | None,
    finnhub: FinnhubClient | None,
    now: pd.Timestamp,
) -> AnalystTargets:
    """Rating counts and the low/mean/high target. Eulerpool primary.

    A Finnhub fallback carries real buy/hold/sell counts but `None` targets
    (see module docstring) -- it is not folded into `first_success`,
    because it is a partial substitute, not an equally-complete alternative.
    """

    def from_eulerpool() -> AnalystTargets:
        rows = eulerpool.recommendations(symbol)
        return _from_eulerpool_recommendation(max(rows, key=lambda r: r.period), as_of=now)

    def from_finnhub() -> AnalystTargets:
        rows = finnhub.recommendation_trends(symbol)
        return _from_finnhub_recommendation(max(rows, key=lambda r: r.period), as_of=now)

    calls: list[Callable[[], AnalystTargets]] = []
    if eulerpool is not None:
        calls.append(from_eulerpool)
    if finnhub is not None:
        calls.append(from_finnhub)
    result, is_primary = first_success(calls)
    return result if is_primary else replace(result, quality="fallback")
```

- [ ] **Step 4: Run it and watch it pass.**

Run (in `common/`): `uv run pytest -q tests/test_consensus.py`
Expected: `13 passed`.

- [ ] **Step 5: Add the dividends probe recorder.** In `scripts/record.py`, replace:

```python
_RECORDERS = {
    "alpaca": record_alpaca,
    "sec": record_sec,
    "sec_jpm": record_jpm_paging,
    "fred": record_fred,
    "finnhub": record_finnhub,
    "alphavantage": record_alphavantage,
    "eulerpool": record_eulerpool,
}
```

with:

```python
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
```

This probe is run once, by hand, against the owner's real key, and never writes a fixture; its output (not re-run as part of this task's own verification) is folded into 02d by Step 7 below, since it was already run live during the prototype (see "Eulerpool dividends finding" in `REPORT-FINAL.md`).

- [ ] **Step 6: Run everything and lint, confirming the full common suite.**

Run (in `common/`): `uv run pytest -q -rs && uv run ruff check . && uv run ruff format --check .`
Expected: `150 passed` (137 + 13), ruff clean, 0 skipped. This is common's final count for Phase 2a.

- [ ] **Step 7: Fold the pilot result into 02d.** In `ai-trading/plans/subplans/02d-desk-spike-results.md`, append a new numbered finding after finding 9 ("Paper account ID prefix") and before "## Notes for Phase 3 (from the documentation research)". Replace:

```markdown
### 9. Paper account ID prefix

**Status:** pending the probe (`paper`, `accounts`). The docs say paper accounts start with `DU`.

**Decision:** the guard value stays `DU` unless the probe shows otherwise.

## Notes for Phase 3 (from the documentation research)
```

with:

```markdown
### 9. Paper account ID prefix

**Status:** pending the probe (`paper`, `accounts`). The docs say paper accounts start with `DU`.

**Decision:** the guard value stays `DU` unless the probe shows otherwise.

### 10. Consensus EPS: the Eulerpool 10-symbol pilot (Phase 2a)

**Status: done.** Eulerpool, Finnhub, and (for 5 of the 10 symbols) Alpha Vantage were called live
across AAPL, MSFT, NVDA, AMZN, GOOGL, JPM, KO, XOM, BRK.B, and RGR (Sturm Ruger, the "one small
cap" symbol) — `estimates`, `earnings-by-symbol`, `earnings-surprises`, and `recommendations` on
Eulerpool; earnings surprises and recommendation trends on Finnhub; `EARNINGS_ESTIMATES` on Alpha
Vantage, replayed from bodies the same session had already fetched live rather than spending
additional daily quota.

**From the pilot:**
- Eulerpool covered 39 of 40 data-class checks (10 symbols × 4 classes). The one gap — BRK.B's
  (and BRK.A's) EPS estimates — is a genuine real-world coverage gap, confirmed empty live:
  Berkshire does not have an analyst EPS-estimate consensus the way an operating company does.
  Its earnings calendar, surprises, and recommendations/targets still have Berkshire covered.
- Alpha Vantage's `EARNINGS_ESTIMATES` agreed with Eulerpool's nearest-fiscal-year EPS mean within
  0.1–0.8% for all 5 compared symbols (AAPL 0.3%, MSFT 0.1%, NVDA 0.4%, AMZN 0.8%, GOOGL 0.1%),
  the cross-check 02f §4 asked for.
- Finnhub's `stock/recommendation` (buy/hold/sell trend counts) is free on this key — the research
  notes behind 02b/02f had marked it unverified/pessimistic; this is what gives `AnalystTargets` a
  fallback with real counts (if not a target price) when Eulerpool is down.

**Decision:** **Eulerpool is the consensus-EPS primary**, matching 02f §4's own call. Alpha Vantage
is kept as the `ConsensusSnapshot`/`EarningsResult` fallback; Finnhub is kept as the
`AnalystTargets` fallback (counts only, no target price — see Task 2a.6's module docstring for
`consensus.py`). Method and result recorded here per the brief; the pilot script and its replayed
response bodies are not committed (temp-only prototype artifacts).

### 11. Eulerpool ex-dividend dates (Phase 2a probe, for Phase 5)

**Status: done**, report-only. Probed live (`GET /equity/dividends/{id}`, `/equity/dividend-
quality/{id}`, `/equity/dividends-by-fy/{id}`, via `scripts/record.py eulerpool_dividends_probe`):

| Endpoint | HTTP | Shape |
|---|---|---|
| `/equity/dividends/{id}` | 200 | Full per-payment history: `payDate` and `period`, neither explicitly labeled "ex-dividend" |
| `/equity/dividend-quality/{id}` | 200 | A summary with an explicit `lastExDate` (confirmed live for AAPL), plus `yearsPaid`/`yearsNotDecreased`/`frequency`/`dividendYield` |
| `/equity/dividends-by-fy/{id}` | 200 | Dividends grouped by fiscal year, no per-event dates |

**Decision:** `/equity/dividend-quality/{identifier}`'s `lastExDate` is a free, confirmed path to
*the most recent* ex-dividend date — not a full history. Phase 5 either uses it directly, or
resolves `/equity/dividends`'s `period` field against a known dividend calendar first if a full
ex-dividend history is wanted; IBKR's dividends tick (2b) is the other option. No client is built
in Phase 2a (ruling D10): this is a report-only finding.

## Notes for Phase 3 (from the documentation research)
```

- [ ] **Step 8: Commit.**

```bash
git add ai-trading/common/src/ai_trading_common/consensus.py ai-trading/common/tests/test_consensus.py ai-trading/common/scripts/record.py ai-trading/common/tests/fixtures/eulerpool/calendar_aapl.json ai-trading/plans/subplans/02d-desk-spike-results.md
git commit -m "feat(ai-trading): consensus-EPS normalized types and fallback chains; fold the Eulerpool pilot into 02d"
```

---

### Task 2a.7: The Desk database

**Files:**
- Modify: `packages/family-desk/backend/pyproject.toml`
- Create: `packages/family-desk/backend/alembic.ini`
- Create: `packages/family-desk/backend/src/ai_trading/db/__init__.py`, `.../db/engine.py`, `.../db/models.py`
- Create: `packages/family-desk/backend/src/ai_trading/db/migrations/env.py`, `.../migrations/script.py.mako`, `.../migrations/versions/0001_bars_and_futures_rolls.py`
- Create: `packages/family-desk/backend/tests/conftest.py`, `.../tests/test_db_migrations.py`
- Create: `packages/family-desk/backend/scripts/test-db.sh`
- Modify: `.github/workflows/ai-trading-ci.yml`

**Interfaces:**
- Consumes: nothing new from `ai_trading_common` yet (added to `pyproject.toml` for Task 2a.8, not imported here).
- Produces (2a.8 relies on all of these):
  - `ai_trading.db.{make_engine, make_session_factory, session_scope}`
  - `ai_trading.db.models.{Base, Bar1d, Bar1h, Bar1m, FuturesRoll}`
  - the `db_engine` (session-scoped) and `db_session` (function-scoped, truncates `bars_1d`/`bars_1h`/`bars_1m`/`futures_rolls` between tests) pytest fixtures in `tests/conftest.py`, available to every later test file with no import needed

- [ ] **Step 1: Add the new dependencies.** In `backend/pyproject.toml`, replace:

```toml
dependencies = [
    "exchange-calendars>=4.13",
    "numpy>=2.2",
    "pandas>=2.3",
    "pydantic>=2.12",
]
```

with:

```toml
dependencies = [
    "ai-trading-common",
    "alembic>=1.13",
    "exchange-calendars>=4.13",
    "numpy>=2.2",
    "pandas>=2.3",
    "psycopg[binary]>=3.1",
    "pydantic>=2.12",
    "sqlalchemy>=2.0",
]
```

and, right after the closing `]` of `[dependency-groups]`'s `dev` list (before `[build-system]`), insert:

```toml

[tool.uv.sources]
ai-trading-common = { path = "../../../common", editable = true }
```

Run (in `backend/`): `uv lock && uv sync`
Expected: resolves cleanly (SQLAlchemy 2, Alembic, `psycopg[binary]` 3, and `ai-trading-common` as an editable path dependency on Task 2a.1's package). No test runs yet — this step only updates the lockfile and the virtualenv.

- [ ] **Step 2: Write the failing migration test.** First, `tests/conftest.py` (the real-Postgres harness every DB test in this phase depends on):

```python
"""Real-Postgres test fixtures (Lane P4, `scripts/test-db.sh`).

`DESK_TEST_DATABASE_URL` names a Postgres *server* (its admin/maintenance database, usually
`postgres`), not a database to test against directly. `db_engine` creates a uniquely named database
on that server, migrates it to Alembic head, hands back an engine on it, and drops the database
again at the end of the session. Every test that needs Postgres depends on `db_engine` (or the
convenience `db_session`), so with no URL set they are skipped by pytest's fixture-not-available
path below -- unless `DESK_REQUIRE_DB=1`, which turns that into a hard failure instead.
"""

import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session, sessionmaker

_URL_VAR = "DESK_TEST_DATABASE_URL"
_REQUIRE_VAR = "DESK_REQUIRE_DB"
_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"

_TABLES = ("bars_1d", "bars_1h", "bars_1m", "futures_rolls")


def _alembic_config(url: str) -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


@pytest.fixture(scope="session")
def db_engine() -> Iterator[Engine]:
    server_url = os.environ.get(_URL_VAR)
    if not server_url:
        if os.environ.get(_REQUIRE_VAR) == "1":
            pytest.fail(f"{_URL_VAR} is unset and {_REQUIRE_VAR}=1")
        pytest.skip(f"{_URL_VAR} is not set")

    db_name = f"desk_test_{uuid.uuid4().hex[:12]}"
    admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin_engine.dispose()

    db_url = make_url(server_url).set(database=db_name)
    # `str(URL)`/`URL.__repr__` mask the password (`"***"`) by design; alembic only accepts a
    # string, so build it with the real password explicitly instead of masking our own write.
    db_url_str = db_url.render_as_string(hide_password=False)
    command.upgrade(_alembic_config(db_url_str), "head")

    engine = create_engine(db_url_str)
    try:
        yield engine
    finally:
        engine.dispose()
        admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
        with admin_engine.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{db_name}" WITH (FORCE)'))
        admin_engine.dispose()


@pytest.fixture
def db_session(db_engine: Engine) -> Iterator[Session]:
    """A session on a freshly truncated database, so tests can't see each other's rows."""
    with db_engine.begin() as conn:
        for table in _TABLES:
            conn.execute(text(f'TRUNCATE TABLE "{table}"'))
    factory = sessionmaker(db_engine, expire_on_commit=False)
    with factory() as session:
        yield session
        session.rollback()
```

`tests/test_db_migrations.py`:

```python
"""Alembic head against an empty database, and that it agrees with the models (no autogenerate
drift) -- a migration and a model quietly diverging is a real failure mode once more revisions
exist, so a single run of alembic's own `compare_metadata` catches it before that happens.
"""

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy.engine import Engine

from ai_trading.db.models import Base


def test_head_matches_models(db_engine: Engine) -> None:
    with db_engine.connect() as conn:
        context = MigrationContext.configure(conn)
        diff = compare_metadata(context, Base.metadata)
    assert diff == []


def test_tables_exist(db_engine: Engine) -> None:
    from sqlalchemy import inspect

    tables = set(inspect(db_engine).get_table_names())
    assert {"bars_1d", "bars_1h", "bars_1m", "futures_rolls"} <= tables
```

- [ ] **Step 3: Run it and watch it fail (there is no real Postgres yet, so this fails at collection, not at skip).**

Run (in `backend/`): `uv run pytest -q tests/test_db_migrations.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading.db.models'` (`conftest.py` itself imports fine; `alembic`, `psycopg`, and `sqlalchemy` are already installed from Step 1).

- [ ] **Step 4: Implement `ai_trading.db`.** `backend/src/ai_trading/db/engine.py`:

```python
"""A minimal SQLAlchemy 2 engine/session helper. No pooling tuning, no global state: callers build
one engine per process (or per test database) and pass it in.
"""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker


def make_engine(url: str) -> Engine:
    return create_engine(url)


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False)


@contextmanager
def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    """Commits on a clean exit, rolls back and re-raises otherwise."""
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
```

`backend/src/ai_trading/db/models.py`:

```python
"""Typed SQLAlchemy 2 models for the Desk's Postgres store (02b §5's bar tables, 02a §9's roll
map). Only these four tables exist yet: `bars_1d`, `bars_1h`, `bars_1m`, `futures_rolls`. The
strategy and alert tables (02 §7, 02a §9, 02f, 02h) come in their own later phase (owner decision,
02c Phase 2 outline).

Every table's primary key matches how `ai_trading.data.bars`/`rolls` upsert into it (`symbol` plus
the bar's own time column; `product` plus `contract_month`), so `INSERT ... ON CONFLICT DO UPDATE`
needs no separate unique index.
"""

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


# Each bar table repeats its OHLCV + `source` columns rather than sharing them through a mixin:
# splitting a composite primary key across a mixin and its subclass (symbol here, the time column
# there) makes SQLAlchemy's declarative mapper build the primary key in two steps and emit a
# spurious warning, even though the result is correct. Three short, explicit classes avoid it.


class Bar1d(Base):
    __tablename__ = "bars_1d"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String)


class Bar1h(Base):
    __tablename__ = "bars_1h"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    bar_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String)


class Bar1m(Base):
    __tablename__ = "bars_1m"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    bar_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String)


class FuturesRoll(Base):
    """One contiguous front-month window from `ai_trading.data.rolls.roll_windows`."""

    __tablename__ = "futures_rolls"
    product: Mapped[str] = mapped_column(String, primary_key=True)
    contract_month: Mapped[date] = mapped_column(Date, primary_key=True)
    contract_symbol: Mapped[str] = mapped_column(String)
    active_from: Mapped[date] = mapped_column(Date)
    active_until: Mapped[date] = mapped_column(Date)
```

`backend/src/ai_trading/db/__init__.py`:

```python
"""The Desk's Postgres layer: typed SQLAlchemy 2 models (`models.py`) and a minimal engine/session
helper (this module). Alembic migrations live under `migrations/`.
"""

from ai_trading.db.engine import make_engine, make_session_factory, session_scope

__all__ = ["make_engine", "make_session_factory", "session_scope"]
```

- [ ] **Step 5: Set up Alembic.** `backend/alembic.ini`:

```ini
[alembic]
script_location = src/ai_trading/db/migrations
prepend_sys_path = .
path_separator = os

# Overridden at runtime (tests, scripts/test-db.sh) with the real server URL; never read from a
# file, so no secret ever sits here (AGENTS.md).
sqlalchemy.url = postgresql+psycopg://localhost/placeholder

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARNING
handlers = console
qualname =

[logger_sqlalchemy]
level = WARNING
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
```

`backend/src/ai_trading/db/migrations/env.py`:

```python
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from ai_trading.db.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

`backend/src/ai_trading/db/migrations/script.py.mako`:

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision: str = ${repr(up_revision)}
down_revision: str | None = ${repr(down_revision)}
branch_labels: str | Sequence[str] | None = ${repr(branch_labels)}
depends_on: str | Sequence[str] | None = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

`backend/src/ai_trading/db/migrations/versions/0001_bars_and_futures_rolls.py` (hand-written, not autogenerated):

```python
"""bars_1d, bars_1h, bars_1m, futures_rolls

Revision ID: 0001
Revises:
Create Date: 2026-10-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _bar_columns() -> list[sa.Column]:
    # A fresh list of `Column` objects per call: a `Column` binds to one `Table`, so the same
    # instances can't be passed to three `op.create_table` calls.
    return [
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("open", sa.Float(), nullable=False),
        sa.Column("high", sa.Float(), nullable=False),
        sa.Column("low", sa.Float(), nullable=False),
        sa.Column("close", sa.Float(), nullable=False),
        sa.Column("volume", sa.Float(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "bars_1d",
        *_bar_columns(),
        sa.Column("day", sa.Date(), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "day"),
    )
    op.create_table(
        "bars_1h",
        *_bar_columns(),
        sa.Column("bar_start", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "bar_start"),
    )
    op.create_table(
        "bars_1m",
        *_bar_columns(),
        sa.Column("bar_start", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "bar_start"),
    )
    op.create_table(
        "futures_rolls",
        sa.Column("product", sa.String(), nullable=False),
        sa.Column("contract_month", sa.Date(), nullable=False),
        sa.Column("contract_symbol", sa.String(), nullable=False),
        sa.Column("active_from", sa.Date(), nullable=False),
        sa.Column("active_until", sa.Date(), nullable=False),
        sa.PrimaryKeyConstraint("product", "contract_month"),
    )


def downgrade() -> None:
    op.drop_table("futures_rolls")
    op.drop_table("bars_1m")
    op.drop_table("bars_1h")
    op.drop_table("bars_1d")
```

- [ ] **Step 6: Write the local real-Postgres runner.** `backend/scripts/test-db.sh` (`chmod +x` it):

```bash
#!/usr/bin/env bash
# Starts a throwaway postgres:17 container, runs the backend test suite against it
# (DESK_TEST_DATABASE_URL + DESK_REQUIRE_DB=1, so the DB tests fail loud if the server never comes
# up), and removes the container on exit however the run ends.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="desk-test-postgres-$$"
PORT="${DESK_TEST_DB_PORT:-55432}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_USER=desk -e POSTGRES_PASSWORD=desk -e POSTGRES_DB=postgres \
  -p "127.0.0.1:${PORT}:5432" \
  postgres:17 >/dev/null

export DESK_TEST_DATABASE_URL="postgresql+psycopg://desk:desk@127.0.0.1:${PORT}/postgres"
export DESK_REQUIRE_DB=1

ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U desk >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:17 never became ready" >&2
  exit 1
fi

uv run pytest -q -rs "$@"
```

- [ ] **Step 7: Run it and watch it pass.**

Run (in `backend/`): `./scripts/test-db.sh tests/test_db_migrations.py`
Expected: `2 passed`, and `docker ps -a` afterward shows no leftover `desk-test-postgres-*` container.

Run (in `backend/`), to confirm the skip-without-a-URL path: `uv run pytest -q -rs tests/test_db_migrations.py`
Expected: `2 skipped` (no `DESK_TEST_DATABASE_URL` set locally).

- [ ] **Step 8: Add the `postgres:17` CI service.** In `.github/workflows/ai-trading-ci.yml`, replace:

```yaml
  desk:
    name: Desk contracts and backend
    runs-on: ubuntu-latest
    steps:
```

with:

```yaml
  desk:
    name: Desk contracts and backend
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: desk
          POSTGRES_PASSWORD: desk
          POSTGRES_DB: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U desk"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
```

then replace:

```yaml
      - name: Backend (Pydantic parity and drift, core, templates)
        working-directory: ai-trading/packages/family-desk/backend
        run: |
          uv sync --locked
          uv run ruff check .
          uv run ruff format --check .
          uv run pytest -q
```

with:

```yaml
      - name: Backend (Pydantic parity and drift, core, templates, DB)
        working-directory: ai-trading/packages/family-desk/backend
        env:
          DESK_TEST_DATABASE_URL: postgresql+psycopg://desk:desk@localhost:5432/postgres
          DESK_REQUIRE_DB: "1"
        run: |
          uv sync --locked
          uv run ruff check .
          uv run ruff format --check .
          uv run pytest -q
```

- [ ] **Step 9: Run the full backend suite and lint, both with and without a database.**

Run (in `backend/`): `./scripts/test-db.sh`
Expected: `527 passed` (525 baseline + 2 new).

Run (in `backend/`): `uv run pytest -q -rs`
Expected: `525 passed, 2 skipped` (only the two new migration tests skip; every Phase 1/1b/1c/1d test is unaffected).

Run (in `backend/`): `uv run ruff check . && uv run ruff format --check .`
Expected: ruff clean.

- [ ] **Step 10: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/pyproject.toml ai-trading/packages/family-desk/backend/uv.lock ai-trading/packages/family-desk/backend/alembic.ini ai-trading/packages/family-desk/backend/src/ai_trading/db ai-trading/packages/family-desk/backend/tests/conftest.py ai-trading/packages/family-desk/backend/tests/test_db_migrations.py ai-trading/packages/family-desk/backend/scripts/test-db.sh .github/workflows/ai-trading-ci.yml
git commit -m "feat(ai-trading): Desk Postgres schema -- bars_1d/1h/1m, futures_rolls, Alembic, and the test-db harness"
```

---

### Task 2a.8: The Desk data layer — bars, rolls, slots, backfill

**Files:**
- Create: `packages/family-desk/backend/src/ai_trading/data/bars.py`, `.../data/rolls.py`, `.../data/slots.py`, `.../data/backfill.py`
- Create: `packages/family-desk/backend/tests/test_bars_store.py`, `.../tests/test_rolls.py`, `.../tests/test_slots.py`, `.../tests/test_backfill.py`, `.../tests/test_end_to_end.py`
- Modify: `ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md`, `ai-trading/plans/subplans/02b-desk-market-data-options.md`, `ai-trading/plans/STATUS.md`

**Interfaces:**
- Consumes: `ai_trading.db.models.{Bar1d, Bar1h, Bar1m, FuturesRoll}` (2a.7); `ai_trading.core.calendar.{ET, Asset, session, previous_session}` and `ai_trading.core.futures.{MONTH_CODES, front_month, roll_date, _extract_product}` (Phase 1/1c, unmodified); `ai_trading_common.alpaca.AlpacaBars` and `ai_trading_common.errors.ProviderError` (2a.2) — only `backfill.py` imports `ai_trading_common`.
- Produces:
  - `ai_trading.data.bars.{Timeframe, bar_close, upsert_bars, read_bars, missing_sessions, prune_1m}`
  - `ai_trading.data.rolls.{RollWindow, roll_windows, store_roll_windows, continuous}`
  - `ai_trading.data.slots.{SlotKind, SlotDemand, SlotDecision, allocate}`
  - `ai_trading.data.backfill.{ALPACA_FREE_HISTORY_START, BackfillResult, backfill}`

Fixture path used (already committed, copied from `common/tests/fixtures/alpaca/daily_range_aapl.json` since `ai_trading_common`'s own `tests/` is not part of the installed package): `packages/family-desk/backend/tests/fixtures/alpaca/daily_range_aapl.json`.

- [ ] **Step 1: Write the failing tests for the bar store.** `tests/test_bars_store.py`:

```python
"""The bar store: closed-bar-only upserts (Review Focus 2), as-of reads (Review Focus 6), backfill
planning, and the 1-minute retention prune. Needs a real Postgres (`scripts/test-db.sh`)."""

from datetime import date, timedelta

import pandas as pd
import pytest

from ai_trading.core.calendar import et, session
from ai_trading.data.bars import bar_close, missing_sessions, prune_1m, read_bars, upsert_bars

DAY = date(2026, 10, 6)  # a regular (non-half-day) XNYS session
NEXT_DAY = date(2026, 10, 7)
THIRD_DAY = date(2026, 10, 8)
HALF_DAY = date(2025, 11, 28)  # the day after Thanksgiving, 13:00 ET close


def _frame(points, prices) -> pd.DataFrame:
    return pd.DataFrame(
        {"open": prices, "high": prices, "low": prices, "close": prices, "volume": [1_000.0] * len(prices)},
        index=pd.Index(points),
    )


# --- bar_close -----------------------------------------------------------------------------------


def test_bar_close_1m_is_one_minute_later():
    start = et(DAY, "10:00")
    assert bar_close("stock", "1m", start) == start + pd.Timedelta(minutes=1)


def test_bar_close_1d_is_the_session_regular_close():
    assert bar_close("stock", "1d", DAY) == session("stock", DAY).regular_close
    assert bar_close("stock", "1d", HALF_DAY) == et(HALF_DAY, "13:00")


def test_bar_close_1h_is_one_hour_later_on_a_full_day():
    start = et(DAY, "10:00")
    assert bar_close("stock", "1h", start) == start + pd.Timedelta(hours=1)


def test_bar_close_1h_caps_at_a_half_days_short_last_hour():
    # 12:30-13:30 ET would naturally close at 13:30, but the half day closes at 13:00.
    start = et(HALF_DAY, "12:30")
    assert bar_close("stock", "1h", start) == et(HALF_DAY, "13:00")


def test_bar_close_1h_does_not_pull_a_post_market_bar_backward():
    # Already past the regular close; the half-day cap must not apply to it.
    start = et(HALF_DAY, "14:00")
    assert bar_close("stock", "1h", start) == start + pd.Timedelta(hours=1)


# --- upsert_bars -----------------------------------------------------------------------------------


def test_upsert_raises_on_a_bar_not_yet_closed(db_session):
    frame = _frame([DAY], [100.0])
    almost_close = session("stock", DAY).regular_close - pd.Timedelta(seconds=1)
    with pytest.raises(ValueError, match="has not closed"):
        upsert_bars(db_session, "AAPL", "1d", frame, "alpaca", "stock", now=almost_close)
    db_session.rollback()
    assert read_bars(db_session, "AAPL", "1d", DAY, DAY, "stock", as_of=et(DAY, "20:00")).empty


def test_upsert_accepts_a_bar_exactly_at_its_close(db_session):
    frame = _frame([DAY], [100.0])
    upsert_bars(db_session, "AAPL", "1d", frame, "alpaca", "stock", now=session("stock", DAY).regular_close)
    db_session.commit()
    out = read_bars(db_session, "AAPL", "1d", DAY, DAY, "stock", as_of=et(DAY, "20:00"))
    assert list(out["close"]) == [100.0]


def test_upsert_is_idempotent_and_the_second_write_wins(db_session):
    now = et(DAY, "20:00")
    upsert_bars(db_session, "AAPL", "1d", _frame([DAY], [100.0]), "alpaca", "stock", now=now)
    upsert_bars(db_session, "AAPL", "1d", _frame([DAY], [101.0]), "stooq", "stock", now=now)
    db_session.commit()
    out = read_bars(db_session, "AAPL", "1d", DAY, DAY, "stock", as_of=now)
    assert list(out["close"]) == [101.0]


# --- read_bars: no look-ahead (Review Focus 6) ------------------------------------------------------


def test_read_as_of_ignores_a_later_mutation_of_a_future_bar(db_session):
    now = et(THIRD_DAY, "20:00")
    upsert_bars(db_session, "AAPL", "1d", _frame([DAY, NEXT_DAY], [100.0, 101.0]), "alpaca", "stock", now=now)
    db_session.commit()
    as_of = session("stock", DAY).regular_close + pd.Timedelta(minutes=1)  # only DAY has closed

    before = read_bars(db_session, "AAPL", "1d", DAY, THIRD_DAY, "stock", as_of=as_of)

    # Mutate the later (still-in-the-future, relative to `as_of`) bar -- closed by `now`, so the
    # write itself is legal, but it must not change what the earlier `as_of` sees.
    upsert_bars(db_session, "AAPL", "1d", _frame([NEXT_DAY], [999.0]), "alpaca", "stock", now=now)
    db_session.commit()

    after = read_bars(db_session, "AAPL", "1d", DAY, THIRD_DAY, "stock", as_of=as_of)
    pd.testing.assert_frame_equal(before, after)
    assert list(before.index) == [DAY]  # NEXT_DAY had not closed as of `as_of`


def test_read_as_of_filters_an_intraday_bar_not_yet_closed(db_session):
    first = et(DAY, "10:00")
    second = et(DAY, "10:01")
    now = et(DAY, "20:00")
    upsert_bars(db_session, "AAPL", "1m", _frame([first, second], [100.0, 101.0]), "alpaca", "stock", now=now)
    db_session.commit()
    out = read_bars(db_session, "AAPL", "1m", first, second, "stock", as_of=first + pd.Timedelta(minutes=1))
    assert list(out.index) == [first]


# --- missing_sessions ------------------------------------------------------------------------------


def test_missing_sessions_daily_reports_a_day_with_no_bar(db_session):
    now = et(THIRD_DAY, "20:00")
    upsert_bars(db_session, "AAPL", "1d", _frame([DAY, THIRD_DAY], [100.0, 102.0]), "alpaca", "stock", now=now)
    db_session.commit()
    assert missing_sessions(db_session, "AAPL", "1d", "stock", DAY, THIRD_DAY) == [NEXT_DAY]


def test_missing_sessions_intraday_treats_a_quiet_session_as_present(db_session):
    now = et(THIRD_DAY, "20:00")
    one_bar = _frame([et(DAY, "10:00")], [100.0])
    upsert_bars(db_session, "AAPL", "1m", one_bar, "alpaca", "stock", now=now)
    db_session.commit()
    # DAY has exactly one bar (quiet minutes elsewhere are fine); NEXT_DAY and THIRD_DAY have none.
    assert missing_sessions(db_session, "AAPL", "1m", "stock", DAY, THIRD_DAY) == [NEXT_DAY, THIRD_DAY]


# --- prune_1m --------------------------------------------------------------------------------------


def test_prune_1m_drops_only_bars_older_than_90_days(db_session):
    now = et(DAY, "20:00")
    old = now - timedelta(days=91)
    recent = now - timedelta(days=10)
    upsert_bars(db_session, "AAPL", "1m", _frame([old], [1.0]), "alpaca", "stock", now=old + pd.Timedelta(minutes=1))
    upsert_bars(
        db_session, "AAPL", "1m", _frame([recent], [2.0]), "alpaca", "stock", now=recent + pd.Timedelta(minutes=1)
    )
    db_session.commit()
    deleted = prune_1m(db_session, now=now)
    db_session.commit()
    assert deleted == 1
    out = read_bars(db_session, "AAPL", "1m", old - pd.Timedelta(days=1), now, "stock", as_of=now)
    assert list(out["close"]) == [2.0]
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `./scripts/test-db.sh tests/test_bars_store.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading.data.bars'`.

- [ ] **Step 3: Implement `data/bars.py`.**

```python
"""The bar store (02b §5): closed-bar-only upserts, as-of reads, backfill planning, and the
1-minute retention prune. Frames are in `ai_trading.core.evaluate`'s shape: `bars_1d` indexed by
trading day (`datetime.date`), `bars_1h`/`bars_1m` indexed by UTC bar start, columns `open high low
close volume`.

Pattern (not copied): ai-hedge-fund `hedge_fund/data/cached.py`'s rule, "never cache a trading day
that has not closed" (02a §11) -- here, "never store a bar whose period has not closed".
"""

from collections.abc import Sequence
from datetime import date, timedelta

import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, Asset, session
from ai_trading.db.models import Bar1d, Bar1h, Bar1m

Timeframe = str  # "1d" | "1h" | "1m"

_MODEL = {"1d": Bar1d, "1h": Bar1h, "1m": Bar1m}
_COLUMNS = ("open", "high", "low", "close", "volume")
_RETENTION_1M = timedelta(days=90)


def _bar_day(asset: Asset, start: pd.Timestamp) -> date:
    """The trading day `start` (a UTC bar start) falls on, mirroring `core.calendar.annotate`'s
    own shift: a future's "day" is its overnight session, which starts at 18:00 ET the evening
    before, so it is attributed to the next calendar day by shifting 6 hours before taking the
    ET date."""
    shift = timedelta(hours=6) if asset == "future" else timedelta(0)
    return (start.tz_convert(ET) + shift).date()


def bar_close(asset: Asset, timeframe: Timeframe, point: date | pd.Timestamp) -> pd.Timestamp:
    """The instant `point` (a `bars_1d` day, or a `bars_1h`/`bars_1m` bar start) closes.

    `1m`: one minute after the start. `1h`: one hour after the start, except a session's short
    last hour (a half day), which closes at that session's regular close instead -- only when the
    regular close falls strictly between the bar's start and its natural hour-later close; a
    post-market hourly bar (already past the regular close) is never pulled backward by this.
    `1d`: the trading day's own regular close (16:00 or 13:00 ET).
    """
    if timeframe == "1d":
        found = session(asset, point)
        if found is None:
            raise ValueError(f"{point} is not a trading day for {asset!r}")
        return found.regular_close
    if timeframe == "1m":
        return point + pd.Timedelta(minutes=1)
    if timeframe == "1h":
        natural_close = point + pd.Timedelta(hours=1)
        found = session(asset, _bar_day(asset, point))
        if found is not None and point < found.regular_close <= natural_close:
            return found.regular_close
        return natural_close
    raise ValueError(f"unknown timeframe {timeframe!r}")


def upsert_bars(
    session_: Session,
    symbol: str,
    timeframe: Timeframe,
    frame: pd.DataFrame,
    source: str,
    asset: Asset,
    *,
    now: pd.Timestamp,
) -> None:
    """Idempotent upsert of `frame` into the `timeframe` bar table. Raises `ValueError` -- and
    writes nothing -- if any row has not closed by `now` (Review Focus 2: a forming bar can never
    be stored and repaint later)."""
    if frame.empty:
        return
    model = _MODEL[timeframe]
    time_column = "day" if timeframe == "1d" else "bar_start"

    for point in frame.index:
        close = bar_close(asset, timeframe, point)
        if now < close:
            raise ValueError(f"{symbol} {timeframe} bar at {point} has not closed by {now} (closes {close})")

    rows = [
        {"symbol": symbol, time_column: point, "source": source, **{c: float(row[c]) for c in _COLUMNS}}
        for point, row in frame.iterrows()
    ]
    stmt = pg_insert(model).values(rows)
    update_columns = {c: stmt.excluded[c] for c in (*_COLUMNS, "source")}
    stmt = stmt.on_conflict_do_update(index_elements=["symbol", time_column], set_=update_columns)
    session_.execute(stmt)


def read_bars(
    session_: Session,
    symbol: str,
    timeframe: Timeframe,
    start: date | pd.Timestamp,
    end: date | pd.Timestamp,
    asset: Asset,
    *,
    as_of: pd.Timestamp,
) -> pd.DataFrame:
    """Bars for `symbol` in `[start, end]` (inclusive) that had closed by `as_of` -- recomputed
    from each row's own close time, not from when it was written, so a replay at an earlier
    `as_of` never sees a bar that had not yet closed at that point even though it is already
    stored (Review Focus 6: no look-ahead)."""
    model = _MODEL[timeframe]
    time_column = model.day if timeframe == "1d" else model.bar_start
    rows = session_.execute(
        select(model).where(model.symbol == symbol, time_column >= start, time_column <= end).order_by(time_column)
    ).scalars()

    index: list[date | pd.Timestamp] = []
    data: dict[str, list[float]] = {c: [] for c in _COLUMNS}
    for row in rows:
        point = row.day if timeframe == "1d" else pd.Timestamp(row.bar_start)
        if bar_close(asset, timeframe, point) > as_of:
            continue
        index.append(point)
        for c in _COLUMNS:
            data[c].append(getattr(row, c))
    return pd.DataFrame(data, index=pd.Index(index))


def _sessions_in_range(asset: Asset, start: date, end: date) -> list[date]:
    days = []
    cursor = start
    while cursor <= end:
        if session(asset, cursor) is not None:
            days.append(cursor)
        cursor += timedelta(days=1)
    return days


def missing_sessions(
    session_: Session, symbol: str, timeframe: Timeframe, asset: Asset, start: date, end: date
) -> list[date]:
    """XNYS/CMES sessions in `[start, end]` with no stored bar for `symbol`. For an intraday
    timeframe a missing session is a whole day with *no* bars at all -- quiet minutes inside a
    session that has some bars are normal, not a gap."""
    model = _MODEL[timeframe]
    days = _sessions_in_range(asset, start, end)
    if timeframe == "1d":
        present = set(session_.execute(select(model.day).where(model.symbol == symbol, model.day.in_(days))).scalars())
        return [d for d in days if d not in present]

    missing = []
    for d in days:
        found = session(asset, d)
        count = session_.execute(
            select(model.bar_start)
            .where(
                model.symbol == symbol,
                model.bar_start >= found.extended_open,
                model.bar_start < found.extended_close,
            )
            .limit(1)
        ).first()
        if count is None:
            missing.append(d)
    return missing


def prune_1m(session_: Session, *, now: pd.Timestamp) -> int:
    """Deletes `bars_1m` rows older than the 90-day retention window (02b §5). Returns the row
    count deleted."""
    cutoff = now - _RETENTION_1M
    result = session_.execute(Bar1m.__table__.delete().where(Bar1m.bar_start < cutoff))
    return result.rowcount


__all__: Sequence[str] = (
    "bar_close",
    "upsert_bars",
    "read_bars",
    "missing_sessions",
    "prune_1m",
)
```

- [ ] **Step 4: Run it and watch it pass.**

Run (in `backend/`): `./scripts/test-db.sh tests/test_bars_store.py`
Expected: `13 passed`.

- [ ] **Step 5: Write the failing tests for the futures roll map.** `tests/test_rolls.py`:

```python
"""The futures roll map: contiguous windows from `core.futures`' roll dates, their storage, and the
difference back-adjusted continuous series (Review Focus 4: "the roll test -- no cross-contract
gap")."""

from datetime import date, timedelta

import pandas as pd
import pytest
from sqlalchemy import select

from ai_trading.core import futures
from ai_trading.data import rolls
from ai_trading.db.models import FuturesRoll


def test_roll_windows_are_contiguous_with_no_gap_or_overlap():
    start, end = date(2026, 1, 1), date(2026, 12, 31)
    windows = rolls.roll_windows("ES", start, end)

    assert windows[0].active_from == start
    assert windows[-1].active_until == end
    for earlier, later in zip(windows, windows[1:], strict=False):
        assert later.active_from == earlier.active_until + timedelta(days=1)
    for w in windows:
        assert w.active_from <= w.active_until
        assert w.product == "ES"
        assert futures._extract_product(w.contract_symbol) == "ES"
        # Still the front month through this window's own last day.
        assert futures.front_month("ES", w.active_until) == w.contract_month


def test_roll_windows_accepts_a_micro_symbol_on_its_own_terms():
    # "MES" is itself one of the Desk's 12 listed products (`_extract_product` does not collapse a
    # micro to its mini): it gets its own windows and contract symbols.
    windows = rolls.roll_windows("MES", date(2026, 1, 1), date(2026, 3, 1))
    assert all(w.product == "MES" for w in windows)
    assert all(w.contract_symbol.startswith("MES") for w in windows)


def test_roll_windows_covers_a_physically_settled_product_too():
    windows = rolls.roll_windows("CL", date(2026, 1, 1), date(2026, 6, 30))
    assert windows[0].active_from == date(2026, 1, 1)
    assert windows[-1].active_until == date(2026, 6, 30)
    for earlier, later in zip(windows, windows[1:], strict=False):
        assert later.active_from == earlier.active_until + timedelta(days=1)


def test_store_roll_windows_is_idempotent(db_session):
    windows = rolls.roll_windows("ES", date(2026, 1, 1), date(2026, 12, 31))
    rolls.store_roll_windows(db_session, windows)
    rolls.store_roll_windows(db_session, windows)  # re-run: no duplicate-key error
    db_session.commit()
    stored = db_session.execute(select(FuturesRoll).where(FuturesRoll.product == "ES")).scalars().all()
    assert len(stored) == len(windows)
    assert {row.contract_symbol for row in stored} == {w.contract_symbol for w in windows}


# --- continuous: difference back-adjustment -------------------------------------------------------


def _daily(days: list[date], closes: list[float]) -> pd.DataFrame:
    """Daily bars indexed by trading day (`datetime.date`), matching `core.backtest`'s `bars_1d`
    shape -- not a `DatetimeIndex`."""
    return pd.DataFrame({"close": closes}, index=pd.Index(days))


def test_continuous_back_adjusts_by_the_difference_at_each_roll():
    roll_day = date(2026, 3, 16)
    w_old = rolls.RollWindow("ES", date(2026, 3, 1), "ESH6", date(2026, 3, 1), roll_day - timedelta(days=1))
    w_new = rolls.RollWindow("ES", date(2026, 6, 1), "ESM6", roll_day, date(2026, 3, 20))

    bars = {
        # The front (old) contract: 5000 the day before the roll.
        "ESH6": _daily([roll_day - timedelta(days=1), roll_day], [5000.0, 5010.0]),
        # The new contract trades 20 points richer at the bridge day, and that gap must disappear.
        "ESM6": _daily([roll_day - timedelta(days=1), roll_day, date(2026, 3, 20)], [5020.0, 5030.0, 5040.0]),
    }

    out = rolls.continuous([w_old, w_new], bars)

    # The latest segment stays at real (unadjusted) prices.
    assert out.loc[roll_day] == 5030.0
    assert out.loc[date(2026, 3, 20)] == 5040.0
    # The old segment is shifted by the +20 gap observed at the bridge day, so the series is level.
    assert out.loc[roll_day - timedelta(days=1)] == pytest.approx(5020.0)
    assert list(out.index) == sorted(out.index)


def test_continuous_raises_when_contracts_share_no_bar_near_the_roll():
    roll_day = date(2026, 3, 16)
    w_old = rolls.RollWindow("ES", date(2026, 3, 1), "ESH6", date(2026, 3, 1), roll_day - timedelta(days=1))
    w_new = rolls.RollWindow("ES", date(2026, 6, 1), "ESM6", roll_day, date(2026, 3, 20))
    bars = {
        "ESH6": _daily([roll_day - timedelta(days=1)], [5000.0]),
        "ESM6": _daily([date(2026, 3, 25)], [5040.0]),  # no overlap with the old contract at all
    }
    with pytest.raises(ValueError, match="no common bar"):
        rolls.continuous([w_old, w_new], bars)


def test_continuous_of_a_single_window_is_unadjusted():
    w = rolls.RollWindow("ES", date(2026, 3, 1), "ESH6", date(2026, 3, 1), date(2026, 3, 10))
    bars = {"ESH6": _daily([date(2026, 3, 1), date(2026, 3, 10)], [5000.0, 5005.0])}
    out = rolls.continuous([w], bars)
    assert list(out) == [5000.0, 5005.0]
```

- [ ] **Step 6: Run it and watch it fail.**

Run (in `backend/`): `./scripts/test-db.sh tests/test_rolls.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading.data.rolls'`.

- [ ] **Step 7: Implement `data/rolls.py`.**

```python
"""The futures roll map (02a §9, Review Focus 4): contiguous front-month windows from
`ai_trading.core.futures`' roll dates, stored in `futures_rolls`, and a difference back-adjusted
continuous series stitched from them so indicators and levels never see a fake cross-contract gap.
"""

from dataclasses import dataclass
from datetime import date, timedelta

import pandas as pd
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.core import futures
from ai_trading.db.models import FuturesRoll


@dataclass(frozen=True)
class RollWindow:
    product: str  # the extracted product, e.g. "ES" (never a micro/mini alias of it)
    contract_month: date  # first of the delivery month
    contract_symbol: str  # e.g. "ESZ6"; parses back through `futures._extract_product`
    active_from: date
    active_until: date  # inclusive


def _contract_symbol(product: str, contract_month: date) -> str:
    """`product` + its CME month code + the contract year's last digit, e.g. "ESZ6" for December
    2026 -- the shortest form `futures._extract_product`'s suffix regex (`[FGHJKMNQUVXZ]\\d{1,4}`)
    accepts, matching how CME itself abbreviates a front-month symbol."""
    return f"{product}{futures.MONTH_CODES[contract_month.month]}{contract_month.year % 10}"


def roll_windows(product: str, start: date, end: date) -> list[RollWindow]:
    """Contiguous, non-overlapping front-month windows covering `[start, end]`: each window's
    `active_until` is the day before the next contract's roll date, and that roll date is the
    next window's `active_from` -- so there is no gap and no overlap between them."""
    extracted = futures._extract_product(product)
    windows: list[RollWindow] = []
    window_start = start
    contract_month = futures.front_month(extracted, window_start)
    while window_start <= end:
        roll = futures.roll_date(extracted, contract_month)
        window_end = min(roll - timedelta(days=1), end)
        windows.append(
            RollWindow(
                product=extracted,
                contract_month=contract_month,
                contract_symbol=_contract_symbol(extracted, contract_month),
                active_from=window_start,
                active_until=window_end,
            )
        )
        if window_end >= end:
            break
        window_start = roll
        contract_month = futures.front_month(extracted, roll)
    return windows


def store_roll_windows(session: Session, windows: list[RollWindow]) -> None:
    """Idempotent upsert of `windows` into `futures_rolls`, keyed by (product, contract_month)."""
    if not windows:
        return
    rows = [
        {
            "product": w.product,
            "contract_month": w.contract_month,
            "contract_symbol": w.contract_symbol,
            "active_from": w.active_from,
            "active_until": w.active_until,
        }
        for w in windows
    ]
    stmt = pg_insert(FuturesRoll).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=["product", "contract_month"],
        set_={
            "contract_symbol": stmt.excluded.contract_symbol,
            "active_from": stmt.excluded.active_from,
            "active_until": stmt.excluded.active_until,
        },
    )
    session.execute(stmt)


def _last_common_bar(old: pd.Series, new: pd.Series, before: date) -> date | None:
    """The latest date on or before `before` that both `old` and `new` (daily series indexed by
    trading day) hold a non-NaN value for -- the bridge a difference back-adjustment needs at a
    roll."""
    candidates = old.index[old.index <= before]
    for d in sorted(candidates, reverse=True):
        if d in new.index and pd.notna(old.loc[d]) and pd.notna(new.loc[d]):
            return d
    return None


def continuous(
    windows: list[RollWindow], bars_by_contract: dict[str, pd.DataFrame], *, field: str = "close"
) -> pd.Series:
    """Stitches each window's own contract bars into one series, difference back-adjusted at every
    roll: the new contract's (already-adjusted) price minus the old contract's raw price, both at
    the last bar before the roll where both contracts have data. The newest window carries no
    adjustment, so the latest segment is always at real prices (02a §11, Review Focus 4: "the roll
    test -- no cross-contract gap").

    Raises `ValueError` if two consecutive contracts share no bar on or before a window's
    `active_until`: back-adjusting across a gap would have to guess an offset, which this never
    does (AGENTS.md "unknown data never fires or guesses").
    """
    if not windows:
        return pd.Series(dtype=float)
    ordered = sorted(windows, key=lambda w: w.active_from)
    pieces: list[pd.Series] = []
    offset = 0.0
    for i in range(len(ordered) - 1, -1, -1):
        w = ordered[i]
        raw = bars_by_contract[w.contract_symbol][field]
        if i < len(ordered) - 1:
            next_w = ordered[i + 1]
            next_raw = bars_by_contract[next_w.contract_symbol][field]
            bridge = _last_common_bar(raw, next_raw, w.active_until)
            if bridge is None:
                raise ValueError(
                    f"no common bar between {w.contract_symbol!r} and {next_w.contract_symbol!r} "
                    f"near the roll on {next_w.active_from}"
                )
            # `offset` here is still the one computed for `next_w` (0.0 for the newest window).
            offset = (next_raw.loc[bridge] + offset) - raw.loc[bridge]
        else:
            offset = 0.0
        segment = raw.loc[(raw.index >= w.active_from) & (raw.index <= w.active_until)]
        pieces.append(segment + offset)
    pieces.reverse()
    return pd.concat(pieces).sort_index()
```

- [ ] **Step 8: Run it and watch it pass.**

Run (in `backend/`): `./scripts/test-db.sh tests/test_rolls.py`
Expected: `7 passed`.

- [ ] **Step 9: Write the failing tests for the streaming-slot allocator.** `tests/test_slots.py`:

```python
"""The streaming-slot allocator (02a §7)."""

from datetime import UTC, datetime

from ai_trading.data.slots import SlotDemand, allocate

T0 = datetime(2026, 1, 1, tzinfo=UTC)


def at(minutes: int) -> datetime:
    return T0.replace(minute=minutes % 60, hour=minutes // 60)


def test_priority_order_wins_over_arrival_time():
    # A later intraday-strategy demand still beats an earlier open-chart one (02a §7's order).
    demands = [
        SlotDemand("AAPL", "open_chart", at(0)),
        SlotDemand("MSFT", "intraday_strategy", at(10)),
    ]
    decisions = {d.symbol: d for d in allocate(demands, cap=1)}
    assert decisions["MSFT"].granted is True
    assert decisions["AAPL"].granted is False
    assert decisions["AAPL"].reason == "no streaming slot available (cap 1)"


def test_within_a_kind_earlier_since_wins_then_symbol():
    demands = [
        SlotDemand("ZZZ", "open_chart", at(5)),
        SlotDemand("AAA", "open_chart", at(5)),  # same since as ZZZ: symbol breaks the tie
        SlotDemand("BBB", "open_chart", at(1)),  # earliest: wins first
    ]
    decisions = allocate(demands, cap=2)
    granted = [d.symbol for d in decisions if d.granted]
    assert granted == ["BBB", "AAA"]  # AAA beats ZZZ at the same `since`


def test_one_symbol_many_demands_counts_once_under_its_best_kind():
    demands = [
        SlotDemand("AAPL", "covered_call_scan", at(0)),
        SlotDemand("AAPL", "intraday_strategy", at(20)),
        SlotDemand("AAPL", "open_chart", at(5)),
    ]
    decisions = allocate(demands, cap=70)
    assert len(decisions) == 1
    assert decisions[0].kind == "intraday_strategy"
    assert decisions[0].since == at(20)
    assert decisions[0].granted is True


def test_cap_denies_the_overflow_deterministically():
    demands = [SlotDemand(f"SYM{i}", "open_chart", at(i)) for i in range(5)]
    decisions = allocate(demands, cap=3)
    granted = sorted(d.symbol for d in decisions if d.granted)
    denied = sorted(d.symbol for d in decisions if not d.granted)
    assert granted == ["SYM0", "SYM1", "SYM2"]
    assert denied == ["SYM3", "SYM4"]
    assert all(d.reason for d in decisions if not d.granted)


def test_allocation_is_deterministic_regardless_of_input_order():
    demands = [SlotDemand(f"SYM{i}", "open_chart", at(i)) for i in range(10)]
    forward = allocate(demands, cap=4)
    backward = allocate(list(reversed(demands)), cap=4)
    assert forward == backward
```

- [ ] **Step 10: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_slots.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading.data.slots'`.

- [ ] **Step 11: Implement `data/slots.py`.**

```python
"""The IBKR streaming-slot allocator (02a §7): at most `cap` symbols get a live subscription, in
priority order `intraday_strategy` > `open_chart` > `covered_call_scan`.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

SlotKind = Literal["intraday_strategy", "open_chart", "covered_call_scan"]

#: Lower sorts first (wins), matching 02a §7's listed priority order.
_PRIORITY: dict[SlotKind, int] = {"intraday_strategy": 0, "open_chart": 1, "covered_call_scan": 2}


@dataclass(frozen=True)
class SlotDemand:
    symbol: str
    kind: SlotKind
    since: datetime


@dataclass(frozen=True)
class SlotDecision:
    symbol: str
    kind: SlotKind  # the highest-priority kind this symbol was demanded under
    since: datetime  # the earliest `since` among that kind's demands for this symbol
    granted: bool
    reason: str | None  # set only when `granted` is False


def allocate(demands: list[SlotDemand], cap: int = 70) -> list[SlotDecision]:
    """One slot per symbol, however many demands name it, counted under its highest-priority kind
    (ties broken by the earliest `since` within that kind). Symbols compete for `cap` slots in
    priority order, then by `since`, then by symbol, so the result is deterministic regardless of
    `demands`' input order."""
    by_symbol: dict[str, list[SlotDemand]] = defaultdict(list)
    for demand in demands:
        by_symbol[demand.symbol].append(demand)

    canonical = []
    for symbol, group in by_symbol.items():
        best_kind = min((d.kind for d in group), key=lambda k: _PRIORITY[k])
        earliest = min(d.since for d in group if d.kind == best_kind)
        canonical.append((symbol, best_kind, earliest))
    canonical.sort(key=lambda c: (_PRIORITY[c[1]], c[2], c[0]))

    decisions = []
    for rank, (symbol, kind, since) in enumerate(canonical):
        granted = rank < cap
        reason = None if granted else f"no streaming slot available (cap {cap})"
        decisions.append(SlotDecision(symbol, kind, since, granted, reason))
    return decisions
```

- [ ] **Step 12: Run it and watch it pass.**

Run (in `backend/`): `uv run pytest -q tests/test_slots.py`
Expected: `5 passed`.

- [ ] **Step 13: Copy the shared Alpaca fixture.** `backfill.py`'s tests need the real recorded AAPL daily fixture, but `ai_trading_common`'s own `tests/` directory is not part of the installed package — copy it verbatim:

```bash
mkdir -p packages/family-desk/backend/tests/fixtures/alpaca
cp common/tests/fixtures/alpaca/daily_range_aapl.json packages/family-desk/backend/tests/fixtures/alpaca/daily_range_aapl.json
```

- [ ] **Step 14: Write the failing tests for `backfill.py`.** `tests/test_backfill.py`:

```python
"""The backfill glue module: fills missing sessions for one symbol/timeframe from Alpaca,
through the bar store. Needs a real Postgres (`scripts/test-db.sh`); the HTTP layer is a fake
serving the recorded Alpaca fixtures (and, for the pre-2016 and error scenarios below, small
hand-built bodies in the same real Alpaca response shape, since no recorded fixture spans the
2016 boundary or a 5xx)."""

import json
from datetime import date
from pathlib import Path

import pandas as pd
import pytest
from ai_trading_common.alpaca import AlpacaBars
from ai_trading_common.errors import Unavailable
from ai_trading_common.testing import FakeResponse, make_client

from ai_trading.core.calendar import et
from ai_trading.data.backfill import ALPACA_FREE_HISTORY_START, backfill
from ai_trading.data.bars import read_bars, upsert_bars

FIXTURES = Path(__file__).parent / "fixtures" / "alpaca"

DAY = date(2026, 10, 6)  # a regular XNYS session (shared with test_bars_store.py)
NEXT_DAY = date(2026, 10, 7)
THIRD_DAY = date(2026, 10, 8)


def load_daily_range_aapl() -> dict:
    return json.loads((FIXTURES / "daily_range_aapl.json").read_text())["body"]


def _alpaca_from(*responses) -> tuple[AlpacaBars, object]:
    client, session, _ = make_client(list(responses))
    return AlpacaBars("kid", "sec", http=client), session


def _bar(day_iso: str, price: float = 100.0) -> dict:
    return {"o": price, "h": price, "l": price, "c": price, "v": 1_000.0, "t": f"{day_iso}T14:30:00Z"}


class TestFillsFromARecordedFixture:
    def test_one_contiguous_range_is_one_http_call(self, db_session):
        # The recorded fixture's own range (2026-01-02..01-14); drop_unclosed naturally trims
        # it to just the two requested days once `now` is set right after the second closes.
        alpaca, session_ = _alpaca_from(FakeResponse(200, load_daily_range_aapl()))
        start, end = date(2026, 1, 2), date(2026, 1, 5)
        now = et(end, "20:00")

        result = backfill(db_session, "AAPL", "1d", "stock", start, end, alpaca=alpaca, now=now)
        db_session.commit()

        assert result.requested == (start, end)
        assert result.written == [start, end]
        assert result.uncovered == []
        assert len(session_.calls) == 1

        got = read_bars(db_session, "AAPL", "1d", start, end, "stock", as_of=now)
        assert list(got.index) == [start, end]
        assert list(got["close"]) == [270.27, 266.53]


class TestClampsPre2016History:
    def test_sessions_before_the_free_history_start_are_uncovered_not_fetched(self, db_session):
        start, end = date(2015, 12, 30), date(2016, 1, 5)
        assert ALPACA_FREE_HISTORY_START == date(2016, 1, 1)
        body = {
            "bars": [_bar("2016-01-04"), _bar("2016-01-05")],
            "next_page_token": None,
            "symbol": "AAPL",
        }
        alpaca, session_ = _alpaca_from(FakeResponse(200, body))
        now = et(end, "20:00")

        result = backfill(db_session, "AAPL", "1d", "stock", start, end, alpaca=alpaca, now=now)
        db_session.commit()

        assert result.uncovered == [date(2015, 12, 30), date(2015, 12, 31)]
        assert result.written == [date(2016, 1, 4), date(2016, 1, 5)]
        assert len(session_.calls) == 1  # the clamped range never reaches the provider

        got = read_bars(db_session, "AAPL", "1d", start, end, "stock", as_of=now)
        assert list(got.index) == [date(2016, 1, 4), date(2016, 1, 5)]


class TestProviderErrorMidway:
    def test_an_unavailable_range_leaves_earlier_writes_intact_and_names_where_it_stopped(self, db_session):
        # A session already stored (NEXT_DAY) splits [DAY, THIRD_DAY] into two separate
        # contiguous ranges, so the fake HTTP layer sees exactly two calls: one per range.
        now = et(THIRD_DAY, "20:00")
        upsert_bars(db_session, "AAPL", "1d", _frame_for(NEXT_DAY, 200.0), "alpaca", "stock", now=now)
        db_session.commit()

        first_range_body = {"bars": [_bar(DAY.isoformat(), 150.0)], "next_page_token": None, "symbol": "AAPL"}
        failing_responses = [FakeResponse(500, {}) for _ in range(4)]  # exhausts ThrottledClient's 3 retries
        alpaca, session_ = _alpaca_from(FakeResponse(200, first_range_body), *failing_responses)

        with pytest.raises(Unavailable) as excinfo:
            backfill(db_session, "AAPL", "1d", "stock", DAY, THIRD_DAY, alpaca=alpaca, now=now)
        db_session.commit()

        assert any("backfill stopped" in note for note in excinfo.value.__notes__)
        assert len(session_.calls) == 1 + 4  # the successful first range, then the exhausted retries

        got = read_bars(db_session, "AAPL", "1d", DAY, THIRD_DAY, "stock", as_of=now)
        assert list(got.index) == [DAY, NEXT_DAY]  # DAY written before the failure; THIRD_DAY never reached
        assert list(got["close"]) == [150.0, 200.0]


def _frame_for(day: date, price: float) -> pd.DataFrame:
    return pd.DataFrame(
        {"open": [price], "high": [price], "low": [price], "close": [price], "volume": [1_000.0]},
        index=pd.Index([day]),
    )
```

- [ ] **Step 15: Run it and watch it fail.**

Run (in `backend/`): `./scripts/test-db.sh tests/test_backfill.py`
Expected: collection error — `ModuleNotFoundError: No module named 'ai_trading.data.backfill'`.

- [ ] **Step 16: Implement `data/backfill.py`.**

```python
"""Backfills the missing sessions for one symbol/timeframe from Alpaca.

Glue between `ai_trading_common.alpaca.AlpacaBars` and the bar store
(`ai_trading.data.bars`): `missing_sessions` finds the gaps, this module groups them into
contiguous trading-session ranges, fetches each range through Alpaca, and `upsert_bars`s it
under Alpaca's own source label. `ai_trading_common` never imports the Desk; this is the one
module on the Desk side that imports both packages.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pandas as pd
from ai_trading_common.alpaca import AlpacaBars
from ai_trading_common.errors import ProviderError
from sqlalchemy.orm import Session

from ai_trading.core.calendar import Asset, previous_session, session
from ai_trading.data.bars import Timeframe, missing_sessions, upsert_bars

#: Alpaca's free Basic plan history starts here (02b §2 finding 4). Stooq, the Desk's planned
#: pre-2016 fallback, was dropped after Lane P1 found its CSV endpoint gated behind a JS
#: proof-of-work challenge with no API key offered -- there is currently no substitute, so a
#: request reaching further back is clamped, never fabricated.
ALPACA_FREE_HISTORY_START = date(2016, 1, 1)


@dataclass(frozen=True)
class BackfillResult:
    """What one `backfill` call covered within `requested`.

    `written`: the missing sessions a provider call was attempted for without error (a session
    with genuinely no bars in its own range, e.g. a quiet day, still counts -- `upsert_bars`
    simply stores nothing for it; this is not treated as a failure).
    `uncovered`: missing sessions before `ALPACA_FREE_HISTORY_START`, clamped out of every
    provider call and never fabricated.
    """

    requested: tuple[date, date]
    written: list[date]
    uncovered: list[date]


def _contiguous_ranges(asset: Asset, days: list[date]) -> list[tuple[date, date]]:
    """Groups `days` (already sorted ascending, as `missing_sessions` returns them) into the
    fewest `[start, end]` ranges of *actually adjacent* trading sessions -- a gap where some
    other, non-missing session sits between two missing ones starts a new range, so each
    resulting range is truly contiguous on the exchange calendar, not just adjacent in the
    list."""
    if not days:
        return []
    ranges: list[list[date]] = [[days[0]]]
    for day in days[1:]:
        if previous_session(asset, day) == ranges[-1][-1]:
            ranges[-1].append(day)
        else:
            ranges.append([day])
    return [(group[0], group[-1]) for group in ranges]


def backfill(
    session_: Session,
    symbol: str,
    timeframe: Timeframe,
    asset: Asset,
    start: date,
    end: date,
    *,
    alpaca: AlpacaBars,
    now: pd.Timestamp,
) -> BackfillResult:
    """Fills every missing `symbol`/`timeframe` session in `[start, end]` from Alpaca.

    A provider error (`ai_trading_common.errors.ProviderError` and its subclasses --
    `NotConfigured`, `Unavailable`, `SoftBanned`, `NoData`) propagates to the caller with its
    own type intact (never wrapped or swallowed), with a note attached naming the range the
    backfill was attempting when it failed (`exc.__notes__`, via `BaseException.add_note`).
    Every range upserted before that point is already applied to `session_` (not yet
    committed -- committing or rolling back is the caller's job, same as `upsert_bars`), so a
    caller that commits after catching the error keeps everything that did succeed.
    """
    missing = missing_sessions(session_, symbol, timeframe, asset, start, end)
    uncovered = [day for day in missing if day < ALPACA_FREE_HISTORY_START]
    to_fill = [day for day in missing if day >= ALPACA_FREE_HISTORY_START]

    written: list[date] = []
    for range_start, range_end in _contiguous_ranges(asset, to_fill):
        start_session = session(asset, range_start)
        end_session = session(asset, range_end)
        assert start_session is not None and end_session is not None  # missing_sessions only names real sessions

        try:
            bars = alpaca.bars(symbol, timeframe, start_session.extended_open, end_session.extended_close, now=now)
        except ProviderError as exc:
            exc.add_note(f"backfill stopped fetching {symbol} {timeframe} {range_start}..{range_end}")
            raise

        upsert_bars(session_, symbol, timeframe, bars.frame, bars.source, asset, now=now)
        written.extend(day for day in to_fill if range_start <= day <= range_end)

    return BackfillResult(requested=(start, end), written=written, uncovered=uncovered)


__all__ = ("ALPACA_FREE_HISTORY_START", "BackfillResult", "backfill")
```

- [ ] **Step 17: Run it and watch it pass.**

Run (in `backend/`): `./scripts/test-db.sh tests/test_backfill.py`
Expected: `3 passed`.

- [ ] **Step 18: Write the failing end-to-end test.** `tests/test_end_to_end.py`:

```python
"""End-to-end: a recorded Alpaca daily fixture goes through `backfill`, then `read_bars`, then
`ai_trading.core.evaluate.evaluate` with a simple template -- proving the client's frame shape
(`ai_trading_common.bars.Bars`), the store's shape (`ai_trading.data.bars`), and the core's
shape (`ai_trading.core.evaluate`) actually agree. Needs a real Postgres (`scripts/test-db.sh`).
"""

import json
from datetime import date
from pathlib import Path

from ai_trading_common.alpaca import AlpacaBars
from ai_trading_common.testing import FakeResponse, make_client

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import et
from ai_trading.core.evaluate import evaluate
from ai_trading.data.backfill import backfill
from ai_trading.data.bars import read_bars

FIXTURES = Path(__file__).parent / "fixtures" / "alpaca"


def test_backfilled_alpaca_bars_evaluate_cleanly(db_session):
    body = json.loads((FIXTURES / "daily_range_aapl.json").read_text())["body"]
    client, _, _ = make_client([FakeResponse(200, body)])
    alpaca = AlpacaBars("kid", "sec", http=client)

    start, end = date(2026, 1, 2), date(2026, 1, 14)
    now = et(end, "20:00")  # after the fixture's last session has closed

    result = backfill(db_session, "AAPL", "1d", "stock", start, end, alpaca=alpaca, now=now)
    db_session.commit()
    assert result.uncovered == []
    assert len(result.written) == 9  # every trading day in the fixture's range

    bars_1d = read_bars(db_session, "AAPL", "1d", start, end, "stock", as_of=now)
    assert len(bars_1d) == 9
    assert list(bars_1d.columns) == ["open", "high", "low", "close", "volume"]

    spec = StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "E2E smoke: close above 265",
            "watch": {"universe": {"symbols": ["AAPL"]}, "session": "regular", "runOn": "daily_close"},
            "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 265}},
            "then": {"alert": {"channels": ["inbox"]}},
        }
    )

    candidates = evaluate(spec, "AAPL", "stock", bars_1m=None, bars_1d=bars_1d, as_of=now)

    # The fixture's first close (270.27) is the only day above 265 that also starts the series
    # true -- a rising edge with no prior known state -- so exactly one candidate fires.
    assert len(candidates) == 1
    assert candidates[0].bar_time.date() == date(2026, 1, 2)
    assert candidates[0].evidence["close"] == 270.27
```

- [ ] **Step 19: Run it and watch it pass.**

Run (in `backend/`): `./scripts/test-db.sh tests/test_end_to_end.py`
Expected: `1 passed`. No shape mismatch between the client, the store, and the core's `evaluate` — the frame index type, column names, and dtypes agree at every hop on the first run.

- [ ] **Step 20: Run the full backend suite and lint, both with and without a database.**

Run (in `backend/`): `./scripts/test-db.sh`
Expected: `556 passed` (527 + 13 + 7 + 5 + 3 + 1).

Run (in `backend/`): `uv run pytest -q -rs`
Expected: `541 passed, 15 skipped` (the 15 skips are exactly the 2 migration tests plus the DB-only tests from this task: 8 in `test_bars_store.py`, 1 in `test_rolls.py`, 3 in `test_backfill.py`, 1 in `test_end_to_end.py`).

Run (in `backend/`): `uv run ruff check . && uv run ruff format --check .`
Expected: ruff clean.

- [ ] **Step 21: Update 02c's Phases table.** In `ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md`, replace:

```markdown
| 2. Data foundation | `ai-trading/common` providers (Alpaca, Stooq, SEC EDGAR, FRED, Finnhub, consensus EPS; IBKR after Phase 0), the Postgres schema, bar store, roll map, streaming slots | 1c; the IBKR client waits on 0 | `phase-2-data.md` | Planned |
```

with:

```markdown
| 2. Data foundation | `ai-trading/common` providers (Alpaca, SEC EDGAR, FRED, Finnhub, Alpha Vantage, Eulerpool, consensus EPS; IBKR after Phase 0), the Postgres schema, bar store, roll map, streaming slots | 1c; the IBKR client waits on 0 | [phase-2a-data-without-ibkr.md](02c-desk-v1-tasks/phase-2a-data-without-ibkr.md) | 2a done; 2b waits on Phase 0 |
```

- [ ] **Step 22: Update 02c's Phase 2 outline in place.** In the same file, replace:

```markdown
### Phase 2: Data foundation (2a without IBKR, 2b the IBKR client)

**Scope:**
- **`ai-trading/common/`** (new):
  - `http.py` (copied from Vibe-Trading's throttle) with a soft-ban latch;
  - typed provider errors and the fallback policy;
  - bar hygiene guards, and "never cache a trading day that has not closed".
- **Clients:**
  - Alpaca, moved from `ai-trading/market-data/` together with the open-source lane;
  - Stooq as the daily fallback;
  - SEC EDGAR, by filing date and span;
  - FRED, with vintages and release dates;
  - Finnhub: earnings calendar, dividends, news in publication windows;
  - consensus EPS: the Eulerpool 10-symbol pilot, written up in 02d, then the free fallback (02f §4).
- **2b:** the IBKR client through `ib_async`. Paper and data profiles and ports, the market-data type, live 1-minute bars, futures history, daily IV, option snapshots, and what-if margin.
- **Desk `ai_trading.db`:** SQLAlchemy and Alembic for every table in Shared Interfaces, plus the role and schema init under `deploy/postgres/`.
- **Desk `ai_trading.data`:**
  - the bar store, with backfill when a symbol joins a watchlist;
  - the roll map, using Phase 1c's dates;
  - the streaming slot manager;
  - read models, including typed evidence snapshots for tools and card backs.

**Reuse:** TradingAgents' router and errors (pattern), bar guards, SEC and FRED clients (adapt), and news windows (pattern); ai-hedge-fund's cache freshness rule and the 8-K announcement-date rule (pattern); Vibe-Trading's throttle (copy) and IBKR profiles (adapt).

**Acceptance:**
- contract tests on recorded responses, with no network in CI;
- store tests against a real Postgres container;
- the roll test (no cross-contract gap) and the slot-priority test;
- the throttle's limits;
- the pilot report.

**Size:** about 9 tasks: 2a with 7, 2b with 2.
```

with:

```markdown
### Phase 2: Data foundation (2a without IBKR, done; 2b the IBKR client)

**Scope (2a, done — [phase-2a-data-without-ibkr.md](02c-desk-v1-tasks/phase-2a-data-without-ibkr.md)):**
- **`ai-trading/common/`** (new):
  - `http.py` (copied from Vibe-Trading's throttle) with a soft-ban latch;
  - typed provider errors and one generic fallback-chaining helper (`first_success[T]`);
  - bar hygiene guards, and "never cache a trading day that has not closed".
- **Clients:**
  - Alpaca, moved from `ai-trading/market-data/` together with the open-source lane;
  - SEC EDGAR, by filing date and span, including 8-K `filings.files` paging;
  - FRED, with vintages and release dates;
  - Finnhub: earnings calendar, company news, recommendation trends, earnings surprises;
  - consensus EPS: the Eulerpool 10-symbol pilot, written up in 02d, with Finnhub and Alpha Vantage as the fallback (02f §4). Stooq is dropped (its CSV endpoint is gated behind a JS proof-of-work challenge with no API key offered); the Desk's effective daily-history start is 2016-01-01 unless 2b's IBKR client backfills further back.
- **2b:** the IBKR client through `ib_async`. Paper and data profiles and ports, the market-data type, live 1-minute bars, futures history, daily IV, option snapshots, and what-if margin.
- **Desk `ai_trading.db` (2a):** SQLAlchemy and Alembic for `bars_1d`, `bars_1h`, `bars_1m`, and `futures_rolls` only — every other table in Shared Interfaces arrives with the phase that first needs it (owner decision). The Postgres role and schema init under `deploy/postgres/` moves to Phase 3, where `desk-postgres` first joins the deploy compose file.
- **Desk `ai_trading.data` (2a):**
  - the bar store (closed-bar-only upserts, as-of reads, backfill planning, 1-minute retention) and the Alpaca backfill glue;
  - the roll map (contiguous windows, difference back-adjusted continuous series), using Phase 1c's dates;
  - the streaming slot manager.
  - Read models and typed evidence snapshots for tools and card backs move to the phases that consume them (3, 5, 7).

**Reuse:** TradingAgents' router and errors (pattern), bar guards, SEC and FRED clients (adapt), and news windows (pattern); ai-hedge-fund's cache freshness rule and the 8-K announcement-date rule (pattern); Vibe-Trading's throttle (copy) and IBKR profiles (adapt, 2b).

**Acceptance:**
- contract tests on recorded responses, with no network in CI;
- store tests against a real Postgres container;
- the roll test (no cross-contract gap) and the slot-priority test;
- the throttle's limits;
- the pilot report.

**Size:** about 10 tasks: 2a with 8 (done), 2b with 2.
```

- [ ] **Step 23: Remove 02b §5's Stooq mentions.** In `ai-trading/plans/subplans/02b-desk-market-data-options.md`, replace:

```markdown
| US stocks and ETFs | IBKR, 250 ms, pre/post market | Alpaca free: daily since 2016, hourly 5 years, 1-minute 30 days. Stooq for daily before 2016, marked `fallback`. | `bars_1d`, `bars_1h`, `bars_1m` (1-minute rolling 90 days) |
```

with:

```markdown
| US stocks and ETFs | IBKR, 250 ms, pre/post market | Alpaca free: daily since 2016, hourly 5 years, 1-minute 30 days. No source for daily history before 2016 (Stooq's CSV endpoint is gated behind a JS proof-of-work challenge with no API key offered, confirmed dead 2026-10-11, Phase 2a); IBKR can backfill further back in Phase 2b if the owner wants it. | `bars_1d`, `bars_1h`, `bars_1m` (1-minute rolling 90 days) |
```

- [ ] **Step 24: Append a sentence to STATUS.md's "5+" row.** In `ai-trading/plans/STATUS.md`, find the row beginning `| 5+ | Release 2 plan and build (Desk v1) |` and, inside its description cell, replace:

```markdown
Phase 1d (research math) done: as-of helpers, valuation methods, earnings reaction, the backtest engine, AI call settlement.
```

with:

```markdown
Phase 1d (research math) done: as-of helpers, valuation methods, earnings reaction, the backtest engine, AI call settlement. Phase 2a (data foundation without IBKR) done: `ai-trading-common` providers (Alpaca, SEC EDGAR, FRED, Finnhub, Alpha Vantage, Eulerpool, the consensus-EPS fallback chains), the Desk Postgres schema (`bars_1d`/`1h`/`1m`, `futures_rolls`), the bar store, the futures roll map, the streaming-slot allocator, and Alpaca backfill, with CI's `postgres:17` service.
```

- [ ] **Step 25: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/data ai-trading/packages/family-desk/backend/tests/test_bars_store.py ai-trading/packages/family-desk/backend/tests/test_rolls.py ai-trading/packages/family-desk/backend/tests/test_slots.py ai-trading/packages/family-desk/backend/tests/test_backfill.py ai-trading/packages/family-desk/backend/tests/test_end_to_end.py ai-trading/packages/family-desk/backend/tests/fixtures/alpaca/daily_range_aapl.json ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md ai-trading/plans/subplans/02b-desk-market-data-options.md ai-trading/plans/STATUS.md
git commit -m "feat(ai-trading): Desk data layer -- bar store, futures roll map, slot allocator, Alpaca backfill"
```
