// Illustrative swing-practice payloads in the shapes of the generated contract (`lib/api/openapi.d.ts`). The numbers are
// made up (SIMULATED, not market data); the node tests parse them with the real schemas and the screens can be
// developed against them. One thread: Swing, 50 names, Day 7 of 20 (Week 2, a Tuesday), two holds open (NVDA long,
// AMD short), Week 1 reviewed. Balance $51,240, equity $52,010 (the balance plus the two holds' unrealized P/L at the
// prior close). Swing-only keys that have no value are left out, as the API does.
import { delta, feed, openTrade, session, stamp } from "./fixtures.ts";
import { ReplayDeltaSchema, ReplayFeedSchema, type DailyBlock, type Hold, type OpenTrade, type Paused, type ReplayDelta, type ReplayFeed, type ReplayStamp, type StripRow } from "./schemas.ts";
import type {
  BoardRow,
  HoldsOut,
  SwingDayList,
  SwingDaySummary,
  SwingOpenNext,
  SwingPlan,
  UniversePreview,
  WeekOut,
  WeekRow,
} from "./swingApi.ts";
import type { SwingState, Thread, ThreadBrief, ThreadSummary } from "./threads.ts";
import { activeThread, threadBrief } from "./threadFixtures.ts";

export const SIMULATED = "Simulated money · practice only, never a real account";
export const SURVIVORSHIP =
  "Fixed universe · 50 symbols chosen today from the symbols the Desk tracks now. Stocks that were delisted or renamed since Day 1 cannot appear, so the list leans toward survivors. Your watchlists are today's lists: a name may be on them because of moves you already know about.";

// -- the setup the thread was created with ---------------------------------------------------------------------

const watchlist = ["NVDA", "AMD", "AAPL", "MSFT", "TSLA", "META", "AMZN", "GOOGL", "AVGO"];
const manual = ["SMCI", "PLTR"];
const filtered = ["COIN", "UBER", "SHOP", "CRWD", "PANW", "NOW"];
const liquidity = Array.from({ length: 33 }, (_, index) => `LQ${String(index + 1).padStart(2, "0")}`);

export const universe = [
  ...watchlist.map((symbol) => ({ symbol, source: "watchlist" as const })),
  ...manual.map((symbol) => ({ symbol, source: "manual" as const })),
  ...filtered.map((symbol) => ({ symbol, source: "filter" as const })),
  ...liquidity.map((symbol) => ({ symbol, source: "liquidity" as const })),
];

export const swingSetup = {
  firstDay: "2026-07-06",
  sessions: 20,
  hideDates: "yes",
  universe,
  interval: "15m",
  tape: "off",
  armed: [{ source: "filter", id: 4 }],
  riskPerHoldUsd: 100,
} as const;

// -- the thread: hub card and journal ---------------------------------------------------------------------------

export const swingState: SwingState = {
  day_no: 7,
  days: 20,
  days_ended: 6,
  week_no: 2,
  weeks: 4,
  holds_open: 2,
  free_cash_usd: 24720,
  equity_usd: 52010,
  equity_series: [
    { day_no: 1, weekday: "Mon", balance_usd: 50000, equity_usd: 50085 },
    { day_no: 2, weekday: "Tue", balance_usd: 50000, equity_usd: 50275 },
    { day_no: 3, weekday: "Wed", balance_usd: 50000, equity_usd: 50210 },
    { day_no: 4, weekday: "Thu", balance_usd: 50412, equity_usd: 50620 },
    { day_no: 5, weekday: "Fri", balance_usd: 50412, equity_usd: 50670 },
    { day_no: 6, weekday: "Mon", balance_usd: 51240, equity_usd: 51895 },
  ],
  next: "day",
};

