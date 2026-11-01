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
/** `off` is a swing session with the tape off: no prints are fetched and marks price at one-minute closes (02p). */
export const TapeFeedSchema = z.enum(["sip", "iex", "off"]);
export const SessionStatusSchema = z.enum(["active", "ended"]);
export const ArmedSourceSchema = z.enum(["alert_strategy", "filter"]);
export const MarkKindSchema = z.enum(["long_entry", "short_entry", "long_exit", "short_exit", "stop", "note"]);
export const SideSchema = z.enum(["long", "short"]);

/** `stamp.freshness` is `"replay"` on every Practice response (02o §b1). */
export const ReplayStampSchema = z.object({
  as_of: timestamp.nullable(),
  source: z.string().nullable(),
  quality,
  freshness: z.literal("replay"),
}) satisfies z.ZodType<components["schemas"]["Stamp"]>;

// -- days ---------------------------------------------------------------------------------------------------

export const ReplayDaySchema = z.object({
  symbol: z.string(),
  day: z.iso.date(),
  weekday: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  rank: finite.int(),
  rv_pct_rank: finite,
  gap_pct: finite.nullable(),
  tags: z.array(z.enum(["gap_up", "gap_down", "heavy_volume", "earnings"])),
  attempts: finite.int(),
}) satisfies z.ZodType<components["schemas"]["ReplayDayOut"]>;

export const ReplayDaysSchema = z.object({
  days: z.array(ReplayDaySchema),
  symbols: z.array(z.string()),
  lookback_sessions: finite.int(),
  stamp: ReplayStampSchema,
}) satisfies z.ZodType<components["schemas"]["ReplayDaysOut"]>;

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

export const PriceBasisSchema = z.enum(["prior_close", "last"]);

/** In a swing session the open trade is the name's practice hold (`trade_no` is the hold id). The four swing fields are
 *  absent for a day session, and a swing one that has no value yet (`gap_usd` before the first price) is absent too. */
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
  /** A day's `DaySessionOut.position` only: when play paused because this trade's stop was crossed. Absent while not. */
  stop_hit_at: timestamp.nullish(),
  /** A day trade only: when the entry mark was placed. Absent on a swing hold. */
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

// -- swing practice (02p): holds, the day strip, the stop pause and the daily block ----------------------------------------
// Every swing-only key that has no value is ABSENT in the JSON (the API leaves it out), so those are `.nullish()`.

export const EarningsChipSchema = z.object({
  in_sessions: finite.int(),
  timing: z.enum(["before open", "after close"]),
}) satisfies z.ZodType<components["schemas"]["EarningsChipOut"]>;

/** A practice hold. Day numbers and weekdays only: a swing payload carries no calendar date. */
export const HoldSchema = z.object({
  id: finite.int(),
  symbol: z.string(),
  side: SideSchema,
  shares: finite.int(),
  entry_day_no: finite.int(),
  entry_weekday: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  entry_price: finite,
  days_held: finite.int(),
  stop_at_entry: finite.nullable(),
  stop_price: finite.nullable(),
  stop_hit: z.enum(["yes", "no"]),
  status: z.enum(["open", "closed"]),
  exit_day_no: finite.int().nullable(),
  exit_price: finite.nullable(),
  exit_source: z.enum(["her", "auto"]).nullable(),
  last_close: finite.nullable(),
  price_basis: PriceBasisSchema.nullable(),
  unrealized_usd: finite.nullable(),
  pnl_usd: finite.nullable(),
  r: finite.nullable(),
  gap_usd: finite.nullable(),
  earnings: EarningsChipSchema.nullable(),
  split_note: z.string().nullable(),
}) satisfies z.ZodType<components["schemas"]["HoldOut"]>;

/** Play stopped at the first minute that crossed an open hold's stop (`gap`: the day opened beyond it). */
export const PausedSchema = z.object({
  symbol: z.string(),
  stop_price: finite,
  at: timestamp,
  price: finite,
  kind: z.enum(["cross", "gap"]),
  also: z.array(z.string()),
}) satisfies z.ZodType<components["schemas"]["PausedOut"]>;

