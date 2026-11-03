import { z } from "zod";
import { PracticeThreadV1Schema } from "@ai-trading/contracts/practice-thread-v1";
import type { components } from "../api/openapi.js";

// Response shapes of the practice-thread endpoints: `/replay/threads`, `/replay/threads/{id}` and the thread header strip every
// Practice screen carries (ADR-0025, freestyle). `PracticeThreadV1` is the contract itself (plan and stats); the rest mirrors
// `ai_trading/api/schemas/threads.py` and is checked against the generated OpenAPI: a field the backend adds, drops or retypes
// breaks `pnpm typecheck`. A thread has no mode, no list of days and no fixed course length: it is a paper account and one clock. The
// contract and the brief still carry `mode` (the backend writes "day" until the contract migration); no screen reads it.
// Every dollar figure here is SIMULATED.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });

export const ThreadModeSchema = z.enum(["day", "swing"]);
export const ThreadStatusSchema = z.enum(["active", "closed"]);

/** The header strip of a Screen or the workspace: the balance (the ledger's, realized only). */
export const ThreadBriefSchema = z.object({
  id: finite.int(),
  mode: ThreadModeSchema,
  status: ThreadStatusSchema,
  balance: finite,
  label: z.string(),
}) satisfies z.ZodType<components["schemas"]["ThreadBriefOut"]>;

/** A thread's clock in the list: the simulated time `T`, whether it runs and at what speed, and why it stopped (the horizon). */
export const ThreadClockBriefSchema = z.object({
  clock: timestamp,
  running: z.boolean(),
  speed: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]),
  start_at: timestamp.nullable(),
  pause: z.record(z.string(), z.unknown()).nullable(),
}) satisfies z.ZodType<components["schemas"]["ThreadClockBriefOut"]>;

/** A row of the hub's "Your practice threads": the contract thread, its clock, how many positions are open, and a SIMULATED label. */
export const ThreadSummarySchema = z.object({
  thread: PracticeThreadV1Schema,
  /** Null while the thread has no setup yet (no start instant, so no time). */
  clock: ThreadClockBriefSchema.nullable(),
  positions_open: finite.int(),
  /** UTC wall-clock moment of the last trade or clock move; never a replayed date. Null while the thread is fresh. */
  last_activity_at: timestamp.nullable(),
  label: z.string(),
}) satisfies z.ZodType<components["schemas"]["ThreadSummaryOut"]>;

/** One ET calendar date of the thread's trades (a label and a grouping key only): the day's realized P/L and the balance after it. */
export const ThreadDateSchema = z.object({
  n: finite.int(),
  day: z.iso.date(),
  weekday: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
  trades: finite.int(),
  pnl_usd: finite,
  balance: finite,
}) satisfies z.ZodType<components["schemas"]["ThreadDateOut"]>;

/** `n` 0 is the starting balance (no date), then one point per ET date with a realized trade. */
export const CurvePointSchema = z.object({ n: finite.int(), day: z.iso.date().nullable(), balance: finite }) satisfies z.ZodType<components["schemas"]["CurvePointOut"]>;

export const ThreadSchema = ThreadSummarySchema.extend({
  /** One row per ET date with a realized trade, oldest first. */
  daily: z.array(ThreadDateSchema),
  curve: z.array(CurvePointSchema),
}) satisfies z.ZodType<components["schemas"]["ThreadOut"]>;

export const ThreadsSchema = z.array(ThreadSummarySchema);

/** The thread slots, shared by every user: at most `day_max` active threads at once (ADR-0025; the key names stay until the contract migration). */
export const ThreadCapacitySchema = z.object({
  day_active: finite.int(),
  day_max: finite.int(),
}) satisfies z.ZodType<components["schemas"]["ThreadCapacityOut"]>;

export type ThreadBrief = z.infer<typeof ThreadBriefSchema>;
export type ThreadClockBrief = z.infer<typeof ThreadClockBriefSchema>;
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type ThreadCapacity = z.infer<typeof ThreadCapacitySchema>;
export type ThreadDate = z.infer<typeof ThreadDateSchema>;
export type CurvePoint = z.infer<typeof CurvePointSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type PracticeThread = ThreadSummary["thread"];
export type ThreadPlan = PracticeThread["plan"];
