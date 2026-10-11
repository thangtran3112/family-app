# Desk: Technical Indicators (Spouse) and the Desk AI Daily Verdict (Owner)

Status: approved in conversation on 2026-10-10 (the mocks, this architecture, and the budget). This extends [02a](02a-desk-v1-strategies-design.md); for these features, this file wins where the two conflict. The phased plan is [02c](02c-desk-v1-implementation-plan.md).

## 1. What the Owner Asked For

- **Spouse (short-term):** the Desk calculates technical indicators for her: RSI, MACD, and the popular set on Investing.com's technical summary. She flips a stock card to see them.
- **Owner (long-term):** consensus EPS, the Desk's own daily AI analysis of each stock (a target price and Buy/Hold/Sell), and alerts.

Owner decisions (2026-10-10):
1. **One verdict, panel inside.** The AI analysis shows one rating, target, confidence, and set of reasons. Underneath sit the votes it weighed and a bull-versus-bear summary.
2. **Eulerpool for consensus EPS.** It comes from Eulerpool's free tier after a 10-symbol pilot, with a free fallback (section 4).
3. **No budget cap on the daily AI job.** The OpenAI and Anthropic keys are sponsored. Its spend is logged and shown on the Usage page.
4. **The mocks are the UI reference:** the six artboards in section 2.

## 2. Screens

The mocks are in Paper: file "TobyTest", page "Family Desk · R2 mockups", bottom row. They are indexed in 02a §16.

| Artboard | Shows |
|---|---|
| D9 · Watchlist flip cards | A card grid with NVDA and ES flipped to their backs. A back shows timeframe chips, the bias gauge with Sell/Neutral/Buy counts, RSI, MACD, Stochastic, ADX, ATR (volatility, no vote), levels, and the "Full technicals" and "Make strategy" buttons |
| D10 · Technicals | Oscillator, summary, and moving-average gauges; a 15m chart with RSI and MACD panes; the oscillator, moving-average, and pivot tables; a "+ Strategy" action on each row |
| M7 · Watchlist flip (mobile) | The same flip on a phone |
| D11 · Stock long-term | The Desk AI verdict (rating, target and range, confidence, change since yesterday, reasons, risks) with "How Desk AI decided" (votes, bull and bear cases, inputs); consensus EPS (beats and misses, next earnings, revisions); analyst consensus as context; the "Alert me" toggles |
| D12 · AI daily brief | Every analyzed stock after the close: rating changes, targets, confidence, EPS revisions, earnings within 7 days; the alerts feed |
| M8 · Stock long-term (mobile) | The verdict, consensus EPS, and alerts on a phone |

**Interaction**
- ↻ or the F key flips a card, and "Flip all" shows every back.
- A back shows one timeframe at a time: 5m, 15m, 1h, 1D, or 1W. The Technicals page adds 30m and 4h.

**Visuals**
- Two visual languages never mix:
  - the half-circle gauge belongs only to the technical bias;
  - the AI uses a rating chip, a range bar, and a violet "Desk AI" mark (`--color-ai`, `#A78BFA`).
- Amber stays the app accent.
- Every number carries its as-of time and data-quality label.

**Actions and footnotes**
- The Desk places no orders. Its actions are "Make strategy", "Full technicals", "Alert me", and "Ask".
- The Technicals page explains how the bias is computed.
- AI screens carry "Desk AI analysis for the family's own use. Not investment advice."

## 3. Technical Indicators and the Desk Technical Bias (Phase 1c, pure code)

Indicators use closed bars only. Stocks use regular-hours bars; futures use the full CME session.

