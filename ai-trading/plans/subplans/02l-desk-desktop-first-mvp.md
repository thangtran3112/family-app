# 02l: Family Desk desktop-first MVP (Technical lane)

Status: owner directive, planned 2026-10-24. Desk lane only. This plan supersedes the mobile-first order of the R3 persona-split
plan (`paper-persona-split-plan.md`, local Hermes run `desk-activation-20261020`). It keeps that plan's lane taxonomy (§a), board
specs (§b2), technical-lane specs (§c1–c5), and schema outline (§e, built as [02k](02k-desk-strategy-config-contracts.md)).

## a. Goal and non-goals

**Goal.** The Desk becomes desktop-first. The first MVP is the **Technical lane at 1440 px** for the wife, who day-trades US stocks:

- filter US stocks with filter strategies (the screener);
- read full technical indicators on a TradingView-style chart;
- see a dashboard of her day: market status, her signals, her screener matches, her watchlists;
- get a per-stock technical recommendation in the investing.com "Technical summary" style, with buy/sell gauges that aggregate
  indicator votes and her strategies' votes (the mobile Technicals board 8TQ-1 shows the pattern);
- receive alerts driven by her watchlists, filter strategies, and alert strategies.

Alerts, filters, and recommendations run on **real market data**. She makes real trades in her own IBKR account from what she
sees. The Desk never places orders: it alerts, filters, and recommends, and she decides.

**Non-goals (MVP):**

- No backtesting. The backtest boards stay illustrative and labelled SIMULATED.
- No order placement of any kind, live or paper. Broker and order controls stay disabled in the product while she trades manually
  at IBKR. Paper-trading screens are out of the MVP.
- No mobile. The R3 mobile boards are kept as reference only.
- No Fundamental lane screens (later phases, §f).
- No AI setup assistant (R3 T9/T10) and no futures trading screens (sizer, position detail). ES and NQ appear only as read-only
  market context. Both are fast-follow candidates after the MVP ships.
- No custom strategy builder as a separate screen (R3 T6). With orders off, every MVP strategy is alert-only, so the alert setup
  board (D10) is the one condition builder.

## b. Desktop layout system

### b1. Frames

- **Base:** 1440 × 900 artboards. Content may grow downward (`height: fit-content`), but the shell (top bar, rails, status bar)
  must fit in 900 px so it fills one laptop screen.
- **Narrow desktop:** 1180 × 820. Adaptation rules are in §b3. Two boards get a 1180 mock (D12); the others follow the rules.
- **Tablet (iPad landscape, 1024 and 834):** later. It inherits the 1180 rules; no mocks in the MVP.
- Every Desk screen eventually needs a desktop horizontal view. Fundamental desktop views come in roadmap step 3.

### b2. The shell (TradingView-like multi-pane)

| Region | 1440 size | Content |
|---|---|---|
| Top bar | full width × 48 | "Family Desk" wordmark; lane switch `Fundamental \| Technical` (segmented, Technical active); primary nav tabs **Today · Screener · Watchlists · Alerts · Strategies**, with More and Settings under the avatar menu (this replaces the mobile `Lane tab bar · Technical`); symbol search (`⌘K`); market status pill; data freshness badge; alerts bell with unread count; avatar initial `W`. |
| Left rail | 280 wide | Tabs `Watchlists \| Filters`. Watchlists: list switcher (Day movers, Swing), dense rows (symbol, last, change %, strategy tag dot). Filters: her filter strategies with match counts. Collapsible to a 48 px icon strip. |
| Center | ~840 wide (flexible) | Symbol header (symbol, name, last, change, session, freshness); chart toolbar (36 px): timeframe switcher, chart type, `Indicators`, `+ Alert`; main chart pane with volume; indicator panes; time axis. Below it, a collapsible bottom panel (240 px) with tabs `Technicals · Signals · Levels`. |
| Right rail | 320 wide | Recommendation card (Summary gauge + one-line verdict + timeframe); "Alerts on this stock"; "Strategy matches"; key levels. |
| Status bar | full width × 24 | Quote source and state ("Quotes live · IBKR", "Delayed 15 min"), last update time in ET, alert delivery state. |

Hairlines (`--color-hairline`, 1 px) separate the regions. The center region is always the widest. Screens without a chart
(Screener, Alerts, Settings) keep the top bar and status bar and use the center plus one rail as a list/detail split.