export const swingThreadSummary: ThreadSummary = {
  thread: {
    ...activeThread.thread,
    id: 7,
    mode: "swing",
    plan: { stopNoteOnEntry: "yes", tradeOnlyOnSignal: "no", maxLossUsd: 600, maxTrades: 6, planNote: "Hold winners, cut at the stop." },
    swing: swingSetup as unknown as NonNullable<ThreadSummary["thread"]["swing"]>,
    stats: { balance: 51240, daysPracticed: 5, daysSkipped: 1, wins: 2, losses: 1, winRate: 0.67, avgWinUsd: 620, avgLossUsd: -160 },
  },
  today: { day_list_id: 71, day: "2026-07-14", weekday: "Tue", day_no: 7, status: "listed", trades: 0, pnl_usd: 0 },
  last_day: null,
  last_activity_at: null,
  label: SIMULATED,
  swing: swingState,
};

/** Week 1 just ended: the review is ready and the next day has not opened. */
export const swingThreadReviewReady: ThreadSummary = {
  ...swingThreadSummary,
  today: null,
  last_day: null,
  swing: { ...swingState, day_no: 6, days_ended: 5, week_no: 2, holds_open: 1, next: "week_review", equity_series: swingState.equity_series.slice(0, 5) },
};

export const swingThreadFinished: ThreadSummary = {
  ...swingThreadSummary,
  today: null,
  last_day: null,
  swing: { ...swingState, day_no: 20, days_ended: 20, week_no: 4, holds_open: 0, next: "finished" },
};

export const swingThread: Thread = {
  ...swingThreadSummary,
  daily: [],
  curve: [
    { n: 0, day: null, balance: 50000 },
    { n: 4, day: "2026-07-09", balance: 50412 },
    { n: 6, day: "2026-07-13", balance: 51240 },
  ],
};

export const swingBrief: ThreadBrief = {
  ...threadBrief,
  id: 7,
  mode: "swing",
  balance: 51240,
  today_pnl_usd: 0,
  label: SIMULATED,
  equity_usd: 52010,
  free_cash_usd: 24720,
  day_no: 7,
  days: 20,
  week_no: 2,
};

// -- holds -------------------------------------------------------------------------------------------------------

/** A long carried since Day 5, valued at the prior close. */
export const nvdaHold: Hold = {
  id: 11,
  symbol: "NVDA",
  side: "long",
  shares: 100,
  entry_day_no: 5,
  entry_weekday: "Fri",
  entry_price: 184.2,
  days_held: 2,
  stop_at_entry: 178.5,
  stop_price: 178.5,
  stop_hit: "no",
  status: "open",
  exit_day_no: null,
  exit_price: null,
  exit_source: null,
  last_close: 190.1,
  price_basis: "prior_close",
  unrealized_usd: 590,
  pnl_usd: null,
  r: 1.04,
  gap_usd: null,
  earnings: { in_sessions: 3, timing: "after close" },
  split_note: null,
};

/** A short entered on Day 6 without a split or a chip. */
export const amdHold: Hold = {
  id: 12,
  symbol: "AMD",
  side: "short",
  shares: 50,
  entry_day_no: 6,
  entry_weekday: "Mon",
  entry_price: 162,
  days_held: 1,
  stop_at_entry: 168,
  stop_price: 168,
  stop_hit: "no",
  status: "open",
  exit_day_no: null,
  exit_price: null,
  exit_source: null,
  last_close: 158.4,
  price_basis: "prior_close",
  unrealized_usd: 180,
  pnl_usd: null,
  r: 0.6,
  gap_usd: null,
  earnings: null,
  split_note: null,
};

/** A hold that crossed a 10-for-1 split before today's open. */
export const splitHold: Hold = {
  ...nvdaHold,
  id: 13,
  entry_price: 120.38,
  stop_at_entry: 115,
  stop_price: 115,
  last_close: 121.2,
  unrealized_usd: 820,
  shares: 1000,
  earnings: null,
  split_note: "Split 10-for-1 before today's open · 100 shares are now 1,000 at 121.20",
};

