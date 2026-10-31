# Release 2 Addendum B: Family Desk Market Data Options

Status: Research done 2026-10-10. The owner approved the decision (section 4) the same day; **the 2026-10-10 decision is revised 2026-10-29 (section 4b): live data moves from the IBKR data username to Alpaca Algo Trader Plus, not yet purchased; section 4c (2026-10-30) adds Tradier and marketdata.app behind the same registry.** Prices come from vendor and broker pages read on 2026-10-10 and change often. The owner subscribed the IBKR data user on 2026-10-10 ([02e](02e-ibkr-data-user-setup.md)); [02d](02d-desk-spike-results.md) records what the spike confirms.

Related: [02a-desk-v1-strategies-design.md](02a-desk-v1-strategies-design.md) (the Desk v1 design that uses this data), [02-release-2-desk-design.md](02-release-2-desk-design.md) (the kept base sections), [STATUS.md](../STATUS.md).

## 1. Needs

| User | Style | Data need |
|---|---|---|
| Spouse | Day and one-week trades in US stocks/ETFs, index futures (ES, NQ, MES, MNQ), and commodity futures (CL, GC). Limit and stop orders; no high-frequency trading. | Real-time quotes and 1-minute bars including pre- and after-hours. TradingView-style charts inside the Desk. |
| Owner | Long-term, swing, and tactical investing; covered calls | Daily and hourly history; option chains with greeks (a 15-minute delay is fine for scans); fundamentals; earnings and dividend dates |

- Budget: at most **$30 per month** for paid data, both users combined. This replaces the $20 cap in 02.
- The same data layer will later feed the upstream apps (Vibe-Trading, ai-hedge-fund, TradingAgents).

## 2. Findings That Decided It

