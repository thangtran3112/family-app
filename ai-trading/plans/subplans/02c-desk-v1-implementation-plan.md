# Family Desk v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> This file is the master plan for the whole Desk. Each phase has its own task file under [02c-desk-v1-tasks/](02c-desk-v1-tasks/). A task file is written with the writing-plans skill, from a tested prototype, and the owner reviews it before that phase starts. That keeps every task file small enough to carry complete code. Phases 0, 1, 1b, 1c, and 1d have task files. Each later phase gets its own before it starts.
>
> **Re-sequenced 2026-10-24 ([02l](02l-desk-desktop-first-mvp.md)):** the desktop-first Technical-lane MVP now comes before Phases 5-7 and 6b. That MVP is alerts, filters, and recommendations on real data, with no backtests and no orders of any kind; paper trading, backtests, the Fundamental lane, and mobile follow it. Phases 0-4 below are unchanged and mostly done.

**Goal:** ship Family Desk v1 at `trading.tobytran.dev`, in phases that each deliver working, tested software:
- the two users' strategies alert automatically and paper-trade on IBKR paper;
- the Desk calculates technical indicators and futures sizing for short-term trades;
- it gives long-term holdings consensus EPS, valuation, covered calls, and a daily Desk AI verdict with a track record;
- strategies can be backtested on history before they reach paper.

**Architecture:**
- **Two services** run from one Python 3.12 backend image:
  - `api` (FastAPI): REST, SSE, AG-UI chat, the live stream, and bar-close strategy evaluation;
  - `scheduler`: backfills, daily and weekly jobs (the covered-call scan, the Desk AI verdict, settlements, backtests), imports, and watchdog checks.
- **Code layout:** the Desk is the package `ai-trading/packages/family-desk/` (`contracts/`, `backend/`, `frontend/`). Provider clients that other ai-trading apps also use live in `ai-trading/common/`.
- **Strategy specs** are JSON, validated by Zod v4 schemas in `packages/family-desk/contracts`. Those generate JSON Schema, which generates the backend's Pydantic models.
- **Pure core:** all math lives in `ai_trading.core`, which does no I/O. Live evaluation, backtests, and settlements call the same functions on closed bars stored in PostgreSQL 17.
- **IBKR:** one IB Gateway (IBC) serves live data and paper orders, unless the Phase 0 spike forces the two-gateway fallback.
- **Web:** the static Next.js Desk is served from GCS through the existing Worker pattern. `/api/*` reaches `api` through the tunnel and the Clerk/Caddy gate.

**Tech Stack:**
- Backend: Python 3.12, uv, FastAPI, PydanticAI (`pydantic-ai-slim[ag-ui]`), `ib_async` 2.1, `alpaca-py`, `exchange_calendars`, SQLAlchemy 2 + Alembic, pytest, ruff
- Database: PostgreSQL 17
- Contracts and web: Node 24, pnpm 11.9.0, Zod v4, Next.js 16 static export, Tailwind CSS 4, TradingView lightweight-charts, assistant-ui
- Infrastructure: Docker Compose, `ghcr.io/gnzsnz/ib-gateway` (IBC), Cloudflare Worker and Tunnel (Terraform), Firestore `family-config`

**Spec:**
- [02a-desk-v1-strategies-design.md](02a-desk-v1-strategies-design.md): primary; §11 is the reuse map
- [02f-desk-indicators-and-ai-daily-design.md](02f-desk-indicators-and-ai-daily-design.md): indicators, the technical bias, consensus EPS, the Desk AI verdict
- [02g-desk-covered-calls-and-futures-swing-design.md](02g-desk-covered-calls-and-futures-swing-design.md): covered calls, futures swings
- [02h-desk-research-tools-design.md](02h-desk-research-tools-design.md): backtests, the AI track record, valuation and earnings reaction, the holding timeline
- [02b-desk-market-data-options.md](02b-desk-market-data-options.md): data sources and cost
- [02-release-2-desk-design.md](02-release-2-desk-design.md): base design, wherever the others are silent
- Mockups: Paper file "TobyTest", page "Family Desk · R2 mockups", D1–D19 and M2–M11 (index in 02a §16)

## Global Constraints

