import { z } from "zod";
import { PracticeBlockV1Schema } from "@ai-trading/contracts/practice-block-v1";
import type { components } from "../api/openapi.js";
import { ReplayStampSchema, SessionStatusSchema } from "./schemas.ts";
import { ThreadBriefSchema, ThreadSummarySchema } from "./threads.ts";

// Response shapes of the daily-list practice endpoints (02o-b v1), checked against the generated OpenAPI the way
// lib/replay/schemas.ts does: a field the backend adds, drops or retypes breaks `pnpm typecheck` here.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const metric = finite.nullable();

export const DayListStatusSchema = z.enum(["listed", "practicing", "ended"]);
export const WeekdaySchema = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const StarKindSchema = z.enum(["traded", "starred"]);

// -- the plan and the hub card ----------------------------------------------------------------------------

const PlanFilterSchema = z.object({ id: finite.int(), name: z.string() }) satisfies z.ZodType<components["schemas"]["PlanFilterOut"]>;

const PlanCurrentSchema = z.object({
  id: finite.int(),
  day_no: finite.int(),
  status: DayListStatusSchema,
}) satisfies z.ZodType<components["schemas"]["PlanCurrentOut"]>;

const PlanPrepSchema = z.object({
  state: z.enum(["running", "done"]),
  done: finite.int(),
  total: finite.int(),
  failed: finite.int(),
}) satisfies z.ZodType<components["schemas"]["PlanPrepOut"]>;

export const PracticePlanSchema = z.object({
  id: finite.int(),
  /** The practice thread this plan's days book into (02r). */
  thread_id: finite.int().nullable(),
  spec: PracticeBlockV1Schema,
  sessions: finite.int(),
  /** The most names she can star and practise in a day (the plan's `maxSymbols`, else 5). */
  max_symbols: finite.int(),
  days_opened: finite.int(),
  filters: z.array(PlanFilterSchema),
  current: PlanCurrentSchema.nullable(),
  next_day: z.iso.date().nullable(),
  next_weekday: WeekdaySchema.nullable(),
  next_day_no: finite.int().nullable(),
  finished: z.boolean(),
  prep: PlanPrepSchema,
}) satisfies z.ZodType<components["schemas"]["PracticePlanOut"]>;

/** The hub card: her plan and cursor, and her active day thread with its SIMULATED balance and stats (02r). */
export const DailySchema = z.object({ plan: PracticePlanSchema.nullable(), thread: ThreadSummarySchema.nullable() }) satisfies z.ZodType<components["schemas"]["DailyOut"]>;

export const OpenNextSchema = z.object({
  plan: PracticePlanSchema,
  day_list_id: finite.int().nullable(),
}) satisfies z.ZodType<components["schemas"]["OpenNextOut"]>;

// -- the day list -------------------------------------------------------------------------------------------

const DayFilterSchema = z.object({ id: finite.int(), version_id: finite.int(), name: z.string() }) satisfies z.ZodType<
  components["schemas"]["DayFilterOut"]
>;

const DayScreenSchema = z.object({
  filters: z.array(DayFilterSchema),
  list_at: z.string(),
  max_list: finite.int(),
}) satisfies z.ZodType<components["schemas"]["DayScreenOut"]>;

const ListFilterCountsSchema = z.object({
  id: finite.int(),
  version_id: finite.int(),
  name: z.string(),
  scanned: finite.int(),
  no_data: finite.int(),
  matches_total: finite.int(),
}) satisfies z.ZodType<components["schemas"]["ListFilterCountsOut"]>;

const ListUniverseSchema = z.object({
  source: z.literal("desk"),
  size: finite.int(),
  scanned: finite.int(),
  no_data: finite.int(),
  below_floor: finite.int(),
  matches_total: finite.int(),
  shown: finite.int(),
  prev_basis: z.boolean(),
  filters: z.array(ListFilterCountsSchema),
  label: z.string(),
  footnote: z.string(),
}) satisfies z.ZodType<components["schemas"]["ListUniverseOut"]>;

export const ListColumnSchema = z.object({ key: z.string(), label: z.string(), format: z.string() }) satisfies z.ZodType<
  components["schemas"]["ListColumnOut"]
>;

export const CandidateSchema = z.object({
  rank: finite.int(),
  symbol: z.string(),
  filters: z.array(z.string()),
  rank_value: metric,
  matched_since: timestamp,
  operands: z.record(z.string(), metric),
  list_price: finite,
  price_at: timestamp,
  prior_close: metric,
  reported_before_open: z.boolean(),
  metrics: z.record(z.string(), metric),
}) satisfies z.ZodType<components["schemas"]["CandidateOut"]>;

const StarSchema = z.object({ symbol: z.string(), starred_clock: timestamp }) satisfies z.ZodType<components["schemas"]["StarOut"]>;

/** A name she has practised today: the day strip's row (02o-b2). */
const DaySessionSchema = z.object({
  id: finite.int(),
  symbol: z.string(),
  status: SessionStatusSchema,
  revealed_through: timestamp,
  /** Behind the day clock: its next advance catches it up, and it cannot be marked until then. */
  behind_clock: z.boolean(),
  /** The day holds one open trade at a time: close it before moving to another name. */
  has_open_trade: z.boolean(),
}) satisfies z.ZodType<components["schemas"]["DaySessionOut"]>;

