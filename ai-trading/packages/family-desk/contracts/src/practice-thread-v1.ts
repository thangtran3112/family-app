import { z } from "zod";
import { SchemaVersionSchema, UtcTimestampSchema } from "./strategy-common.ts";

// PracticeThreadV1 and its ledger entry (02r): a practice thread is the paper account she practises
// in across days. `PracticeThreadCreateV1` and `PracticeThreadPatchV1` are what she authors;
// `PracticeThreadV1` is what the server reads back (the thread, its risk plan, and the stats derived
// from the ledger); `PracticeLedgerEntryV1` is one realized practice trade. Money is SIMULATED.
// Nothing is a boolean or null (yes/no enums; an absent key means "no value"), every object is
// strict, and no field names an order, account or broker, as in the other 02k-family contracts.
// State rules (no plan edit once closed, the daily plan binding to an
// active thread) are server rules, not contract rules.

export const DEFAULT_STARTING_BALANCE = 50_000;

const YesNoSchema = z.enum(["yes", "no"]);
const ThreadModeSchema = z.enum(["day", "swing"]);
const StartingBalanceSchema = z.int().min(1000).max(10_000_000);
const IsoDaySchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/);
const StockTickerSchema = z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/);
const IdSchema = z.int().min(1);
const PriceSchema = z.number().positive().max(1_000_000);
// A derived dollar figure: signed, bounded so a bad row cannot overflow the curve.
const UsdSchema = z.number().min(-1_000_000_000).max(1_000_000_000);
const PercentSchema = z.int().min(0).max(100);
const CountSchema = z.int().min(0).max(1_000_000);
const plainText = (min: number, max: number) =>
  z.string().min(min).max(max).regex(/^[ -~ -퟿-￿]+$/);

// The risk plan lives on the thread (D-007), not on the daily-list setup. It is the PracticePlanV1
// of 02o-b under the thread's own names. Nested objects carry ids so the generated Pydantic classes
// keep their own names.
const PracticeThreadPlanSchema = z
  .strictObject({
    stopNoteOnEntry: YesNoSchema,
    tradeOnlyOnSignal: YesNoSchema,
    maxLossUsd: z.int().min(1).max(100_000).optional(),
    maxTrades: z.int().min(1).max(50).optional(),
    planNote: plainText(1, 500).optional(),
  })
  .meta({ id: "PracticeThreadPlanV1" });

// Same bounds as ReplaySessionV1.armed, with PracticeBlockV1's item id so the generated class is shared.
const ArmedRefsSchema = z
  .array(
    z
      .strictObject({ source: z.enum(["alert_strategy", "filter"]), id: IdSchema })
      .meta({ id: "PracticeArmedV1" }),
  )
  .max(5);

export const SWING_SETUP_RULES = [
  { id: "universe-symbols-unique", description: "universe symbols must be unique" },
] as const;

// The swing calendar and universe (02p): what a swing thread is created with and what it reads back.
// `firstDay` (a session from 2017-01-03), the universe coverage and the daily-cadence arms are server
// rules; the form defaults (20 sessions, hidden dates, 15m, tape off, 3 holds) are the form's, not the
// contract's. The universe is frozen at creation; in a swing thread the plan's `maxLossUsd` and
// `maxTrades` count per week.
export const SwingSetupV1Schema = z
  .strictObject({
    firstDay: IsoDaySchema,
    sessions: z.int().min(15).max(23),
    hideDates: YesNoSchema,
    universe: z
      .array(
        z
          .strictObject({
            symbol: StockTickerSchema,
            source: z.enum(["watchlist", "manual", "filter", "liquidity"]),
          })
          .meta({ id: "SwingUniverseEntryV1" }),
      )
      .min(10)
      .max(50),
    interval: z.enum(["5m", "15m"]),
    tape: z.enum(["off", "on"]),
    armed: ArmedRefsSchema,
    maxOpenHolds: z.int().min(1).max(5),
    riskPerHoldUsd: z.int().min(1).max(100_000).optional(),
  })
  .superRefine((swing, ctx) => {
    if (new Set(swing.universe.map((entry) => entry.symbol)).size !== swing.universe.length) {
      ctx.addIssue({ code: "custom", path: ["universe"], message: SWING_SETUP_RULES[0].description });
    }
  })
  .meta({ id: "SwingSetupV1" });