/** A hold she closed herself on Day 5 with a win, and one the thread closed at the last close. */
export const closedHold: Hold = {
  id: 9,
  symbol: "TSLA",
  side: "long",
  shares: 40,
  entry_day_no: 2,
  entry_weekday: "Tue",
  entry_price: 240.5,
  days_held: 3,
  stop_at_entry: 232,
  stop_price: 236,
  stop_hit: "no",
  status: "closed",
  exit_day_no: 4,
  exit_price: 255.8,
  exit_source: "her",
  last_close: null,
  price_basis: null,
  unrealized_usd: null,
  pnl_usd: 612,
  r: 1.8,
  gap_usd: 230,
  earnings: null,
  split_note: null,
};

export const autoClosedHold: Hold = { ...closedHold, id: 10, symbol: "META", exit_day_no: 20, exit_source: "auto", pnl_usd: -85, r: -0.4, gap_usd: null };

/** The open hold she is looking at in the workspace, after the open: a gap and a stop that was crossed. */
export const gappedHold: Hold = {
  ...nvdaHold,
  stop_hit: "yes",
  price_basis: "last",
  last_close: 177.4,
  unrealized_usd: -680,
  r: -1.19,
  gap_usd: -1270,
};

export const holdsOut: HoldsOut = { thread_id: 7, as_of_day_no: 6, holds: [nvdaHold, amdHold, closedHold], label: SIMULATED };

// -- the universe preview ---------------------------------------------------------------------------------------

const previewRow = (symbol: string, source: "watchlist" | "manual" | "filter" | "liquidity", index: number) => ({
  symbol,
  source,
  prior_close: 100 + index * 3.25,
  chg_20d_pct: index % 5 === 0 ? null : Number((((index * 7) % 23) - 8).toFixed(2)),
  avg_dollar_volume_20d: 900_000_000 - index * 12_000_000,
  atr_pct_14: Number((1.5 + (index % 7) * 0.4).toFixed(2)),
  matched: source === "filter" ? ["New 20-day high"] : [],
  warnings: source === "manual" && symbol === "SMCI" ? ["below floor"] : [],
});

export const universePreview: UniversePreview = {
  basis_day: "2026-07-03",
  state: "ready",
  prep: { done: 133, total: 133 },
  rows: universe.map((entry, index) => previewRow(entry.symbol, entry.source, index)),
  excluded: [
    { symbol: "NEWCO", reason: "Not enough price history for this whole range" },
    { symbol: "FRSH", reason: "Not enough price history for this whole range" },
  ],
  counts: { watchlist: 9, manual: 2, filter: 6, liquidity: 33, total: 50 },
  survivorship: SURVIVORSHIP,
  label: SURVIVORSHIP,
  pending_symbols: 0,
};

/** The first call: her own picks are in, the pool is still being fetched. */
export const universePreviewPreparing: UniversePreview = {
  ...universePreview,
  state: "preparing",
  prep: { done: 96, total: 133 },
  rows: universePreview.rows.slice(0, 17),
  counts: { watchlist: 9, manual: 2, filter: 6, liquidity: 0, total: 17 },
  pending_symbols: 37,
};

// -- the plan, the board and a day ---------------------------------------------------------------------------------

export const swingPlan: SwingPlan = {
  id: 5,
  thread_id: 7,
  mode: "swing",
  sessions: 20,
  days_opened: 7,
  current: { id: 71, day_no: 7, status: "listed" },
  next_day_no: 7,
  next_weekday: "Tue",
  finished: false,
  prep: { state: "done", done: 51, total: 51, failed: 0 },
};

export const swingOpenNext: SwingOpenNext = { day_list_id: 71, kind: "swing", plan: swingPlan };
/** The prep is still running: no day yet. */
export const swingOpenNextWaiting: SwingOpenNext = {
  day_list_id: null,
  kind: "swing",
  plan: { ...swingPlan, days_opened: 0, current: null, next_day_no: 1, next_weekday: "Mon", prep: { state: "running", done: 12, total: 51, failed: 0 } },
};