export const StripHoldSchema = z.object({
  side: SideSchema,
  shares: finite.int(),
  unrealized_usd: finite,
  stop_price: finite.nullable(),
  /** Signed in her favour: positive while the price is on the safe side of the stop, negative once it crossed. */
  stop_distance_pct: finite.nullable(),
  stopped: z.enum(["yes", "no"]),
}) satisfies z.ZodType<components["schemas"]["StripHoldOut"]>;

/** A row of the day strip: every open hold first, then the focus names; at most ten. */
export const StripRowSchema = z.object({
  symbol: z.string(),
  source: z.enum(["hold", "focus"]),
  last: finite.nullable(),
  chg_pct: finite.nullable(),
  hold: StripHoldSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["StripRowOut"]>;

export const DailyBarSchema = z.object({ t: z.iso.date(), o: finite, h: finite, l: finite, c: finite, v: finite }) satisfies z.ZodType<
  components["schemas"]["DailyBarOut"]
>;

const DailyHoldMarkerSchema = z.object({
  entry_t: z.iso.date(),
  side: SideSchema,
  entry_price: finite,
  stop_price: finite.nullable(),
}) satisfies z.ZodType<components["schemas"]["DailyHoldMarkerOut"]>;

/** The Daily chart: rebased bars through the session before the day, the forming candle, and this name's hold marker. */
export const DailyBlockSchema = z.object({
  bars: z.array(DailyBarSchema),
  forming: DailyBarSchema.nullable(),
  holds: z.array(DailyHoldMarkerSchema),
}) satisfies z.ZodType<components["schemas"]["DailyBlockOut"]>;

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
  /** The day list this session practices (daily-list practice); null for a standalone session. */
  day_list_id: finite.int().nullable(),
  /** The practice thread its realized trades book into; null for a standalone session (02r). */
  thread_id: finite.int().nullable(),
  /** The SIMULATED thread balance and today's realized P/L; null for a standalone session. */
  thread: ThreadBriefSchema.nullable(),
  attempt: finite.int(),
  status: SessionStatusSchema,
  spec: ReplaySessionV1Schema,
  window_start: timestamp,
  window_end: timestamp,
  revealed_through: timestamp,
  /** The day list's shared clock; null for a standalone session (02o-b2). */
  day_clock: timestamp.nullable(),
  /** Behind the day clock: the next advance catches this name up, and it cannot be marked until then. */
  behind_clock: z.boolean(),
  tape_feed: TapeFeedSchema,
  armed: z.array(ArmedSchema),
  marks: z.array(MarkSchema),
  open_trade: OpenTradeSchema.nullable(),
  journal: JournalSchema,
  notes: z.string().nullable(),
  rating: finite.int().nullable(),
  created_at: timestamp,
  ended_at: timestamp.nullable(),
  stamp: ReplayStampSchema,
}) satisfies z.ZodType<components["schemas"]["ReplaySessionOut"]>;

export const ReplaySessionSummarySchema = z.object({
  id: finite.int(),
  day_list_id: finite.int().nullable(),
  thread_id: finite.int().nullable(),
  symbol: z.string(),
  day: z.iso.date(),
  attempt: finite.int(),
  status: SessionStatusSchema,
  hide_date: z.enum(["yes", "no"]),
  revealed_through: timestamp,
  window_end: timestamp,
  trades: finite.int(),
  pnl_usd: finite.nullable(),
  adherence_pct: finite.int().nullable(),
  updated_at: timestamp,
}) satisfies z.ZodType<components["schemas"]["ReplaySessionSummaryOut"]>;

/** The list route answers a bare array. */
export const ReplaySessionsSchema = z.array(ReplaySessionSummarySchema);

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

const LastSchema = z.object({ price: finite, at: timestamp, age_s: finite.int() }) satisfies z.ZodType<components["schemas"]["LastPrintOut"]>;

