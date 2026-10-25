import { z } from "zod";
import { ReplaySessionV1Schema } from "@ai-trading/contracts/replay-session-v1";

// Response shapes of the Practice (replay) endpoints (02o §b2, §c5). The generated OpenAPI file does not
// carry these routes yet, so they are written by hand against the plan; once the backend stream
// regenerates `openapi.*`, add `satisfies z.ZodType<components["schemas"][…]>` the way lib/api/schemas.ts
// does. Fields the plan leaves open (`pace`, `big_print_usd`, `window_start`, the session list envelope)
// are optional or accept both shapes, so a backend that follows the plan to the letter still parses.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const quality = z.enum(["realtime", "delayed-15m", "eod", "fallback", "unavailable"]);

export const ReplayIntervalSchema = z.enum(["1m", "5m", "15m"]);
export const TapeFeedSchema = z.enum(["sip", "iex"]);
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
});

// -- days ---------------------------------------------------------------------------------------------------

export const ReplayDaySchema = z.object({
  symbol: z.string(),
  day: z.iso.date(),
  weekday: z.string(),
  rank: finite.int(),
  rv_pct_rank: finite,
  gap_pct: finite.nullable(),
  tags: z.array(z.string()),
  attempts: finite.int(),
});

export const ReplayDaysSchema = z.object({
  days: z.array(ReplayDaySchema),
  symbols: z.array(z.string()),
  lookback_sessions: finite.int(),
  stamp: ReplayStampSchema.optional(),
});

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
});

export const OpenTradeSchema = z.object({
  trade_no: finite.int(),
  side: SideSchema,
  shares: finite.int(),
  entry_price: finite,
  stop_price: finite.nullable(),
  last_price: finite,
  unrealized_usd: finite,
  r: finite.nullable(),
});

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
});

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
});

const AdherenceCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  applicable: z.boolean(),
  passed: z.boolean(),
  detail: z.string(),
});

const AdherenceSchema = z.object({
  score_pct: finite.int().nullable(),
  hint: z.string().nullable().optional(),
  checks: z.array(AdherenceCheckSchema),
});

const SignalVsTradeSchema = z.object({
  time: timestamp,
  name: z.string(),
  close: finite,
  chg_15m_pct: finite.nullable(),
  chg_30m_pct: finite.nullable(),
  her: z.string(),
});

const PnlPointSchema = z.object({ t: timestamp, pnl_usd: finite });

export const JournalSchema = z.object({
  totals: JournalTotalsSchema,
  trades: z.array(JournalTradeSchema),
  adherence: AdherenceSchema,
  signals_vs_trades: z.array(SignalVsTradeSchema),
  pnl_series: z.array(PnlPointSchema),
});

// -- sessions -----------------------------------------------------------------------------------------------

const ArmedSchema = z.object({
  source: ArmedSourceSchema,
  id: finite.int(),
  version_id: finite.int(),
  name: z.string(),
  bias: z.enum(["bullish", "bearish", "neutral"]).nullable().optional(),
  fires_so_far: finite.int(),
});

export const ReplaySessionSchema = z.object({
  id: finite.int(),
  attempt: finite.int(),
  status: SessionStatusSchema,
  spec: ReplaySessionV1Schema,
  window_start: timestamp,
  window_end: timestamp,
  revealed_through: timestamp,
  tape_feed: TapeFeedSchema,
  armed: z.array(ArmedSchema),
  marks: z.array(MarkSchema),
  open_trade: OpenTradeSchema.nullable(),
  journal: JournalSchema,
  notes: z.string().nullable(),
  rating: finite.int().nullable(),
  ended_at: timestamp.nullable().optional(),
  stamp: ReplayStampSchema,
});

export const ReplaySessionSummarySchema = z.object({
  id: finite.int(),
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
});

/** The list route answers a bare array or `{ sessions: […] }`; both read as an array. */
export const ReplaySessionsSchema = z
  .union([z.array(ReplaySessionSummarySchema), z.object({ sessions: z.array(ReplaySessionSummarySchema) })])
  .transform((value) => (Array.isArray(value) ? value : value.sessions));

// -- advance and feed ---------------------------------------------------------------------------------------

export const ReplayBarSchema = z.object({
  t: timestamp,
  o: finite,
  h: finite,
  l: finite,
  c: finite,
  v: finite,
  ext: z.boolean().optional(),
});

const FormingBarSchema = z.object({ t: timestamp, o: finite, h: finite, l: finite, c: finite, v: finite });

const PaceSchema = z.object({
  window_s: finite,
  prints_per_s: finite,
  shares_per_s: finite,
  x_of_avg: finite.nullable().optional(),
  band: z.enum(["quiet", "steady", "busy", "frantic"]).nullable().optional(),
});

const TickSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);

const PrintsSchema = z.object({
  feed: TapeFeedSchema,
  /** `[time, price, size, tick]`, oldest first; tick 1 up, -1 down, 0 same. */
  rows: z.array(z.tuple([timestamp, finite, finite.int(), TickSchema])),
  count: finite.int(),
  volume: finite,
  shown: finite.int(),
  big_print_usd: finite.nullable().optional(),
  pace: PaceSchema.nullable().optional(),
});

export const ReplaySignalSchema = z.object({
  source: ArmedSourceSchema,
  id: finite.int(),
  name: z.string(),
  bias: z.enum(["bullish", "bearish", "neutral"]).nullable().optional(),
  bar_time: timestamp,
  bar_close: timestamp,
  close: finite,
  evidence: z.record(z.string(), finite).optional(),
});

const LevelsSchema = z.object({
  prior_close: finite.nullable().optional(),
  session_high: finite.nullable().optional(),
  session_low: finite.nullable().optional(),
  opening_range_high: finite.nullable().optional(),
  opening_range_low: finite.nullable().optional(),
});

const LastSchema = z.object({ price: finite, at: timestamp });

/** What `advance` returns for `(previous, revealed_through]`; `feed` returns the same object for everything revealed so far. */
export const ReplayDeltaSchema = z.object({
  revealed_through: timestamp,
  at_end: z.boolean(),
  bars: z.array(ReplayBarSchema),
  forming: FormingBarSchema.nullable(),
  prints: PrintsSchema,
  signals: z.array(ReplaySignalSchema),
  levels: LevelsSchema,
  last: LastSchema.nullable(),
  open_trade: OpenTradeSchema.nullable(),
  stamp: ReplayStampSchema,
});

export const ReplayFeedSchema = ReplayDeltaSchema.extend({
  interval: ReplayIntervalSchema.optional(),
  window_start: timestamp.optional(),
});

// -- marks --------------------------------------------------------------------------------------------------

export const MarkResultSchema = z.object({
  mark: MarkSchema,
  open_trade: OpenTradeSchema.nullable(),
  journal: JournalSchema,
});

/** Undo answers the new book (`removed_mark_id`, `open_trade`, `journal`); an empty 204 also reads as success. */
export const MarkUndoSchema = z.union([
  z.object({ removed_mark_id: finite.int().optional(), open_trade: OpenTradeSchema.nullable(), journal: JournalSchema.optional() }),
  z.undefined(),
]);

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