export const boardColumns = [
  { key: "source", label: "Source", format: "text" },
  { key: "prior_close", label: "Prior close", format: "price" },
  { key: "chg_1d_pct", label: "1d %", format: "pct_signed" },
  { key: "chg_5d_pct", label: "5d %", format: "pct_signed" },
  { key: "chg_20d_pct", label: "20d %", format: "pct_signed" },
  { key: "atr_pct_14", label: "ATR %", format: "pct" },
  { key: "rsi_14", label: "RSI", format: "number" },
  { key: "rvol_10d", label: "RVOL", format: "ratio" },
  { key: "pct_from_20d_high", label: "vs 20d high %", format: "pct_signed" },
  { key: "vs_50d_avg_pct", label: "vs 50d avg %", format: "pct_signed" },
  { key: "avg_dollar_volume_20d", label: "$ volume 20d", format: "compact" },
  { key: "matches", label: "Matches", format: "text" },
];

export const boardRows: BoardRow[] = [
  {
    symbol: "NVDA", source: "watchlist", prior_close: 190.1, chg_1d_pct: 1.2, chg_5d_pct: 3.4, chg_20d_pct: 9.8, atr_pct_14: 2.9, rsi_14: 63.2, rvol_10d: 1.35,
    pct_from_20d_high: -0.4, vs_50d_avg_pct: 8.1, avg_dollar_volume_20d: 21_400_000_000, matches: ["New 20-day high"], earnings: { in_sessions: 3, timing: "after close" },
  },
  {
    symbol: "AMD", source: "watchlist", prior_close: 158.4, chg_1d_pct: -2.2, chg_5d_pct: -3.9, chg_20d_pct: 1.1, atr_pct_14: 3.1, rsi_14: 41.7, rvol_10d: 0.92,
    pct_from_20d_high: -7.6, vs_50d_avg_pct: -2.3, avg_dollar_volume_20d: 6_800_000_000, matches: [], earnings: null,
  },
  {
    symbol: "COIN", source: "filter", prior_close: 301.55, chg_1d_pct: 4.8, chg_5d_pct: 9.1, chg_20d_pct: 22.4, atr_pct_14: 4.6, rsi_14: 71.9, rvol_10d: 1.8,
    pct_from_20d_high: 0, vs_50d_avg_pct: 19.6, avg_dollar_volume_20d: 2_400_000_000, matches: ["New 20-day high"], earnings: null,
  },
  {
    symbol: "LQ01", source: "liquidity", prior_close: null, chg_1d_pct: null, chg_5d_pct: null, chg_20d_pct: null, atr_pct_14: null, rsi_14: null, rvol_10d: null,
    pct_from_20d_high: null, vs_50d_avg_pct: null, avg_dollar_volume_20d: null, matches: [], earnings: null,
  },
];

const stampOf: ReplayStamp = { ...stamp, as_of: "2026-07-13T20:00:00Z" };

/** Day 7, listed: the board as of the prior close, holds pinned, two focus names starred. */
export const swingDayList: SwingDayList = {
  kind: "swing",
  id: 71,
  plan: swingPlan,
  thread: swingBrief,
  day: "2026-07-14",
  weekday: "Tue",
  day_no: 7,
  of: 20,
  week_no: 2,
  week_label: "Week 2",
  status: "listed",
  clock: null,
  watch: [
    { symbol: "NVDA", starred_clock: "2026-07-14T13:30:00Z" },
    { symbol: "COIN", starred_clock: "2026-07-14T13:30:00Z" },
  ],
  columns: boardColumns,
  candidates: boardRows,
  holds: [nvdaHold, amdHold],
  free_cash_usd: 24720,
  sessions: [],
  universe: {
    source: "swing",
    size: 50,
    mix: { watchlist: 9, manual: 2, filter: 6, liquidity: 33 },
    label: SURVIVORSHIP,
    footnote: "Dividends are not credited in practice",
  },
  label: SURVIVORSHIP,
  peek: {
    symbol: "NVDA",
    daily: [
      { t: "2026-07-09", o: 184, h: 188.5, l: 183.2, c: 187.4, v: 41_200_000 },
      { t: "2026-07-10", o: 187.4, h: 189.9, l: 186.1, c: 188.2, v: 38_900_000 },
      { t: "2026-07-13", o: 188.2, h: 191.4, l: 187.8, c: 190.1, v: 44_700_000 },
    ],
    levels: { prior_high: 191.4, prior_low: 187.8, prior_close: 190.1 },
  },
  journal: null,
  notes: null,
  rating: null,
  created_at: "2026-07-14T13:00:00Z",
  ended_at: null,
  stamp: stampOf,
};