/** What `advance` returns for `(previous, revealed_through]`; `feed` returns the same object for everything revealed so far. */
export const ReplayDeltaSchema = z.object({
  revealed_through: timestamp,
  day_clock: timestamp.nullable(),
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
  stamp: ReplayStampSchema,
  /** Swing only: play stopped at a crossed stop (the clock is at that minute's close). */
  paused: PausedSchema.nullish(),
  /** Swing only: the day strip at the day clock. */
  strip: z.array(StripRowSchema).nullish(),
  /** Swing only: the forming day candle from the revealed one-minute bars. */
  daily_forming: DailyBarSchema.nullish(),
}) satisfies z.ZodType<components["schemas"]["AdvanceOut"]>;

export const ReplayFeedSchema = ReplayDeltaSchema.extend({
  interval: ReplayIntervalSchema,
  window_start: timestamp,
  /** Swing only: the Daily chart's bars and this name's hold marker. */
  daily: DailyBlockSchema.nullish(),
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
  /** Swing only: the hold the mark opened, moved or closed (the symbol's open hold for a note). */
  hold: HoldSchema.nullish(),
}) satisfies z.ZodType<components["schemas"]["MarkResultOut"]>;

/** Undo answers the new book: the removed mark, the open trade and the journal. */
export const MarkUndoSchema = z.object({
  removed_mark_id: finite.int(),
  open_trade: OpenTradeSchema.nullable(),
  journal: JournalSchema,
  /** Undoing an exit takes its P/L back out of the thread balance. */
  thread: ThreadBriefSchema.nullable(),
  /** Swing only: the hold after the undo (an undone entry leaves none). */
  hold: HoldSchema.nullish(),
}) satisfies z.ZodType<components["schemas"]["MarkUndoOut"]>;

export type ReplayStamp = z.infer<typeof ReplayStampSchema>;
export type ReplayInterval = z.infer<typeof ReplayIntervalSchema>;
export type TapeFeed = z.infer<typeof TapeFeedSchema>;
export type ReplayDay = z.infer<typeof ReplayDaySchema>;
export type ReplayDays = z.infer<typeof ReplayDaysSchema>;
export type ReplayMark = z.infer<typeof MarkSchema>;
export type MarkKind = z.infer<typeof MarkKindSchema>;
export type OpenTrade = z.infer<typeof OpenTradeSchema>;
export type ReplayJournal = z.infer<typeof JournalSchema>;
export type JournalTrade = ReplayJournal["trades"][number];
export type SignalVsTrade = ReplayJournal["signals_vs_trades"][number];
export type ReplaySession = z.infer<typeof ReplaySessionSchema>;
export type ArmedStrategy = ReplaySession["armed"][number];
export type ReplaySessionSummary = z.infer<typeof ReplaySessionSummarySchema>;
export type ReplayBar = z.infer<typeof ReplayBarSchema>;
export type ReplayPrints = z.infer<typeof ReplayDeltaSchema>["prints"];
export type ReplayPace = NonNullable<ReplayPrints["pace"]>;
export type ReplaySignal = z.infer<typeof ReplaySignalSchema>;
export type ReplayLevels = z.infer<typeof ReplayDeltaSchema>["levels"];
export type ReplayDelta = z.infer<typeof ReplayDeltaSchema>;
export type ReplayFeed = z.infer<typeof ReplayFeedSchema>;
export type MarkResult = z.infer<typeof MarkResultSchema>;
export type PriceBasis = z.infer<typeof PriceBasisSchema>;
export type EarningsChip = z.infer<typeof EarningsChipSchema>;
export type Hold = z.infer<typeof HoldSchema>;
export type Paused = z.infer<typeof PausedSchema>;
export type StripRow = z.infer<typeof StripRowSchema>;
export type DailyBar = z.infer<typeof DailyBarSchema>;
export type DailyBlock = z.infer<typeof DailyBlockSchema>;
