import { z } from "zod";
import { ReplaySessionV1Schema } from "@ai-trading/contracts/replay-session-v1";
import type { components } from "../api/openapi.js";
import { ThreadBriefSchema } from "./threads.ts";

// Response shapes of the Practice (replay) endpoints (02o §b2, §c5), checked against the generated OpenAPI
// (`lib/api/openapi.d.ts`) with `satisfies z.ZodType<components["schemas"][…]>` the way lib/api/schemas.ts does:
// a field the backend adds, drops or retypes breaks `pnpm typecheck` here instead of a screen at run time.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const quality = z.enum(["realtime", "delayed-15m", "eod", "fallback", "unavailable"]);

export const ReplayIntervalSchema = z.enum(["1m", "5m", "15m"]);
export const TapeFeedSchema = z.enum(["sip", "iex", "off"]);
export const SessionStatusSchema = z.enum(["active", "ended"]);
export const ArmedSourceSchema = z.enum(["alert_strategy", "filter"]);
/** `split` is a corporate-action mark the server stamps (source `auto`): shares and prices restate, no P/L. She never places one. */
export const MarkKindSchema = z.enum(["long_entry", "short_entry", "long_exit", "short_exit", "stop", "note", "split"]);
export const SideSchema = z.enum(["long", "short"]);

/** `stamp.freshness` is `"replay"` on every Practice response (02o §b1). */
export const ReplayStampSchema = z.object({
  as_of: timestamp.nullable(),
  source: z.string().nullable(),
  quality,
  freshness: z.literal("replay"),
}) satisfies z.ZodType<components["schemas"]["Stamp"]>;

// -- marks, trades, journal -----------------------------------------------------------------------------------

export const MarkSchema = z.object({
  id: finite.int(),
  seq: finite.int(),
  kind: MarkKindSchema,
  at: timestamp,
  price: finite.nullable(),
  shares: finite.int().nullable(),
  stop_price: finite.nullable(),
  note: z.string().nullable(),
  trade_no: finite.int().nullable(),
  source: z.enum(["her", "auto"]),
}) satisfies z.ZodType<components["schemas"]["MarkOut"]>;

/** A limit, stop or stop-limit entry that was not filled at once, and what became of it. A fill is also an entry mark (`mark_id`). */
export const OrderSchema = z.object({
  id: finite.int(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "stop", "stop_limit"]),
  shares: finite.int(),
  limit_price: finite.nullable(),
  /** The stop leg's trigger. */
  stop_price: finite.nullable(),
  status: z.enum(["working", "filled", "cancelled"]),
  placed_at: timestamp,
  triggered_at: timestamp.nullable(),
  closed_at: timestamp.nullable(),
  fill_price: finite.nullable(),
  mark_id: finite.int().nullable(),
  /** Why the server cancelled it, when it did. */
  reason: z.string().nullable(),
  /** Time in force: `gtc` rests until it fills or she cancels it (the default); `day` lapses at the extended close of the session it was placed in (the market's rule). */
  tif: z.enum(["gtc", "day"]).default("gtc"),
  /** When a `day` order lapses; absent for `gtc`. */
  expires_at: timestamp.nullable().default(null),
  /** A closing order is derived reduce-only: it fills for at most the position and is cancelled once the position is gone. */
  reduce_only: z.boolean().default(false),
}) satisfies z.ZodType<components["schemas"]["OrderOut"]>;

export const PriceBasisSchema = z.enum(["prior_close", "last"]);

/** A lane's open position: one average-cost position per name, marked at the thread clock `T` (`last_price`). The swing-only fields
 *  (`opened_day_no`, `days_held`, `gap_usd`, `price_basis`) stay in the payload until the contract migration; no screen reads them. */
export const OpenTradeSchema = z.object({
  trade_no: finite.int(),
  side: SideSchema,
  shares: finite.int(),
  entry_price: finite,
  stop_price: finite.nullable(),
  last_price: finite,
  unrealized_usd: finite,
  r: finite.nullable(),
  opened_day_no: finite.int().nullish(),
  days_held: finite.int().nullish(),
  gap_usd: finite.nullish(),
  price_basis: PriceBasisSchema.nullish(),
  /** When this trade's stop line was first crossed (an alert flag only: the stop never exits). Absent while not. */
  stop_hit_at: timestamp.nullish(),
  /** When the position's first entry mark was placed. */
  entry_at: timestamp.nullish(),
}) satisfies z.ZodType<components["schemas"]["OpenTradeOut"]>;

