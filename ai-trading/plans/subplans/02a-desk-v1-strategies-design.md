# Release 2 Addendum A: Family Desk v1 (Strategies, Alerts, Paper Trading)

Status: approved in conversation on 2026-10-10, section by section. The phased plan is [02c](02c-desk-v1-implementation-plan.md). Sequencing changed 2026-10-24: [02l](02l-desk-desktop-first-mvp.md) puts the desktop Technical-lane MVP (alerts, filters, recommendations; no orders, no backtests, no mobile) first, and paper trading, backtests, and mobile follow it. This design's scope is otherwise unchanged. [02](02-release-2-desk-design.md) keeps only the base sections this design still cites.

Related:
- [02b-desk-market-data-options.md](02b-desk-market-data-options.md): data research and the IBKR decision
- [02f-desk-indicators-and-ai-daily-design.md](02f-desk-indicators-and-ai-daily-design.md): technical indicators and the bias (spouse), consensus EPS and the Desk AI daily verdict (owner)
- [02g-desk-covered-calls-and-futures-swing-design.md](02g-desk-covered-calls-and-futures-swing-design.md): covered calls (owner) and mini/micro futures swing trading (both users)
- [02h-desk-research-tools-design.md](02h-desk-research-tools-design.md): backtests, the Desk AI track record, valuation and earnings reaction, the holding timeline
- [02-release-2-desk-design.md](02-release-2-desk-design.md): the kept base sections (§4.3, §6.3, §6.4, §6.6, §7, §8, §11, §12)
- [STATUS.md](../STATUS.md): decisions log
- Mockups: Paper file "TobyTest", page "Family Desk · R2 mockups" (https://app.paper.design/file/01M4K3AXAKQC8Z6JTW03YR5HEG)

## 1. What Changed From 02

| Topic | 02 | Desk v1 |
|---|---|---|
| Center of the product | Fixed scans and chat | **User-owned strategies.** Every alert and paper order comes from a strategy. |
| Alerts | Morning scan, covered-call scan, short-call risk | Only strategies and the system create alerts. 02's scans become built-in templates. There are no manual price alerts. |
| Orders | No order code in Release 2 | Paper orders on IBKR paper, behind a paper-only guard |
| Intraday | Out of scope | In scope: strategies evaluate on each 1-minute bar close |
| Live data | IBKR on the Investor's paper login | One dedicated IBKR data login, shared by both users across all ai-trading apps ([02b](02b-desk-market-data-options.md)) |
| Paid data cap | $20 per month | $30 per month; expected $4.50–$14.50 |
| Holdings | Form and CSV | IBKR Flex read-only import, plus form and CSV (Robinhood) |
| Roles | `investor` / `trader` | Gone. Each watchlist has a horizon and each strategy has an owner. |
| Auth | Cloudflare Access JWT | The Clerk/Caddy gate from Release 1 (STATUS, 2026-10-07) |
| Address | `trading.tobytran.dev/desk` | `trading.tobytran.dev` is the Desk; the hub moved to `trading-hub.tobytran.dev` (01l, live 2026-10-10) |
| Push channel | Telegram | Telegram or Slack, chosen per user |

Still valid from 02:
- §6.3 covered-call math, filters, flags, and risk rules (now inside templates)
- §6.4 chat tools
- §6.6 LLM budgets
- §8 schedules (now template cadences)
- §11 reliability (watchdog checks)
- §12 core testing approach

## 2. Users and Goals

| User | Style | v1 value |
|---|---|---|
| Spouse | Day and one-week trades: US stocks/ETFs, ES/NQ/MES/MNQ, CL/GC. She executes in IBKR or Robinhood. | Live charts with key levels; intraday strategies that alert automatically; paper-testing her setups |
| Owner | Long-term, swing, tactical; covered calls; mini and micro futures swings ([02g](02g-desk-covered-calls-and-futures-swing-design.md)) | Long-term and options strategies that alert automatically; paper-testing covered-call and swing rules |

The two main jobs are answering investment questions (stocks, futures, options, mostly covered calls) and watching each user's own lists through their own strategies.

Success criteria:
1. Each user keeps at least one active strategy that alerts without manual setup per symbol.
2. Every alert and paper fill can be traced to a strategy version and its evidence.
3. No alert is wrong because of missing data. Gaps and delayed data are labeled, never hidden.

## 3. Scope

**Desk v1 (Release 2):**
- Strategies with a versioned spec, a builder, templates, and chat drafting.
- Automatic alerts.
- IBKR paper trading with performance per strategy.
- Watchlists (as strategy inputs).
- Ask (chat).
- Holdings import.
- Charts as context for signals.
- The data foundation from [02b](02b-desk-market-data-options.md).

**Parked, not committed:**
- **Desk v2:** automated live long-term trading.
  - Sell and roll covered calls; buy and sell long-term stocks when strategy triggers fire.
  - It starts in "propose, then confirm" mode, and later runs automatically within limits.
- **Desk v3:** automated day trading at 1–10 trades per day, with hard caps and the off switch. Never high-frequency.

**Not in v1:**
- live orders
- backtesting (the spec format leaves room for it)
- native apps
- web push
- investor-persona portfolio reports beyond the weekly review block
- IBKR CSV statements (Flex replaces them)

## 4. Strategy Model

### 4.1 Records

| Record | Meaning |
|---|---|
| Strategy | Owner, name, current stage, current version |
| Strategy version | An immutable spec. Every save creates a new version, and old signals and fills stay attributed to the version that produced them. |
| Signal | A version fired for a symbol on a bar, with its evidence (the inputs and values that made the rule true) and a data-quality label |
| Alert | A signal (or system event) delivered to a person |
| Order intent | A paper order requested by a signal, sent through an outbox |
| Fill | An IBKR execution linked back to its order intent |

### 4.2 Stages

`draft` → `alert_only` → `paper`. The owner moves a strategy between stages and must confirm the move to `paper`. Desk v2 adds `live_confirm` and `live_auto`. v1 code must not offer either.

### 4.3 Spec Format and Validation

- The spec is **JSON**, stored as JSONB in Postgres.
- YAML was rejected for two reasons:
  - YAML 1.1 parsers read `15:55` as the integer 955 and `no` as `false`.
  - The chat drafts specs with JSON-Schema-constrained output.
- **Zod v4 is the source of truth.** This mirrors `expense-tax-management/packages/contracts`:
  - A new `ai-trading/contracts` package defines `StrategySpecV1`.
  - A `generate:json-schema` script writes `strategy-spec-v1.schema.json`.
  - `datamodel-code-generator` turns that schema into Pydantic models for the Python engine.
  - A CI `check-generated` step fails on drift.
- The frontend form validates with Zod. **The API validates again on every save**, because client-side validation is a convenience, not a trust boundary.
- `schemaVersion` is a required field. A breaking change creates `StrategySpecV2` plus a migration.
- Nobody types JSON by hand. Specs come from the form builder or a chat draft. "View JSON" shows the stored spec.

Spec shape (example; field names are final in the contracts package):

```json
{
  "schemaVersion": 1,
  "name": "ORB breakout 15m",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" },
  "when": {
    "all": [
      { "op": "crosses_above", "left": { "series": "close" }, "right": { "level": "opening_range_high", "minutes": 15 } },
      { "op": "gte", "left": { "series": "rvol", "lookbackDays": 10 }, "right": { "value": 2.0 } },
      { "op": "gt", "left": { "series": "close" }, "right": { "series": "vwap" } }
    ]
  },
  "then": {
    "alert": { "channels": ["inbox", "telegram"] },
    "paperOrder": { "side": "buy", "riskUsd": 200, "stop": { "level": "premarket_high" }, "targetR": 2 }
  },
  "limits": { "maxTradesPerDay": 3, "maxOpenPositions": 2, "flatBy": "15:55", "pauseAfterDailyLossUsd": 600 }
}
```

### 4.4 Block Library (v1)

Blocks are code. Adding a block type takes a pull request that changes the Zod schema, the evaluator, and the tests together.

| Kind | Blocks |
|---|---|
| Series | close/open/high/low/volume, VWAP, EMA(n), SMA(n), RSI(n, timeframe), ATR(n), relative volume (lookback), gap %, % from 52-week high, IV30, IV rank; the [02f](02f-desk-indicators-and-ai-daily-design.md) §3 indicators (MACD, Stochastic, Stoch RSI, CCI, ADX/DMI, Awesome Oscillator, Momentum, Williams %R, Bull/Bear Power, Ultimate Oscillator, VWMA, Hull MA, Ichimoku) and the Desk Technical Bias |
| Levels | prior-day high/low/close, pre-market high/low, overnight high/low (futures), opening-range high/low (minutes), N-day high/low, support/resistance, cost basis, short-call strike, pivots (Classic, Fibonacci, Camarilla; 02f §3) |
| Conditions | `gt`, `gte`, `lt`, `lte`, `crosses_above`, `crosses_below`, `within_pct`, `all`, `any`, `not`, time window, earnings within N days, ex-dividend within N days |
| Fundamentals | forward P/E, P/E versus its 5-year median, FCF yield, revenue growth (YoY), debt/equity, position weight %, gain versus cost %, consensus EPS and its 7/30/90-day revision (02f §4), the Desk AI rating, target, and confidence (02f §5) |
| Options | covered-call candidates with 02 §6.3 filters, metrics, and flags; short-call risk rules (02 §6.3) |
| Review | The Desk AI daily verdict ([02f](02f-desk-indicators-and-ai-daily-design.md) §5): four votes and one structured verdict per stock each trading day, checked in code. It replaces the weekly `persona_review`. Spend is logged, with no cap (owner, 2026-10-10). |
| Actions | `alert` (channels, severity); `paperOrder` (side, sizing by risk $, shares, % of book, or contracts; stop; target by R or level; bracket); `paperCoveredCall` (sell by delta/DTE, close at % decay, roll rules) |
| Limits | max trades per day, max open positions, max position $, flat-by time, flatten before the weekend (02g), pause after daily loss, cooldown minutes |

Family-wide limits: at most 12 paper orders per day, plus a global off switch.

### 4.5 Templates (seeded; both users can copy and tune)

- **Intraday:**
  - opening-range breakout
  - VWAP reclaim/loss
  - pre-market high/low break
  - gap-and-go (this replaces the morning scan; runs at 08:30)
  - futures overnight-range break
  - volume spike
- **Swing:**
  - N-day breakout on volume
  - pullback to the 20/50-day average in an uptrend
  - RSI extreme reversal
  - technical bias change (02f §6)
  - futures position risk: roll due, Friday before the close, margin use (02g §5)
- **Long-term:**
  - quality dip (drawdown plus valuation)
  - trim/rebalance (position weight, stretched valuation)
  - covered-call income (02 §6.3; runs at 15:30)
  - short-call risk (02 §6.3)
  - AI daily view (02f §6; replaces the weekly persona review)

### 4.6 Editing

- **Form builder:** Watch, When, Then, and Limits blocks (mockup D2).
- **Chat drafting:** `draft_strategy` returns a schema-valid spec and a diff against the current version. Nothing is saved until the owner confirms.
- **Version history and "View JSON"** in the builder.

## 5. Strategy Runtime

**Cadences:**

| Cadence | When it runs | Where it runs |
|---|---|---|
| `bar_close_1m` | Every 1-minute bar close | The live stream in `api` |
| `premarket_0830` | 08:30 ET | `scheduler` |
| `daily_close` | 16:30 ET, after bars are appended | `scheduler` |
| `weekly` | Monday 07:00 ET | `scheduler` |

All times are America/New_York on exchange trading days. Timestamps are stored in UTC.

**Closed bars only:**
- Rules evaluate on closed bars, so a signal never repaints.
- The signal dedupe key is (strategy version, symbol, bar time).

**Data quality:**
- Every signal carries the freshness label of its inputs (`realtime`, `delayed-15m`, `eod`, `fallback`, `unavailable`).
- A `bar_close_1m` strategy that has no live streaming slot is marked "degraded". It still alerts, labeled delayed, but **places no paper orders**.

**Action pipeline:**
1. A signal writes its `alerts` and `order_intents` rows in one transaction (outbox).
2. The notifier sends the alerts.
3. The paper broker sends the order intents.

**Alerts:**
- They go to the in-app inbox plus each user's channel (Telegram bot message or Slack incoming webhook).
- Quiet hours apply. Risk and system alerts ignore them.
- System alerts cover:
  - gateway down
  - the weekly IBKR re-login reminder (Sunday 18:00 ET)
  - a strategy that paused itself
  - a reconciliation mismatch

**Limits:**
- A strategy that hits a limit pauses itself, with a system alert.
- The global off switch (in Settings, usable from mobile) stops all new order intents and cancels working paper orders.

## 6. Paper Trading (IBKR Paper)

- **Gateway:** IB Gateway logs into the data username's paper account, with the live data subscriptions shared to it. One session then serves both live data and paper orders. If IBKR does not allow this, the spike fallback adds a second gateway: one on the live data login (read-only) and one on paper for orders.
- **Paper-only guard (fails closed):**
  - The broker refuses any order unless the connected account ID starts with `DU` *and* the gateway is on the paper port *and* the Desk config is `paper`.
  - The guard has its own tests.
- **Orders:**
  - Limit, stop, and bracket (one-cancels-other) orders through `ib_async`.
  - `orderRef` carries the order-intent ID, which links the order to its strategy version.
  - Order intents are sent once. After a restart, the broker reconciles by `orderRef` before sending anything.
- **Fills:**
  - IBKR executions are written to `fills` (unique by execution ID).
  - Positions and P&L are computed per strategy from those fills.
  - Two strategies cannot hold the same symbol at the same time in paper (a v1 rule), so positions never net out silently.
- **Flat-by:** at a strategy's flat-by time, the broker cancels its working orders and closes its positions.
- **Reconciliation:** on every reconnect and every 15 minutes, IBKR orders and positions are compared with ours. A mismatch pauses the strategy and sends a system alert.
- **Stats:** a daily rollup per version records trades, win rate, average R, P&L, and maximum drawdown (mockups D2 and D3).
- **Layout:** Paper is a top-level tab (`/paper`). Later it becomes "Test", with Paper and Backtests sub-tabs. There is one app and one Clerk login. Safety comes from three things:
  - the stage machine
  - a permanent amber `PAPER` badge
  - (in v2) an extra confirmation step for anything live

## 7. Data Architecture

Data sources, cost, and the store layout are in [02b](02b-desk-market-data-options.md). The runtime:

| Service | Role |
|---|---|
| `ib-gateway` + IBC | The data username's paper login (section 6), on the internal network only. Order placement is enabled only because the login is paper, and every order goes through the paper guard. If the spike fallback adds a live-data gateway, that one runs with IBKR's Read-Only API setting. Up to 32 API clients: Desk `api` = 1, `scheduler` = 2, Vibe-Trading = 3 later. |
| `api` (one process) | Owns the live stream: subscriptions, 1-minute bars, SSE fan-out to browsers (at most about 4 updates per second), `bar_close_1m` evaluation, and alert delivery even with no browser open. Also serves REST, AG-UI chat, and an internal `/api/data/*`. One worker on purpose; split out a `market` service if CPU becomes the limit. |
| `scheduler` | Backfills, nightly appends, the 15-minute refresh, `premarket_0830`, `daily_close`, `weekly`, calendar and fundamentals refresh, the Flex import, and watchdog checks |
| `postgres` | All state (PostgreSQL 17) |

**Streaming slots** (IBKR's default cap is 100 live symbols per username):
- The Desk uses at most 70, in this priority order:
  1. intraday strategy universes
  2. open charts
  3. covered-call underlyings during scans
- 30 are left for Vibe-Trading and option-chain snapshots.
- Settings shows slots in use.

**Failure handling:**
- **Gateway down:**
  - Stocks fall back to delayed Alpaca data (labeled).
  - Futures show `unavailable`.
  - `bar_close_1m` strategies are degraded (no paper orders).
  - A system alert goes out.
- **Alpaca or Finnhub down:** retry with backoff, and data stays labeled stale. Nothing is silently substituted.

**Reuse by the other ai-trading apps:**
- Vibe-Trading attaches to the same gateway (spike).
- TradingAgents and Vibe-Trading get the free keys (FRED, Finnhub, Alpaca) through their Firestore profiles.
- ai-hedge-fund can use `/api/data` later by overriding its hard-coded `BASE_URL` in the wrapper image (no upstream edits; not v1).

## 8. Hostnames and App Layout

| Host | Role |
|---|---|
| `trading.tobytran.dev` | **Family Desk** from Phase 4: static Next.js export from GCS through the existing Worker pattern; `/api/*` goes through the tunnel to the Desk `api`. Until then it still serves the hub from `web:3000`. |
| `trading-hub.tobytran.dev` | **Hub** (moved 2026-10-10, 01l): the registry (`/apps/*`) and the terminals (`/u/*`) |
| `tradingagents.`, `ai-hedge-fund.`, `vibe-trading.`, `mirofish.` | The upstream apps (open-source lane) |

The hub move (cutover steps 1 and 2: bring up `trading-hub`, pass its staging checks) is done. Phase 4 does step 3, switching `trading.tobytran.dev` to the Desk:
- a GCS bucket and Worker routes for `trading.tobytran.dev` (static plus `/api/*`) in `infrastructure/cloudflare/ai-trading/`;
- the hub registry's Desk card, which links to `trading.tobytran.dev`;
- a check that the Clerk origins and the `ai-trading/gateway` profile's `ALLOWED_ORIGINS` (set by the hub move) still admit `trading.tobytran.dev`.

Tabs:
- Desktop: **Today · Strategies · Paper · Ask · Watchlists · Holdings**
- Mobile: **Today · Strategies · Paper · Ask · More** (Watchlists, Holdings, Settings under More)

## 9. Data Model Additions

These add to 02 §7. The 02 `users.role` column is dropped.

| Table | Key columns |
|---|---|
| `watchlists` | 02 columns + `horizon` (`intraday`, `swing`, `long_term`) |
| `strategies` | id, owner_user_id, name, stage, current_version_id, paused_reason, created_at |
| `strategy_versions` | id, strategy_id, version, schema_version, spec (jsonb), change_note, created_by, created_at; unique (strategy_id, version) |
| `signals` | id, strategy_version_id, symbol, bar_time, evidence (jsonb), data_quality, created_at; unique (strategy_version_id, symbol, bar_time) |
| `alerts` | 02 columns + signal_id (nullable for system alerts) |
| `order_intents` | id (also the IBKR `orderRef`), signal_id, strategy_version_id, mode (`paper`), payload (jsonb), status, created_at, sent_at |
| `fills` | id, order_intent_id, exec_id (unique), symbol, side, quantity, price, commission, filled_at |
| `strategy_stats` | strategy_version_id, trade_date, trades, wins, pnl, max_drawdown |
| `holdings_imports` | id, user_id, source (`ibkr_flex`, `csv`), imported_at, status, error. Fills 02's `accounts`, `lots`, and `short_calls`. |

## 10. Security and Safety

- Clerk/Caddy gate as in Release 1. The API checks the verified identity on every request and checks ownership on strategies, threads, and holdings.
- **Who can place orders:**
  - Only the strategy runtime places orders, through the paper broker and its guard.
  - The chat agent cannot call the broker.
  - Chat edits to strategies require the owner's confirmation.
- **Secrets:** a new Firestore profile `ai-trading/desk`, written only through `common/config/family_config.py`. Key names:
  - IBKR paper login for IBC
  - Alpaca key pair
  - Finnhub and FRED keys
  - Telegram bot token
  - Slack webhook URLs
  - Desk database passwords
  - IBKR Flex tokens
  - LLM keys (linked from `shared/llm`)
  Values are never committed or logged.
- **Flex tokens** can only pull read-only reports.
- **Public repository:** no balances, positions, account numbers, or emails in commits. Mockups use made-up numbers.

## 11. Reuse Map

Code from the upstream apps is copied into the Desk (or into `ai-trading/common/` when two packages need it), never imported (`AGENTS.md` "Our Code"). Each adapted file carries an attribution header and a row in the receiving package's `THIRD_PARTY_NOTICES.md` with the upstream license text. Apache-2.0 files (TradingAgents) are also marked as modified. MiroFish is AGPL-3.0: ideas only, never code.

The recon of 2026-10-10 checked all four apps against the Desk goals: TradingAgents `1394a3f` (v0.6.0), ai-hedge-fund `78b779c` (v2.5.0), Vibe-Trading fork `d402c2d`, MiroFish `7657031`. Each pin equals its upstream tip or is synced to it. The local notes are `ai-trading/temp/desk-research/recon-*.md`. Verdicts:
- **copy:** lift with attribution;
- **adapt:** rework the code into our shapes;
- **pattern:** reimplement the idea, no code.

| Phase | Source (license) | Item | Use | Verdict |
|---|---|---|---|---|
| 1b ✓ | Vibe-Trading `agent/src/quantlib/options.py` (MIT) | Black-Scholes, greeks, IV solver | `core/options_math.py` (standard library) | done |
| 1b ✓ | Vibe-Trading `agent/src/tools/pattern_tool.py` (MIT) | Peak/valley clustering | `levels.support_resistance` | done |
| 1b ✓ | ai-hedge-fund `hedge_fund/risk/limits.py` (MIT) | Clamps with an audit trail | `core/sizing.py` | done (pattern) |
| 1c | Vibe-Trading `agent/backtest/engines/global_futures.py` `_MULTIPLIER`, `_extract_product` (MIT) | Futures specs per product (minis and micros) and product-code parsing, with tests | `core/futures.py` | copy (not its margins or engine) |
| 1c | Vibe-Trading `agent/src/skills/technical-basic/example_signal_engine.py` `compute_adx`; `skills/ichimoku/example_signal_engine.py` (MIT) | The ADX/DMI chain with Wilder smoothing; the Ichimoku lines | `core/indicators.py` | adapt (formulas; our tests) |
| 1c | TradingView technical-ratings documentation | Published vote rules and thresholds | `core/bias.py` (02f §3) | rules only |
| 1d | TradingAgents `tradingagents/dataflows/date_window.py` (Apache-2.0) | One as-of boundary; half-open windows; withholding undated data | `core/asof.py` | adapt (pure helpers and tests) |
| 1d | ai-hedge-fund `6c41ae8:src/agents/valuation.py` (MIT, v1 history) | Owner earnings, DCF and scenarios, EV/EBITDA, residual income, WACC | `core/valuation.py` (02h §4) | copy |
| 1d | ai-hedge-fund `hedge_fund/event_study/engine.py`, `stats.py` (MIT) | Market-model abnormal returns around events | `core/earnings_reaction.py` (single stock, no bootstrap) | adapt |
| 1d | ai-hedge-fund `hedge_fund/backtesting/fund.py`, `pipeline/stages.py` (MIT) | Performance metrics; decide at the close, execute at the next bar | `core/backtest.py` over the Phase 1 evaluator (02h §2) | pattern |
| 1d | TradingAgents `tradingagents/memory/log.py`, `settlement.py` (Apache-2.0) | Idempotent settlement after a horizon; known-at-time filtering | `core/settlement.py` (02h §3) | pattern |
| 2 | Vibe-Trading `agent/backtest/loaders/_http.py` `HostThrottle`, `throttled_get_json` (MIT) | Per-host rate limiter with jitter and session reuse | `ai-trading/common/http.py` | copy |
| 2 | Vibe-Trading `agent/backtest/loaders/stooq_loader.py` (MIT) | Detect an anti-bot page and latch the source off | Provider fallback policy | pattern |
| 2 | TradingAgents `dataflows/router.py`, `errors.py`, `config.py` (Apache-2.0) | Fallback chains; "no data" versus "unavailable" | `ai-trading/common` provider errors | pattern |
| 2 | TradingAgents `dataflows/vendors/yahoo/ohlcv.py`, `market.py` (Apache-2.0) | Bar hygiene: inclusive ends, stale-frame rejection, partial-bar refresh | Bar-store guards (rules and tests, not the Yahoo client) | adapt |
| 2 | TradingAgents `dataflows/vendors/sec_edgar.py` (Apache-2.0) | SEC CompanyFacts by filing date, correct quarter and year spans, daily cache | The fundamentals client in `ai-trading/common/`; compare with `ai-trading/market-data/sec.py` and keep one | adapt |
| 2 | TradingAgents `dataflows/vendors/fred.py` (Apache-2.0) | FRED with the vintage pinned to the as-of date | Macro client in `ai-trading/common/` | adapt |
| 2 | TradingAgents news and social fetchers (Apache-2.0) | Publication-window filtering; "unavailable" kept apart from "no news" | The Finnhub news client | pattern |
| 2 | ai-hedge-fund `hedge_fund/data/cached.py` (MIT) | Never cache a trading day that has not closed | Bar and quote caches | pattern |
| 2 | ai-hedge-fund `hedge_fund/signals/pead.py` (MIT) | The 8-K (Item 2.02) is the announcement date, not the 10-Q | `earnings_results` | pattern |
| 2 | `ai-trading/market-data/` (ours, open-source lane) | Alpaca daily bars, SEC metrics | Move into `ai-trading/common/` with the open-source lane | move |
| 2 | Vibe-Trading `agent/src/trading/connectors/ibkr/local.py` (MIT) | Paper and live-read-only profiles with their ports; the market-data type (delayed type 3 when no subscription) | The IBKR client in `ai-trading/common/`; read side only (the file places no orders) | adapt |
| 3 | ai-hedge-fund `hedge_fund/paper/tick.py` (MIT) | Idempotent, catch-up-safe ticks that halt on failure | Scheduler jobs | pattern |
| 3 | Vibe-Trading `agent/src/channels/manager.py`, `channels/bus/queue.py` (MIT) | Retry with backoff, fingerprint dedupe, URL-credential redaction | `ai_trading.notify` | adapt |
| 3 | Vibe-Trading `agent/src/live/runtime/triggers.py` (MIT) | Wall-clock-free "due now" checks | Scheduler tests (the calendar itself stays `exchange_calendars`) | pattern |
| 3 | deer-flow notification delivery (MIT) | Secret redaction | `ai_trading.notify` | adapt |
| 4 | Vibe-Trading `frontend/src/lib/indicators.ts` (MIT) | MA, EMA, Bollinger, MACD, RSI, stochastic for chart overlays | Desk frontend chart overlays | copy |
| 4 | TradingAgents `tradingagents/agents/rating.py`, `reporting.py` (Apache-2.0) | Own rating kept apart from quoted ratings; provenance fields | The AI verdict card | adapt (tests and fields) |
| 5 | ai-hedge-fund `hedge_fund/signals/llm_agent.py`, `buffett.py` and the other maintained personas (MIT) | Fail loud on data errors, abstain on model failure, a prompt cache keyed by content hash, a JSON-only contract | The Desk AI votes (02f §5) | pattern; persona prompts adapted |
| 5 | ai-hedge-fund `hedge_fund/features/snapshot.py` (MIT) | Point-in-time snapshot with a content hash | Verdict inputs and cache keys | pattern |
| 5 | ai-hedge-fund `hedge_fund/llm/client.py` `extract_json` (MIT) | Fenced, bare, or embedded JSON extraction | Fallback parsing behind PydanticAI | adapt |
| 5 | TradingAgents `agents/schemas.py`, `structured.py`, analyst and debate prompts (Apache-2.0) | Typed recommendation with a structured-output fallback; evidence-first prompts | The verdict schema and prompts | adapt |
| 5 | TradingAgents `agents/context.py` (Apache-2.0) | A run signature: never resume a run under changed inputs | The AI job | pattern |
| 5 | Vibe-Trading `agent/src/scheduled_research/verdict.py` (MIT) | An explicit "contract violation" state instead of guessing | Verdict validation (02f §5 checks) | pattern |
| 6 | ai-hedge-fund `hedge_fund/paper/ledger.py` (MIT) | Append-only, hash-chained records; a kill switch; corrections kept, not erased | The fills journal | pattern |
| 6 | ai-hedge-fund `hedge_fund/pipeline/stages.py` (MIT) | Reject a decision made under a stale strategy version | The order gate | pattern |
| 6 | Vibe-Trading `agent/src/live/order_guard.py` (MIT) | Enforce the larger of notional or quantity × price; fail closed on a bad quote; a locked daily counter | The order gate | pattern |
| 6 | ai-hedge-fund `hedge_fund/fund/spec.py` (MIT) | Validated spec with an off switch | Paper settings | pattern |
| 7 | TradingAgents `dataflows/vendors/yahoo/snapshot.py` (Apache-2.0) | A typed, as-of evidence snapshot | Every Ask tool result carries provider, as-of time, and values | adapt (the contract, not the Yahoo text) |
| 7 | Vibe-Trading `agent/backtest/options_payoff.py` (MIT) | Option legs and payoff | `collar_quote` | adapt |
| Later | Vibe-Trading `agent/backtest/engines/options_portfolio.py` `iv_smile_adjustment` (MIT) | Skew and curvature against moneyness | Option backtests and marks | adapt later |
| Later | Vibe-Trading `agent/src/tools/options_chain_tool.py` (MIT) | Free options chain from Yahoo's unofficial API | A fallback chain source, only if the owner accepts Yahoo's terms | owner decision |
| Later | MiroFish (AGPL-3.0) | A catalyst-to-position brief; a "what-if" delta | Ask features | idea only |
| — | Packages | `ib_async`, `alpaca-py`, `pydantic-ai-slim[ag-ui]`, `ag-ui-protocol`, assistant-ui, lightweight-charts (Apache-2.0; keep its notice), Zod v4, datamodel-code-generator | Dependencies | — |

Corrections from the recon:
- TradingAgents' indicator catalog covers only SMA, EMA, MACD, RSI, Bollinger, ATR, and VWMA (descriptions over `stockstats`). It is not a source for the 02f indicators.
- Vibe-Trading's `ibkr/local.py` only reads; its order path is elsewhere and gated.
- ai-hedge-fund v2.5.0 has no web app and no numeric valuation. The maintained personas are in `hedge_fund/signals/`, while the v1 personas exist only in history.

Skipped:
- Vibe-Trading:
  - its LLM-written strategy code and sandbox;
  - the factor zoo;
  - China- and Hong Kong-specific tools and channels;
  - harmonic, Elliott-wave, and chanlun skills;
  - the shadow-account subsystem;
  - crypto connectors.
- TradingAgents:
  - its LangGraph orchestration and LangChain tools;
  - the CLI;
  - its Yahoo, Alpha Vantage, Polymarket, Reddit, and StockTwits feeds;
  - its LLM-rating backtest.
- ai-hedge-fund:
  - the Textual TUI;
  - the `JevLLM` adapter;
  - the v1 graph agents.
- MiroFish code, and its synthetic personas and simulated forecasts.

## 12. Verification Spike (First Implementation Task)

Each item has a decided fallback, so the design does not change if a check fails. Results: [02d](02d-desk-spike-results.md).

| Check | Fallback |
|---|---|
| The data username's paper login receives shared live data, and whether it needs 2FA | Two gateways: live data login (read-only) plus paper login for orders |
| The $10 bundle waiver applies to a second username | Pay $14.50 |
| Option-chain snapshot speed under the 100-symbol cap | Spread covered-call scans over about 5 minutes; fewer candidates |
| IBKR implied-volatility history for IV rank | Store daily IV30; label IV rank "short history" until 252 sessions and hide it before 60 |
| The Vibe-Trading IBKR connector's host and port can be configured | Vibe-Trading keeps its own data |
| Host headroom for IB Gateway, Postgres, `api`, and `scheduler` on the VPS | Move the ai-trading stack to the home Ubuntu server |
| An IBKR Flex Web Service token pulls positions and open options read-only | CSV upload |
| The `trading-hub` hostname move (Clerk origins, cookies, ttyd origin) | Done by the open-source lane (01l, live 2026-10-10) |
| Paper account ID prefix | Record the observed prefix as the guard value |

## 13. Testing

- **Strategy evaluation:** pure functions; golden tests on fixed bar fixtures for every template, at exact trigger boundaries (fires, does not fire, and repaint safety).
- **Contracts:** Zod and the generated Pydantic models accept and reject the same fixtures; CI fails on drift.
- **Paper broker:**
  - the guard refuses non-`DU` accounts, non-paper ports, and a non-paper config
  - order intents are never sent twice
  - fills attribute to the right strategy
  - limits pause strategies
  - the off switch cancels working orders
  - reconciliation detects mismatches
- **Data adapters:** contract tests against recorded responses; no live network calls in CI.
- **Chat:** PydanticAI test models show that `draft_strategy` only produces schema-valid specs and never saves without confirmation.
- **Frontend:** component tests for the builder, signal cards, and Paper tables; one Playwright smoke test (Today → Strategies → Paper).
- **Deploy:** compose validation, `health-check.sh`, and the backup restore drill for the Desk database (02 §12).

## 14. Build Order

Each slice ships on its own:
1. Data foundation, the strategy engine (alert-only), intraday templates, and alerts (inbox and channel).
2. Long-term templates, fundamentals, the Flex holdings import, and the covered-call templates.
3. IBKR paper trading, the guard, reconciliation, and performance tracking (Paper tab).
4. Ask (chat) with `draft_strategy`, `explain_signal`, and `strategy_performance`.

The hub already moved to `trading-hub` (01l), so `trading.tobytran.dev` is free for the Desk once Phase 4 ships.

## 15. What v1 Must Not Block (for v2 and v3)

- The broker interface takes a mode (`paper` now; `live` later). Live mode needs its own guard and an extra confirmation step.
- The stage machine can grow to add `live_confirm` and `live_auto`.
- Family-wide caps and the off switch already apply to every order path.
- Every order is traceable to a strategy version and a signal.

## 16. Mockups (Paper)

All mockups are in the file "TobyTest", page "Family Desk · R2 mockups". Dark instrument-panel style: Inter, amber `#FFB020` as the single accent for live/alert/paper state, and green/red only for price direction.

| Artboard | Shows |
|---|---|
| D1 · Today (desktop) | Watchlist, chart with the paper position (entry, stop, target), strategy signal feed, "Desk read" |
| D2 · Strategies (desktop) | Strategy list with owner, stage, and 30-day paper P&L; builder blocks; stage control with Live locked; unsaved-change bar |
| D3 · Paper (desktop) | Paper P&L, open positions by strategy, per-strategy table, fill journal, "Pause all strategies", Backtests locked as "later" |
| M3 · Today (mobile) | Signal feed: paper fill, VWAP alert, short-call risk with a roll idea, persona review |
| M2 · ES chart (mobile) | Futures strategy armed at the overnight high |
| M5 · Watchlist (mobile) | Lists as strategy inputs, rows tagged with signals |
| D4 · Watchlists (desktop) | Lists with horizon tags; symbols with live/delayed labels and today's signals; a new symbol backfilling (`/ES` style for futures); strategies using the list; streaming slots 41 of 70; where each number comes from |
| D5 · Holdings (desktop) | Accounts from IBKR Flex and Robinhood CSV; positions with covered-call coverage under each symbol's cap; tax lots with the short-term flag; open short calls; the strategy watching the position |
| D6 · Ask (desktop) | Threads; a covered-call candidate table rendered from a tool result with its data label; a `draft_strategy` diff (v5 → draft v6) that saves only on "Save as v6"; the monthly budget |
| D7 · Settings (desktop) | Telegram/Slack channels and quiet hours; the family-wide off switch, daily cap, and paper guard checks; Ask budget; gateway re-login, data sources, reconciliation, and backups status |
| D8 · New strategy from a template (desktop) | The ten intraday and swing templates (`packages/family-desk/contracts/templates`), alert-only versus alert + paper, a plain-English preview, the list picker, and "Use this template" creating draft v1 |
| D9 · Watchlist flip cards (desktop) | A card grid with NVDA and ES flipped to their technical backs ([02f](02f-desk-indicators-and-ai-daily-design.md) §2) |
| D10 · Technicals (desktop) | Gauges; a chart with RSI and MACD; the oscillator, moving-average, and pivot tables |
| D11 · Stock long-term (desktop) | The Desk AI verdict with its panel, consensus EPS, analyst context, "Alert me" |
| D12 · AI daily brief (desktop) | Every analyzed stock after the close, with the alerts feed |
| M7 · Watchlist flip (mobile) | A flipped card on a phone |
| M8 · Stock long-term (mobile) | The verdict, consensus EPS, and alerts on a phone |
| D13 · Covered calls (desktop) | Coverage for each holding with its reasons, AVGO's candidates with the opportunity banner, a payoff sketch, Desk AI context ([02g](02g-desk-covered-calls-and-futures-swing-design.md) §2) |
| D14 · Short calls & income (desktop) | Open short calls and risks, the KO roll panel, the assignment note, premium by month, the Monday digest |
| D15 · Futures swing (desktop) | Pair chips (mini/micro, broker availability), weekly levels, bias gauges, the micro-first sizer, positions with roll warnings, the weekend card |
| D16 · Futures specs & roll calendar (desktop) | The 12 contracts' specs and approximate margins, mini/micro equivalence, the roll timeline, session hours |
| M9 · Short-call risk alert (mobile) | The KO alert with roll candidates |
| M10 · Futures swing position (mobile) | MNQ ×3 with P/L, R multiple, a price ladder, the weekend choice, the roll countdown |
| D17 · Backtest (desktop) | A strategy version over 2018–2026 daily bars: next-open fills, stats in R, equity against buy-and-hold, per-year returns, honest-results box, "Promote to Paper" ([02h](02h-desk-research-tools-design.md) §2) |
| D18 · Desk AI track record (desktop) | Settled AI calls against SPY: results by rating, calibration, the target hit rate, recent calls with lessons |
| D19 · Valuation & earnings reaction (desktop) | AAPL: four intrinsic-value methods and the blend, the earnings-reaction stats and chart, "Feeds the Desk AI" |
| M11 · Holding timeline (mobile) | AAPL's dated events: earnings, macro, Desk AI, consensus, news, strategy, filings |
| M6 · More (mobile) | The off switch first, then Watchlists, Holdings, and Settings; the next IBKR phone approval |
