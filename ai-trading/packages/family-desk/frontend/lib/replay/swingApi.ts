import { z } from "zod";
import type { components } from "../api/openapi.js";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "../desk/api.ts";
import {
  DayListSchema,
  DaySessionSchema,
  ListColumnSchema,
  PeekDailyBarSchema,
  PeekLevelsSchema,
  PlanCurrentSchema,
  PlanPrepSchema,
  StarSchema,
  WeekdaySchema,
  type DayList,
} from "./daily.ts";
import { EarningsChipSchema, HoldSchema, ReplayStampSchema } from "./schemas.ts";
import { ThreadBriefSchema } from "./threads.ts";

// Response shapes and loaders of the swing-practice endpoints (02p f1, f2): the universe preview, the swing board
// (`SwingDayListOut`, told apart from `DayListOut` by `kind: "swing"`), the continue call, the holds, and the weekly
// review. Checked against the generated OpenAPI with `satisfies` like lib/replay/daily.ts, so a field the backend adds,
// drops or retypes breaks `pnpm typecheck` here. The session-side shapes (holds, strip, pause, daily block) live in
// schemas.ts next to the advance and mark answers that carry them. A swing payload names days by number and weekday; the
// only dates are the day list's own `day` and the preview's `basis_day`. Every dollar figure is SIMULATED.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });

export const SwingSourceSchema = z.enum(["watchlist", "manual", "filter", "liquidity"]);
export type SwingSource = z.infer<typeof SwingSourceSchema>;

// -- the universe preview (setup, no write) -------------------------------------------------------------------

export const UniverseRowSchema = z.object({
  symbol: z.string(),
  source: SwingSourceSchema,
  prior_close: finite,
  chg_20d_pct: finite.nullable(),
  avg_dollar_volume_20d: finite,
  atr_pct_14: finite.nullable(),
  /** Names of her daily filters that matched this symbol at the close before Day 1. */
  matched: z.array(z.string()),
  /** Plain words, for example "below floor" (allowed for her own picks only). */
  warnings: z.array(z.string()),
}) satisfies z.ZodType<components["schemas"]["UniverseRowOut"]>;

/** Left out of the table with one neutral reason that names no date. */
export const UniverseExcludedSchema = z.object({ symbol: z.string(), reason: z.string() }) satisfies z.ZodType<
  components["schemas"]["UniverseExcludedOut"]
>;

export const UniverseCountsSchema = z.object({
  watchlist: finite.int(),
  manual: finite.int(),
  filter: finite.int(),
  liquidity: finite.int(),
  total: finite.int(),
}) satisfies z.ZodType<components["schemas"]["UniverseCountsOut"]>;

export const UniversePrepSchema = z.object({ done: finite.int(), total: finite.int() }) satisfies z.ZodType<components["schemas"]["UniversePrepOut"]>;

/** The table she edits: every figure is as of `basis_day` (the close before Day 1). `label` is the survivorship text. */
export const UniversePreviewSchema = z.object({
  basis_day: z.iso.date(),
  state: z.enum(["ready", "preparing"]),
  prep: UniversePrepSchema,
  rows: z.array(UniverseRowSchema),
  excluded: z.array(UniverseExcludedSchema),
  counts: UniverseCountsSchema,
  survivorship: z.string(),
  label: z.string(),
  pending_symbols: finite.int(),
}) satisfies z.ZodType<components["schemas"]["SwingUniversePreviewOut"]>;

/** What the setup form posts (snake_case on the wire). `fill` and `target` default on the server. */
export type SwingPreviewRequest = Omit<components["schemas"]["SwingUniversePreviewIn"], "fill" | "target"> & {
  fill?: components["schemas"]["SwingUniversePreviewIn"]["fill"];
  target?: number;
};

// -- the plan cursor and the continue call ------------------------------------------------------------------------

