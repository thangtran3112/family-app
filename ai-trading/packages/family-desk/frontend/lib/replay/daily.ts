import { z } from "zod";
import { PracticeBlockV1Schema } from "@ai-trading/contracts/practice-block-v1";
import type { components } from "../api/openapi.js";
import { OpenTradeSchema, ReplayStampSchema, SessionStatusSchema } from "./schemas.ts";
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

export const PlanCurrentSchema = z.object({
  id: finite.int(),
  day_no: finite.int(),
  status: DayListStatusSchema,
}) satisfies z.ZodType<components["schemas"]["PlanCurrentOut"]>;

export const PlanPrepSchema = z.object({
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
  days_opened: finite.int(),
  /** Ended days the thread had before this plan: a day's number in the thread is `day_no + day_offset` (D-047). */
  day_offset: finite.int(),
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

/** Where the scanned names came from: the Desk's recording of that morning, or today's Desk set (02o-b2). */
const UniverseMembershipSchema = z.object({
  source: z.enum(["universe_days", "today"]),
  recorded_size: finite.int().nullable(),
  scanned_size: finite.int(),
  note: z.string(),
}) satisfies z.ZodType<components["schemas"]["UniverseMembershipOut"]>;

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
  /** Null for a list opened before 02o-b2. */
  membership: UniverseMembershipSchema.nullable().optional(),
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
  /** A re-scan added it: the list before the scan did not hold it. False on a list no re-scan has touched. */
  new_since_list: z.boolean(),
  /** The scan no longer matches it, and it stays because she opened or starred it. */
  held_over: z.boolean(),
}) satisfies z.ZodType<components["schemas"]["CandidateOut"]>;

/** The latest re-scan, run at the day clock `as_of` on data through `data_through` (02o-b2). Its names ARE the day list:
 *  the scan repopulated it, so this is only the label (which scan, when, what it added). */
const RescanSchema = z.object({
  seq: finite.int(),
  as_of: timestamp,
  data_through: timestamp,
  new_count: finite.int(),
  created_at: timestamp,
}) satisfies z.ZodType<components["schemas"]["RescanOut"]>;

/** A re-scan in flight or last run: the screen polls the day list while `state` is `running`, `done` of `total` symbols read. */
const RescanJobSchema = z.object({
  state: z.enum(["running", "done", "failed"]),
  as_of: timestamp,
  done: finite.int(),
  total: finite.int(),
  message: z.string().nullable(),
}) satisfies z.ZodType<components["schemas"]["RescanJobOut"]>;

export const StarSchema = z.object({ symbol: z.string(), starred_clock: timestamp }) satisfies z.ZodType<components["schemas"]["StarOut"]>;