/** What an ended day shows: the strip of tiles (it was a watched day with one stop crossed while away). */
export const swingDaySummary: SwingDaySummary = {
  passed: "no",
  realized_usd: 828,
  gap_usd: 230,
  intraday_usd: 215,
  unrealized_change_usd: 17,
  equity_change_usd: 845,
  balance_usd: 51240,
  equity_usd: 52010,
  free_cash_usd: 24720,
  holds: [nvdaHold, amdHold],
  stop_hits: [{ symbol: "AMD", at: "14:05", watched: "no" }],
  late_stars: ["COIN"],
  entries: 1,
  exits: 1,
  max_open_seen: 2,
};

export const swingDayListEnded: SwingDayList = { ...swingDayList, status: "ended", clock: "2026-07-14T20:00:00Z", journal: swingDaySummary, ended_at: "2026-07-14T20:00:01Z" };

// -- the workspace: strip, pause, daily block, advance and feed ------------------------------------------------------

export const stripRows: StripRow[] = [
  { symbol: "NVDA", source: "hold", last: 191.4, chg_pct: 0.68, hold: { side: "long", shares: 100, unrealized_usd: 720, stop_price: 178.5, stop_distance_pct: 6.7, stopped: "no" } },
  { symbol: "AMD", source: "hold", last: 168.4, chg_pct: 6.31, hold: { side: "short", shares: 50, unrealized_usd: -320, stop_price: 168, stop_distance_pct: -0.2, stopped: "yes" } },
  { symbol: "COIN", source: "focus", last: 305.1, chg_pct: 1.18, hold: null },
  { symbol: "UBER", source: "focus", last: null, chg_pct: null, hold: null },
];

export const pausedCross: Paused = { symbol: "AMD", stop_price: 168, at: "2026-07-14T15:42:00Z", price: 168.2, kind: "cross", also: [] };
export const pausedGap: Paused = { symbol: "NVDA", stop_price: 182.5, at: "2026-07-14T13:30:00Z", price: 179.1, kind: "gap", also: ["AMD", "TSLA"] };

export const dailyBlock: DailyBlock = {
  bars: [
    { t: "2026-07-09", o: 184, h: 188.5, l: 183.2, c: 187.4, v: 41_200_000 },
    { t: "2026-07-10", o: 187.4, h: 189.9, l: 186.1, c: 188.2, v: 38_900_000 },
    { t: "2026-07-13", o: 188.2, h: 191.4, l: 187.8, c: 190.1, v: 44_700_000 },
  ],
  forming: { t: "2026-07-14", o: 190.3, h: 191.9, l: 189.8, c: 191.4, v: 6_100_000 },
  holds: [{ entry_t: "2026-07-10", side: "long", entry_price: 184.2, stop_price: 178.5 }],
};

/** The open-trade card of a carried hold after the open: days held, the gap and the price it is valued at. */
export const swingOpenTrade: OpenTrade = {
  ...openTrade,
  trade_no: 11,
  side: "long",
  shares: 100,
  entry_price: 184.2,
  stop_price: 178.5,
  last_price: 191.4,
  unrealized_usd: 720,
  r: 1.26,
  opened_day_no: 5,
  days_held: 3,
  gap_usd: 220,
  price_basis: "last",
};

/** An advance that found a crossed stop: play stopped at that minute. */
export const swingDelta: ReplayDelta = ReplayDeltaSchema.parse({
  ...delta,
  revealed_through: "2026-07-14T15:42:00Z",
  open_trade: swingOpenTrade,
  paused: pausedCross,
  strip: stripRows,
  daily_forming: dailyBlock.forming,
  prints: { ...delta.prints, feed: "off", rows: [], count: 0, volume: 0, shown: 0, pace: null },
});