- **Paid market data:** at most $30 a month for both users (02b §1). Today it is $14.50: the IBKR add-on includes OPRA (02g §3). Consensus EPS uses free tiers (02f §4).
- **Hostnames (02a §8):** `trading.tobytran.dev` is the Family Desk (from Phase 4). `trading-hub.tobytran.dev` is the hub. The upstream apps keep their own hosts.
- **Paper-only guard (02a §6, §3):** refuse any order unless all three hold:
  - the connected account ID starts with `DU`;
  - the gateway is on the paper port;
  - the Desk config is `paper`.

  v1 contains no live order code. Backtests never place orders.
- **Strategy specs (02a §4.3):** JSON with a required `schemaVersion`. Zod v4 in `packages/family-desk/contracts` is the source of truth. CI fails on drift, and the API re-validates every save.
- **Versions (02a §4.1):** every save creates an immutable version. Signals, alerts, order intents, fills, and backtests stay attributed to the version that produced them.
- **Evaluation (02a §5):** rules evaluate on closed bars only. The signal dedupe key is (strategy version, symbol, bar time). Unknown data neither fires nor resets a rule.
- **No look-ahead (02h):** backtests, settlements, and historical tool calls see only data that existed at their decision time.
- **Data-quality labels:** `realtime`, `delayed-15m`, `eod`, `fallback`, `unavailable`, on every number shown.
- **Stages (02a §4.2):** `draft` → `alert_only` → `paper`. v1 code must not offer `live_confirm` or `live_auto`.
- **Time (02 §4.3):** schedules use America/New_York on exchange trading days. Timestamps are stored in UTC.
- **Streaming slots (02a §7):** the Desk uses at most 70 of IBKR's default 100.
- **Family-wide limits (02a §4.4):** at most 12 paper orders a day, plus a global off switch.
- **LLM budgets:**
  - chat: 12 model requests and 60,000 tokens per run, and $25 per user per calendar month (02 §6.6);
  - the Desk AI daily job: no cap, with spend logged (02f §5).
- **Secrets (AGENTS.md):**
  - Firestore profile `ai-trading/desk`, read and written only through `common/config/family_config.py`;
  - no `.env` files inside `ai-trading/`;
  - never print values.
- **Public repository:** no balances, positions, account numbers, emails, or VPS addresses in commits. Mockups and fixtures use made-up numbers.
- **Layout and reuse (owner, 2026-10-10):**
  - The Desk never imports another package.
  - Code shared by two or more ai-trading packages lives in `ai-trading/common/`.
  - Upstream code is copied with attribution (02a §11). MiroFish gives ideas only.
- **Upstream code:** never edit the submodules under `ai-trading/packages/` (`vibe-trading` only through its fork rules).
- **Git (AGENTS.md):**
  - The main session works in the main checkout on `feature/toby`, merged up to `origin/dev`.
  - Subagents work in `.worktrees/` and the main session merges their branches.
  - Single-line commit messages without trailers.
  - One pull request to `dev` per finished phase.

## Review Focus

1. **Stale or delayed data must never place a paper order.**
   - A strategy is "degraded" when the gateway is down, it has no streaming slot, or an input is `fallback`.
   - It may alert (labeled) but creates no order intent.
   - Pinned in Phase 3 (degraded alert) and Phase 6 (order gate).
2. **No repainting.**
   - A rule that is true mid-bar but false at the close must not fire.
   - A restart must not re-emit a signal for a bar that was already evaluated.
   - Pinned in Phase 1 (evaluator) and Phase 3 (dedupe across restarts).
3. **Session-calendar edges.** These must all produce the right opening range, pre-market window, `flatBy`, card-back timing, and weekend card:
   - daylight-saving changes;
   - half days (13:00 ET close);
   - exchange holidays;
   - the futures Sunday 18:00 ET open.

   Pinned in Phase 1 (calendar), Phase 1c (roll dates), and Phase 3 (scheduler).
4. **Futures roll and expiry.**
   - When the front month changes, indicators and levels must not see a fake gap between contracts.
   - An open position keeps its contract and gets a roll warning before the last trade or first notice day.
   - Pinned in Phase 1c (dates), Phase 2 (roll map), and Phase 6 (position contract and template).