| Kind | Indicators |
|---|---|
| Oscillators (vote) | RSI(14), Stochastic(14,3,3), CCI(20), ADX/DMI(14), Awesome Oscillator, Momentum(10), MACD(12,26,9), Stoch RSI(3,3,14,14), Williams %R(14), Bull/Bear Power(13), Ultimate Oscillator(7,14,28) |
| Moving averages (vote) | SMA and EMA of 10, 20, 30, 50, 100, and 200; Ichimoku (9,26,52); VWMA(20); Hull MA(9) |
| Volatility (no vote) | ATR(14) and ATR as a percent of price, labeled low, normal, or high against its own 100-bar median (below 0.8× or above 1.25×) |
| Levels (no vote) | Classic, Fibonacci, and Camarilla pivots from the prior completed period: the prior session for intraday timeframes, the prior week for 1D, the prior month for 1W |

**The bias**
- Each voting indicator gives −1, 0, or +1 under TradingView's published rules: [how the ratings are computed](https://www.tradingview.com/support/solutions/43000614331-technical-ratings/) and [the rule for each indicator](https://www.tradingview.com/support/solutions/43000475547-what-do-the-ratings-in-the-screener-mean/).
- The oscillator score is the mean of the oscillator votes, and the moving-average score is the mean of the moving-average votes. The summary is the mean of those two scores.

| Score s | Label |
|---|---|
| s < −0.5 | Strong Sell |
| −0.5 ≤ s < −0.1 | Sell |
| −0.1 ≤ s ≤ +0.1 | Neutral |
| +0.1 < s ≤ +0.5 | Buy |
| s > +0.5 | Strong Buy |