/** An advance with nothing special: the swing keys are there, but no pause (the key is absent). */
export const swingDeltaQuiet: ReplayDelta = ReplayDeltaSchema.parse({
  ...delta,
  revealed_through: "2026-07-14T15:43:00Z",
  open_trade: swingOpenTrade,
  strip: stripRows,
  daily_forming: dailyBlock.forming,
  prints: { ...delta.prints, feed: "off", rows: [], count: 0, volume: 0, shown: 0, pace: null },
});

export const swingFeed: ReplayFeed = ReplayFeedSchema.parse({
  ...feed,
  revealed_through: "2026-07-14T15:30:00Z",
  open_trade: swingOpenTrade,
  strip: stripRows,
  daily: dailyBlock,
  prints: { ...feed.prints, feed: "off", rows: [], count: 0, volume: 0, shown: 0, pace: null },
});

export const swingSession = { ...session, day_list_id: 71, thread_id: 7, thread: swingBrief, tape_feed: "off", open_trade: swingOpenTrade } as const;

// -- weeks -------------------------------------------------------------------------------------------------------

const heatNames = [
  ["COIN", "filter", 9.4, "yes", "yes"],
  ["NVDA", "watchlist", 4.2, "yes", "yes"],
  ["TSLA", "watchlist", 3.1, "yes", "no"],
  ["META", "watchlist", 0.4, "no", "no"],
  ["UBER", "filter", 0.4, "no", "yes"],
  ["AMD", "watchlist", -2.3, "yes", "no"],
  ["LQ01", "liquidity", -3.6, "no", "no"],
] as const;

/** Week 1, frozen at its last close. */
export const weekClosed: WeekOut = {
  week_no: 1,
  label: "Week 1",
  status: "closed",
  to_date: "no",
  review: {
    week: { week_no: 1, label: "Week 1", first_day_no: 1, last_day_no: 5 },
    tiles: {
      realized_usd: 612,
      unrealized_change_usd: 258,
      equity_change_usd: 870,
      balance_usd: 50612,
      win_rate: 1,
      avg_win_usd: 612,
      avg_loss_usd: null,
      avg_days_held: 3,
      gap_usd: 230,
      gap_share_pct: 26.4,
      adherence_pct: 88,
      selection_pts: 1.8,
      timing_pts: -0.6,
      spy_return_pct: 0.9,
      universe_median_return_pct: 0.4,
      universe_mean_return_pct: 0.7,
    },
    equity: [
      { day_no: 1, balance_usd: 50000, equity_usd: 50085 },
      { day_no: 2, balance_usd: 50000, equity_usd: 50275 },
      { day_no: 3, balance_usd: 50000, equity_usd: 50210 },
      { day_no: 4, balance_usd: 50612, equity_usd: 50720 },
      { day_no: 5, balance_usd: 50612, equity_usd: 50870 },
    ],
    days: [
      { day_no: 1, weekday: "Mon", watched: "yes", entries: 0, exits: 0, realized_usd: 0, gap_usd: 0, intraday_usd: 85, adherence_pct: null },
      { day_no: 2, weekday: "Tue", watched: "yes", entries: 1, exits: 0, realized_usd: 0, gap_usd: 0, intraday_usd: 190, adherence_pct: 100 },
      { day_no: 3, weekday: "Wed", watched: "no", entries: 0, exits: 0, realized_usd: 0, gap_usd: 230, intraday_usd: -295, adherence_pct: null },
      { day_no: 4, weekday: "Thu", watched: "yes", entries: 0, exits: 1, realized_usd: 612, gap_usd: 0, intraday_usd: -504, adherence_pct: null },
      { day_no: 5, weekday: "Fri", watched: "yes", entries: 1, exits: 0, realized_usd: 0, gap_usd: 0, intraday_usd: 150, adherence_pct: 75 },
    ],
    holds: [
      {
        hold_id: 9, symbol: "TSLA", side: "long", shares: 40, entry_day_no: 2, entry_price: 240.5, status: "closed", exit_day_no: 4, exit_price: 255.8, days_held: 3,
        pnl_usd: 612, r: 1.8, gap_usd: 230, stop: "set", selection_rank: 4, selection_of: 50, selection_edge_pts: 2.4, timing_edge_pts: -0.5,
      },
      {
        hold_id: 11, symbol: "NVDA", side: "long", shares: 100, entry_day_no: 5, entry_price: 184.2, status: "open", exit_day_no: null, exit_price: null, days_held: 1,
        pnl_usd: 258, r: 0.45, gap_usd: null, stop: "none", selection_rank: null, selection_of: null, selection_edge_pts: null, timing_edge_pts: null,
      },
    ],
    heat: heatNames.map(([symbol, source, return_pct, held, focus]) => ({ symbol, source, return_pct, held, focus })),
    adherence: {
      score_pct: 88,
      checks: [
        { id: "stop_set", label: "Stop on every entry", applicable: true, passed: true, detail: "2 of 2" },
        { id: "stop_honored", label: "Stop honored", applicable: false, passed: true, detail: "No stop was hit" },
        { id: "week_loss_limit", label: "Week loss limit", applicable: true, passed: true, detail: "No entry after a loss over $600" },
        { id: "focus_before_open", label: "Focus before the open", applicable: true, passed: false, detail: "1 of 2 entries" },
      ],
    },
    filter_quality: { n: 6, median_return_pct: 1.2, universe_median_pct: 0.4, edge_pts: 0.8 },
    source_quality: [
      { source: "watchlist", median_return_pct: 1.4, n: 9 },
      { source: "liquidity", median_return_pct: 0.3, n: 33 },
    ],
    focus_untraded: [{ symbol: "COIN", rank: 1, of: 50, return_pct: 9.4 }],
    copy: ["Selection +1.8 pts vs the universe median · your hold ranked 4th of 50 · Timing −0.6 pts"],
  },
  notes: null,
  rating: null,
  universe_label: SURVIVORSHIP,
  footnote: "Dividends are not credited in practice",
};

