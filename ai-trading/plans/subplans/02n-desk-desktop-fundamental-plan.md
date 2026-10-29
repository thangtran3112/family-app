# 02n: Family Desk desktop Fundamental lane (the owner's view)

Status: planned 2026-10-24 (docs only; nothing activated). This is roadmap step 3 of [02l](02l-desk-desktop-first-mvp.md) §f: the
desktop Fundamental views, built after the desktop Technical MVP ([02l](02l-desk-desktop-first-mvp.md), [02m](02m-desk-mvp-implementation-spec.md),
STATUS rows 5D–5F). **Mocks (2026-10-24):** FD1–FD8 are complete and the owner gate has passed. **Code:** the consensus snapshot job
(step 3a, `0004_consensus_history`) is built; Practice then took `0005` to `0011`, so the rest of the migration below is
`0012_fundamental_lane` (built 2026-10-29 with the models, the settings keys and `short_call_risks` with an optional delta;
see the revision note below). It delivers 02c Phase 5 (long-term, covered calls, Desk AI) desktop-first and reuses everything 02l/02m built:
the `DesktopShell`, the 1440 and 1180 bands, the lane switch, the wrong-lane interstitial, `DenseTable`, `useDeskQuery`, the
`lib/desk/freshness.ts` copy table, the `stamp` convention, and the stub-first stream order. Nothing here redesigns them.

**Data-source revision (owner, 2026-10-29; [02b](02b-desk-market-data-options.md) §4b).** Wherever this plan says "IBKR slot",
"IBKR option chains", "IBKR quotes" or the "Monday probe", read it as: option chains, option quotes and Δ come from Alpaca's
options feed (OPRA; delayed until the $99 Algo Trader Plus tier is bought, which waits until the products are tested and the
bugs are fixed); IBKR is only the Flex holdings import (`IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY_ID` in Firestore `ai-trading/desk`);
US futures prices are deferred, so FD6 keeps roll and expiry dates and the macro week and its prices say "futures deferred".
The registry's `option_chain` kind (built in step 3c-a) resolves through the delayed `alpaca_options` provider, so
`fundamental/sources.py` reports the chain `delayed-15m`; it is `not_configured` only while the Alpaca keys are unset.

