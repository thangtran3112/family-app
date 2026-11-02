import { z } from "zod";
import type { components } from "../api/openapi.js";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "../desk/api.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { SPEEDS, type Speed } from "./clock.ts";
import { MarketSchema } from "./schemas.ts";
import { ms } from "./time.ts";

// The day-trade thread's clock as the Summary sees it (ADR-0018). The clock, the positions and the balance live on the server; this
// file only reads them and asks for changes. The clock is real time, shifted: it runs through the close, the night and the weekend and
// stops only when she pauses it. `extrapolate` moves the TIME LABEL between two polls (clock + elapsed x speed, no cap). It never prices
// anything: a balance needs prices after the clock, which the server must not send, so it comes from the next poll. Every dollar is SIMULATED.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const speed = z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]);

export const ClockAccountSchema = z.object({
  balance: finite,
  open_pnl_usd: finite,
  equity_usd: finite,
  buying_power_usd: finite,
  day_pnl_usd: finite,
  positions: finite.int(),
  as_of: timestamp,
}) satisfies z.ZodType<components["schemas"]["ClockAccountOut"]>;

export const ThreadClockSchema = z.object({
  thread_id: finite.int(),
  state: z.enum(["no_day", "paused", "running"]),
  day_list_id: finite.int().nullable(),
  day_no: finite.int().nullable(),
  running: z.boolean(),
  speed,
  clock: timestamp.nullable(),
  window_start: timestamp.nullable(),
  window_end: timestamp.nullable(),
  focus_end: timestamp.nullable(),
  next_start: timestamp.nullable(),
  server_now: timestamp,
  market: MarketSchema.nullish(),
  account: ClockAccountSchema.nullable(),
  label: z.string(),
}) satisfies z.ZodType<components["schemas"]["ThreadClockOut"]>;

export const SkipDaySchema = z.object({
  ended_day_list_id: finite.int(),
  next_day_list_id: finite.int().nullable(),
  clock: ThreadClockSchema,
}) satisfies z.ZodType<components["schemas"]["SkipDayOut"]>;

export type ThreadClock = z.infer<typeof ThreadClockSchema>;
export type ClockAccount = z.infer<typeof ClockAccountSchema>;
export type SkipDay = z.infer<typeof SkipDaySchema>;
/** What the Play bar can ask: any mix of these (the server settles the time that passed first). */
export type ClockCommand = { running?: boolean; speed?: Speed; step?: "bar" | "next_signal"; to?: string };

export const loadThreadClock = (threadId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/clock`), ThreadClockSchema, readInit(options));

export const commandThreadClock = (threadId: number, command: ClockCommand, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/clock`), ThreadClockSchema, jsonInit("POST", command, options));

export const skipThreadDay = (threadId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/skip-day`), SkipDaySchema, jsonInit("POST", {}, options));

export const isSpeed = (value: number): value is Speed => (SPEEDS as readonly number[]).includes(value);

/**
 * The clock label `elapsedMs` of wall time after the poll that read `clock`. Only a running clock moves, at `speed` market seconds per
 * wall second, and it has no end: the close, the night and the weekend are ordinary time. Anything else shows the server's time as it is.
 */
export function extrapolate(clock: Pick<ThreadClock, "clock" | "running" | "speed" | "state">, elapsedMs: number): string | null {
  if (clock.clock === null) return null;
  if (!clock.running || clock.state !== "running" || elapsedMs <= 0) return clock.clock;
  return new Date(ms(clock.clock) + elapsedMs * clock.speed).toISOString();
}

/**
 * The label to show: moved on by `elapsedMs` while the server keeps confirming the clock, HELD at the last confirmed time while a read is
 * failing (`stale`). A clock that keeps running with no answer behind it is a guess, so it is not shown as the time.
 */
export const shownClock = (clock: Pick<ThreadClock, "clock" | "running" | "speed" | "state">, elapsedMs: number, stale: boolean): string | null =>
  extrapolate(clock, stale ? 0 : elapsedMs);

/** The pill beside the time. */
export function clockStateText(clock: Pick<ThreadClock, "state" | "speed">): string {
  switch (clock.state) {
    case "running": return practiceText("clockStateRunning", { speed: clock.speed });
    case "paused": return PRACTICE_COPY.clockStatePaused;
    case "no_day": return "";
  }
}

/** What the board may do: Play or Pause, the speed and Skip day need an open day, and nothing else is needed (no name has to be opened). */
export function clockControls(clock: Pick<ThreadClock, "state"> | null) {
  const open = clock !== null && clock.state !== "no_day";
  return { play: open, started: open, skip: open };
}

/** How far through the current day's tape the clock is, 0 to 1: 1 once it is past the extended session's end (the night, the weekend). */
export function clockProgress(clock: Pick<ThreadClock, "clock" | "window_start" | "window_end">, shown: string | null): number {
  if (shown === null || clock.window_start === null || clock.window_end === null) return 0;
  const span = ms(clock.window_end) - ms(clock.window_start);
  return span <= 0 ? 0 : Math.min(1, Math.max(0, (ms(shown) - ms(clock.window_start)) / span));
}

/** Where her practice window ends along the day, 0 to 1, or null without one. A mark on the track and nothing more: it stops no clock. */
export function focusProgress(clock: Pick<ThreadClock, "window_start" | "window_end" | "focus_end">): number | null {
  if (clock.focus_end === null || clock.window_start === null || clock.window_end === null) return null;
  const span = ms(clock.window_end) - ms(clock.window_start);
  return span <= 0 ? null : Math.min(1, Math.max(0, (ms(clock.focus_end) - ms(clock.window_start)) / span));
}

/** The line after the clock reached the next session on its own: the day that ended and where the next one stands. */
export const rolledText = (from: number | null, next: { day_no: number | null }): string =>
  next.day_no !== null ? practiceText("clockRolled", { from: from ?? "", next: next.day_no }) : practiceText("clockRolledDone", { from: from ?? "" });

/** The line after Skip day: where the next day stands. */
export const skippedText = (result: SkipDay): string =>
  result.next_day_list_id !== null ? PRACTICE_COPY.clockSkipped : result.clock.state === "no_day" ? PRACTICE_COPY.clockSkippedDone : PRACTICE_COPY.clockSkippedPreparing;
