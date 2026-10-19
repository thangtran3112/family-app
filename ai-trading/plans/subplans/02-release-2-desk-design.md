# Release 2 Base Design: Family Desk (Kept Sections)

Status: approved 2026-10-04 as the first Desk design. On 2026-10-10 the strategy-first Desk v1 replaced most of it:
- [02a-desk-v1-strategies-design.md](02a-desk-v1-strategies-design.md): Desk v1 (strategies, automatic alerts, IBKR paper trading), with its scope, architecture, data model additions, security, spike, and reuse map;
- [02b-desk-market-data-options.md](02b-desk-market-data-options.md): the market-data decision and the store layout;
- [02c-desk-v1-implementation-plan.md](02c-desk-v1-implementation-plan.md): the phased plan.

This file keeps only the sections those documents still cite, under their original numbers: §4.3, §6.3, §6.4, §6.6, §7, §8, §11, and §12. The superseded sections were removed on 2026-10-10; git history has them. Those were: purpose and roles, scope, constraints, services and repository layout, data layer, data entry, morning scan, alerts, infrastructure, Cloudflare Access security, the first spike, the first reuse map, and later releases.

## 4. Architecture

### 4.3 Rules

1. Tools return numbers with as-of timestamps and a data-quality label (02a §5: `realtime`, `delayed-15m`, `eod`, `fallback`, `unavailable`). The UI renders numbers from tool results. The LLM explains and ranks; it never computes prices, greeks, or yields itself.
2. Chat and scheduled jobs call the same tool functions: one code path, one test suite.
3. Borrowed code carries attribution headers and is listed in the receiving package's `THIRD_PARTY_NOTICES.md`.
4. All schedules use the `America/New_York` time zone and an exchange-holiday calendar. Timestamps are stored in UTC.

## 6. Features

### 6.3 Covered-call scan

The covered-call income template runs this scan at 15:30 ET on trading days, and on demand. The math is in `packages/family-desk/backend/src/ai_trading/core/covered_calls.py` (Phase 1b).

Eligibility, per account and symbol: coverable contracts = max(0, floor(shares x max cover % / 100 / 100) - open short-call contracts), at 100 shares per contract. Example: 1,000 shares, 50% cap, 3 open contracts gives 2 more contracts.

Candidate filters (defaults, all settings):

| Filter | Default |
|---|---|
| Days to expiry | 21-45 |
| Delta | 0.15-0.30 |
| Open interest | >= 100 |
| Bid-ask spread | <= 10% of mid |
| Bid | >= $0.10 |
| Earnings before expiry | Excluded |

Metrics per candidate (premium uses the bid; mid is shown for reference):

- Premium yield = bid / spot; annualized yield = premium yield x 365 / DTE.
- Upside cap = (strike - spot) / spot.
- Return if called = (strike - spot + bid) / spot.
- Delta, used as a rough probability of finishing in the money.
- IV rank = (IV30 now - 52-week low) / (52-week high - 52-week low) x 100. IV percentile = share of the last 252 sessions with IV30 below today's value. Both are hidden before 60 sessions of history and labeled "short history" before 252 (02a §12).

Flags:

- Ex-dividend date before expiry.
- Strike below the average cost basis of the account's lots.
- The taxable account holds lots under one year old (assignment could realize a short-term gain, depending on which lots are delivered).
- Shares in a tax-advantaged account are available to cover first.

Score (deterministic): 100 x min(annualized yield, 0.40) + 0.1 x IV rank - 10 per flag - 5 if the spread exceeds 5% of mid - 5 if delta exceeds 0.25. The scan keeps the top three candidates per account and symbol.

Alerts:

- Opportunity: annualized yield >= 15%, IV rank >= 50, and no flags.
- Short-call risk, for each open short call:
  - delta > 0.50;
  - spot within 2% of the strike with 7 or fewer days to expiry;
  - ex-dividend date on the next trading day while the call's extrinsic value is below the dividend (early-assignment risk);
  - an earnings date before expiry.

  Each risk alert lists roll candidates: same or higher strike, later expiry within 60 DTE, net credit >= $0.05 per share.
- Monday digest: open short calls expiring that week with current status.

### 6.4 Chat

One PydanticAI agent. The system prompt includes the user's holdings summary, watchlist names, and strategies. It instructs the model to take every number from tool results, to state as-of times and data-quality labels, to treat news text as untrusted, and to frame ideas as analysis rather than instructions.

Read-only tools (02c Phase 7 adds the strategy tools):

| Tool | Returns |
|---|---|
| `quote` | Last, change, bid, ask, volume, as-of |
| `bars` | OHLCV series for a timeframe and lookback |
| `indicators` | RSI, MACD, EMA, SMA, VWAP (intraday), ATR, Bollinger Bands, relative volume |
| `key_levels` | Prior-day and pre-market or overnight levels, pivots, 52-week range, recent swing highs and lows |
| `chart` | Bars plus overlays and levels for the chart component |
| `option_chain` | Calls and puts with greeks for an expiry and strike range |
| `covered_call_candidates` | The section 6.3 scan for one symbol |
| `collar_quote` | Buy put plus sell call: net cost or credit, protected floor, capped upside |
| `iv_rank` | IV30, IV rank, IV percentile |
| `earnings_and_dividends` | Next earnings date, next ex-dividend date and amount |
| `news` | Recent headlines with sources and times |
| `economic_calendar` | Upcoming economic events |
| `scan_results` | Latest covered-call scan |
| `my_holdings`, `my_watchlists`, `my_short_calls` | The user's own records |