**Step 3c-b built (2026-10-29): the real services.** With `DESK_FUNDAMENTAL_STUB` off, these 13 of the 20 endpoints answer
from services: holdings (`GET /holdings`, `/holdings/{symbol}/lots`, `POST /holdings/import`, `PATCH /accounts/{id}`),
covered calls (coverage, candidates, short calls, roll, income) and research (brief, symbol, valuation, timeline). Four stay
503 behind the flag: `/dashboard/fundamental`, `/futures/readings` (futures deferred, 02b §4b) and the two fundamental-alert
routes (step 5 scoring). `/status` reports the real import state and the chain's last read. Covered calls resolve each request
from the `quotes` kind (spot), the `option_chain` kind (calls, DTE from the user's filters) and the newest Flex statement,
through `core/covered_calls.py` unchanged; the scan job and its stored scans (`covered_call_scans`, `iv_history`) are step 6,
so IV rank stays null until 60 sessions of IV history exist. The Desk AI verdict is null and the brief has no rows until step 5.
The Alpaca key currently answers 401, so live chain calls read `unavailable` until a valid key is set; tests use fixtures.

Inputs read: 02l §b–§d, 02m §a, §c and §e, the R3 persona-split plan (`paper-persona-split-plan.md`, local Hermes run
`desk-activation-20261020`; its F1–F12 mobile boards are content reference, not layouts), [02g](02g-desk-covered-calls-and-futures-swing-design.md),
[02f](02f-desk-indicators-and-ai-daily-design.md), [02h](02h-desk-research-tools-design.md), [02d](02d-desk-spike-results.md) §7 (Flex),
and the code on this branch (`core/covered_calls.py`, `core/futures.py`, `core/valuation.py`, `core/earnings_reaction.py`,
`core/settlement.py`, the `ai_trading_common` registry kinds, `frontend/lib/lanes.ts`, `components/shell/desktop/*`).

## a. Who it serves, goal, and lane rules

**Who.** The owner: a fundamental investor who holds long-term positions, sells covered calls on them for income, and trades
futures casually. For swing and futures trades the owner switches to the Technical view, which already exists (02l). The
Fundamental view is the owner's default (`settings.default_view = "fundamental"`).

**Goal.** At 1440 px, with the 1180 band, the owner can:

- see the day: what needs attention on the holdings (short calls near the strike, earnings or ex-dividend before an expiry, a new
  covered-call opportunity, a Desk AI change), the portfolio's day, and the market strip;
- see real holdings from the IBKR Flex `desk-holdings` query (LOT level, 21 records at the 2026-10-24 probe), with money values
  masked by default;
- see coverage per holding, the best covered calls with the engine's annualized yield, open short calls with their risk in words,
  roll choices, and premium income by month;
- read futures context (ES, NQ, CL, GC: last, day change, weekly range, roll and expiry dates, the macro week) without any trading
  control;
- read research per stock: the Desk AI verdict, consensus EPS and revisions, valuation and earnings reaction, and the timeline;
- set the Fundamental settings: accounts, masking, covered-call scan filters, and the fundamental alert templates.

**The engine is authoritative.** Covered-call numbers come from `core/covered_calls.py` unchanged:
`premium_yield = bid / spot`, `annualized_yield = premium_yield × 365 / DTE`, the 02 §6.3 filters (DTE 21–45, Δ 0.15–0.30, open
interest ≥ 100, spread ≤ 10% of mid, bid ≥ $0.10), the score, the top three, `is_opportunity` (≥ 15% a year, IV rank ≥ 50, no flags),
`coverable_contracts`, `short_call_risks`, and `roll_candidates`. The frontend never recomputes them; it formats them.

**Lane rules (R3 §a, unchanged).** The Fundamental view never shows RSI, MACD or VWAP values, ORB or pattern setups, the screener,
the position sizer, futures strategy drafts, or any order control. A price chart without indicators is allowed on the stock page.
"Reading only · switch to the Technical view to trade futures or swing" stands where a trading control would be.

## b. Desktop Fundamental screen map

### b1. Navigation and routes

- **Primary nav (Fundamental lane):** **Today · Holdings · Covered calls · Stocks · Futures**; Settings and More under the avatar
  menu, as in the Technical lane. This extends the existing `PRIMARY_NAV.fundamental` (Holdings, Covered calls, Stocks) in
  `lib/lanes.ts`.
- **Shared routes render the active lane's variant** (R3 §a "same routes render the active lane's variant"). `lib/lanes.ts` gains a
  third value, `"shared"`, for `/`, `/today`, `/watchlists`, `/settings`, `/more`, and `/futures/specs`; the page picks its variant
  from `useDeskUi().lane`. Lane-only routes keep the interstitial: Fundamental owns `/holdings`, `/covered-calls`, `/stocks`, and
  `/futures/read` (longest prefix wins over the Technical `/futures`).
- **Left rail (Fundamental):** tabs `Holdings | Watchlists`. Holdings: dense rows (symbol, weight %, change %, a violet AI rating
  dot). Watchlists: the owner's `long_term` lists (`watchlists.horizon`, already in the schema). 1180: 240 px, symbol, weight,
  change only.
- **Right rail (Fundamental):** for the selected symbol, the Desk AI verdict card (violet), a covered-call mini card (coverable
  contracts, best candidate, open calls), and upcoming events (earnings, ex-dividend). 1180: a 40 px strip
  `Verdict · Calls · Events` with the 320 px drawer (02l §b3 rule 2).
- **Masking:** a `Show values | Hide values` toggle in the top bar (`Alt+M`). Hidden is the default on every load
  (`settings.mask_values`, default `true`). Hidden renders dollar amounts, share counts, and contract counts as `•••••`; prices per
  share, percentages, dates, and symbols stay visible. The API returns real values; masking is a render rule in
  `lib/desk/mask.ts`. Broker account numbers never leave the backend (§c1).

### b2. R3 mobile F-boards: port, merge, retire

| R3 mobile board | Desktop decision | Desktop screen |
|---|---|---|
| F1 Today | **Port** | FD2 Today |
| F2 Watchlist | **Merge** into Holdings: the `Watchlists` rail tab shows a `long_term` list in the same table component | FD3 |
| F3 Watchlist parameters | **Retire** as a screen. Desktop has room for the columns, so a `Columns` menu (up to 8 of §c4's metric keys, saved in `settings.fundamental_columns`) replaces it. Threshold flags and "Make it an alert" are deferred (§f) | FD3 |
| F4 Covered calls overview | **Port** | FD4 Covered calls · Scan |
| F5 Open calls & income | **Port** | FD5 Covered calls · Open calls & income |
| F6 Short-call risk detail | **Merge** into FD5 as the right detail pane (list/detail split, 02l §b2) | FD5 |
| F7 Futures reading | **Port** | FD6 Futures reading |
| F8 Stock daily brief | **Port** | FD7 AI daily brief |
| F9 Stock AI track record | **Retire for now**: calls settle 90 trading days after the first verdict, so the screen would be empty until 2027. A track-record tile (calls, settled, pending) sits on FD7 | FD7 tile |
| F10 Stock valuation & earnings | **Port** | FD9 |
| F11 Stock timeline (already 1440) | **Port** into the desktop shell | FD10 |
| F12 Ask (Fundamental) | **Retire** from this lane: research chat stays in Vibe-Trading on the hub; no Desk chat surface in this phase | none |

**New desktop screens (no R3 F source):** FD1 Fundamental shell and states; FD3 Holdings (source: the fixture `/holdings` page and
R2 D5); FD8 Stock overview (source: R2 D11 and M8, the 02f long-term stock page); FD11 Settings, Fundamental (source: S1 and the
Technical D11).

### b3. Screens

| # | Screen | Route | Family | Content (sources) | Gate (§e) |
|---|---|---|---|---|---|
| FD1 | Shell and states | none (layout) | shell | Fundamental left and right rails, nav, mask toggle, and the new states of §b4 | now |
| FD2 | Today | `/`, `/today` (Fundamental variant) | Today | portfolio strip (value, day change, unrealized; masked); market strip (SPY, QQQ, IWM, `/ES`, `/NQ`); "Needs you" feed: short-call risks, earnings within 7 days, ex-dividend before an expiry, covered-call opportunities, Desk AI changes, import problems; income-this-month and open-calls tiles; the macro week | now; opportunities and AI changes join when their sources do |
| FD3 | Holdings | `/holdings`, `/watchlists` (Fundamental variant) | Holdings | import line ("Holdings as of Fri 2026-10-23 close · IBKR Flex · 21 lots"); account filter (alias and type only); `DenseTable`: symbol, shares, avg cost, last, change %, market value, weight %, unrealized %, coverable contracts, open calls, next earnings, AI rating, plus the chosen metric columns; right pane: tax lots of the selected symbol (acquired, shares, cost, short or long term, gain %) and its short calls | now (interim query only with the owner's go; data account after Monday) |
| FD4 | Covered calls · Scan | `/covered-calls#scan` | Covered calls | coverage table per holding and account (shares, cap %, open contracts, coverable, reason in words: "120 shares: under one contract at a 50% cap", "earnings Oct 30: waits", "fully covered at its cap"); for the selected holding the top three candidates (expiry, strike, DTE, bid, Δ, premium yield, **annualized yield**, upside cap, return if called, OI, spread %, flags, score); IV rank; opportunity banner; payoff sketch with numeric axes; Desk AI context chip (violet); `Alert me` (covered-call income template); `OrdersOffNotice` where "Paper sell" was | coverage now; candidates, IV rank, opportunity after the IBKR slot |
| FD5 | Covered calls · Open calls & income | `/covered-calls#income` | Covered calls | open short calls (symbol, account, strike, expiry, DTE, contracts, spot, moneyness %, Δ, risks in words); right pane = F6: cost to close, roll candidates (net credit, DTE, Δ, flags), assignment note by account type ("not tax advice"); premium by month (bars, numeric $ axis), assignments, Monday digest preview | list and rules without Δ now; Δ, roll after the IBKR slot; income history after the data-account Flex query adds Trades |
| FD6 | Futures reading | `/futures/read` | Futures | ES, NQ, CL, GC rows: front contract, last, day change, weekly high/low, next roll, expiry; the week's macro releases (FRED); contract-size reference linking to `/futures/specs`; banner "Reading only · to trade futures or swing, switch to the Technical view" with `Switch to Technical` | roll, expiry, macro now; prices after the IBKR slot |
| FD7 | AI daily brief | `/stocks` | Research | every analyzed stock after the close: rating and change, base target, upside %, confidence, EPS revision 30d, earnings within 7 days, stale marker; run line (ran at, analyzed, skipped, cost); track-record tile | AI verdict job (step 5) |
| FD8 | Stock overview | `/stocks?symbol=…#overview` | Research | verdict card (rating chip, target range bar, confidence, reasons, risks, what changed) with "How Desk AI decided" (votes, bull and bear, inputs with as-of); consensus EPS (quarters, FY, beats and misses, next earnings, revisions 7/30/90d); analyst targets as context; a 1D/1W price chart without indicators; `Alert me` toggles (AI daily view template) | consensus now; verdict at step 5 |
| FD9 | Valuation & earnings | `/stocks?symbol=…#valuation` | Research | four methods (DCF, owner earnings, EV/EBITDA, residual income) and the 60/40 blend vs price; assumptions with the `core/valuation.py` fallbacks stated in words; earnings reaction over the last 8 reports (average absolute move, excess vs SPY, beats vs misses) with a numeric-axis chart; options-implied move | now; implied move after the IBKR slot |
| FD10 | Timeline | `/stocks?symbol=…#timeline` | Research | filters All, Earnings, Desk AI, News, Strategy, Filings; dated items newest first, each with source and link | now (Desk AI items from step 5) |
| FD11 | Settings, Fundamental | `/settings`, `/more` (Fundamental variant) | Settings | default view; masking default; accounts (alias, type `taxable | ira | roth`); holdings import (source, account, last import, `Import now`); covered-call scan filters and cover cap (02 §6.3 defaults, bounded); fundamental alert templates on/off; alert channels and market-data rows (reuse D11 components); broker rows disabled with the orders-off reason | now |
| FD12 | 1180 band | `/holdings`, `/covered-calls#scan` at 1180 | 1180 | duplicates of FD3 and FD4 applying 02l §b3 (dropped columns on FD3; collapsed right rail with the `Calls` drawer open on FD4) | as FD3, FD4 |

**1180 column drop orders (lowest first):** FD3 `next_earnings`, `ai_rating`, `open_calls`, `unrealized_pct`; FD4 candidates
`spread_pct`, `open_interest`, `return_if_called`, `upside_cap`; FD5 `moneyness_pct`, `contracts`; FD7 `eps_rev_30d_pct`,
`confidence`. No Fundamental table scrolls horizontally.

### b4. New copy-table rows (`lib/desk/freshness.ts`, same banned-term rule)

| State | Wording |
|---|---|
| Holdings fresh | "Holdings as of Fri 2026-10-23 close · IBKR Flex" |
| Importing (client state) | "Importing holdings…" |
| Import failed | "Couldn't import holdings · showing Thu 2026-10-22 · Try again" |
| Not connected | "Holdings aren't connected yet · set up the IBKR import in Settings" |
| No holdings for this user | "No holdings imported for you" |
| Option quotes not connected | "Option quotes connect after the IBKR setup" |
| IV rank short history | "IV rank needs more history · opportunity alerts start later" |
| Ex-dividend unknown | "Ex-dividend date unknown · check before selling a call" |
| Desk AI not started | "Desk AI starts after its first daily run (5:05 PM ET)" |
| Desk AI stale | "Desk AI view from Thu · today's update didn't finish" |
| Values hidden | "Values hidden · Show values" |
| Futures reading only | "Reading only · switch to the Technical view to trade futures or swing" |
| Tax | "Not tax advice" |

## c. API surface extensions (02m §a1 conventions)

All paths are under `/api/desk`; every router uses `APIRouter(..., dependencies=[Depends(get_current_user)])`; every row is scoped to
`user.id` (non-owner = 404); timestamps are ISO-8601 UTC; market data carries `stamp {as_of, source, quality, freshness}`; numbers are
`FiniteFloat | None`, never `NaN`; validation failures are `422 {"detail": {"problems": [...]}}`. No path contains `order`,
`position`, or `broker`, so the 02m §d3 no-orders route test keeps passing.

### c1. Privacy rules

- **Whose holdings.** The Flex import belongs to one Desk user, named by a `family-config` key (`DESK_FLEX_USER`, value only in
  Firestore `ai-trading/desk`). A user cannot claim it through `PUT /settings`. Every other user gets empty holdings and the "No
  holdings imported for you" state.
- **Account identifiers.** The broker account number is stored in `accounts.external_id` (to match imports) and is never returned.
  The API returns `{id, label, type}`; the label is owner-set ("IRA", "Taxable"), defaulting to "Account 1", "Account 2". A test
  serializes every Fundamental response for a seeded import and asserts the external id appears nowhere.
- **Logs and snapshots.** Import logs record counts and states, never values (02d §7). The mock snapshot file stays gitignored.

### c2. Endpoint inventory (20: 17 new, 3 extended)

| # | Method and path | | Screen | Purpose |
|---|---|---|---|---|
| 1 | GET `/dashboard/fundamental` | N | FD2 | one aggregate read for Fundamental Today |
| 2 | GET `/holdings?account_id=` | N | FD1, FD2, FD3 | import state, accounts, totals, holdings rows, option lots |
| 3 | GET `/holdings/{symbol}/lots` | N | FD3 | tax lots and short calls for one symbol |
| 4 | POST `/holdings/import` | N | FD3, FD11 | run the Flex import now (idempotent per statement date) |
| 5 | PATCH `/accounts/{id}` | N | FD11 | set label and type |
| 6 | GET `/covered-calls/coverage` | N | FD4 | coverage per holding and account with reasons |
| 7 | GET `/covered-calls/candidates?symbol=&account_id=` | N | FD4, right rail | top three from the latest scan |
| 8 | GET `/covered-calls/short-calls` | N | FD2, FD5 | open short calls with risks |
| 9 | GET `/covered-calls/short-calls/{id}/roll` | N | FD5 | cost to close, roll candidates, assignment note |
| 10 | GET `/covered-calls/income?months=12` | N | FD2, FD5 | premium by month and assignments |
| 11 | GET `/futures/readings` | N | FD6 | ES, NQ, CL, GC rows and the macro week |
| 12 | GET `/research/brief?date=` | N | FD7 | AI daily brief rows, run summary, track-record counts |
| 13 | GET `/research/symbols/{symbol}` | N | FD8, right rail | verdict, consensus, targets |
| 14 | GET `/research/symbols/{symbol}/valuation` | N | FD9 | valuation methods and earnings reaction |
| 15 | GET `/research/symbols/{symbol}/timeline?kind=&limit=&offset=` | N | FD10 | timeline items (paginated like `/signals`) |
| 16 | GET `/fundamental-alerts` | N | FD4, FD8, FD11 | the three templates' state |
| 17 | PUT `/fundamental-alerts/{template}` | N | FD4, FD8, FD11 | toggle or edit rules (saves a new strategy version) |
| 18 | GET `/status` | X | FD1, FD11 | adds `holdings`, `options`, `ai_daily` |
| 19 | PUT `/settings` (GET returns the keys) | X | FD1, FD3, FD11 | validates `mask_values`, `fundamental_columns`, `covered_calls` |
| 20 | GET `/watchlists/{id}/table` | X | FD3 | `long_term` lists add a `fundamentals` object per row |

Reused unchanged: `/me`, `/symbols/search`, `/watchlists` CRUD and items, `/alerts` (the inbox shows fundamental alerts too),
`/alerts/{id}/read`, `/alerts/read-all`, `GET /settings`, `/settings/channels*`, `/futures/specs`, `/bars/{symbol}` (FD8 price chart).
After this phase `/api/desk` has **70** routes (53 + 17).

### c3. Shapes in brief

TypeScript-style; stream S writes Pydantic models, stream F zod schemas that `satisfies` the generated types (02m §a3).

```ts
// 1
DashboardFundamental = { stamp: Stamp, market: { session, next_open },
  market_strip: StripTile[],                     // SPY, QQQ, IWM, /ES, /NQ; futures "unavailable" until the IBKR slot
  portfolio: { value, day_change, day_change_pct, unrealized_pct, import: ImportState },
  feed: { kind: "short_call_risk" | "earnings_soon" | "ex_dividend" | "cc_opportunity" | "ai_change" | "import",
          symbol: string | null, title: string, detail: string, at: string, href: string }[],   // max 20, newest first
  income: { month_to_date, open_calls, next_expiry: string | null },
  events: { symbol: string | null, kind: "earnings" | "ex_dividend" | "macro", date, label }[] }

ImportState = { source: "ibkr_flex", account_scope: "data" | "main_interim", statement_date: string | null,
  imported_at: string | null, lots: number, state: "ok" | "running" | "failed" | "not_configured" | "none" }

// 2
Holdings = { import: ImportState, accounts: { id, label, type: "taxable" | "ira" | "roth" }[],
  totals: { market_value, cost, unrealized, unrealized_pct, day_change, day_change_pct },
  rows: { symbol, name, account_ids: number[], shares, avg_cost, last, change_pct, market_value, weight_pct, unrealized_pct,
          coverable_contracts, open_calls, next_earnings: string | null, ai_rating: AiRating | null,
          fundamentals: Fundamentals, stamp: Stamp }[],
  option_lots: { id, symbol, account_id, right: "C" | "P", strike, expiry, contracts }[] }      // contracts < 0 = short

// 3
Lots = { symbol, lots: { account_id, shares, cost_per_share, acquired, term: "short" | "long", gain_pct }[],
  short_calls: ShortCallRow[] }

// 4  POST /holdings/import  ->  202 { import: ImportState }; 409 when one ran in the last 60 s (Flex allows 10 requests a minute)
// 5  PATCH /accounts/{id}  body { label?, type? }  ->  { id, label, type }

// 6
Coverage = { cap_pct, rows: { symbol, account_id, shares, open_contracts, coverable,
  reason: "ok" | "under_one_contract" | "earnings_wait" | "fully_covered" | "no_chain", reason_text }[] }

// 7  (engine fields exactly as core/covered_calls.Candidate)
Candidates = { symbol, account_id, spot, spot_stamp: Stamp, chain_stamp: Stamp, iv_rank: number | null,
  iv_history_sessions: number, opportunity: boolean,
  candidates: { expiry, strike, dte, bid, ask, delta, premium_yield, annualized_yield, upside_cap, return_if_called,
                spread_pct, open_interest, flags: string[], score }[],
  ai_context: { rating: AiRating, target_base, note: string | null } | null }   // empty list + chain freshness "unavailable" before IBKR

// 8
ShortCallRow = { id, symbol, account_id, strike, expiry, contracts, dte, spot, moneyness_pct, delta: number | null,
  risks: { kind: "delta_above_0_50" | "near_strike_near_expiry" | "early_assignment_before_dividend" | "earnings_before_expiry",
           text: string }[], stamp: Stamp }

// 9
Roll = { cost_to_close: number | null, candidates: { expiry, strike, dte, delta, net_credit, flags: string[] }[],
  assignment_note: { account_type, text }, chain_stamp: Stamp }

// 10
Income = { by_month: { month: "2026-10", premium, contracts }[], assignments: { date, symbol, contracts, strike }[],
  ytd_premium, source_stamp: Stamp }                 // empty with state "needs_trades" until the Flex query has Trades

// 11
FuturesReadings = { rows: { root: "/ES" | "/NQ" | "/CL" | "/GC", front: string, last, change_pct, week_high, week_low,
  next_roll: string, expiry: string, stamp: Stamp }[],      // prices null + "unavailable" until the IBKR slot
  macro_week: { date, release: string, series_id: string }[] }

// 12
Brief = { date, run: { ran_at, analyzed, skipped, cost_usd } | null,
  rows: { symbol, rating: AiRating, prev_rating: AiRating | null, target: { low, base, high }, upside_pct, confidence,
          eps_rev_30d_pct, earnings_in_days: number | null, stale_days: number }[],
  track_record: { calls, settled, pending } }

// 13
Research = { symbol, verdict: { rating, target: { low, base, high }, confidence, reasons: string[], risks: string[],
    changed: string, votes: { name, signal: "buy" | "hold" | "sell", score, reasons: string[] }[], bull: string, bear: string,
    inputs: { name, as_of }[], as_of, stale_days } | null,
  consensus: { quarters: { period, eps_estimate, analysts }[], fiscal_years: { period, eps_estimate, analysts }[],
    surprises: { period, actual, estimate, surprise_pct }[], next_earnings: { date, timing } | null,
    revisions: { d7, d30, d90 } } | null,                   // a revision is null until that much snapshot history exists
  targets: { low, mean, high, counts: { buy, hold, sell } } | null, stamp: Stamp }

// 14
Valuation = { price, methods: { id: "dcf" | "owner_earnings" | "ev_ebitda" | "residual_income", value: number | null,
    inputs: Record<string, number | null>, fallbacks: string[] }[], blend: number | null, filing_as_of,
  earnings_reaction: { reports, avg_abs_move_pct, avg_excess_pct, beats: { n, avg_excess_pct }, misses: { n, avg_excess_pct },
    series: { date, move_pct, excess_pct }[], implied_move_pct: number | null } | null }     // null below 4 reports (02h §7)

// 15
Timeline = { items: { at, kind: "earnings" | "desk_ai" | "news" | "strategy" | "filing" | "macro" | "consensus",
  title, detail, source, href: string | null }[], total }

// 16, 17
FundamentalAlert = { template: "covered_call_income" | "short_call_risk" | "ai_daily_view", enabled: boolean,
  scope: "holdings" | { watchlist_id: number }, rules: Record<string, number | boolean>, strategy_id: number | null }
// ai_daily_view rules: rating_change, cross_target, eps_revision_pct (3), earnings_within_days (3), confidence_below (50) — 02f §6

// 18  /status adds
holdings: ImportState; options: Stamp & { state: "connected" | "not_connected" };
ai_daily: { state: "not_started" | "ok" | "partial" | "failed", last_run_at: string | null }

// 19  settings keys
mask_values: boolean (true); fundamental_columns: MetricKey[] (max 8);
covered_calls: { min_dte, max_dte, min_delta, max_delta, min_open_interest, max_spread_pct, min_bid, cap_pct }
  // defaults = core/covered_calls.Filters plus cap_pct 50; 422 when min > max or outside the engine's sane bounds
```

### c4. Fundamental metric keys (like 02m §a1's technical keys)

`Fundamentals` (holdings rows, `long_term` watchlist rows, the `Columns` menu) uses exactly these keys, numbers or `null`:
`fwd_pe, pe_vs_5y_median_pct, fcf_yield_pct, revenue_growth_yoy_pct, debt_to_equity, eps_rev_7d_pct, eps_rev_30d_pct,
eps_rev_90d_pct, next_earnings, dividend_yield_pct, ex_dividend, ai_rating, ai_target_base, ai_upside_pct,
dist_to_252d_high_pct, weight_pct, gain_vs_cost_pct, cc_coverable`. Default columns (R3 §d): `fwd_pe, pe_vs_5y_median_pct,
fcf_yield_pct, eps_rev_30d_pct, next_earnings, cc_coverable`.

## d. Backend modules (under `backend/src/ai_trading/`)

Most math exists (`core/covered_calls.py`, `options_math.py`, `futures.py`, `valuation.py`, `earnings_reaction.py`, `settlement.py`,
`asof.py`) and the providers exist (`fundamentals`, `consensus`, `earnings`, `targets`, `earnings_calendar`,
`earnings_announcements`, `news`, `macro` kinds). New code is storage, jobs, and thin services.

| Module | New or extended | Responsibility | Gate |
|---|---|---|---|
| `holdings/flex.py` | new | Flex v3 client: `SendRequest`, then poll `GetStatement` (1 request a second, 10 a minute); XML parse that rejects DTDs and entities (trust boundary); maps `OpenPositions` LOT rows (stocks and options) and, when present, `Trades` rows | **built 3c-b** (fixture); live per §e |
| `holdings/importer.py` | new | idempotent import per (account, statement date): upsert `accounts` by external id, write `holding_imports` and `holding_lots` (and `holding_trades`); assigns the import to the `DESK_FLEX_USER`; hooks into `jobs/premarket.py` and `POST /holdings/import` | **built 3c-b** for `POST /holdings/import` (a background task, state in process memory); the `premarket` hook waits for the owner's go on live Flex |
| `holdings/service.py` | new | holdings rows: lots grouped per symbol and account, market value from the latest close (`data/bars.py`), weights, gains, short or long term, coverable contracts | **built 3c-b** |
| `covered_calls/service.py` | new | coverage and reasons (`coverable_contracts`, earnings wait); candidates from the latest stored scan; short-call rows with `short_call_risks`; roll via `roll_candidates`; income and assignments from `holding_trades` | **built 3c-b** (candidates, roll and income resolve per request; no stored scan yet) |
| `covered_calls/scan.py` | new | the 15:30 ET scan job (02c Phase 5): per holding with coverable > 0, fetch the chain through the registry, run `candidates`, store `covered_call_scans`; record IV30 in `iv_history`; evaluate the covered-call income and short-call risk templates into `signals` and the existing outbox | IBKR slot |
| `core/covered_calls.py` | extended (one change) | `short_call_risks` accepts `delta: float | None` and `extrinsic: float | None` and skips the rules that need them (unknown data never fires a rule, Phase 1 ruling), so the date and strike rules run before option quotes exist | now |
| `futures/readings.py` | new | ES, NQ, CL, GC rows: front month and roll and expiry dates from `core/futures.py`; last, change, weekly range from the registry `quotes` kind (IBKR slot, 02m §b4); the week's releases from FRED `release_dates` for a fixed series list (CPI, PPI, payrolls, PCE, GDP, retail sales) | dates now; prices IBKR slot |
| `research/consensus.py` | new | daily snapshot job after 16:30 ET: `consensus_snapshots`, `earnings_results`, `analyst_targets` (02f §4); revisions from the Desk's own snapshots. **Start this first:** 7/30/90-day revisions need that much history | now |
| `research/fundamentals.py` | new | the §c4 metric row per symbol (SEC facts, consensus, bars) into `symbol_fundamentals`, in `daily_close` for holdings and `long_term` watchlist symbols | now |
| `research/valuation.py` | new (thin) | `core/valuation.py` and `core/earnings_reaction.py` on stored filings and bars, cached per filing date; implied move from the chain when present | **built 3c-b**; implied move not built (null) |
| `research/timeline.py` | new | read model over earnings, verdicts, consensus, news, filings, signals (02h §5); no new source | **built 3c-b** (no `desk_ai` or `macro` items) |
| `ai/verdict.py`, `ai/votes.py`, `jobs/ai_daily.py` | new | the 17:05 ET Desk AI verdict (02f §5): four votes, one structured call, the code checks, content-hash cache, the stale path, `llm_usage` cost; writes `ai_verdicts` and, on a rating change, `ai_calls` (settlement job later, §f) | step 5 (new dependency, §g) |
| `alerts/fundamental.py` | new | the three templates' toggles as `strategies` rows with `lane = 'fundamental'` and versions; the scan job and the AI job evaluate them | now (rules fire when their data exists) |
| `api/holdings.py`, `api/covered_calls.py`, `api/research.py`, `api/fundamental_alerts.py` | new | thin routers per §c | |
| `api/dashboard.py`, `api/futures.py`, `api/status.py`, `api/settings.py`, `api/watchlists.py` | extended | `/dashboard/fundamental`, `/futures/readings`, and the §c2 X items | |

**Migration `0004_fundamental_lane`** (additive, reversible, with role grants in `docker/postgres/zz-20-desk-roles.sh` and
`tests/test_db_roles.py`): `accounts` (`id`, `owner_user_id`, `broker`, `external_id` unique per broker, `label`, `type`),
`holding_imports` (`account_id`, `source`, `statement_date`, `imported_at`, `lots`, `state`, `detail`; unique per account and
statement date), `holding_lots` (`import_id`, `account_id`, `symbol`, `asset_class` `STK | OPT`, `quantity`, `cost_per_share`,
`acquired`, option `right`, `strike`, `expiry`, `multiplier`), `holding_trades` (option sells, buys, assignments for income),
`covered_call_scans` (`symbol`, `account_id`, `run_at`, `stamp`, `iv_rank`, `candidates jsonb`), `iv_history` (`symbol`, `day`,
`iv30`), `consensus_snapshots`, `earnings_results`, `analyst_targets`, `symbol_fundamentals` (`symbol` PK, `as_of`, `metrics jsonb`),
`ai_verdicts`, `ai_calls`. `ai_call_outcomes` and backtest tables are not added.

**`ai-trading/common` (02j addendum):** an `option_chain` registry kind, **built in step 3c-a** as the delayed Alpaca options
provider (`alpaca_options`: chain plus bid, ask, OI, model delta, IV); futures roots in a `quotes` provider stay deferred (02b §4b).

## e. What is available now vs gated on the Monday 2026-10-26 IBKR probe

The Monday order is 02l §e1's: retry the data user's Reporting grant, then the Gateway probe at 09:30 ET (owner phone approval),
then move Flex to the data user. "IBKR slot" below means the probe passed and Phase 2b's client is live behind the registry.

| Available now (Alpaca, free providers, Flex fixture) | Gated |
|---|---|
| Holdings import code, tested on a recorded-shape fixture with invented values | **Live holdings:** from the data user's Flex query after Monday's Reporting grant. The interim main-account query is owner-gated (STATUS 2026-10-24 account policy): an agent reads it only with the owner's explicit go |
| Coverage list and reasons (lots plus `coverable_contracts`, earnings dates) | **Candidates table, annualized yield, IV rank, opportunity banner:** IBKR option chains. IV rank also needs 60 sessions of IV30 (about Fri 2027-01-22 if snapshots start Tue 2026-10-27) unless the probe shows IBKR historical implied volatility can backfill a year |
| Open short calls from Flex option lots; moneyness from Alpaca spot; the near-strike and earnings risk rules | **Δ, the Δ > 0.50 rule, early-assignment rule (needs extrinsic), roll panel, cost to close:** IBKR option quotes |
| Futures roll and expiry dates, specs, macro week (FRED) | **ES, NQ, CL, GC last, change, weekly range:** IBKR slot (and 02l §e1 decision 3, the CME non-professional subscription, if the probe shows the data user lacks it) |
| Consensus EPS, targets, earnings dates, revisions (snapshots start now) | **Premium income by month and assignments:** the data user's Flex query with a `Trades` section (§g decision 2) |
| Fundamental metric columns, valuation, earnings reaction, timeline | **Options-implied earnings move:** IBKR option quotes |
| Today feed (risks, earnings, ex-dividend when known, import state), Settings, alert toggles | **Desk AI verdict, brief, AI changes, AI alert rules:** not probe-gated; gated on the step 5 build and the new dependency |

**Update 2026-10-29 (3c-b).** Wherever this table says IBKR option chains or quotes, read Alpaca's delayed chain: candidates,
annualized yield, the opportunity flag, Δ, the roll panel and the cost to close are built and answer `unavailable` until a valid
key is set. IV rank still needs 60 sessions of IV history (the step-6 scan job writes it). Premium income needs the Flex
`Trades` section (`needs_trades` until then). Futures prices stay deferred.

## f. Non-goals

- **No orders.** No endpoint, control, job, or contract field that places, previews, or simulates an order, paper or live. "Paper
  sell" and "Paper roll" from R3 become `OrdersOffNotice`. IBKR is never given order permission; the Flex token cannot trade.
- **No backtesting** and no backtest screens.
- **No mobile or tablet work.** Below 1100 px the existing mobile routes keep working unchanged; R3 F1–F12 stay reference (02l §f
  step 4 is a later phase).
- **No new styling.** R2+ tokens, amber as the single accent, violet (`--color-ai`) only for Desk AI content, Inter, the 02l §b6
  desktop type scale and target sizes. No new colours, no new chart library (payoff sketch and income bars are small SVGs with
  numeric axes; the price chart reuses `MarketChart` with no overlays).
- **Deferred:** Ask (F12) in the Desk; the AI track-record screen (F9) and the settlement job; watchlist threshold flags and
  "Make it an alert" (F3); CSV import; "Adjust assumptions" recompute (02h §4); tax advice beyond the 02g assignment note; options
  on futures; ETF covered calls with non-standard deliverables; any automation against the main account.
- **No activation.** The public Desk, IBKR, the alert runtime flag, and the AI job's schedule stay off in deployed environments
  until the owner turns them on.

## g. Owner decisions (confirm or overrule; each is cheap before its step)

1. **Option-chain source.** IBKR snapshots through the data user (default). If snapshots are too slow for the 15:30 scan over the
   holdings, the 02b upgrade path is Massive Options Starter ($29 a month, 15-minute-delayed chains with greeks).
2. **Flex query sections for the data user.** Recommendation: `OpenPositions` (LOT) plus `Trades` (options, the last 365 days), so
   income history and assignments work from day one. Created during Monday's Flex move (02e).
3. **Ex-dividend dates.** No current registry kind has them. Recommendation: verify Alpaca corporate-action announcements during
   step 3 and add a `dividends` kind if they cover the holdings; until then the engine gets `ex_dividend=None` and the UI says
   "Ex-dividend date unknown · check before selling a call".
4. **Masking default.** Hidden on every load (recommended); the owner can turn the default off in Settings.
5. **Account types.** Set by the owner in Settings (`taxable` until set); drives the assignment note and the tax flags.
6. **Desk AI dependency.** The verdict needs an LLM client with structured output (02f §8 names PydanticAI test models); the backend
   has none today. Step 5 adds one and picks the model from the sponsored keys; it gets its own short spec before code.
7. **Mock data source.** Run F0 (§i) reads holdings from the data user's query after Monday by default; it reads the interim
   main-account query earlier only on the owner's explicit go.

## h. Implementation order and model assignments

Opus wrote this plan (done) and reviews only on request. Sonnet runs the two streams and each Paper run marked Sonnet; Haiku runs
the mechanical sub-tasks as subagents of the stream that owns them. Streams follow 02m §d1 ownership (S: `backend/` and
`common/`; F: `frontend/`) and the repository rule: stack commits, one pull request per finished phase.

| Step | Owner | Work | Gate |
|---|---|---|---|
| 0 | Opus | this plan | done |
| 1 | Sonnet (no Paper) | **Run F0 snapshot** (§i) | Flex per §g decision 7 |
| 2 | Sonnet, then Haiku | **Paper runs F1–F6** (§i), sequential; owner gate after F2 | F0 |
| 3a | S: Sonnet; Haiku subagents for the migration, role grants, and migration tests | `0004_fundamental_lane`, models, settings keys, `short_call_risks` optional delta; **`research/consensus.py` snapshot job first** (history clock starts) | now, parallel to step 2 |
| 3b | S: Sonnet; Haiku for routers and `pnpm gen:api` | contract-first stubs for all 20 endpoints from a trimmed fixture behind an off-by-default stub setting (the 02m §d2 step 2 pattern), OpenAPI committed; **F starts here** | 3a |
| 3c | S: Sonnet | real services available now: Flex client and importer (fixture, then live per §e), holdings service, coverage and short calls, futures readings (dates, macro), fundamentals metrics, valuation and earnings reaction, timeline, fundamental alert toggles, `/dashboard/fundamental`, status and settings | 3b |
| 4 | F: Sonnet; Haiku subagents for FD6, FD10, FD11, the 1180 column priorities, and the copy-table rows | `lib/lanes.ts` shared routes and Fundamental nav; left and right rails; `MaskToggle` and `lib/desk/mask.ts`; FD2, FD3, FD4, FD5 (the owner-gated templates first), then FD6–FD11; FD12 is the §b3 media rules, no new components | 3b |
| 5 | S: Sonnet | Desk AI verdict job (§g decision 6), `ai_verdicts`, `ai_calls`; the brief and verdict sections go live | owner approves the dependency |
| 6 | S: Sonnet; Haiku for fixtures | **after the probe:** ~~`option_chain` kind~~ (done, 3c-a) and IBKR futures quotes in `common` (deferred); `covered_calls/scan.py` and IV history; roll and candidates real; Flex switched to the data user with `Trades`; income real | Monday 2026-10-26 probe and Reporting grant |
| 7 | Sonnet (Paper) | **Run F7:** re-stamp FD4, FD5, FD6 with real chain and futures values; drop their SIMULATED labels | step 6 data |
| 8 | Both | integration: stubs off; Playwright projects at 1440 and 1180 for the Fundamental specs; acceptance (§j) | 3c, 4, 6 |

## i. Paper boards for the mock phase

Paper file TobyTest, the **same page as D1–D12** ("R3 · Desktop · Technical MVP"), so every run can `duplicate_nodes` the named D1
shell groups (`Desktop shell`, `Desktop top bar`, `Left rail`, `Right rail`, `Status bar`, `Freshness badge`). Board name format:
`R3 · Fund · <Screen> · desktop` (1180: `R3 · Fund · <Screen> · desktop 1180`). The R3 mobile page stays untouched.

**Grid (the D1–D12 convention):** 1440 boards at x = −195, 1405, 3005, 4605 (1600 px step); 1180 boards at x = −195, 1085 (1280 px
step). The Technical rows sit at y = 26000, 28800, 31200, 33600, and the lowest board ends near y ≈ 34914. The Fundamental rows start
at **y = 36000** and step 2800. Before writing, each run reads the bottom edge of the row above; if any board above ends within 400 px
of its row, it moves its row down by 400 px steps and records the move in its run JSON.

| Board | Name | Width × start height | x | y | Model, run |
|---|---|---|---|---|---|
| FD1 | `R3 · Fund · Shell & states · desktop` | 1440 × 900 | −195 | 36000 | Sonnet, F1 |
| FD2 | `R3 · Fund · Today · desktop` | 1440 × 900 | 1405 | 36000 | Sonnet, F1 |
| FD3 | `R3 · Fund · Holdings · desktop` | 1440 × 900 | 3005 | 36000 | Sonnet, F2 |
| FD4 | `R3 · Fund · Covered calls scan · desktop` | 1440 × 900 | 4605 | 36000 | Sonnet, F2 |
| FD5 | `R3 · Fund · Open calls & income · desktop` | 1440 × 900 | −195 | 38800 | Sonnet, F3 |
| FD8 | `R3 · Fund · Stock overview · desktop` | 1440 × 900 | 1405 | 38800 | Sonnet, F3 |
| FD6 | `R3 · Fund · Futures reading · desktop` | 1440 × 900 | 3005 | 38800 | Haiku, F4 |
| FD7 | `R3 · Fund · AI daily brief · desktop` | 1440 × 900 | 4605 | 38800 | Haiku, F4 |
| FD9 | `R3 · Fund · Valuation & earnings · desktop` | 1440 × 900 | −195 | 41600 | Haiku, F5 |
| FD10 | `R3 · Fund · Timeline · desktop` | 1440 × 900 | 1405 | 41600 | Haiku, F5 |
| FD11 | `R3 · Fund · Settings & More · desktop` | 1440 × 900 | 3005 | 41600 | Haiku, F6 |
| FD12a | `R3 · Fund · Holdings · desktop 1180` | 1180 × 820 | −195 | 44400 | Haiku, F6 |
| FD12b | `R3 · Fund · Covered calls scan · desktop 1180` | 1180 × 820 | 1085 | 44400 | Haiku, F6 |

**Count: 13 boards**: 6 Sonnet (FD1–FD5, FD8), 7 Haiku (FD6, FD7, FD9–FD11, FD12a, FD12b). Heights grow with `fit-content`; the
shell must fit in 900 (820 at 1180), as in 02l §b1.

**Runs (one Paper writer at a time, sequential):**

| Run | Model | Boards | Depends on |
|---|---|---|---|
| F0 | Sonnet (no Paper) | snapshot | §g decision 7 |
| F1 | Sonnet | FD1, FD2 | F0 |
| F2 | Sonnet | FD3, FD4 | F1; **owner gate after F2** (the holdings table and covered calls are the templates for the rest) |
| F3 | Sonnet | FD5, FD8 | F2 |
| F4 | Haiku | FD6, FD7 | F1 |
| F5 | Haiku | FD9, FD10 | F3 (FD8's tabs) |
| F6 | Haiku | FD11, FD12a, FD12b | F2 |
| F7 | Sonnet | re-stamp FD4, FD5, FD6 | step 6 |

**Run F0 snapshot.** A throwaway script under `ai-trading/temp/desk-desktop-fundamental/` (gitignored) loads keys only through
`common/config/family_config.py` (never by shell-sourcing an `.env`) and writes `snapshot-fundamental-2026-10-23.json`: the Flex LOT
records (holdings and option lots), Alpaca closes for the held symbols and the market strip, consensus, targets, and earnings dates
for the held symbols, the §c4 metrics, valuation and earnings reaction for three holdings, coverage through `coverable_contracts`
with the 50% cap, open short calls through `short_call_risks` (the date and strike rules only), the FRED macro week, and futures roll
and expiry dates. The run log records counts only, never values. Nothing in it is committed or printed.

**Real versus SIMULATED on the boards (02l §c2 rule):**

- Real from the snapshot: symbols, weights, change and gain percentages, lot dates and terms, coverage and reasons, short-call
  strikes, expiries, and date rules, consensus and valuation numbers, macro dates, roll dates. As-of line: "As of last close ·
  Fri 2026-10-23 · 4:00 PM ET".
- Masked: every dollar amount, share count, and contract count shows `•••••` (the default state). The "values shown" strip on FD1
  uses round SIMULATED numbers.
- SIMULATED until Run F7: candidate rows and the payoff sketch on FD4, Δ and the roll pane on FD5, futures prices on FD6, the implied
  move on FD9. Each board also shows the real pre-probe state ("Option quotes connect after the IBKR setup").
- SIMULATED until step 5: every Desk AI verdict, brief row, and AI timeline item (FD7, FD8, FD10, right rail). FD8 also shows the
  "Desk AI starts after its first daily run" state.

Per run: load the Paper guide once, `get_font_family_info` for Inter once, duplicate the D1 shell groups, rename the Fundamental
groups (`Fund left rail`, `Fund right rail`, `Mask toggle`) on FD1 for later runs, one screenshot per board at the end,
`finish_working_on_nodes`. No Mobbin calls.

## j. Tests and acceptance (additions to 02m §d3–§d5)

- **Backend:** Flex parse on the recorded-shape fixture (stocks, short calls, multiple accounts, a malformed file, a DTD rejected);
  import idempotency per statement date; holdings ownership (the other user gets empty holdings, 404 on lots); the external account
  id absent from every response; coverage reasons at each boundary; candidates equal `core.candidates` on a golden chain fixture;
  `short_call_risks` with `delta=None` fires only the date and strike rules; futures readings return `unavailable` prices without
  the IBKR slot; revisions from snapshots with gaps; the AI checks and stale path on test models, no paid calls in CI; the existing
  401 walk and no-orders route test cover the new routes.
- **Frontend (node tests in `lib/`):** `mask.ts` (what hides, what stays), payoff math and axes, annualized display formatting,
  `lanes.ts` shared routes and the Fundamental nav, the new copy rows against the banned-term list, column priorities per board, and
  a lane-purity test that greps Fundamental components for `RSI`, `MACD`, `VWAP`, `ORB`, and `Screener` (and Technical components
  for `P/E`, `FCF`, `covered call`).
- **E2E:** Playwright at 1440 × 900 and 1180 × 820: Today, Holdings (mask toggle, lots pane, watchlist tab), Covered calls (pre-IBKR
  state, coverage reasons), Futures reading, Stock tabs, Settings (account type, scan filter validation). Every spec asserts no
  order control and no banned wording.
- **Acceptance before the owner relies on it:** after the data-account import, every holding's share count and lot count match the
  IBKR statement for the same date; on three holdings, a candidate's bid, Δ, and annualized yield match TWS within a stated tolerance
  at one scan; one covered-call income alert and one short-call risk alert reach the owner's Telegram.