export const PRACTICE_THREAD_RULES = [
  { id: "closed-at-matches-status", description: "closedAt is present exactly when status is closed" },
  { id: "swing-block-matches-mode", description: "swing is present exactly when mode is swing" },
] as const;

function swingMatchesMode(thread: { mode: "day" | "swing"; swing?: unknown }, ctx: z.RefinementCtx) {
  if ((thread.mode === "swing") !== (thread.swing !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["swing"], message: PRACTICE_THREAD_RULES[1].description });
  }
}

export const PracticeThreadCreateV1Schema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    mode: ThreadModeSchema,
    startingBalance: StartingBalanceSchema.default(DEFAULT_STARTING_BALANCE),
    plan: PracticeThreadPlanSchema,
    swing: SwingSetupV1Schema.optional(),
  })
  .superRefine(swingMatchesMode)
  .meta({ id: "PracticeThreadCreateV1" });

// Edits the plan while the thread is active. The starting balance and the mode never change.
export const PracticeThreadPatchV1Schema = z
  .strictObject({ schemaVersion: SchemaVersionSchema, plan: PracticeThreadPlanSchema })
  .meta({ id: "PracticeThreadPatchV1" });

// Derived from the ledger and the day lists, never stored twice. `winRate` is 0..1 and absent with
// no closed trade; `avgLossUsd` is negative, as in the journal. A day is practised when it ended
// with a session and skipped when it ended with none. The two adherence endpoints are the first and
// the latest day that had a score, for a trend arrow without the series.
const PracticeThreadStatsSchema = z
  .strictObject({
    balance: UsdSchema,
    daysPracticed: CountSchema,
    daysSkipped: CountSchema,
    wins: CountSchema,
    losses: CountSchema,
    winRate: z.number().min(0).max(1).optional(),
    avgWinUsd: UsdSchema.optional(),
    avgLossUsd: UsdSchema.optional(),
    bestDayUsd: UsdSchema.optional(),
    worstDayUsd: UsdSchema.optional(),
    adherenceFirstPct: PercentSchema.optional(),
    adherenceLastPct: PercentSchema.optional(),
  })
  .meta({ id: "PracticeThreadStatsV1" });

export const PracticeThreadV1Schema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: IdSchema,
    mode: ThreadModeSchema,
    startingBalance: StartingBalanceSchema,
    status: z.enum(["active", "closed"]),
    plan: PracticeThreadPlanSchema,
    swing: SwingSetupV1Schema.optional(),
    createdAt: UtcTimestampSchema,
    closedAt: UtcTimestampSchema.optional(),
    stats: PracticeThreadStatsSchema,
  })
  .superRefine((thread, ctx) => {
    if ((thread.status === "closed") !== (thread.closedAt !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: PRACTICE_THREAD_RULES[0].description,
      });
    }
    swingMatchesMode(thread, ctx);
  })
  .meta({ id: "PracticeThreadV1" });

// One row per realized practice trade: written when its exit mark is placed (her own or the day's
// auto-exit), once per exit mark, and removed with it if the mark is undone. A swing hold is credited
// when the day it exits ends, so its row carries `holdId`, and has no session or mark when the hold
// auto-exited at a close (02p). `pnlUsd` is the journal's own figure (no fees, spread or slippage);
// `r` is absent when no stop was set.
export const PracticeLedgerEntryV1Schema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: IdSchema,
    threadId: IdSchema,
    sessionId: IdSchema.optional(),
    markId: IdSchema.optional(),
    holdId: IdSchema.optional(),
    symbol: StockTickerSchema,
    day: IsoDaySchema,
    side: z.enum(["long", "short"]),
    shares: z.int().min(1).max(10_000),
    entryPrice: PriceSchema,
    exitPrice: PriceSchema,
    pnlUsd: UsdSchema,
    r: z.number().min(-1000).max(1000).optional(),
    realizedAt: UtcTimestampSchema,
  })
  .meta({ id: "PracticeLedgerEntryV1" });

export type SwingSetupV1 = z.infer<typeof SwingSetupV1Schema>;
export type PracticeThreadCreateV1 = z.infer<typeof PracticeThreadCreateV1Schema>;
export type PracticeThreadPatchV1 = z.infer<typeof PracticeThreadPatchV1Schema>;
export type PracticeThreadV1 = z.infer<typeof PracticeThreadV1Schema>;
export type PracticeLedgerEntryV1 = z.infer<typeof PracticeLedgerEntryV1Schema>;