const JournalTotalsSchema = z.object({
  pnl_usd: finite,
  r_total: finite,
  trades: finite.int(),
  wins: finite.int(),
  losses: finite.int(),
  scratches: finite.int(),
  win_rate: finite.nullable(),
  avg_win_usd: finite.nullable(),
  avg_loss_usd: finite.nullable(),
  largest_loss_usd: finite.nullable(),
}) satisfies z.ZodType<components["schemas"]["JournalTotalsOut"]>;

const JournalTradeSchema = z.object({
  no: finite.int(),
  side: SideSchema,
  entry_at: timestamp,
  entry_price: finite,
  exit_at: timestamp,
  exit_price: finite,
  shares: finite.int(),
  pnl_usd: finite,
  r: finite.nullable(),
  stop_price: finite.nullable(),
  on_signal: z.boolean(),
  exit_source: z.enum(["her", "auto"]),
}) satisfies z.ZodType<components["schemas"]["JournalTradeOut"]>;

const AdherenceCheckSchema = z.object({
  id: z.enum(["stop_set", "stop_honored", "on_signal", "max_loss", "max_trades"]),
  label: z.string(),
  applicable: z.boolean(),
  passed: z.boolean(),
  detail: z.string(),
}) satisfies z.ZodType<components["schemas"]["AdherenceCheckOut"]>;

const AdherenceSchema = z.object({
  score_pct: finite.int().nullable(),
  hint: z.string().nullable(),
  checks: z.array(AdherenceCheckSchema),
}) satisfies z.ZodType<components["schemas"]["AdherenceOut"]>;

const SignalVsTradeSchema = z.object({
  time: timestamp,
  name: z.string(),
  close: finite,
  chg_15m_pct: finite.nullable(),
  chg_30m_pct: finite.nullable(),
  her: z.string(),
}) satisfies z.ZodType<components["schemas"]["SignalVsTradeOut"]>;

const PnlPointSchema = z.object({ t: timestamp, pnl_usd: finite }) satisfies z.ZodType<components["schemas"]["PnlPointOut"]>;

export const JournalSchema = z.object({
  totals: JournalTotalsSchema,
  trades: z.array(JournalTradeSchema),
  adherence: AdherenceSchema,
  signals_vs_trades: z.array(SignalVsTradeSchema),
  pnl_series: z.array(PnlPointSchema),
}) satisfies z.ZodType<components["schemas"]["JournalOut"]>;

// -- sessions -----------------------------------------------------------------------------------------------

const ArmedSchema = z.object({
  source: ArmedSourceSchema,
  id: finite.int(),
  version_id: finite.int(),
  name: z.string(),
  bias: z.enum(["bullish", "bearish", "neutral"]).nullable(),
  fires_so_far: finite.int(),
}) satisfies z.ZodType<components["schemas"]["ArmedOut"]>;

export const ReplaySessionSchema = z.object({
  id: finite.int(),
  /** The Screen row this lane belongs to (kept in the payload for the legacy rows; no screen reads it). */
  day_list_id: finite.int().nullable(),
  /** The practice thread this lane belongs to: its realized trades book into it. Null for a legacy standalone session (read-only). */
  thread_id: finite.int().nullable(),
  /** The SIMULATED thread balance; null for a legacy standalone session. */
  thread: ThreadBriefSchema.nullable(),
  attempt: finite.int(),
  status: SessionStatusSchema,
  spec: ReplaySessionV1Schema,
  window_start: timestamp,
  window_end: timestamp,
  revealed_through: timestamp,
  /** The thread clock at this read; null for a legacy standalone session. */
  day_clock: timestamp.nullable(),
  /** Behind the thread clock: the next advance catches this name up, and it cannot be marked until then. */
  behind_clock: z.boolean(),
  tape_feed: TapeFeedSchema,
  armed: z.array(ArmedSchema),
  marks: z.array(MarkSchema),
  open_trade: OpenTradeSchema.nullable(),
  /** Orders that were not filled at once, newest last; absent from an older answer. */
  orders: z.array(OrderSchema).default([]),
  journal: JournalSchema,
  notes: z.string().nullable(),
  rating: finite.int().nullable(),
  created_at: timestamp,
  ended_at: timestamp.nullable(),
  stamp: ReplayStampSchema,
}) satisfies z.ZodType<components["schemas"]["ReplaySessionOut"]>;