### b3. 1180 adaptation rules

1. The left rail narrows to 240: the row drops the name and keeps symbol, last, and change %.
2. The right rail collapses to a 40 px tab strip (`Summary · Alerts · Levels`). A tab opens a 320 px overlay drawer over the chart;
   `Esc` or a second click closes it.
3. The chart gets the freed width. Indicator panes keep their heights.
4. Tables drop columns from a declared priority order (lowest first; each board lists its order). The screener table may scroll
   horizontally with a sticky symbol column; no other table scrolls horizontally.
5. The top bar keeps every control; the nav tabs shrink to their labels with 12 px gaps, and search collapses to an icon.

### b4. Dense data tables

- Row height 28 px default; 24 px minimum for compact rails. Header row 28 px, `--color-muted` 11 px caps.
- Numbers right-aligned with tabular figures (`font-variant-numeric: tabular-nums`). Change values use `--color-up` / `--color-down`
  and always carry a sign (`+2.14%`, `−0.87%`), so colour is never the only cue.
- Hover row: `--color-raised` background. Selected row: 2 px amber left edge. Sortable headers show a caret.
- Row click loads the symbol into the chart (or the preview pane); row actions (`+ Watchlist`, `+ Alert`) appear on hover and are
  always reachable by keyboard.

### b5. Chart conventions

The chart is built on the installed `lightweight-charts` 5.2.0 (`components/charts/MarketChart.tsx` already supports panes).
Mock only what that library can render.

- **Candles:** filled, `--color-up` / `--color-down`. Volume histogram in the bottom 20% of the main pane at 40% opacity.
- **Overlays (no new colours):** default three, told apart by colour and line style: VWAP amber solid, EMA 9 `--color-text` solid,
  EMA 21 `--color-muted` dashed. SMA 50/200 are off by default (toggle in `Indicators`). A top-left legend names every series and
  shows its value at the crosshair: `NVDA · 15m · O … H … L … C …`, then one line per overlay.
- **Indicator panes:** RSI(14) at 120 px with 30/70 hairline bands; MACD(12,26,9) at 120 px (histogram in up/down colours, MACD
  line in text, signal in muted). Each pane has its own legend and a close `×`.
- **Crosshair:** dashed hairline in both axes; axis labels in an amber pill with `--color-on-pill` text.
- **Axes:** price on the right with a last-price pill in the up/down colour; time on the bottom in ET.
- **Timeframe switcher:** `1m 5m 15m 1h 4h 1D 1W`, active item underlined in amber; session toggle `Regular | Extended`;
  extended hours shaded with `--color-panel`.
- **Levels:** classic pivots (P, S1–S3, R1–R3), prior close, session high/low as dotted muted lines with right-edge labels.
  Alert levels are amber dashed lines with a bell glyph.
- **Markers:** pattern markers as a short text label below the bar ("Hammer"); fired-alert markers as an amber bell above the bar.

### b6. Tokens and type at desktop density

- Same R2+ tokens: `--color-ground`, `--color-panel`, `--color-raised`, `--color-hairline`, `--color-text`, `--color-muted`,
  `--color-amber`, `--color-up`, `--color-down`, `--color-ai`, `--color-on-pill`. Amber stays the single accent; violet
  (`--color-ai`) is for AI content only, so the MVP barely uses it. No new colours.
- Inter. Desktop scale: 11 px caps labels, 12 px secondary, 13 px table and body, 15 px panel titles, 20 px symbol price in the
  header, 28 px gauge verdict.
- **Pointer targets:** the 44 px touch rule was mobile-only. Desktop controls are at least 24 × 24 px (WCAG 2.2 target size), rows
  at least 24 px, form controls 32 px. Every control has a hover state and a 2 px amber focus ring; keyboard shortcuts are shown in
  tooltips (`⌘K` search, `Alt+A` new alert).

## c. Real-data presentation rules

### c1. Real values, truthfully dated

- Technical mocks use **real US symbols with real last-known values**. Executors never type a price, indicator value, or match
  from memory. Every number comes from the snapshot file below.