/** A swing thread's calendar cursor and prep: `next_day_no` and `next_weekday`, never a date. */
export const SwingPlanSchema = z.object({
  id: finite.int(),
  thread_id: finite.int().nullable(),
  mode: z.literal("swing"),
  sessions: finite.int(),
  days_opened: finite.int(),
  current: PlanCurrentSchema.nullable(),
  next_day_no: finite.int().nullable(),
  next_weekday: WeekdaySchema.nullable(),
  finished: z.boolean(),
  prep: PlanPrepSchema,
}) satisfies z.ZodType<components["schemas"]["SwingPlanOut"]>;

/** `day_list_id` is null while the prep runs (read the thread again) and once every day is done. */
export const SwingOpenNextSchema = z.object({
  day_list_id: finite.int().nullable(),
  kind: z.literal("swing"),
  plan: SwingPlanSchema,
}) satisfies z.ZodType<components["schemas"]["SwingOpenNextOut"]>;

// -- the swing board ------------------------------------------------------------------------------------------

/** One name of the fixed universe as of the prior close; every metric can be missing for a symbol with a data gap. */
export const BoardRowSchema = z.object({
  symbol: z.string(),
  source: SwingSourceSchema,
  prior_close: finite.nullable(),
  chg_1d_pct: finite.nullable(),
  chg_5d_pct: finite.nullable(),
  chg_20d_pct: finite.nullable(),
  atr_pct_14: finite.nullable(),
  rsi_14: finite.nullable(),
  rvol_10d: finite.nullable(),
  pct_from_20d_high: finite.nullable(),
  vs_50d_avg_pct: finite.nullable(),
  avg_dollar_volume_20d: finite.nullable(),
  /** Names of her armed daily filters that matched at the prior close. */
  matches: z.array(z.string()),
  earnings: EarningsChipSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["BoardRowOut"]>;

export const SwingUniverseSchema = z.object({
  source: z.literal("swing"),
  size: finite.int(),
  /** Count by source tag, for example `{ watchlist: 9, manual: 2, filter: 6, liquidity: 33 }`. */
  mix: z.record(z.string(), finite),
  label: z.string(),
  footnote: z.string(),
}) satisfies z.ZodType<components["schemas"]["SwingUniverseOut"]>;

/** Peek on the board: daily bars through the prior close, never a minute of the day. */
export const SwingPeekSchema = z.object({
  symbol: z.string(),
  daily: z.array(PeekDailyBarSchema),
  levels: PeekLevelsSchema,
}) satisfies z.ZodType<components["schemas"]["SwingPeekOut"]>;

/** `at` is an ET "HH:MM"; `watched` is no for a crossing she was away for. */
export const StopHitSchema = z.object({ symbol: z.string(), at: z.string(), watched: z.enum(["yes", "no"]) }) satisfies z.ZodType<
  components["schemas"]["StopHitOut"]
>;

/** The strip of tiles an ended day serves: the equity change split into realized, overnight gap and intraday. */
export const SwingDaySummarySchema = z.object({
  passed: z.enum(["yes", "no"]),
  realized_usd: finite,
  gap_usd: finite,
  intraday_usd: finite,
  unrealized_change_usd: finite,
  equity_change_usd: finite,
  balance_usd: finite,
  equity_usd: finite,
  free_cash_usd: finite,
  holds: z.array(HoldSchema),
  stop_hits: z.array(StopHitSchema),
  late_stars: z.array(z.string()),
  entries: finite.int(),
  exits: finite.int(),
  max_open_seen: finite.int(),
}) satisfies z.ZodType<components["schemas"]["SwingDaySummaryOut"]>;

/** One swing day: the board as of the prior close, her focus names, the holds pinned above, and the day clock. */
export const SwingDayListSchema = z.object({
  kind: z.literal("swing"),
  id: finite.int(),
  plan: SwingPlanSchema,
  thread: ThreadBriefSchema.nullable(),
  day: z.iso.date(),
  weekday: WeekdaySchema,
  day_no: finite.int(),
  of: finite.int(),
  week_no: finite.int(),
  week_label: z.string(),
  status: z.enum(["listed", "practicing", "ended"]),
  clock: timestamp.nullable(),
  watch: z.array(StarSchema),
  columns: z.array(ListColumnSchema),
  candidates: z.array(BoardRowSchema),
  holds: z.array(HoldSchema),
  free_cash_usd: finite.nullable(),
  sessions: z.array(DaySessionSchema),
  universe: SwingUniverseSchema,
  /** The survivorship and hindsight label every swing screen shows. */
  label: z.string(),
  peek: SwingPeekSchema.nullable(),
  journal: SwingDaySummarySchema.nullable(),
  notes: z.string().nullable(),
  rating: finite.int().nullable(),
  created_at: timestamp,
  ended_at: timestamp.nullable(),
  stamp: ReplayStampSchema,
}) satisfies z.ZodType<components["schemas"]["SwingDayListOut"]>;

/** The day-list routes answer a day list or a swing one; `kind: "swing"` tells them apart (a day list has no `kind`). */
export const AnyDayListSchema = z.union([SwingDayListSchema, DayListSchema]) satisfies z.ZodType<
  components["schemas"]["DayListOut"] | components["schemas"]["SwingDayListOut"]
>;

// -- holds ---------------------------------------------------------------------------------------------------

/** The thread's holds. Open ones are marked at the LAST ENDED day's close, never later (`as_of_day_no`). */
export const HoldsSchema = z.object({
  thread_id: finite.int(),
  as_of_day_no: finite.int().nullable(),
  holds: z.array(HoldSchema),
  label: z.string(),
}) satisfies z.ZodType<components["schemas"]["HoldsOut"]>;

// -- weeks ---------------------------------------------------------------------------------------------------

export const WeekRowSchema = z.object({
  week_no: finite.int(),
  label: z.string(),
  days: finite.int(),
  first_day_no: finite.int(),
  last_day_no: finite.int(),
  status: z.enum(["open", "closed"]),
  realized_usd: finite.nullable(),
  equity_change_usd: finite.nullable(),
  adherence_pct: finite.nullable(),
  selection_pts: finite.nullable(),
  timing_pts: finite.nullable(),
}) satisfies z.ZodType<components["schemas"]["WeekRowOut"]>;

export const WeeksSchema = z.object({ thread_id: finite.int(), weeks: z.array(WeekRowSchema), label: z.string() }) satisfies z.ZodType<
  components["schemas"]["WeeksOut"]
>;

export const WeekMetaSchema = z.object({
  week_no: finite.int(),
  label: z.string(),
  first_day_no: finite.int(),
  last_day_no: finite.int(),
}) satisfies z.ZodType<components["schemas"]["WeekMetaOut"]>;

/** Every tile can be null: a figure that cannot be computed is never a guess. Percent figures are percent points. */
export const WeekTilesSchema = z.object({
  realized_usd: finite.nullable(),
  unrealized_change_usd: finite.nullable(),
  equity_change_usd: finite.nullable(),
  balance_usd: finite.nullable(),
  /** 0..1. */
  win_rate: finite.nullable(),
  avg_win_usd: finite.nullable(),
  avg_loss_usd: finite.nullable(),
  avg_days_held: finite.nullable(),
  gap_usd: finite.nullable(),
  gap_share_pct: finite.nullable(),
  adherence_pct: finite.nullable(),
  selection_pts: finite.nullable(),
  timing_pts: finite.nullable(),
  spy_return_pct: finite.nullable(),
  universe_median_return_pct: finite.nullable(),
  universe_mean_return_pct: finite.nullable(),
}) satisfies z.ZodType<components["schemas"]["WeekTilesOut"]>;

export const WeekEquityPointSchema = z.object({ day_no: finite.int(), balance_usd: finite, equity_usd: finite }) satisfies z.ZodType<
  components["schemas"]["WeekEquityPointOut"]
>;

export const WeekDaySchema = z.object({
  day_no: finite.int(),
  weekday: WeekdaySchema,
  watched: z.enum(["yes", "no"]),
  entries: finite.int(),
  exits: finite.int(),
  realized_usd: finite,
  gap_usd: finite,
  intraday_usd: finite,
  adherence_pct: finite.nullable(),
}) satisfies z.ZodType<components["schemas"]["WeekDayOut"]>;

export const WeekStopSchema = z.enum(["none", "set", "honored", "away"]);

export const WeekHoldSchema = z.object({
  hold_id: finite.int(),
  symbol: z.string(),
  side: z.enum(["long", "short"]),
  shares: finite.int(),
  entry_day_no: finite.int(),
  entry_price: finite,
  status: z.enum(["open", "closed"]),
  exit_day_no: finite.int().nullable(),
  exit_price: finite.nullable(),
  days_held: finite.int(),
  pnl_usd: finite,
  r: finite.nullable(),
  gap_usd: finite.nullable(),
  stop: WeekStopSchema,
  selection_rank: finite.int().nullable(),
  selection_of: finite.int().nullable(),
  selection_edge_pts: finite.nullable(),
  timing_edge_pts: finite.nullable(),
}) satisfies z.ZodType<components["schemas"]["WeekHoldOut"]>;

export const WeekHeatSchema = z.object({
  symbol: z.string(),
  source: SwingSourceSchema.nullable(),
  return_pct: finite,
  held: z.enum(["yes", "no"]),
  focus: z.enum(["yes", "no"]),
}) satisfies z.ZodType<components["schemas"]["WeekHeatOut"]>;

export const WeekCheckIdSchema = z.enum([
  "stop_set",
  "stop_honored",
  "risk_per_hold",
  "open_holds_within_plan",
  "week_loss_limit",
  "entries_per_week",
  "on_signal",
  "focus_before_open",
]);

export const WeekCheckSchema = z.object({
  id: WeekCheckIdSchema,
  label: z.string(),
  applicable: z.boolean(),
  passed: z.boolean(),
  detail: z.string(),
}) satisfies z.ZodType<components["schemas"]["WeekCheckOut"]>;

export const WeekAdherenceSchema = z.object({ score_pct: finite.nullable(), checks: z.array(WeekCheckSchema) }) satisfies z.ZodType<
  components["schemas"]["WeekAdherenceOut"]
>;

/** Names her filters flagged on the week's boards, against the universe median. */
export const FilterQualitySchema = z.object({
  n: finite.int(),
  median_return_pct: finite,
  universe_median_pct: finite,
  edge_pts: finite,
}) satisfies z.ZodType<components["schemas"]["FilterQualityOut"]>;

export const SourceQualitySchema = z.object({ source: z.string(), median_return_pct: finite, n: finite.int() }) satisfies z.ZodType<
  components["schemas"]["SourceQualityOut"]
>;

/** A starred name she never held: where it ranked from the star day on (informational). */
export const FocusUntradedSchema = z.object({ symbol: z.string(), rank: finite.int(), of: finite.int(), return_pct: finite }) satisfies z.ZodType<
  components["schemas"]["FocusUntradedOut"]
>;

export const WeekReviewSchema = z.object({
  week: WeekMetaSchema,
  tiles: WeekTilesSchema,
  equity: z.array(WeekEquityPointSchema),
  days: z.array(WeekDaySchema),
  holds: z.array(WeekHoldSchema),
  heat: z.array(WeekHeatSchema),
  adherence: WeekAdherenceSchema,
  filter_quality: FilterQualitySchema.nullable(),
  source_quality: z.array(SourceQualitySchema),
  focus_untraded: z.array(FocusUntradedSchema),
  /** The sentences under the tiles, for example "Selection +1.8 pts vs the universe median · ...". Empty with nothing to score. */
  copy: z.array(z.string()),
}) satisfies z.ZodType<components["schemas"]["WeekReviewOut"]>;

/** A frozen review, or "Week to date" (`to_date` yes) for the open week through the last ended close. */
export const WeekSchema = z.object({
  week_no: finite.int(),
  label: z.string(),
  status: z.enum(["open", "closed"]),
  to_date: z.enum(["yes", "no"]),
  review: WeekReviewSchema,
  notes: z.string().nullable(),
  rating: finite.int().nullable(),
  universe_label: z.string(),
  footnote: z.string(),
}) satisfies z.ZodType<components["schemas"]["WeekOut"]>;

export type UniverseRow = z.infer<typeof UniverseRowSchema>;
export type UniverseExcluded = z.infer<typeof UniverseExcludedSchema>;
export type UniverseCounts = z.infer<typeof UniverseCountsSchema>;
export type UniversePreview = z.infer<typeof UniversePreviewSchema>;
export type SwingPlan = z.infer<typeof SwingPlanSchema>;
export type SwingOpenNext = z.infer<typeof SwingOpenNextSchema>;
export type BoardRow = z.infer<typeof BoardRowSchema>;
export type SwingPeek = z.infer<typeof SwingPeekSchema>;
export type StopHit = z.infer<typeof StopHitSchema>;
export type SwingDaySummary = z.infer<typeof SwingDaySummarySchema>;
export type SwingDayList = z.infer<typeof SwingDayListSchema>;
/** What the day-list routes answer: narrow with `isSwingDayList`. */
export type AnyDayList = SwingDayList | DayList;
export type HoldsOut = z.infer<typeof HoldsSchema>;
export type WeekRow = z.infer<typeof WeekRowSchema>;
export type WeekReview = z.infer<typeof WeekReviewSchema>;
export type WeekTiles = z.infer<typeof WeekTilesSchema>;
export type WeekDay = z.infer<typeof WeekDaySchema>;
export type WeekHold = z.infer<typeof WeekHoldSchema>;
export type WeekHeat = z.infer<typeof WeekHeatSchema>;
export type WeekCheck = z.infer<typeof WeekCheckSchema>;
export type WeekStop = z.infer<typeof WeekStopSchema>;
export type WeekOut = z.infer<typeof WeekSchema>;

/** True for a swing board. A day list has no `kind` key at all. */
export const isSwingDayList = (list: AnyDayList): list is SwingDayList => "kind" in list && list.kind === "swing";

// -- loaders (one function per route; every request goes through /api/desk/replay) ----------------------------------

/** Preview only, nothing is written. The first call starts the pool prep in the background; poll while `state` is `preparing`. */
export const previewSwingUniverse = (body: SwingPreviewRequest, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/threads/swing-universe"), UniversePreviewSchema, jsonInit("POST", body, options));

/** Continues a swing thread's calendar: opens the next day, or answers `day_list_id: null` while the prep runs. */
export const continueSwingThread = (threadId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/daily/next"), SwingOpenNextSchema, jsonInit("POST", { threadId }, options));

/** One day, swing or not. `peek` adds the daily chart of one name on the board (cut at the prior close). */
export const loadAnyDayList = (id: number, params: { peek?: string } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}`, { peek: params.peek }), AnyDayListSchema, readInit(options));

/** Stars (at most five), notes and the 1 to 5 self-rating; a key left out is left alone. */
export const patchAnyDayList = (id: number, body: { watch?: string[]; notes?: string | null; rating?: number | null }, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}`), AnyDayListSchema, jsonInit("PATCH", body, options));

/** Ends the day (End day, or Pass on a day with no session). Open holds are never exited; idempotent. */
export const endAnyDay = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}/end`), AnyDayListSchema, jsonInit("POST", {}, options));

export type HoldsStatus = "open" | "closed" | "all";

/** The thread's holds; open ones are marked at the last ended day's close. */
export const loadHolds = (threadId: number, status: HoldsStatus = "all", options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/holds`, { status }), HoldsSchema, readInit(options));

export const loadWeeks = (threadId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/weeks`), WeeksSchema, readInit(options));

/** A frozen review, or "Week to date" for the open week. A week with no finished day yet is a 404. */
export const loadWeek = (threadId: number, weekNo: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/weeks/${weekNo}`), WeekSchema, readInit(options));

/** Notes (up to 2,000 characters) and the 1 to 5 self-rating; a key left out is left alone, `null` clears it. */
export const patchWeek = (threadId: number, weekNo: number, body: { notes?: string | null; rating?: number | null }, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/weeks/${weekNo}`), WeekSchema, jsonInit("PATCH", body, options));