- The name is "Desk Technical Bias". Investing.com does not publish its rubric ([its help page](https://www.investing-support.com/hc/en-us/articles/360005868017-How-to-Understand-the-Technical-Analysis-Summary-on-Investing-com) gives only an example), so the Desk does not claim to match it.

**Unknowns**
- A timeframe with fewer than 250 closed bars shows "warming up" instead of a bias.
- An indicator without enough history shows no value.
- Unknown data never votes and never fires a rule (Phase 1 rulings).

**Strategy blocks**
- Each indicator becomes a series block, each pivot a level block, and the bias a series from −1 to +1 with its label. A strategy can then say "15m bias turns Buy" or "MACD crosses above its signal".
- The "Technical bias" template alerts when a chosen timeframe's label changes (section 6).

**Where it runs:** Phase 3 computes the card backs for every watchlist symbol and card timeframe at each bar close. The Technicals page computes on demand.

## 4. Consensus EPS (Phase 2)

- **The client:** it lives in `ai-trading/common/`, behind the shared provider interface (02c Phase 2). Per symbol it returns:
  - EPS estimates by quarter and by fiscal year, with analyst counts;
  - reported results with their surprise;
  - the next earnings date and time;
  - as context, analyst rating counts and the low/mean/high target.
- **Eulerpool free tier:** 100,000 calls a month, non-commercial ([pricing](https://eulerpool.com/financial-data-api)). A 10-symbol pilot comes first. It confirms the fields, the fiscal-period labels, the analyst counts, and that the terms allow two family users.
- **Fallback, if the pilot fails:**
  - Finnhub free: the next quarter's estimate from the earnings calendar, within a month of the report, and four quarters of surprises;
  - Alpha Vantage free: `EARNINGS_ESTIMATES` for holdings, rotating within its 25 calls a day.

  Analyst targets are then unavailable.
- **Snapshots:** one per symbol per trading day, taken after 16:30 ET. The Desk computes the 7-, 30-, and 90-day revisions from its own snapshots, so revisions work with any source. They show "—" until that much history exists.
- **Labels:** consensus numbers are `eod`, with their source and as-of date. A missing value is `unavailable`, never a stale number shown as current.
- **Tables** (Phase 2 schema): `consensus_snapshots`, `earnings_results`, `analyst_targets`.
- **Cost:** $0. 02b's $30 data cap is unchanged.

## 5. Desk AI Daily Verdict (Phase 5; replaces the weekly `persona_review`)

- **When:** 17:05 ET each trading day, after the 16:30 bars and the consensus snapshot.
- **Which stocks:** every stock in either user's holdings or watchlists. Futures are excluded.
- **Votes**, each `{signal: buy|hold|sell, score −1…+1, reasons, evidence}`:
  - Fundamentals: SEC filings and consensus EPS trends;
  - Valuation: P/E against its own history, FCF yield, and forward EPS (prompts after ai-hedge-fund's value personas);
  - Technicals: deterministic, from the daily Desk Technical Bias;
  - News and sentiment: Finnhub headlines from the last 7 days, treated as untrusted text.
- **Verdict:** one structured call over the votes, yesterday's verdict, and the key numbers. It returns:
  - the rating;
  - the 12-month target (low, base, high);
  - confidence (0–100);
  - three reasons and up to two risks;
  - what changed since yesterday.

  Prompts adapt TradingAgents' evidence-first analyst and bull/bear debate prompts (Apache-2.0) and ai-hedge-fund's personas (MIT), with attribution (02a §11).
- **Checks in code:**
  - low ≤ base ≤ high, and all three are positive;
  - a Buy needs a base above the price, and a Sell a base below it;
  - confidence lies within 0–100.

  If a verdict fails a check or the model errors, yesterday's verdict stays on screen marked stale with its age. No alert fires, and the run summary lists the symbol as skipped.
- **Stored** per symbol and trading day (`ai_verdicts`): the verdict, the votes, the inputs with their as-of times, the model, tokens, and cost.
- **Budget:** no cap (decision 3). Spend is recorded in `llm_usage` with purpose `ai_daily` and shown on the Usage page. The chat budget (02 §6.6) is unchanged.

## 6. Alerts (Strategy-First)

Every alert still comes from a strategy version (02a).

- **"AI daily view" template (owner).** The D11 toggles are its rules:
  - the Desk AI rating changes;
  - the price crosses the AI base target, checked on closed bars during the session against the latest verdict;
  - the 30-day EPS consensus revision reaches ±N% (default 3%);
  - earnings fall within N trading days (default 3);
  - AI confidence drops below N (default 50).

  Turning a toggle on or off saves a new version.
- **"Technical bias" template (spouse).** A chosen timeframe's bias label changes, optionally combined with indicator conditions. It is checked at that timeframe's bar close.
- **New blocks:** `ai_rating`, `ai_target` (low/base/high), `ai_confidence`, `eps_revision_pct(days)`, and the section 3 series and levels. `earnings_within(days)` already exists.

## 7. Phase Changes (02c)

| Phase | Change |
|---|---|
| 1c (new) | Indicators, pivots, and the bias scorer as pure code with golden tests; the new spec blocks in the Zod contract |
| 2 | The consensus client (Eulerpool pilot, fallback) and the snapshot tables |
| 3 | Card-back computation at bar close for watchlist symbols |
| 4 | The flip cards and the Technicals page, wired to Phase 3; the long-term stock page and the AI brief built on fixtures until Phase 5 |
| 5 | The Desk AI daily verdict, the "AI daily view" template, and the brief, replacing the weekly persona review |

## 8. Testing

- **Indicators:** golden values on fixed bar fixtures, checked by hand and against a reference implementation offline; warm-up and unknown handling.
- **Bias:** each vote rule at its boundaries; the label thresholds at exactly ±0.1 and ±0.5.
- **Pivots:** each method's formula on a fixed prior period.
- **Consensus:** revisions from snapshots (gaps included), the fallback order, and the labels, all on recorded responses with no network in CI.
- **AI verdict:** PydanticAI test models for the structured output, every code check, the stale path, and the cost record; no paid calls in CI.
- **Templates:** golden tests for each "AI daily view" and "Technical bias" rule.

## 9. Not in v1

- Matching Investing.com's exact summary
- Woodie and DeMark pivots, and Highs/Lows
- User-editable indicator lengths on the card
- A per-analyst target sheet
- A push-notification permission screen

## 10. Research (local only)

The research notes and Mobbin references are in the gitignored `ai-trading/temp/`, and only on the machine that made them:
- `desk-research/technical-rating-rules.md` and `desk-research/consensus-eps-sources.md`;
- `mobbin-refs/` (findings and saved screens).

Mobbin screens are reference material and are never committed.