/** A name she has opened today: a row of the day's portfolio (02o-b2). Flat unless `position` is set. */
export const DaySessionSchema = z.object({
  id: finite.int(),
  symbol: z.string(),
  status: SessionStatusSchema,
  revealed_through: timestamp,
  /** Behind the day clock: its next advance catches it up, and it cannot be marked until then. */
  behind_clock: z.boolean(),
  /** The name holds an open position: one average-cost position per name, however many fills built it. */
  has_open_trade: z.boolean(),
  /** Closed trades on this name today, and their P/L. */
  trades: finite.int(),
  realized_usd: finite,
  /** The open trade marked at the DAY CLOCK (not the name's own playhead); null when flat. */
  position: OpenTradeSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["DaySessionOut"]>;

/** The day's live P/L, SIMULATED: every name's closed trades plus every open trade marked at the one day clock. */
export const DayPnlSchema = z.object({
  realized_usd: finite,
  open_usd: finite,
  total_usd: finite,
  open_count: finite.int(),
  as_of: timestamp,
}) satisfies z.ZodType<components["schemas"]["DayPnlOut"]>;

// -- peek -----------------------------------------------------------------------------------------------------

export const PeekDailyBarSchema = z.object({ t: z.iso.date(), o: finite, h: finite, l: finite, c: finite, v: finite }) satisfies z.ZodType<
  components["schemas"]["PeekDailyBarOut"]
>;

const PeekMinuteBarSchema = z.object({ t: timestamp, o: finite, h: finite, l: finite, c: finite, v: finite }) satisfies z.ZodType<
  components["schemas"]["PeekMinuteBarOut"]
>;

export const PeekLevelsSchema = z.object({
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

/** One closed practice trade of the day, with the name it was on (D-032). */
const DayTradeLineSchema = z.object({
  no: finite.int(),
  symbol: z.string(),
  side: z.enum(["long", "short"]),
  entry_at: timestamp,
  entry_price: finite,
  exit_at: timestamp,
  exit_price: finite,
  shares: finite.int(),
  pnl_usd: finite,
  r: metric,
  stop_price: metric,
  on_signal: z.boolean(),
  exit_source: z.enum(["her", "auto"]),
}) satisfies z.ZodType<components["schemas"]["DayTradeLineOut"]>;

/** The day's SIMULATED result to the cent: a line per trade, the win and loss counts, and the thread's balance before and after. */
const DayJournalSchema = z.object({
  sessions: z.array(DayJournalSessionSchema),
  trades: finite.int(),
  pnl_usd: finite,
  wins: finite.int(),
  losses: finite.int(),
  scratches: finite.int(),
  lines: z.array(DayTradeLineSchema),
  balance_before: metric,
  balance_after: metric,
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
  median_move_pct: metric,
  picks_avg_move_pct: metric,
}) satisfies z.ZodType<components["schemas"]["SelectionOut"]>;

const ReviewSchema = z.object({
  day: z.iso.date(),
  dates_hidden: z.boolean(),
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

/** The in-screen remedy for a list built too early for its filters (D-012). */
const RelistOfferSchema = z.object({
  list_at: z.string(),
  label: z.string(),
  window_from: z.string().nullable(),
}) satisfies z.ZodType<components["schemas"]["RelistOfferOut"]>;

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
  day_pnl: DayPnlSchema,
  /** The SIMULATED balance and today's realized P/L of the thread this day books into (02r). */
  thread: ThreadBriefSchema.nullable(),
  warnings: z.array(z.string()),
  relist: RelistOfferSchema.nullable(),
  rescan: RescanSchema.nullable(),
  rescan_job: RescanJobSchema.nullable(),
  peek: PeekSchema.nullable(),
  journal: DayJournalSchema.nullable(),
  review: ReviewSchema.nullable(),
  notes: z.string().nullable(),
  rating: finite.int().nullable(),
  created_at: timestamp,
  ended_at: timestamp.nullable(),
  stamp: ReplayStampSchema,
}) satisfies z.ZodType<components["schemas"]["DayListOut"]>;

// -- the recorded universe (02o-b2) ----------------------------------------------------------------------------

const UniverseDaySchema = z.object({
  day: z.iso.date(),
  recorded: z.boolean(),
  size: finite.int().nullable(),
  symbols: z.array(z.string()),
  note: z.string(),
}) satisfies z.ZodType<components["schemas"]["UniverseDayOut"]>;

/** The `universe_days` read path: its coverage, the first day a new plan defaults to (null until 20 finished days are
 *  recorded) with the reason, and with `?day=` that morning's membership. */
export const UniverseDaysSchema = z.object({
  coverage: z.object({ first_day: z.iso.date().nullable(), last_day: z.iso.date().nullable(), days: finite.int() }),
  first_day_default: z.iso.date().nullable(),
  first_day_note: z.string(),
  day: UniverseDaySchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["UniverseDaysOut"]>;

export type UniverseDays = z.infer<typeof UniverseDaysSchema>;
export type DayListStatus = z.infer<typeof DayListStatusSchema>;
export type PracticePlan = z.infer<typeof PracticePlanSchema>;
export type OpenNext = z.infer<typeof OpenNextSchema>;
export type DayList = z.infer<typeof DayListSchema>;
export type DayPnl = z.infer<typeof DayPnlSchema>;
export type ListColumn = z.infer<typeof ListColumnSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type Rescan = NonNullable<DayList["rescan"]>;
export type RescanJob = NonNullable<DayList["rescan_job"]>;
export type Peek = z.infer<typeof PeekSchema>;
export type DayReview = NonNullable<DayList["review"]>;
export type ReviewRow = z.infer<typeof ReviewRowSchema>;
export type DayJournal = NonNullable<DayList["journal"]>;
export type DayTradeLine = DayJournal["lines"][number];
export type RelistOffer = NonNullable<DayList["relist"]>;