- **Snapshot (Run 0, before any board):** a throwaway script under `ai-trading/temp/desk-desktop-mvp/` (gitignored) loads keys
  through `common/config/family_config.py` (never by shell-sourcing an `.env`) and reads bars through `ai_trading_common`
  `DataSources` (Alpaca Basic). It writes `snapshot-2026-10-23.json` with:
  - daily bars (300 sessions) and 5m/15m/1h bars for the sessions up to Fri 2026-10-23, for the market strip (SPY, QQQ, IWM)
    and the seed lists: **Day movers** NVDA, AMD, TSLA, PLTR, META, AAPL, AVGO, COIN; **Swing** MSFT, AMZN, GOOGL, CRWD, SHOP, UBER;
  - indicators from `core/indicators.py`, the Desk Technical Bias votes and gauges from `core/bias.py`, and pivots from
    `core/pivots.py`, per timeframe 5m, 15m, 30m, 1h, 4h, 1D, 1W;
  - the ten screener defaults (02k §4) evaluated over all active US equities that pass the shared liquidity floor, with the
    scanned count and each match's metric values;
  - a replay of 2026-10-23 bars through the seed alert strategies (§e3), giving the times at which each would have fired.
- Every technical board carries a truthful as-of line: **"As of last close · Fri 2026-10-23 · 4:00 PM ET"**, plus the source
  ("Alpaca"). The top bar shows "Market closed · opens Mon 9:30 AM ET".
- Signals derived from the replay carry the caption **"Replay of Fri 2026-10-23 · alerts not live yet"**.
- **ES and NQ:** Alpaca has no futures. Until the IBKR Gateway probe (Mon 2026-10-26 09:30 ET) returns real values, ES/NQ tiles
  carry the SIMULATED label. Re-stamp them with real values after the probe.
- **Patterns:** `core/patterns.py` does not exist yet. The snapshot script may check the R3 §c2 textbook geometry on the real bars.
  A real occurrence is shown with its real bar time; if none is found, the example is drawn and labelled SIMULATED.

### c2. Where SIMULATED stays

The `SIMULATED DESIGN CONTENT` label appears only on content that is genuinely fabricated: ES/NQ before the probe, pattern examples
with no real occurrence, the states gallery's example numbers, and any backtest board (which stays illustrative). A board built
only from the snapshot carries no SIMULATED label.

### c3. Freshness badges and states (user-friendly wording)

One vocabulary for every board. Badges sit in the top bar, the symbol header, and the status bar.

| State | Badge or message | When |
|---|---|---|
| Live | "Live" with an up-colour dot · status bar "Quotes live · IBKR" | streaming quotes within 5 s |
| Delayed | "Delayed 15 min" | the source is delayed by contract (for example a 15-minute-delayed scan) |
| Updating | "Updating quotes…" | refresh in flight; the old values stay visible |
| Reconnecting | "Reconnecting… · last update 10:41:12 AM ET" | the quote connection dropped; values stay visible but dimmed |
| Paused | "Quotes paused · last update 2 min ago" | no update past the limit for the timeframe |
| Backup source | "Using backup quotes · may differ slightly from IBKR" | a fallback provider answered (`quality="fallback"` in 02j) |
| Market closed | "Market closed · showing last close" | outside sessions |
| Pre-market / after hours | "Pre-market · 8:12 AM ET" / "After hours" | extended session |
| Unavailable | "Quotes unavailable right now · trying again" | every provider failed |
| Alerts paused | "Alerts paused until quotes return" | evaluation stopped because data stopped |
| Empty | "No matches right now · next scan 10:15 AM" | a scan returned nothing |
| Load error | "Couldn't load this chart · Try again" | a request failed |
| Orders off | "Trading is off in the Desk · place orders in IBKR" | any place an order control would be |

**Banned in user-facing text:** "async", "Core async update", "fetch", "stream", "socket", "poll", "timeout", HTTP codes, "null",
"NaN", "stale cache", "hydrate", stack traces, provider error names. Engineering detail goes in a `Details` disclosure at most.

### c4. Recommendation wording

Gauges use the TradingView/investing.com labels **Strong sell · Sell · Neutral · Buy · Strong buy** with vote counts. Every
recommendation surface carries the footnote **"Signals, not advice · you place every trade yourself in IBKR"**. Never "Buy now",
never a position size, never an order button.

## d. Board-by-board desktop MVP list

