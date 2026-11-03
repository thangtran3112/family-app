import { z } from "zod";
import { PracticeBlockV1Schema } from "@ai-trading/contracts/practice-block-v1";
import { PracticeSetupV2Schema } from "@ai-trading/contracts/practice-setup-v2";
import type { components } from "../api/openapi.js";
import { MarketSchema, OpenTradeSchema, ReplayStampSchema, SessionStatusSchema } from "./schemas.ts";
import { ThreadBriefSchema } from "./threads.ts";

// Response shapes of the Screen endpoints (ADR-0025): `GET/PATCH /replay/threads/{id}/screen`, its re-scan, and the recorded universe.
// The Screen is the latest scan of her saved filters evaluated at the thread's time `T`, plus her stars, the names she holds and the lanes
// she opened. Checked against the generated OpenAPI the way lib/replay/schemas.ts does: a field the backend adds, drops or retypes breaks
// `pnpm typecheck` here. The Screen has no day number, no list time and no review: it is read at `T`, and a scan runs at `T`.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const metric = finite.nullable();

export const WeekdaySchema = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri"]);

// -- the plan -----------------------------------------------------------------------------------------------

const PlanFilterSchema = z.object({ id: finite.int(), name: z.string() }) satisfies z.ZodType<components["schemas"]["PlanFilterOut"]>;

/** The thread's saved setup: a `PracticeSetupV2`, or the block a thread had before the freestyle migration (read-only history). */
export const PracticePlanSchema = z.object({
  id: finite.int(),
  /** The practice thread this plan belongs to. */
  thread_id: finite.int().nullable(),
  spec: z.union([PracticeSetupV2Schema, PracticeBlockV1Schema]),
  filters: z.array(PlanFilterSchema),
}) satisfies z.ZodType<components["schemas"]["PracticePlanOut"]>;

// -- the Screen ---------------------------------------------------------------------------------------------

const DayFilterSchema = z.object({ id: finite.int(), version_id: finite.int(), name: z.string() }) satisfies z.ZodType<
  components["schemas"]["DayFilterOut"]
>;

const ScreenFiltersSchema = z.object({
  filters: z.array(DayFilterSchema),
  max_list: finite.int(),
}) satisfies z.ZodType<components["schemas"]["ScreenFiltersOut"]>;

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

/** A listed name as of the thread clock (read with `live`): the price, the move from the prior close and the metric block, from bars closed by the clock. */
export const CandidateLiveSchema = z.object({
  at: timestamp,
  price: metric,
  change_pct: metric,
  /** False while no regular-session bar has closed: `metrics` is then the previous session's, not today's. */
  today: z.boolean(),
  metrics: z.record(z.string(), metric),
}) satisfies z.ZodType<components["schemas"]["CandidateLiveOut"]>;

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
  /** The previous session's own RVOL and change %, before or after the open (D-018). */
  prev_rvol: metric,
  prev_change_pct: metric,
  /** `reported` before the open, `none` when the name's report history was read and holds none, null when it was not checked (D-018). */
  earnings_state: z.enum(["reported", "none"]).nullable(),
  metrics: z.record(z.string(), metric),
  /** A re-scan added it: the Screen before the scan did not hold it. False on a Screen no re-scan has touched. */
  new_since_list: z.boolean(),
  /** The scan no longer matches it, and it stays because she opened or starred it. */
  held_over: z.boolean(),
  /** The name at the thread clock `T`: only on a read with `live`. */
  live: CandidateLiveSchema.nullish(),
}) satisfies z.ZodType<components["schemas"]["CandidateOut"]>;

/** The latest re-scan, run at the thread clock `as_of` on data through `data_through` (02o-b2). Its names ARE the Screen:
 *  the scan repopulated it, so this is only the label (which scan, when, what it added). */
const RescanSchema = z.object({
  seq: finite.int(),
  as_of: timestamp,
  data_through: timestamp,
  new_count: finite.int(),
  created_at: timestamp,
}) satisfies z.ZodType<components["schemas"]["RescanOut"]>;

/** A re-scan in flight or last run: the screen polls itself while `state` is `running`, `done` of `total` symbols read. */
const RescanJobSchema = z.object({
  state: z.enum(["running", "done", "failed"]),
  as_of: timestamp,
  done: finite.int(),
  total: finite.int(),
  message: z.string().nullable(),
}) satisfies z.ZodType<components["schemas"]["RescanJobOut"]>;

export const StarSchema = z.object({ symbol: z.string(), starred_clock: timestamp }) satisfies z.ZodType<components["schemas"]["StarOut"]>;

/** A name she has opened: her lane, one book per name for the thread's life (ADR-0025). Flat unless `position` is set. */
export const LaneBriefSchema = z.object({
  id: finite.int(),
  symbol: z.string(),
  status: SessionStatusSchema,
  revealed_through: timestamp,
  /** Behind the thread clock: its next advance catches it up, and it cannot be marked until then. */
  behind_clock: z.boolean(),
  /** The name holds an open position: one average-cost position per name, however many fills built it. */
  has_open_trade: z.boolean(),
  /** Closed trades on this name, and their P/L. */
  trades: finite.int(),
  realized_usd: finite,
  /** The open trade marked at the THREAD CLOCK (not the name's own playhead); null when flat. */
  position: OpenTradeSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["LaneBriefOut"]>;

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

/** "Traded only names on your watch": data for the screen to render; nothing scores it. */
const WatchCheckSchema = z.object({
  starred: z.array(z.string()),
  traded: z.array(z.string()),
  off_watch: z.array(z.string()),
  verdict: z.enum(["no_trades", "on_watch", "off_watch"]),
  label: z.string(),
});

export const ScreenSchema = z.object({
  id: finite.int(),
  thread_id: finite.int(),
  plan: PracticePlanSchema,
  /** The ET calendar date of `T`: a label only. */
  day: z.iso.date(),
  weekday: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  data_through: timestamp,
  /** The scan's time: the thread clock when the Screen was last built. */
  as_of: timestamp,
  screen: ScreenFiltersSchema,
  universe: ListUniverseSchema,
  columns: z.array(ListColumnSchema),
  candidates: z.array(CandidateSchema),
  watch: z.array(StarSchema),
  watch_check: WatchCheckSchema,
  /** The thread clock `T` of this read. */
  clock: timestamp,
  market: MarketSchema.nullish(),
  /** The names she opened, with each one's position marked at `T`. */
  lanes: z.array(LaneBriefSchema),
  /** The SIMULATED balance of the thread this Screen belongs to. */
  thread: ThreadBriefSchema.nullable(),
  warnings: z.array(z.string()),
  rescan: RescanSchema.nullable(),
  rescan_job: RescanJobSchema.nullable(),
  peek: PeekSchema.nullable(),
  notes: z.string().nullable(),
  rating: finite.int().nullable(),
  created_at: timestamp,
  stamp: ReplayStampSchema,
}) satisfies z.ZodType<components["schemas"]["ScreenOut"]>;

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
export type PracticePlan = z.infer<typeof PracticePlanSchema>;
export type Screen = z.infer<typeof ScreenSchema>;
export type Lane = z.infer<typeof LaneBriefSchema>;
export type ListColumn = z.infer<typeof ListColumnSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type Rescan = NonNullable<Screen["rescan"]>;
export type RescanJob = NonNullable<Screen["rescan_job"]>;
export type Peek = z.infer<typeof PeekSchema>;