// -- advance and feed ---------------------------------------------------------------------------------------

export const ReplayBarSchema = z.object({
  t: timestamp,
  o: finite,
  h: finite,
  l: finite,
  c: finite,
  v: finite,
  ext: z.boolean(),
}) satisfies z.ZodType<components["schemas"]["ReplayBarOut"]>;

const FormingBarSchema = z.object({ t: timestamp, o: finite, h: finite, l: finite, c: finite, v: finite }) satisfies z.ZodType<
  components["schemas"]["FormingBarOut"]
>;

const PaceSchema = z.object({
  window_s: finite,
  prints_per_s: finite,
  shares_per_s: finite,
  x_of_avg: finite.nullable(),
  band: z.enum(["quiet", "steady", "busy", "frantic"]).nullable(),
}) satisfies z.ZodType<components["schemas"]["PaceOut"]>;

const TickSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);

const PrintsSchema = z.object({
  feed: TapeFeedSchema,
  /** `[time, price, size, tick]`, oldest first; tick 1 up, -1 down, 0 same. */
  rows: z.array(z.tuple([timestamp, finite, finite.int(), TickSchema])),
  count: finite.int(),
  volume: finite,
  shown: finite.int(),
  big_print_usd: finite.int(),
  pace: PaceSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["PrintsOut"]>;

export const ReplaySignalSchema = z.object({
  source: ArmedSourceSchema,
  id: finite.int(),
  name: z.string(),
  bias: z.enum(["bullish", "bearish", "neutral"]).nullable(),
  bar_time: timestamp,
  bar_close: timestamp,
  close: finite,
  evidence: z.record(z.string(), finite),
  /** False: it fired while she was on another name, so it is on the chart and not scored (02o-b2). */
  seen: z.boolean(),
}) satisfies z.ZodType<components["schemas"]["ReplaySignalOut"]>;

const LevelsSchema = z.object({
  prior_close: finite.nullable().optional(),
  session_high: finite.nullable().optional(),
  session_low: finite.nullable().optional(),
  opening_range_high: finite.nullable().optional(),
  opening_range_low: finite.nullable().optional(),
}) satisfies z.ZodType<components["schemas"]["ReplayLevelsOut"]>;

/** The exchange's state at the thread time (a day thread's payloads; ADR-0022). After `tape_end` the day has no bars: nothing is filled. */
export const MarketSchema = z.object({
  phase: z.enum(["premarket", "regular", "after_hours", "closed"]),
  tape_end: timestamp,
  last_bar_at: timestamp.nullable(),
  next_open_at: timestamp.nullable(),
}) satisfies z.ZodType<components["schemas"]["MarketOut"]>;

const IndicatorRowSchema = z.object({
  t: timestamp,
  ema9: finite.nullable(),
  ema21: finite.nullable(),
  vwap: finite.nullable(),
  rsi14: finite.nullable(),
  macd: finite.nullable(),
  macd_signal: finite.nullable(),
  macd_hist: finite.nullable(),
}) satisfies z.ZodType<components["schemas"]["IndicatorRowOut"]>;

/** Server-computed indicators of the bars this payload carries, then the forming candle (whose close is the price). A value that has not warmed up is null. */
export const IndicatorsSchema = z.object({
  interval: ReplayIntervalSchema,
  as_of_bar: timestamp.nullable(),
  rows: z.array(IndicatorRowSchema),
}) satisfies z.ZodType<components["schemas"]["IndicatorsOut"]>;

const LastSchema = z.object({ price: finite, at: timestamp, age_s: finite.int() }) satisfies z.ZodType<components["schemas"]["LastPrintOut"]>;

/** What `advance` returns for `(previous, revealed_through]`; `feed` returns the same object for everything revealed so far. */
export const ReplayDeltaSchema = z.object({
  revealed_through: timestamp,
  day_clock: timestamp.nullable(),
  /** The thread's own time T, never extrapolated by the server; null for a legacy standalone session (ADR-0022). */
  thread_time: timestamp.nullish(),
  /** The data the cut ends at: nothing after the thread clock `T` is in this payload. */
  data_through: timestamp,
  market: MarketSchema.nullish(),
  /** The indicators of this payload's bars, from the same cut as the bars, the price and the forming candle. */
  indicators: IndicatorsSchema.nullish(),
  behind_clock: z.boolean(),
  at_end: z.boolean(),
  bars: z.array(ReplayBarSchema),
  forming: FormingBarSchema.nullable(),
  prints: PrintsSchema,
  signals: z.array(ReplaySignalSchema),
  levels: LevelsSchema,
  last: LastSchema.nullable(),
  /** Seconds with no eligible print, once that passes a minute (the tape marker); null otherwise. */
  quiet_s: finite.int().nullable(),
  open_trade: OpenTradeSchema.nullable(),
  orders: z.array(OrderSchema).default([]),
  stamp: ReplayStampSchema,
  /** Working orders the tape filled inside this advance, as the entry marks they became; absent when none. */
  fills: z.array(MarkSchema).nullish(),
  /** The thread's server-side clock while it RUNS (ADR-0018); absent when it is not. */
  thread_clock: z.object({ running: z.boolean(), speed: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]) }).nullish(),
}) satisfies z.ZodType<components["schemas"]["AdvanceOut"]>;