Paper file TobyTest, new page **"R3 · Desktop · Technical MVP"** (the mobile page stays untouched). Board name format:
`R3 · Tech · <Screen> · desktop`. Sources are the R3 mobile boards to borrow content from; layout is new.

### d1. Boards

**D1 · `R3 · Tech · Shell & states · desktop`** — no route (component board). Sonnet, Run 1.
- Panes: the full §b2 shell with empty regions, then a states gallery strip.
- Content: top bar (lane switch, nav tabs, search open with results, market status pill in its four states, freshness badge in
  every §c3 state); left rail collapsed and expanded; right rail; status bar variants; wrong-lane interstitial ("This screen
  belongs to the Fundamental view · Switch view"); orders-off notice. Name reusable groups (`Desktop top bar`, `Left rail`,
  `Right rail`, `Status bar`, `Freshness badge`) so every later board duplicates them.
- States: all of §c3. Example numbers here are SIMULATED.

**D2 · `R3 · Tech · Dashboard · desktop`** — `/today`. Sonnet, Run 1. Source: T1.
- Panes: top bar; left rail (Day movers); center grid; right rail (alerts feed).
- Content: market strip (SPY, QQQ, IWM real; ES, NQ per §c1); "Today's signals" from the replay (ORB, VWAP reclaim, pattern, RVOL)
  with time and symbol; "Screener matches" cards per active filter with counts and top three symbols; watchlist heat table (symbol,
  last, change, RVOL, distance to VWAP, bias label); upcoming events for her symbols (earnings dates only, no fundamentals).