// -- peek -----------------------------------------------------------------------------------------------------

const PeekDailyBarSchema = z.object({ t: z.iso.date(), o: finite, h: finite, l: finite, c: finite, v: finite }) satisfies z.ZodType<
  components["schemas"]["PeekDailyBarOut"]
>;

const PeekMinuteBarSchema = z.object({ t: timestamp, o: finite, h: finite, l: finite, c: finite, v: finite }) satisfies z.ZodType<
  components["schemas"]["PeekMinuteBarOut"]
>;

const PeekLevelsSchema = z.object({
  prior_high: metric.optional(),
  prior_low: metric.optional(),
  prior_close: metric.optional(),
  premarket_high: metric.optional(),
  premarket_low: metric.optional(),
}) satisfies z.ZodType<components["schemas"]["PeekLevelsOut"]>;

export const PeekSchema = z.object({
  symbol: z.string(),
  data_through: timestamp,
  list_price: metric.optional(),
  daily: z.array(PeekDailyBarSchema),
  minutes: z.array(PeekMinuteBarSchema),
  levels: PeekLevelsSchema,
}) satisfies z.ZodType<components["schemas"]["PeekOut"]>;

// -- after the day -------------------------------------------------------------------------------------------

const DayJournalSessionSchema = z.object({
  id: finite.int(),
  symbol: z.string(),
  trades: finite.int(),
  pnl_usd: finite,
  adherence_pct: finite.int().nullable(),
}) satisfies z.ZodType<components["schemas"]["DayJournalSessionOut"]>;

const DayJournalSchema = z.object({
  sessions: z.array(DayJournalSessionSchema),
  trades: finite.int(),
  pnl_usd: finite,
}) satisfies z.ZodType<components["schemas"]["DayJournalOut"]>;

export const ReviewRowSchema = z.object({
  symbol: z.string(),
  list_price: finite,
  window_end_price: metric,
  move_pct: metric,
  close_price: metric,
  close_move_pct: metric,
  high_pct: metric,
  low_pct: metric,
  range_pct: metric,
  rank: finite.int().nullable(),
  picked: StarKindSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["ReviewRowOut"]>;

const SelectionSchema = z.object({
  picks: z.array(z.object({ symbol: z.string(), kind: StarKindSchema, move_pct: finite, rank: finite.int() })),
  median_abs_move_pct: metric,
  picks_avg_abs_move_pct: metric,
}) satisfies z.ZodType<components["schemas"]["SelectionOut"]>;

const ReviewSchema = z.object({
  window_end: timestamp,
  of: finite.int(),
  rows: z.array(ReviewRowSchema),
  selection: SelectionSchema,
}) satisfies z.ZodType<components["schemas"]["ReviewOut"]>;

/** "Traded only names on your watch": data for the screen to render; nothing scores it. */
const WatchCheckSchema = z.object({
  starred: z.array(z.string()),
  traded: z.array(z.string()),
  off_watch: z.array(z.string()),
  verdict: z.enum(["no_trades", "on_watch", "off_watch"]),
  label: z.string(),
});

export const DayListSchema = z.object({
  id: finite.int(),
  plan: PracticePlanSchema,
  day: z.iso.date(),
  weekday: WeekdaySchema,
  day_no: finite.int(),
  of: finite.int(),
  status: DayListStatusSchema,
  list_at: timestamp,
  data_through: timestamp,
  screen: DayScreenSchema,
  universe: ListUniverseSchema,
  columns: z.array(ListColumnSchema),
  candidates: z.array(CandidateSchema),
  watch: z.array(StarSchema),
  watch_check: WatchCheckSchema,
  clock: timestamp.nullable(),
  sessions: z.array(DaySessionSchema),
  /** The SIMULATED balance and today's realized P/L of the thread this day books into (02r). */
  thread: ThreadBriefSchema.nullable(),
  warnings: z.array(z.string()),
  peek: PeekSchema.nullable(),
  journal: DayJournalSchema.nullable(),
  review: ReviewSchema.nullable(),
  notes: z.string().nullable(),
  rating: finite.int().nullable(),
  created_at: timestamp,
  ended_at: timestamp.nullable(),
  stamp: ReplayStampSchema,
}) satisfies z.ZodType<components["schemas"]["DayListOut"]>;

export type DayListStatus = z.infer<typeof DayListStatusSchema>;
export type PracticePlan = z.infer<typeof PracticePlanSchema>;
export type OpenNext = z.infer<typeof OpenNextSchema>;
export type DayList = z.infer<typeof DayListSchema>;
export type ListColumn = z.infer<typeof ListColumnSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type Peek = z.infer<typeof PeekSchema>;
export type DayReview = NonNullable<DayList["review"]>;
export type ReviewRow = z.infer<typeof ReviewRowSchema>;
export type DayJournal = NonNullable<DayList["journal"]>;