5. **Editing a strategy that holds a paper position.** The position and its exits stay on the old version until it is flat; the new version only opens new trades. A decision made under a version that has since changed is refused. Pinned in Phase 6.
6. **Look-ahead in replays.** Backtests, AI settlements, and as-of tool results use only data known at the decision time. Pinned in Phase 1d, by mutating future bars and asserting identical results, and in Phase 2 (as-of guards).
7. **A malformed AI answer never alerts.** A verdict that fails its code checks keeps yesterday's verdict, marked stale, and fires nothing. Pinned in Phase 5.

---

## Phases

| Phase | Ships | Depends on | Task file | Status |
|---|---|---|---|---|
| 0. Verification spike | Answers for 02a §12; read-only IBKR and Flex probe tools | none | [phase-0-spike.md](02c-desk-v1-tasks/phase-0-spike.md) | Flex done 2026-10-24; Gateway probe Mon 2026-10-26 09:30 ET (owner phone approval); Task 0.6 after |
| 1. Strategy core | Contracts, backend scaffold, session calendar, first indicators, levels, evaluator, ten templates | none | [phase-1-strategy-core.md](02c-desk-v1-tasks/phase-1-strategy-core.md) | Done (PR #95) |
| 1b. Ported quant core | Option math, covered-call math, support/resistance, order sizing | 1 | [phase-1b-ported-quant-core.md](02c-desk-v1-tasks/phase-1b-ported-quant-core.md) | Done (PR #104) |
| 1c. Technicals and futures math | The 02f §3 indicators, pivots, the Desk Technical Bias and its blocks; the 02g §4 futures specs, roll dates, and micro-first sizer | 1, 1b | [phase-1c-technicals-and-futures.md](02c-desk-v1-tasks/phase-1c-technicals-and-futures.md) | Done |
| 1d. Research math | As-of helpers, valuation methods, earnings reaction, the backtest engine core, AI call settlement (02h) | 1, 1b | [phase-1d-research-math.md](02c-desk-v1-tasks/phase-1d-research-math.md) | Done |
| 2. Data foundation | `ai-trading/common` providers behind one registry (02j: Alpaca, SEC EDGAR, FRED, Finnhub, Alpha Vantage, Eulerpool, consensus EPS; IBKR after Phase 0), the Postgres schema, bar store, roll map, streaming slots | 1c; the IBKR client waits on 0 | [phase-2a-data-without-ibkr.md](02c-desk-v1-tasks/phase-2a-data-without-ibkr.md) | 2a done; 2b waits on Phase 0 |
| 3. Runtime and alerts | `api` and `scheduler`, live evaluation, card backs, alert outbox, Telegram/Slack, watchdog, deploy (first `main` release) | 2 | [phase-3-runtime-and-alerts.md](02c-desk-v1-tasks/phase-3-runtime-and-alerts.md) | Done, live (deployed and verified 2026-10-12) |
| 4. Desk web and hostnames | The static app with every mocked screen (wired as its phase lands); `trading.tobytran.dev` | 3; the shell can start earlier on fixtures | [phase-4-web.md](02c-desk-v1-tasks/phase-4-web.md) | Live at `trading.tobytran.dev` (recutover accepted 2026-10-20); fixtures where data is not wired yet |
| 5. Long-term, covered calls, Desk AI | Imports, Holdings, valuation and consensus cards, the covered-call scan and screens, the daily Desk AI verdict, the AI brief, the track record, the timeline | 1d, 3 (UI after 4) | `phase-5-long-term.md` | Planned; after the 02l MVP |
| 6. Paper trading | The paper broker and order gate, the fills journal, futures brackets, reconciliation, limits, stats, the Paper tab | 3 (UI after 4) | `phase-6-paper.md` | Planned; deferred past the 02l MVP |
| 6b. Backtests | Backtest runs over stored bars, the results page, "Promote to Paper" | 1d, 2 (UI after 4) | `phase-6b-backtests.md` | Planned; deferred past the 02l MVP |
| 7. Ask | The PydanticAI agent over AG-UI with typed evidence tools; budgets | 5, 6 | `phase-7-ask.md` | Planned |

**Delivery** (AGENTS.md's standing authorization):
1. verify and review;
2. merge the phase's pull request to `dev`;
3. release the phase's ai-trading paths to `main`;
4. deploy and verify the live result.

Phases 0–2, 1c, and 1d change nothing that is deployed, so they stop at `dev`. Desk code first goes to `main` with Phase 3.

## Execution Map

| Wave | Who | What |
|---|---|---|
| A (next) | Main session + owner | Phase 0 Task 0.5 Steps 1-2 on Mon 2026-10-26 at 09:30 ET with the owner (the Flex step is done), then Task 0.6; then the IBKR client (Phase 2b) |
| B (done) | Subagents in worktrees | Phases 1c, then 1d: pure code, no data or IBKR needed |
| C | Main session with subagents per task file | Phase 2a (data without IBKR, done) → 3 (done) → 4 (done, live) → 5, 6, and 6b (UI after 4) → 7; re-sequenced behind wave D |
| D (now) | Claude Code agents, one Paper writer at a time | The 02l desktop Technical MVP: Paper boards (Runs 0-6), then the real-data build after the Gateway probe |

## Shared Interfaces

These names are fixed for every phase. A task file may add names but must not rename these.

| Thing | Name |
|---|---|
| Contracts package | `ai-trading/packages/family-desk/contracts`, pnpm name `@ai-trading/contracts`, schema export `StrategySpecV1Schema` |
| Generated JSON Schema | `contracts/generated/strategy-spec-v1.schema.json` |
| Spec fixtures and templates | `contracts/fixtures/strategy-spec-v1/{valid,invalid}/*.json` (both suites read them); `contracts/templates/*.json` |
| Backend project | `packages/family-desk/backend`, uv project `ai-trading-desk`, import package `ai_trading` under `src/` |
| Pure core modules | Phase 1: `calendar`, `indicators`, `levels`, `evaluate`. Phase 1b: `options_math`, `covered_calls`, `sizing`. Phase 1c: `bias`, `pivots`, `futures`. Phase 1d: `asof`, `valuation`, `earnings_reaction`, `backtest`, `settlement`. All under `ai_trading.core`. |
| Other backend modules | `ai_trading.data`, `ai_trading.db`, `ai_trading.engine`, `ai_trading.notify`, `ai_trading.broker`, `ai_trading.agent`, `ai_trading.api`, `ai_trading.jobs` |
| Generated Pydantic models | `ai_trading.contracts.strategy_spec_v1` (generated; never hand-edited) |
| Desk frontend | `packages/family-desk/frontend` (Phase 4) |
| Shared ai-trading code | `ai-trading/common/` (Phase 2a, restructured by 02j): `types.py`, `sources.py`, `registry.py` (`Kind`, `Provider`, `REGISTRY`, `DEFAULT_CHAINS`, `DataSources.from_env()`), `providers/` (Alpaca, SEC EDGAR, FRED, Finnhub, Alpha Vantage, Eulerpool; IBKR in 2b), plus `errors.py`/`quality.py`/`http.py`/`bars.py`/`fallback.py`/`testing.py`. Callers build one `DataSources` and read through it — never `ai_trading_common.providers` directly |
| Attribution | each package's `THIRD_PARTY_NOTICES.md` |
| Services | `api` (port 8000), `scheduler`, `ib-gateway` (paper API 4004 via the image's socat), `desk-postgres` (5432); all internal, with no host ports |
| Data-quality labels | `realtime`, `delayed-15m`, `eod`, `fallback`, `unavailable` |
| Stages | `draft`, `alert_only`, `paper` |
| Cadences | `bar_close_1m`, `bar_close_5m`, `bar_close_15m`, `bar_close_1h`, `premarket_0830`, `daily_close`, `weekly` |
| Tables | 02 §7, 02a §9, 02b §5, plus `consensus_snapshots`, `earnings_results`, `analyst_targets` (02f); `ai_verdicts`, `ai_calls`, `ai_call_outcomes` (02f, 02h); `backtest_runs`, `backtest_trades` (02h) |
| Probe tools | `ai-trading/tools/ibkr-probe/` (Phase 0), kept as the manual gateway smoke test |

Firestore keys in `ai-trading/desk` (names only; values only through `family_config.py`). The profile has existed since 2026-10-10. Shared values live once in `shared/ibkr` and `shared/alpaca`. The Desk links `shared/alpaca` and the free data-provider keys now, and links `shared/ibkr` only once the Gateway probe passes (Phase 2b). A dashboard login stored in a shared group is never linked into an app profile.

| Group | Keys |
|---|---|
| IBKR | `IBKR_DATA_USERNAME` and `IBKR_DATA_PASSWORD`, not linked until the Gateway probe passes (values stay in `shared/ibkr`; Phase 2b links them); `IBKR_PAPER_USERNAME` and `IBKR_PAPER_PASSWORD` once Task 0.6 settles the gateway layout |
| Flex import | `IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY_ID` per imported account (Phase 5 names the suffixes); both set 2026-10-24 on the main account's query (interim; the token expires 2027-09-24). They move to the data user's own query once its Reporting access is granted, then the main-account setup is removed ([STATUS.md](../STATUS.md) 2026-10-24 IBKR rows) |
| Data sources | `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY`, linked to `shared/alpaca` (set); `FINNHUB_API_KEY`, `FRED_API_KEY`, `EULERPOOL_API_KEY`, `ALPHA_VANTAGE_API_KEY` (Phase 2) |
| Alert channels | `TELEGRAM_BOT_TOKEN`, `SLACK_WEBHOOK_URL_OWNER`, `SLACK_WEBHOOK_URL_SPOUSE` |
| Database | `DESK_DB_PASSWORD` |
| LLM keys | linked from `shared/llm` |

---

## Phase Outlines

Each phase's task file turns its outline into complete, test-first tasks. "Reuse" points at 02a §11 rows. Sizes are rough task counts.

### Phase 0: Verification spike (Gateway probe Mon 2026-10-26)

Tasks 0.1–0.4 are done, and so is the Flex part of Task 0.5 (2026-10-24: 21 `OpenPositions` LOT records). The data user's Reporting access grant is still open ([STATUS.md](../STATUS.md) 2026-10-24 IBKR rows).
- **Task 0.5,** with the owner on a weekday during market hours (Mon 2026-10-26, 09:30 ET; the data user's sign-in needs the owner's phone approval):
  - live stock and futures quotes;
  - option greeks through the $4.50 add-on;
  - a paper session alongside the live login.
- **Task 0.6:** the gateway layout decision. Results go in [02d](02d-desk-spike-results.md).

### Phase 1: Strategy core (done, PR #95)

The contracts package, the backend scaffold, the session calendar, the first indicators (SMA, EMA, Wilder RSI, ATR, VWAP, relative volume), levels, the closed-bar evaluator, and ten intraday and swing templates.

### Phase 1b: Ported quant core (done, PR #104)

Black-Scholes and implied volatility (from Vibe-Trading), the 02 §6.3 covered-call math, support/resistance from confirmed pivots, and paper-order sizing that returns a reason when there is no order. Contracts have 40 tests, the backend 169.

### Phase 1c: Technicals and futures math (no I/O; done, PR #110)

**Scope:**
- `core/indicators.py` gains:
  - MACD(12,26,9), Stochastic(14,3,3), Stoch RSI(3,3,14,14), CCI(20);
  - ADX/DMI(14), Awesome Oscillator, Momentum(10), Williams %R(14);
  - Bull/Bear Power(13), Ultimate Oscillator(7,14,28);
  - VWMA(20), Hull MA(9), Ichimoku(9,26,52);
  - ATR% with its low/normal/high label (02f §3).
- `core/pivots.py`: Classic, Fibonacci, and Camarilla pivots from the prior session, week, or month.
- `core/bias.py`: one vote per indicator under TradingView's published rules, the oscillator, moving-average, and summary scores, and the labels at exactly ±0.1 and ±0.5. Below 250 bars it says "warming up".
- `core/futures.py`:
  - the 12 contracts' specs and product parsing;
  - roll and expiry dates (equity index on the Monday before the third Friday; CL and MCL last-trade rules; GC and MGC first notice);
  - the micro-first sizer on top of `core/sizing.py` (02g §4).
- **Contracts:** the new series and level blocks, the bias with its label, the `bar_close_5m`, `bar_close_15m`, and `bar_close_1h` cadences, and the "Technical bias change" template. Regenerate, with parity tests.

**Reuse:** Vibe-Trading's futures tables and parsing (copy); its ADX and Ichimoku (adapt); TradingView's rules (documentation).

**Acceptance:**
- golden values for every indicator, hand-checked and cross-checked offline against a reference implementation;
- the bias thresholds at their boundaries;
- roll dates against CME's 2026–2027 calendar, including holidays and a 25th that falls on a weekend;
- the sizer prefers micros;
- both suites green, with no new runtime dependency.

**Size:** about 6 tasks.

### Phase 1d: Research math (no I/O)

**Scope:**
- `core/asof.py`: as-of windows used by everything that replays history.
- `core/valuation.py`: the DCF with scenarios, owner earnings, EV/EBITDA, residual income, WACC, and the 60/40 blend. A non-positive cash flow gives `unavailable` (02h §4).
- `core/earnings_reaction.py`: market-model excess moves on days 0–1, beats against misses, and `unavailable` under 4 reports.
- `core/backtest.py`: the Phase 1 evaluator looped over bars, with next-open fills, stops and targets (gap fills at the open), costs, Phase 1b sizing, trades, and the 02h §2 statistics.
- `core/settlement.py`: each AI call scored against SPY after 90 trading days (the Hold band is ±5%), target hits, and calibration buckets. Idempotent (02h §3).

**Reuse:**
- TradingAgents: date-window helpers (adapt) and settlement (pattern);
- ai-hedge-fund: the v1 valuation functions (copy), the event study (adapt), and the backtest and pipeline stages (pattern).

**Acceptance:**
- next-open fills proved on a fixture whose close and next open differ;
- a gap through a stop fills at the open;
- no look-ahead, by mutating future bars and asserting identical past trades;
- statistics checked on a hand-computed trade list;
- valuations against hand-checked values;
- settlement boundaries and re-runs.

**Size:** about 5 tasks.

### Phase 2: Data foundation (2a without IBKR, done; 2b the IBKR client)

**Scope (2a, done — [phase-2a-data-without-ibkr.md](02c-desk-v1-tasks/phase-2a-data-without-ibkr.md), restructured by [02j](02j-common-data-providers-design.md) to one provider registry):**
- **`ai-trading/common/`** (new):
  - `http.py` (copied from Vibe-Trading's throttle) with a soft-ban latch;
  - typed provider errors and one generic fallback-chaining helper (`first_success[T]`);
  - bar hygiene guards, and "never cache a trading day that has not closed";
  - `types.py`/`sources.py`/`registry.py`: vendor-neutral types, one Protocol per data kind, and `DataSources.from_env()` — swapping a vendor means an adapter, one `REGISTRY` line, and config, never a caller-code change.
- **Providers (behind the registry):**
  - Alpaca, moved from `ai-trading/market-data/` together with the open-source lane;
  - SEC EDGAR, by filing date and span, including 8-K `filings.files` paging;
  - FRED, with vintages and release dates;
  - Finnhub: earnings calendar, company news, recommendation trends, earnings surprises;
  - consensus EPS: the Eulerpool 10-symbol pilot, written up in 02d, with Finnhub and Alpha Vantage as the fallback (02f §4). Stooq is dropped (its CSV endpoint is gated behind a JS proof-of-work challenge with no API key offered); the Desk's effective daily-history start is 2016-01-01 unless 2b's IBKR client backfills further back.
- **2b:** the IBKR client through `ib_async`, added as `providers/ibkr.py` with no change to any caller. Paper and data profiles and ports, the market-data type, live 1-minute bars, futures history, daily IV, option snapshots, and what-if margin.
- **Desk `ai_trading.db` (2a):** SQLAlchemy and Alembic for `bars_1d`, `bars_1h`, `bars_1m`, and `futures_rolls` only — every other table in Shared Interfaces arrives with the phase that first needs it (owner decision). The Postgres role and schema init under `deploy/postgres/` moves to Phase 3, where `desk-postgres` first joins the deploy compose file.
- **Desk `ai_trading.data` (2a):**
  - the bar store (closed-bar-only upserts, as-of reads, backfill planning, 1-minute retention) and the backfill glue, which takes a `BarsSource`, never a vendor class;
  - the roll map (contiguous windows, difference back-adjusted continuous series), using Phase 1c's dates;
  - the streaming slot manager.
  - Read models and typed evidence snapshots for tools and card backs move to the phases that consume them (3, 5, 7).

**Reuse:** TradingAgents' router and errors (pattern), bar guards, SEC and FRED clients (adapt), and news windows (pattern); ai-hedge-fund's cache freshness rule and the 8-K announcement-date rule (pattern); Vibe-Trading's throttle (copy) and IBKR profiles (adapt, 2b).

**Acceptance:**
- contract tests on recorded responses, with no network in CI;
- a conformance test that every registered provider's adapter satisfies every kind's Protocol it declares;
- store tests against a real Postgres container;
- the roll test (no cross-contract gap) and the slot-priority test;
- the throttle's limits;
- the pilot report.

**Size:** about 10 tasks: 2a with 8 (done), 2b with 2.

### Phase 3: Runtime and alerts (deployed; the first `main` release)

**Scope:**
- **`ai_trading.api`:** FastAPI, with identity from the gateway's verified header; REST for watchlists, strategies, versions, signals, alerts, and settings; SSE quotes, at most about 4 updates per second.
- **`ai_trading.engine`:**
  - live evaluation at each bar close;
  - card backs for every watchlist symbol and card timeframe (02f §3);
  - degraded detection;
  - outbox writes.
- **Scheduler jobs:** idempotent and catch-up-safe, halting on failure. They cover `premarket_0830`, `daily_close` (16:30 bars, IV, consensus snapshots), `weekly`, the 15-minute refresh, backfills, the watchdog, and the Sunday 18:00 ET re-login reminder.
- **`ai_trading.notify`:** inbox, Telegram, and Slack, with retries, fingerprint dedupe, quiet hours, and secret redaction.
- **Deploy:**
  - compose services sized to the VPS headroom;
  - the Caddy `/api/*` route;
  - `deploy.sh` renders `ai-trading/desk`;
  - backups and a restore drill.

**Reuse:** ai-hedge-fund's tick (pattern); Vibe-Trading's channels (adapt) and due-now checks (pattern); deer-flow's redaction.

**Acceptance (staging):**
- an `alert_only` template alerts from live data;
- a restart sends no duplicate;
- a missed tick catches up exactly once;
- no secret appears in error text.

**Size:** about 8 tasks.

### Phase 4: Desk web and hostnames

**Scope:** a Next.js 16 static export, a shell with every mocked tab, and each screen wired when its phase lands:

| Screens | Wired here or later |
|---|---|
| Today, Strategies (builder, versions, JSON view, templates), Settings | here |
| Watchlists with flip cards and Technicals (D9, D10, M7), futures swing and specs (D15, D16, M10) | here |
| Holdings and covered calls (D5, D13, D14, M9), long-term and AI (D11, D12, D18, D19, M8, M11) | fixtures until Phase 5 |
| Paper (D3) | fixtures until Phase 6 |
| Backtest (D17) | fixtures until Phase 6b |
| Ask (D6) | fixtures until Phase 7 |

Chart overlays come from Vibe-Trading's `indicators.ts` (copy).

**Infrastructure:** a GCS bucket and Worker routes for `trading.tobytran.dev`, the hub registry's Desk card, and checks of the Clerk origins and `ALLOWED_ORIGINS` (02a §8).

**Acceptance:**
- a Playwright smoke test: Today → Strategies → new from a template → save → its alert appears; flip a card; open Technicals;
- `trading.tobytran.dev` serves the Desk behind the Clerk gate (401 without a session, forged identity headers stripped).

**Size:** about 10 tasks.

### Phase 5: Long-term, covered calls, and the Desk AI

**Scope:**
- **Imports:** IBKR Flex (Open Positions plus Open Lots), CSV, and the Holdings page.
- **Fundamentals:** fundamentals and valuation from SEC data and Phase 1d; the consensus EPS and earnings-reaction cards (D11, D19). The valuation card states when a number rests on one of `core/valuation.py`'s documented fallbacks: WACC with missing debt or cash treated as no debt, a default credit spread for a missing interest coverage, the default volatility discount, or a 5% revenue growth when growth is missing (Phase 1d review).
- **Covered calls:** the 15:30 covered-call scan, the income and short-call risk templates, and the coverage, roll, income, and assignment views (D13, D14, M9; 02g §3).
- **Desk AI verdict** at 17:05 (02f §5):
  - four votes and a structured verdict, checked in code;
  - a content-hash cache, so unchanged inputs reuse yesterday's verdict at $0;
  - the stale path.
- **AI screens:** the "AI daily view" template and the AI brief (D12).
- **Settlement and track record:** the AI call settlement job and the track record (D18; 02h §3).
- **Timeline:** the holding timeline (M11; 02h §5).

**Reuse:**
- ai-hedge-fund: the LLM agent, snapshot, and `extract_json` patterns;
- TradingAgents: schemas, prompts, rating integrity, and the run signature;
- Vibe-Trading: the verdict-contract pattern.

**Acceptance:**
- golden option-chain fixtures;
- a Flex fixture import;
- PydanticAI test models for every verdict check and the stale path;
- a cache hit costs $0;
- settlement is idempotent;
- no paid calls in CI.

**Size:** about 10 tasks.

### Phase 6: Paper trading

**Scope:**
- **`ai_trading.broker`:**
  - the paper guard;
  - decide at the close and execute the next bar;
  - refusal of decisions made under a stale strategy version;
  - quotes that fail closed;
  - notional normalization;
  - limit, stop, and bracket orders through `ib_async`, with futures in micros or minis and margin from IBKR's what-if.
- **Order-intent outbox:** `orderRef` set to the order intent ID.
- **Fills journal:** append-only and hash-chained, keeping corrections rather than erasing them.
- **Reconciliation:** on reconnect and every 15 minutes.
- **Limits:**
  - per strategy;
  - family-wide (12 a day);
  - flat-by and flatten-before-weekend;
  - the off switch;
  - the "Futures position risk" template (02g §5).
- **Results:** the `strategy_stats` rollup and the Paper tab.

**Reuse:** ai-hedge-fund's ledger, stages, spec, and limits (pattern); Vibe-Trading's order guard (pattern).

**Acceptance:**
- the guard refuses non-`DU` accounts, a non-paper port, and a non-paper config;
- on staging, a `paper` template places a bracket order and its fill is attributed to the right version;
- the journal chain verifies;
- a stale-version decision is refused;
- Review Focus 5 is pinned.

**Size:** about 9 tasks.

### Phase 6b: Backtests

**Scope:**
- **first, a known fix from the Phase 1c/1d final review:** `backtest._signal_positions` maps a resampled signal to its bin's real end (the truncated final `bar_close_1h` bin of a session closes at 16:00, not 16:30), derived the way `evaluate._resample` derives it, with a regression test;
- backtest jobs over stored bars using the Phase 1d engine, with a concurrency limit;
- `backtest_runs` and `backtest_trades`;
- the results page (D17);
- "Promote to Paper" (a stage change only);
- CSV export.

**Acceptance:**
- results match the Phase 1d engine on fixtures;
- a run never places an order;
- promotion changes only the stage.

**Size:** about 4 tasks.

### Phase 7: Ask

**Scope:**
- **Agent:** PydanticAI over AG-UI at `/api/agent`.
- **Tools:** 02 §6.4's tools plus `draft_strategy`, `explain_signal`, `strategy_performance`, `fundamentals`, `futures_info`, `swing_setups`, `backtest_summary`, `ai_verdict`, and `timeline`.
  - Every tool result is a typed evidence snapshot (provider, as-of time, values).
  - `collar_quote` adapts Vibe-Trading's options payoff.
- **Limits and UI:** the chat budgets; the assistant-ui page (D6); chart-screenshot Q&A.

**Acceptance:**
- tool wiring with test models;
- `draft_strategy` output always passes the schema and is never saved without confirmation;
- budget refusal.

**Size:** about 7 tasks.

### Later (not scheduled)

- The IV-smile model for option backtests and marks (Vibe-Trading)
- A Yahoo options-chain fallback, only if the owner accepts Yahoo's terms
- "What-if" analysis and catalyst briefs in Ask (MiroFish ideas)
- Blind replays of past AI verdicts (ai-hedge-fund)
- Nano contracts and options on futures
- The parked Desk v2 and v3 live-trading stages (02a §15)