1. **No vendor sells real-time consolidated US stock data for under $99 per month.**
   - Alpaca Algo Trader Plus costs $99 and Massive Advanced costs $199. Massive is Polygon.io under its new name since 2025-10-30.
   - Cheaper "real-time" feeds cover IEX only, about 2–3% of volume, which biases VWAP and relative volume.
   - Sources: [Alpaca](https://docs.alpaca.markets/docs/about-market-data-api), [Massive](https://massive.com/stocks), [rename](https://massive.com/blog/polygon-is-now-massive).
2. **No vendor sells real-time CME futures for under about $179 per month outside a broker.**
   - Databento Standard costs $179–$199; its blog posts disagree.
   - Massive Futures Starter ($29) is 15 minutes delayed.
   - Sources: [Databento](https://databento.com/pricing), [Massive futures](https://massive.com/futures).
3. **Brokers give account holders real-time data for little or nothing, and both users already hold IBKR accounts.**
4. **Alpaca's free Basic plan serves consolidated (CTA + UTP) historical bars since 2016.**
   - Only the latest 15 minutes are withheld.
   - The limit is 200 calls per minute, and a paper signup is enough.
   - This is the free backbone of the history store. [Alpaca](https://docs.alpaca.markets/docs/about-market-data-api)
5. **IBKR streams snapshots, not every trade.**
   - Updates arrive every 250 ms for US stocks and futures and every 100 ms for US options.
   - True tick-by-tick data is limited to a few symbols at once.
   - [IBKR update frequency](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-live/top-of-book-l-1/market-data-update-frequency)

## 3. Options Considered for Live Data

| Option | Per month | Real-time coverage | Notes |
|---|---|---|---|
| **A. IBKR data login (chosen)** | $14.50 | Stocks (all exchanges, extended hours), futures, option greeks; 250 ms | Uses existing accounts, and quotes match the IBKR order ticket. Billed per username; one session per username; $500 minimum equity for subscriptions. Live logins need a weekly 2FA re-login. |
| B. tastytrade free feed | $0 | Stocks, futures, greeks; streamed in batches of about 100 ms (adjustable) | Needs a new funded account per person, possibly with futures approval. Minute history about 43 days. Its tokens refresh without a person. No upstream app supports it. |
| C. Data vendors only | $29 | Stocks IEX-only; futures *or* options 15 minutes delayed | Fails real-time futures |

Ruled out:
- **Tradovate:** $12 for CME Level 1, but a $35/month inactivity fee applies without trades there.
- **Schwab:** needs a new account and a browser re-login every 7 days.
- **Robinhood, Fidelity, Vanguard:** no official market-data API.

IBKR non-professional pricing, per username ([IBKR market data pricing](https://www.interactivebrokers.com/en/pricing/market-data-pricing.php?p=nonpro2)):

| Subscription | Per month | Note |
|---|---|---|
| US Securities Snapshot and Futures Value Bundle | $10 | Waived in months with at least $30 of commissions |
| US Equity and Options Add-On Streaming Bundle | $4.50 | |
| OPRA Level 1 | $1.50 | Not needed: the $4.50 add-on includes OPRA L1, per IBKR's documentation ([02g](02g-desk-covered-calls-and-futures-swing-design.md) §3) |
| No subscription | $0 | Free streaming from Cboe One + IEX venues only |

## 4. Decision (Owner, 2026-10-10)

- **Live data:** one dedicated IBKR data username, used by every ai-trading app (the Desk and the upstream apps).
  - Both users share this one subscription.
  - Exchange data is licensed per person, so sharing one non-professional subscription inside the household's own apps is a known gray area. The owner accepted it.
- **History and reference data:** free sources (section 5).
- **Paid cost:** $14.50 a month as subscribed: the $10 Snapshot and Futures Value Bundle plus the $4.50 Equity and Options Add-On Streaming Bundle. IBKR's documentation says the add-on includes OPRA L1, so option greeks need no separate OPRA line ([02g](02g-desk-covered-calls-and-futures-swing-design.md) §3). Task 0.5 and the first bill confirm it.
- **Consensus EPS (owner, 2026-10-10):** Eulerpool's free tier after a 10-symbol pilot, with Finnhub free plus Alpha Vantage free as the fallback ([02f](02f-desk-indicators-and-ai-daily-design.md) §4). It adds no cost.

## 4b. Decision revision (Owner, 2026-10-29)

The 2026-10-10 decision (section 4) chose the IBKR data username for live data at $14.50/month. That is **reversed** for live data, for one reason: the IB Gateway/TWS live feed needs a human 2FA re-login roughly weekly that cannot be automated, so it cannot drive a real-time alert. Programmatic API-key access is now a hard requirement for any live alert or live-signal screen.

- **Live data (when purchased):** Alpaca Algo Trader Plus, **$99/month** — real-time all-US-exchanges equities (SIP) plus OPRA options (chains, IV, greeks), one account, one API key, no login. **Not purchased yet (2026-10-29):** subscribe only after the products are tested working, all bugs fixed, and feature requests are done. Until then the free/delayed Alpaca key serves development; the code is built so the upgrade is a key/tier swap, not new work.
- **IBKR is reduced to the one-time Flex holdings import** (yearly token, reports only) — the read-only positions path already verified 2026-10-29 (20 lots). No more IBKR gateway streaming.
- **US futures are deferred** out of live-data scope; revisit only if real-time futures alerts become a requirement (then Massive futures ~$199/month is the add-on).
- **Option chains for covered calls** come from Alpaca's options feed (OPRA; delayed until the $99 tier is purchased), replacing the "IBKR snapshots" line in §5.
- **Budget note:** this exceeds the §1 $30/month cap; that cap is superseded by the owner's 2026-10-29 direction to pay for a programmatic feed once the product is proven.

## 4c. Decision revision (Owner, 2026-10-30)

This adds to section 4b and reverses nothing. The owner keeps the adapter pattern ([02j](02j-common-data-providers-design.md)) and wants the cheaper candidates from the provider comparison (`ai-trading/temp/market-data-comparison-20261030.md`, gitignored scratch) beside Alpaca, so any of them can be chosen by configuration.

- **Behind the adapter registry:** Alpaca (the $99/month Algo Trader Plus baseline, already integrated), Tradier ($0 Lite or $10 Pro brokerage plan), marketdata.app ($30 Starter, delayed chains with greeks) and Longbridge (free US Level 1 quotes; about HK$22/month for the OPRA add-on). Longbridge is the exception described below.
- **Free or delayed data until the app is proven useful.** Nothing is bought, no account is opened, and no key exists for any new provider (2026-10-30). Paid data waits for the same gate as section 4b.
- **A paid swap is keys plus env, with no code change:** store the key in Firestore `ai-trading/market-data` and set `DATA_PROVIDERS_QUOTES` and/or `DATA_PROVIDERS_OPTION_CHAIN` (02j §5, §8), for example `tradier,alpaca` or `marketdata_app,alpaca_options`.

**What shipped** (`ai-trading/common`, row 5Q in STATUS; offline tests only):

| Provider | Kinds | Env names read | Data stamp |
|---|---|---|---|
| `tradier` | `quotes`, `option_chain` | `TRADIER_ACCESS_TOKEN`; optional `TRADIER_ENVIRONMENT` (`production`, the default, or `sandbox`) | Quotes `realtime` in production and `delayed-15m` in the sandbox; chains always `delayed-15m` |
| `marketdata_app` | `quotes`, `option_chain` | `MARKETDATA_APP_TOKEN`; optional `MARKETDATA_APP_QUALITY` (`eod`, the default, `delayed-15m` or `realtime`) | The setting, because the delay depends on the plan and the response does not say |

- **Tradier greeks are hourly.** Tradier refreshes them from about 10:15 ET, so a contract's `delta` and `iv` can be an hour older than its bid and ask. The field is exposed as is, and the module docstring says so. Tradier answers an exceeded rate limit (120 requests a minute) with HTTP 400, not 429; the adapter maps it to `SoftBanned`.
- **marketdata.app takes `Authorization: Bearer <token>`** (its authentication page), not the bare token the first brief wrote. The free plan is 24 hours delayed, Starter is 15 minutes, and real-time needs the top plan plus an OPRA entitlement of unknown cost. A chain costs a credit per option symbol, so every request is narrowed by expiry window and strike band.
- **Longbridge ships no adapter.** Its quote documentation (read 2026-10-30) defines the Quotes call as a binary socket command (business command 11) reached through the vendor SDKs, with OAuth in the examples. It documents no REST path, headers or response envelope, and the Quotes response carries `last_done` but no bid or ask (those sit in the separate Depth call). A REST adapter would be invented, and a socket one needs the vendor SDK as a new dependency, so it waits for an owner decision. The option-chain call returns strikes and contract symbols only, so Longbridge could never serve `option_chain` anyway. No env names are fixed for it.
- **Default chains are unchanged.** An unconfigured provider raises `NotConfigured`, and `fallback.first_success` reports the last transient failure, so a keyless provider at the end of a default chain would turn an earlier provider's `Unavailable` into a "no key" error. With no keys, `DEFAULT_CHAINS` therefore behave exactly as before, and a test pins that the new names are in none.

**Future Firestore `ai-trading/market-data` additions** (names only, none exist yet): `TRADIER_ACCESS_TOKEN`, `TRADIER_ENVIRONMENT` (only to use the sandbox), `MARKETDATA_APP_TOKEN`, `MARKETDATA_APP_QUALITY` (set to `delayed-15m` after Starter). `LONGBRIDGE_APP_KEY` and `LONGBRIDGE_APP_TOKEN` are not read by any code.

**Still open** (the comparison doc, section 6): Tradier's data fee, its equity feed and whether Lite gets real-time options; Longbridge's US-resident OpenAPI eligibility, OPRA price, option quote fields and Level 1 source.

## 4d. Decision revision (Owner, 2026-10-31)

This supersedes parts of section 4b and section 4c; §4b and §4c stay as history. The full design is [02t](02t-market-data-bridge-plan.md), a Go gRPC bridge that hides the provider (planned only: nothing is built, bought, or activated).

- **Tradier is declined.** The owner will not create the account. The Python `tradier` adapter (row 5Q) stays in the tree, **dormant**: in no default chain, never ported to the bridge, never given a key.
- **The IBKR gateway is back in.** The owner accepts a **daily on/off ritual** (sign in each trading morning, approve on the phone, close in the evening) with IB Gateway on the spare Ubuntu laptop. This **supersedes the 2026-10-29 gateway rejection** in §4b ("needs a human 2FA re-login"). When the gateway is off, the design falls back down a ladder and the UI says so. The API stays read-only: quotes only, never orders. The §4b reduction to "Flex import only" no longer holds for live quotes; the Flex holdings import itself is unchanged.
- **marketdata.app ($30/month non-professional plan) is an options fallback only**, bought only if Longbridge's real-time options prove poor. Its stock quotes are 15 minutes delayed on every plan (owner-verified on its pricing page), so it is never a stocks source. This corrects the §6 bench row.
- **Provider mix:** IBKR + Alpaca + Longbridge (+ marketdata.app as the options fallback). Alpaca Basic stays the free baseline and last rung; the $99 Algo Trader Plus tier is bought only when the wife reaches a professional level and the app is comprehensive (Telegram alerting plus AI stock Q&A). Longbridge has no account yet, and its US-resident eligibility is unverified.
- **Order:** stocks first, covered-call options later. Futures stay out of scope.
- **Where the work is planned:** [02t](02t-market-data-bridge-plan.md) (STATUS row 5R). The Desk keeps its adapter pattern; the bridge enters the registry as one more provider.

## 5. Hybrid Store: What We Keep and What We Fetch

| Data | Live source | History and backfill | Stored |
|---|---|---|---|
| US stocks and ETFs | IBKR, 250 ms, pre/post market | Alpaca free: daily since 2016, hourly 5 years, 1-minute 30 days. No source for daily history before 2016 (Stooq's CSV endpoint is gated behind a JS proof-of-work challenge with no API key offered, confirmed dead 2026-10-11, Phase 2a); IBKR can backfill further back in Phase 2b if the owner wants it. | `bars_1d`, `bars_1h`, `bars_1m` (1-minute rolling 90 days) |
| Futures | IBKR, 250 ms | IBKR historical hourly and daily | Same tables, plus a front-month roll map |
| Option chains and greeks | IBKR snapshots at scan or chat time | n/a | Scan results only |
| IV30 for IV rank | IBKR daily | IBKR one-year IV history (to verify in the spike) | `iv_daily` |
| Swing and long-term lists | Alpaca free, 15 minutes delayed, refreshed every 15 minutes | n/a | n/a |
| Fundamentals | n/a | SEC EDGAR XBRL (Finnhub basic financials as fallback), weekly | `fundamentals` |
| Consensus EPS, analyst targets | n/a | Eulerpool free after a 10-symbol pilot; Finnhub free plus Alpha Vantage free as the fallback; daily after 16:30 ([02f](02f-desk-indicators-and-ai-daily-design.md) §4) | `consensus_snapshots`, `earnings_results`, `analyst_targets` |
| Earnings, dividends, news | n/a | Finnhub free + yfinance, at 06:00 and hourly | `calendar_events`, `news_items` (7 days) |
| Macro release dates | n/a | FRED release dates + a static FOMC file | `calendar_events` |

Refresh rules:
- A backfill job runs when a symbol joins a watchlist.
- The day's bars and IV are appended at 16:30 ET.
- A 15-minute in-session refresh covers lists that are not streamed live.

Size:
- At most about 10 million rows: 200 symbols, 20 years daily, 5 years hourly, 90 days of 1-minute.
- Plain PostgreSQL 17 is enough, without a time-series extension.

## 6. Kept on the Bench

| Source | Cost | When we would use it |
|---|---|---|
| Massive Options Starter | $29/month | IBKR option snapshots turn out too slow for scans. It gives 15-minute-delayed full option chains with greeks. |
| marketdata.app Trader | $30 monthly or $12/month billed yearly | Same case, with real-time stock quotes for self-certified non-professionals |
| Databento | $125 free signup credit | One-time deep futures history backfill, if backtesting arrives |
| EODHD | $19.99/month | News with sentiment scores |

## 7. Unverified Items

The [02a](02a-desk-v1-strategies-design.md) spike covers these:
- Whether the $10 waiver applies to a second username on the same account.
- Whether the data username can have a paper login that receives its shared live data.
- IBKR implied-volatility history depth.
- Exact CME non-professional fees, which were inconsistent in CME's January 2026 fee list.
- Finnhub free real-time venue coverage.
- Tiingo intraday history depth.