/** Week 2 so far: "Week to date" through the last ended close, computed on read. */
export const weekToDate: WeekOut = {
  ...weekClosed,
  week_no: 2,
  label: "Week 2 · 2 of 5 days",
  status: "open",
  to_date: "yes",
  review: {
    ...weekClosed.review,
    week: { week_no: 2, label: "Week 2 · 2 of 5 days", first_day_no: 6, last_day_no: 7 },
    equity: [...weekClosed.review.equity, { day_no: 6, balance_usd: 51240, equity_usd: 51895 }, { day_no: 7, balance_usd: 51240, equity_usd: 52010 }],
    days: [
      { day_no: 6, weekday: "Mon", watched: "yes", entries: 1, exits: 1, realized_usd: 628, gap_usd: 220, intraday_usd: -20, adherence_pct: 100 },
      { day_no: 7, weekday: "Tue", watched: "no", entries: 0, exits: 0, realized_usd: 0, gap_usd: 115, intraday_usd: 0, adherence_pct: null },
    ],
    copy: [],
    holds: [],
    filter_quality: null,
    source_quality: [],
    focus_untraded: [],
  },
  notes: "Gap held",
  rating: 4,
};

export const weekRows: WeekRow[] = [
  { week_no: 1, label: "Week 1", days: 5, first_day_no: 1, last_day_no: 5, status: "closed", realized_usd: 612, equity_change_usd: 870, adherence_pct: 88, selection_pts: 1.8, timing_pts: -0.6 },
  { week_no: 2, label: "Week 2", days: 5, first_day_no: 6, last_day_no: 10, status: "open", realized_usd: null, equity_change_usd: null, adherence_pct: null, selection_pts: null, timing_pts: null },
];

export const weeksOut = { thread_id: 7, weeks: weekRows, label: SIMULATED };