- States: market closed (as built), pre-market, live, reconnecting, empty day ("No signals yet today · your strategies are
  watching").
- 1180 column drop order: distance to VWAP, RVOL.

**D3 · `R3 · Tech · Chart workspace · desktop`** — `/technicals?symbol=NVDA#chart`. Sonnet, Run 2. Source: 8TQ-1 chart parts.
- Panes: full §b2 shell; center chart at 15m with VWAP/EMA 9/EMA 21, volume, RSI and MACD panes, crosshair shown mid-chart with
  the legend filled; pivot and alert lines; replay markers. Bottom panel on `Signals`. Right rail: Summary gauge, "Alerts on this
  stock" (2 rows), "Strategy matches", key levels.
- States: loading chart ("Loading chart…" skeleton), load error, reconnecting (dimmed last price), extended-hours shading.

**D4 · `R3 · Tech · Technical summary · desktop`** — `/technicals?symbol=NVDA#summary`. Sonnet, Run 2. Source: 8TQ-1.
- Panes: shell; center replaced by the summary page; right rail keeps the mini chart.
- Content: timeframe tabs `5m 15m 30m 1h 4h 1D 1W`; four gauges (half-dial odometers): **Summary**, **Oscillators**, **Moving
  averages** (all from `core/bias.py`), and **Her strategies** (§e4); counts under each ("Buy 9 · Neutral 3 · Sell 2").
  Oscillators table (Name · Value · Action) and moving-averages table (EMA/SMA 5–200, Value · Action), pivots table (Classic,
  Fibonacci, Camarilla; S3–R3). A "What changed" line ("Moved from Neutral to Buy at 1:45 PM"). Footnote per §c4.
- States: not enough history ("Not enough history for 1W yet"), updating, market closed.

**D5 · `R3 · Tech · Screener · desktop`** — `/screener`. Sonnet, Run 3. Source: T2.
- Panes: shell; left rail on `Filters` (defaults read-only with a lock glyph, then "My filters", each with match count); center
  results table; right pane = chart preview of the selected row (from D3's chart group, no indicator panes).
- Content: header with filter name, plain-English rule summary (from the frontend spec describer, `frontend/lib/spec/describe.ts`), `Regular | Extended`, `Edit`,
  `Save as my filter`, `Alert on this filter`. Table: symbol, last, change %, volume, RVOL, ATR %, gap %, RSI 14, vs VWAP,
  matched since; columns follow the filter's `when` operands and `rank.by`. Universe line: "Scanned <count> US stocks and ETFs ·
  as of last close Fri 2026-10-23" (real count from the snapshot).
- States: scanning ("Scanning US stocks…"), 0 matches (§c3 empty), delayed ("Scan delayed 15 min" if §e1 decision 1 says so).
- 1180 column drop order: matched since, ATR %, volume.

**D6 · `R3 · Tech · Filter editor · desktop`** — `/screener/filters?id=…`. Haiku, Run 4. Source: T3.
- Panes: shell; center form; right pane "Live matches" (count plus top five) and a collapsible `View JSON` panel
  (`FilterStrategySpecV1`).
- Content: the 02k §4 fields exactly: universe, asset types, liquidity, session and `runOn`, conditions (metric · operator ·
  value rows, ALL/ANY), rank by, max results. A seeded default opens read-only with `Copy to edit`. `Save draft`, `Reset to default`.
- States: read-only default, validation error (plain message plus the field path in small muted text), unsaved-changes bar.

**D7 · `R3 · Tech · Watchlists · desktop`** — `/watchlists`. Haiku, Run 4. Source: T4.
- Panes: shell; left rail list switcher; center dense table; right rail "Strategies on Day movers".
- Content: rows with symbol, last, change, RVOL, bias label, strategy tag line ("Hammer 15m · 10:15 AM", "ORB armed"); right rail
  lists attached presets and alert strategies with `Add preset` (opens D8). Manage mode (rename, reorder, add, remove).
- States: empty list ("Add symbols to start watching"), updating, reconnecting.
- 1180 column drop order: RVOL, bias label.

**D8 · `R3 · Tech · Strategy library · desktop`** — `/strategies/library`. Haiku, Run 5. Source: T5.
- Panes: shell; left category list (Candlesticks · Breakouts · Trend · Volume · Futures); center preset list; right preview.
- Content: entries straight from `contracts/catalog.json` (`PresetCatalogV1` label, summary, bias, category). Preview: plain
  English, the WHEN block, defaults, a real example from the snapshot if one exists. `Attach to Day movers · alert only`. Footnote
  "Pattern rules are fixed in v1".
- States: loading, empty search, catalog unavailable ("Strategy library unavailable · Try again").

**D9 · `R3 · Tech · Alerts · desktop`** — `/alerts`. Haiku, Run 5. Source: T7.
- Panes: shell; center table with tabs `List · Log`; right detail pane for the selected alert strategy.
- Content: filters (Active/Paused/Expired; Pattern/Indicator/Level/Screener; symbol), sort, rows (name, source, trigger summary
  from the spec describer, frequency, channels, status, last fired). Log: delivered, held for quiet hours, no channel. Right pane:
  the alert's JSON, recent fires with chart thumbnails, `Pause`.
- States: empty ("No alert strategies yet · New alert strategy"), alerts paused (§c3), replay caption on fired times.

**D10 · `R3 · Tech · Alert setup · desktop`** — `/alerts/new`. Sonnet, Run 3. Source: T8.
- Panes: shell; center four-step form (Source, Condition, Trigger, Deliver) as one scrolling column; right pane live summary in
  plain English, a mini chart showing the condition's level or pattern, and `View JSON` (`AlertStrategySpecV1`).
- Content: source (symbol, watchlist, screener filter); condition with the TradingView operator set mapped to the contract plus
  "pattern detected"; timeframe; trigger frequency (once, once per bar close, every time), cooldown, expiration; delivery Inbox
  (always first, locked) plus Telegram/Slack, severity, message with `{symbol} {close} {time}`. `Save draft`.
- States: validation problem banner ("1 problem to fix"), no channel connected, saved. Before the runtime ships, `Turn on` is
  disabled with "Alerts start when live quotes are connected".

**D11 · `R3 · Tech · Settings & More · desktop`** — `/settings`, `/more`. Haiku, Run 6. Source: S1, settings boards.
- Content: default view (Technical), lane switch, alert channels (Telegram/Slack connected or not), quiet hours, "Pause all
  strategies", market data status in plain words ("Quotes: IBKR · Live", "Scans: Alpaca · Delayed 15 min"), broker rows disabled
  with the orders-off reason.
- States: channel not connected, saving, saved.

**D12 · `R3 · Tech · Chart workspace · desktop 1180`** and **`R3 · Tech · Dashboard · desktop 1180`**. Haiku, Run 6.
- Duplicates of D3 and D2 at 1180 × 820 applying §b3: collapsed right rail with one drawer open on D3, dropped columns on D2.

**Count: 13 boards** (D1–D11 plus the two 1180 boards): **6 Sonnet** (D1, D2, D3, D4, D5, D10), **7 Haiku** (D6, D7, D8, D9,
D11, and the two D12 boards).

### d2. Runs

| Run | Model | Boards | Depends on |
|---|---|---|---|
| 0 | Sonnet (no Paper) | real-data snapshot (§c1) | Alpaca keys in family-config |
| 1 | Sonnet | D1 Shell & states, D2 Dashboard | Run 0 |
| 2 | Sonnet | D3 Chart workspace, D4 Technical summary | Run 1 |
| 3 | Sonnet | D5 Screener, D10 Alert setup | Run 2 (chart group) |
| 4 | Haiku | D6 Filter editor, D7 Watchlists | Run 1 |
| 5 | Haiku | D8 Strategy library, D9 Alerts | Run 1 |
| 6 | Haiku | D11 Settings & More, D12 × 2 (duplicates) | Runs 2, 1 |

- One Paper writer at a time: runs are sequential, never parallel, because they write to the same file.
- **Owner gate after Run 2:** the shell and chart are the template for everything else. Continue only after the owner (and the
  wife) approve D1–D4. Opus reviews only on request.
- Per run: load the Paper guide once, call `get_font_family_info` for Inter once, duplicate the named shell groups from D1, take one
  screenshot per board at the end, call `finish_working_on_nodes`. No Mobbin calls: the TradingView conventions are already in R3
  §c5 and §b5 here. Every number is copied from the snapshot file.

## e. Implementation phases after the mocks

The end state: she practises on the Paper boards (walking her real morning routine through them with the 2026-10-23 snapshot),
then the same screens ship with live data. Broker and order flags stay off throughout.

### e1. Real-data plumbing (02j registry + IBKR Gateway)

- **IBKR Gateway probe, Mon 2026-10-26 09:30 ET**, with the data user (02e). It decides 02c Phase 2b: `providers/ibkr.py` through
  `ib_async`, live 1-minute bars, and streaming quotes behind the 02j registry, so no caller changes when IBKR joins the chain.
- **Who serves what:**
  - IBKR streams quotes and live bars for symbols she is looking at: her watchlists and open charts, allocated by the existing
    streaming slot manager (02c Phase 2a) within the account's market-data line limit.
  - Alpaca Basic serves backfill and the universe scan.
  - The `quality` label from a fallback chain becomes the "Using backup quotes" badge.
- **Freshness in the API:** every quote and scan result carries `as_of`, `source`, and a `freshness` value
  (`live | delayed | closed | paused | unavailable`) that maps one-to-one onto §c3. The UI never computes freshness itself.
- **Owner decisions to record before building:**
  1. Scan feed. Alpaca Basic's real-time feed is IEX only (a small share of volume), which distorts RVOL and volume filters, and its
     full-market (SIP) bars are 15 minutes delayed. Recommendation: the MVP scans on SIP bars labelled "Scan delayed 15 min", and
     symbols on her watchlists alert in real time from IBKR. Upgrade path: a paid real-time SIP plan, or IBKR scanners.
  2. Market-data line budget between her lists, open charts, and Toby's lists (slot priorities).
  3. ES/NQ: whether to add the CME non-professional subscription at IBKR, after the probe shows what the data user can see.

### e2. Engine work (the 02k follow-ups)

From 02k §10, in MVP order:
1. `filter_strategies` and `filter_strategy_versions` tables; `strategies.lane` and `strategies.origin`.
2. A screener runner: evaluates each `FilterStrategySpecV1` on its `runOn` schedule over its universe and stores matches.
3. `filter` universe resolution, so an alert strategy can watch a screener's matches.
4. `core/patterns.py` and the pattern evaluator (fixed geometry, R3 §c2 defaults), with golden tests on recorded bars.
5. `session_high` and `session_low` levels.
6. Alert `frequency`, `expiresOn`, and `message` behaviour.
7. Strategy votes for D4 (§e4).

The `draft_filter` tool waits with the AI setup assistant (fast follow).

### e3. Alert delivery runtime

02c Phase 3 is the vehicle: live evaluation at each bar close, idempotent catch-up-safe scheduler jobs, and `ai_trading.notify`
(inbox, Telegram, Slack, retries, fingerprint dedupe, quiet hours, redaction). MVP deltas:

- Evaluate `AlertStrategySpecV1` specs whose source is a symbol, a watchlist, or a filter's matches.
- Honour `frequency`, cooldown, and `expiresOn`.
- Inbox first, always (02k §7).
- Log every delivered, held, and no-channel event for D9.
- When data stops, stop evaluating and show "Alerts paused until quotes return". Never alert on stale data.
- **Seed alert strategies** (used by the replay in §c1 and shipped as her starting set, all alert-only on Day movers): ORB 15m,
  VWAP reclaim, Hammer 15m near S1, Abnormal volume, High-of-day break.

### e4. How the merged contracts drive the UI

| Contract | Drives |
|---|---|
| `FilterStrategySpecV1` + `templates/filters/*.json` | D5 left rail (defaults read-only, then hers); D6 form fields one-to-one; D5 table columns from `when` operands and `rank.by` |
| Pattern presets (`templates/patterns/`) and setups (`templates/setups/`) | D8 entries; chart markers in D3; watchlist tag lines in D7 |
| `PresetCatalogV1` (`catalog.json`) | D8 categories, labels, summaries; each preset's `bias` gives its vote direction |
| `AlertStrategySpecV1` | D10 form and JSON; D9 rows (the trigger summary comes from the frontend spec describer) |
| `StrategySpecV1` (alert-only) | "Attach to list" in D8 writes one with `watch.universe = { watchlist }` |
| `StrategyDraft` | not in the MVP (AI setup) |

**Strategy votes gauge (D4, "Her strategies"):** for the symbol and timeframe, each of her attached strategies whose condition is
true on the last closed bar votes its catalog `bias` (bullish = buy, bearish = sell, neutral = neutral). The score and label reuse
`core/bias.py`'s label thresholds, so all four gauges read the same way. Strategies with no current signal are listed as "Watching".

### e5. Frontend build

- Desktop shell first (top bar, rails, status bar) as layout components in `packages/family-desk/frontend`, at 1440 and 1180,
  reusing `MarketChart` panes and `lib/stream.ts`.
- Static export: design routes with `:id` become query parameters (`/technicals?symbol=NVDA`), as in the existing routes.
- New routes: `/screener`, `/screener/filters`, `/alerts`, `/alerts/new`, `/strategies/library`. Existing routes get desktop
  layouts. The 15 accepted production routes keep working; broker and orders stay off.
- Acceptance before she trades from it: on five symbols at a live session, last price, VWAP, RSI(14), and the summary gauge match
  IBKR TWS within a stated tolerance; one alert per seed strategy reaches her Telegram; a forced disconnect shows "Reconnecting…"
  and no alert fires on stale data.

## f. Roadmap order

1. **Desktop Technical MVP mocks** (this plan, §d): Runs 0–6.
2. **Real-data implementation** (§e): IBKR probe outcome, engine follow-ups, alert runtime, desktop frontend; she practises on
   the Paper boards meanwhile, then the screens ship live.
3. **Desktop Fundamental views** for Toby at 1440: the R3 F-set re-laid as desktop boards (F11 timeline was already 1440).
4. **Mobile Fundamental** views (R3 F1–F12).
5. **Deferred:** the B8 re-chrome of the mobile baseline, backtesting, and automated order support (each needs its own approval).

The R3 mobile work (77 artboards in TobyTest) is retained as reference. **The B8 gate is on hold.** Fast follows that may slot in
after step 2, by owner call: the AI setup assistant (R3 T9/T10, `draft_filter`), futures reading for ES/NQ, and the iPad breakpoint.

## g. Conventions sync

- **Lane taxonomy:** unchanged from R3 §a. Technical shows no P/E, FCF, covered calls, or Desk AI ratings; the lane chip and the
  wrong-lane interstitial carry over; `intraday` and `swing` watchlists belong to Technical.
- **Contract panels:** the same collapsible `View JSON` panels as R3, showing exactly the merged 02k contracts. No "proposed
  contract" labels in the Technical lane, because every contract it shows is merged.
- **Tokens:** the same R2+ black/amber token set and Inter as R3; no new colours; violet only for AI.
- **Async wording:** every loading, refreshing, reconnecting, delayed, or error state uses the §c3 vocabulary. Never engineering
  terms such as "Core async update".