Tool results render as components: a price chart with overlays and levels (TradingView lightweight-charts, Apache-2.0; keep its attribution notice), an option-chain table, a covered-call candidate table, a levels table, and a scan table.

Chart-screenshot Q&A: the user attaches an image; it reaches a vision-capable model as image content.

Threads are stored server-side. The client loads thread lists and history through REST; each run goes through the AG-UI endpoint with the thread ID, and the server checks thread ownership.

### 6.6 LLM budgets and usage

- Per chat run: PydanticAI `UsageLimits` with at most 12 model requests and 60,000 total tokens.
- Per user per calendar month (America/New_York): a spending cap, default $25. Cost = recorded tokens x prices from `packages/family-desk/backend/config/llm_prices.yaml`.
- When a user's cap is reached, chat returns a budget message, and scan summaries switch to template text. Scans and alerts keep working.
- Model IDs live in `packages/family-desk/backend/config/models.yaml`: a Claude Sonnet-class model for chat, a low-cost model for summaries, and an OpenAI model as an alternative. A self-hosted OpenAI-compatible endpoint is a config entry.
- A Usage page shows month-to-date spend per model.

## 7. Data Model

02a §9 adds the strategy tables (`strategies`, `strategy_versions`, `signals`, `order_intents`, `fills`, `strategy_stats`, `holdings_imports`) and a `horizon` on watchlists. 02b §5 defines the market-data tables (`bars_1d`, `bars_1h`, `bars_1m`, `iv_daily`, `fundamentals`, `calendar_events`, `news_items`).

| Table | Key columns |
|---|---|
| `users` | id, email (unique), display_name, telegram_chat_id, settings (jsonb: alert channel, quiet hours, thresholds) |
| `accounts` | id, user_id, label, tax_type |
| `lots` | id, account_id, symbol, shares, cost_per_share, acquired_on |
| `short_calls` | id, account_id, symbol, strike, expiry, contracts, premium_per_share, opened_on, status |
| `position_rules` | user_id, symbol, max_cover_pct |
| `watchlists` | id, user_id, name |
| `watchlist_items` | watchlist_id, symbol, asset_type (`stock` or `future`) |
| `scan_runs` | id, user_id, kind, started_at, finished_at, status (`ok`, `partial`, `failed`), skipped (jsonb), summary_text |
| `scan_results` | id, run_id, symbol, rank, score, payload (jsonb) |
| `alerts` | id, user_id, kind, severity, dedupe_key, title, body, payload (jsonb), created_at, read_at |
| `deliveries` | id, alert_id, channel, status, attempted_at, error |
| `chat_threads` | id, user_id, title, created_at |
| `chat_messages` | id, thread_id, role, content (jsonb), created_at |
| `llm_usage` | id, user_id, thread_id, purpose (`chat` or `summary`), model, input_tokens, output_tokens, cost_usd, created_at |

## 8. Schedules

Strategy cadences are in 02a §5. The system jobs:

| Job | Time (ET, trading days) |
|---|---|
| Calendar refresh | 06:00 |
| Gap-and-go template (`premarket_0830`) | 08:30 |
| Covered-call income template | 15:30 |
| Daily bars and IV snapshot | 16:30 |
| Monday expiration digest | 08:00 on the first trading day of the week |
| Dead-man check | Every 15 minutes, 07:00-17:00 |

## 11. Reliability and Error Handling

- Every scan run stores a status and a per-symbol skip list. Alerts state skipped symbols explicitly.
- IB Gateway health is checked before each job, with reconnect and exponential backoff. If IBKR is unavailable, stock prices come from Alpaca 15 minutes delayed and are labeled `delayed-15m`; futures and option metrics are `unavailable`, and no opportunity or risk alert is generated from missing option data (02a §7).
- The dead-man check sends a `system` alert when a scheduled scan has not completed within 20 minutes of its slot, or when the gateway has been unavailable for more than 30 minutes during 07:00-17:00 ET.
- Channel deliveries (Telegram or Slack) are retried three times with backoff and recorded in `deliveries`. The inbox remains the source of truth.

## 12. Testing

- `core/`: pytest with fixed option-chain and bar fixtures. Covers greeks and implied volatility against reference values, yields, flags, eligibility math, gap math, scoring order, roll candidates, and every alert rule boundary.
- `data/`: adapter contract tests against recorded responses; no live network calls in CI. A manual smoke script exercises the gateway (`ai-trading/tools/ibkr-probe`).
- `agent/`: PydanticAI test models verify tool wiring, usage limits, budget refusal, and the AG-UI event stream without paid calls.
- `api/`: FastAPI tests with the gateway's verified identity header (the Clerk/Caddy gate, 02a §10); ownership checks on threads and records.
- `frontend/`: component tests for each tool-result component and one Playwright smoke test.
- Deploy: compose validation in CI, `health-check.sh` after every deploy, and the backup restore drill including the Desk database.
