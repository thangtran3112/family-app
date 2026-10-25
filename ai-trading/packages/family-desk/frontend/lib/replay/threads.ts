import { z } from "zod";
import { PracticeThreadV1Schema } from "@ai-trading/contracts/practice-thread-v1";

// Response shapes of the practice-thread endpoints (02r): `/replay/threads`, `/replay/threads/{id}` and the thread
// header strip every day screen and the workspace carry. `PracticeThreadV1` is the contract itself (plan and stats);
// the rest mirrors `ai_trading/api/schemas/threads.py`. The generated OpenAPI of this tree predates the routes, so these
// are not yet checked with `satisfies z.ZodType<components[…]>` the way lib/replay/daily.ts is; add the checks when
// `pnpm gen:api` carries them. Every dollar figure here is SIMULATED.

const finite = z.number().finite();
const weekday = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri"]);

export const ThreadModeSchema = z.enum(["day", "swing"]);
export const ThreadStatusSchema = z.enum(["active", "closed"]);

/** The header strip of a day screen or the workspace: the balance and today's realized P/L (null with no day under way). */
export const ThreadBriefSchema = z.object({
  id: finite.int(),
  mode: ThreadModeSchema,
  status: ThreadStatusSchema,
  balance: finite,
  today_pnl_usd: finite.nullable(),
  label: z.string(),
});

export const ThreadTodaySchema = z.object({
  day_list_id: finite.int(),
  day: z.iso.date(),
  weekday,
  day_no: finite.int(),
  status: z.enum(["listed", "practicing"]),
  trades: finite.int(),
  pnl_usd: finite,
});

/** A row of the hub's "Your practice threads": the contract thread, today's open day, and a SIMULATED label. */
export const ThreadSummarySchema = z.object({
  thread: PracticeThreadV1Schema,
  today: ThreadTodaySchema.nullable(),
  label: z.string(),
});

/** One ended practice day: `skipped` ended with no session, so the balance carried. `balance` is at the day's end. */
export const ThreadDaySchema = z.object({
  n: finite.int(),
  day_list_id: finite.int(),
  day: z.iso.date(),
  weekday,
  kind: z.enum(["practiced", "skipped"]),
  trades: finite.int(),
  pnl_usd: finite,
  adherence_pct: finite.int().nullable(),
  balance: finite,
});

/** `n` 0 is the starting balance (no day), then one point per ended day. */
export const CurvePointSchema = z.object({ n: finite.int(), day: z.iso.date().nullable(), balance: finite });

export const ThreadSchema = ThreadSummarySchema.extend({
  daily: z.array(ThreadDaySchema),
  curve: z.array(CurvePointSchema),
});

export const ThreadsSchema = z.array(ThreadSummarySchema);

export type ThreadBrief = z.infer<typeof ThreadBriefSchema>;
export type ThreadToday = z.infer<typeof ThreadTodaySchema>;
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type ThreadDay = z.infer<typeof ThreadDaySchema>;
export type CurvePoint = z.infer<typeof CurvePointSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type PracticeThread = ThreadSummary["thread"];
export type ThreadPlan = PracticeThread["plan"];