export const ReplayFeedSchema = ReplayDeltaSchema.extend({
  interval: ReplayIntervalSchema,
  window_start: timestamp,
}) satisfies z.ZodType<components["schemas"]["FeedOut"]>;

// -- marks --------------------------------------------------------------------------------------------------

export const MarkResultSchema = z.object({
  mark: MarkSchema,
  open_trade: OpenTradeSchema.nullable(),
  journal: JournalSchema,
  /** Set when the mark was priced off a print older than 30 seconds. */
  warning: z.string().nullable(),
  /** An exit mark books its P/L: the thread balance after it. */
  thread: ThreadBriefSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["MarkResultOut"]>;

/** Placing an order answers the order, the session's list, and the entry mark when it filled at once (a limit through the market). */
export const OrderResultSchema = z.object({
  order: OrderSchema,
  orders: z.array(OrderSchema),
  mark: MarkSchema.nullable(),
  open_trade: OpenTradeSchema.nullable(),
  journal: JournalSchema,
  warning: z.string().nullable(),
  thread: ThreadBriefSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["OrderResultOut"]>;

export const OrderCancelSchema = z.object({
  order: OrderSchema,
  orders: z.array(OrderSchema),
}) satisfies z.ZodType<components["schemas"]["OrderCancelOut"]>;

/** Undo answers the new book: the removed mark, the open trade and the journal. */
export const MarkUndoSchema = z.object({
  removed_mark_id: finite.int(),
  open_trade: OpenTradeSchema.nullable(),
  journal: JournalSchema,
  /** Undoing an exit takes its P/L back out of the thread balance. */
  thread: ThreadBriefSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["MarkUndoOut"]>;

export type ReplayStamp = z.infer<typeof ReplayStampSchema>;
export type ReplayInterval = z.infer<typeof ReplayIntervalSchema>;
export type TapeFeed = z.infer<typeof TapeFeedSchema>;
export type ReplayMark = z.infer<typeof MarkSchema>;
export type MarkKind = z.infer<typeof MarkKindSchema>;
export type OpenTrade = z.infer<typeof OpenTradeSchema>;
export type ReplayJournal = z.infer<typeof JournalSchema>;
export type JournalTrade = ReplayJournal["trades"][number];
export type SignalVsTrade = ReplayJournal["signals_vs_trades"][number];
export type ReplaySession = z.infer<typeof ReplaySessionSchema>;
export type ArmedStrategy = ReplaySession["armed"][number];
export type ReplayBar = z.infer<typeof ReplayBarSchema>;
export type ReplayPrints = z.infer<typeof ReplayDeltaSchema>["prints"];
export type ReplayPace = NonNullable<ReplayPrints["pace"]>;
export type ReplaySignal = z.infer<typeof ReplaySignalSchema>;
export type ReplayLevels = z.infer<typeof ReplayDeltaSchema>["levels"];
export type ReplayDelta = z.infer<typeof ReplayDeltaSchema>;
export type Market = z.infer<typeof MarketSchema>;
export type Indicators = z.infer<typeof IndicatorsSchema>;
export type IndicatorBar = Indicators["rows"][number];
export type ReplayFeed = z.infer<typeof ReplayFeedSchema>;
export type MarkResult = z.infer<typeof MarkResultSchema>;
export type PracticeOrder = z.infer<typeof OrderSchema>;
export type OrderResult = z.infer<typeof OrderResultSchema>;
