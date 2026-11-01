import { z } from "zod";
import type { components } from "../api/openapi.js";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "../desk/api.ts";
import { formatPrice } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { SPEEDS, type Speed } from "./clock.ts";
import { ms } from "./time.ts";

// The day-trade thread's clock as the Summary sees it (ADR-0018). The clock, the positions and the balance live on the server; this
// file only reads them and asks for changes. `extrapolate` moves the TIME LABEL between two polls (clock + elapsed x speed, capped at
// the close). It never prices anything: a balance needs prices after the clock, which the server must not send, so it comes from the
// next poll. Every dollar is SIMULATED.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const speed = z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]);

export const ClockPauseSchema = z.object({
  kind: z.enum(["stop", "close"]),
  at: timestamp,
  symbol: z.string().nullish(),
  stop_price: finite.nullish(),
  price: finite.nullish(),
  crossing: z.enum(["cross", "gap"]).nullish(),
  also: z.array(z.string()).default([]),
}) satisfies z.ZodType<components["schemas"]["ClockPauseOut"]>;

export const ClockAccountSchema = z.object({
  balance: finite,
  open_pnl_usd: finite,
  equity_usd: finite,
  day_pnl_usd: finite,
  positions: finite.int(),
  as_of: timestamp,
}) satisfies z.ZodType<components["schemas"]["ClockAccountOut"]>;

export const ThreadClockSchema = z.object({
  thread_id: finite.int(),
  state: z.enum(["no_day", "listed", "paused", "running", "at_close"]),
  day_list_id: finite.int().nullable(),
  day_no: finite.int().nullable(),
  running: z.boolean(),
  speed,
  clock: timestamp.nullable(),
  window_start: timestamp.nullable(),
  window_end: timestamp.nullable(),
  server_now: timestamp,
  pause: ClockPauseSchema.nullable(),
  account: ClockAccountSchema.nullable(),
  label: z.string(),
}) satisfies z.ZodType<components["schemas"]["ThreadClockOut"]>;

export const SkipDaySchema = z.object({
  ended_day_list_id: finite.int(),
  next_day_list_id: finite.int().nullable(),
  clock: ThreadClockSchema,
}) satisfies z.ZodType<components["schemas"]["SkipDayOut"]>;

export type ThreadClock = z.infer<typeof ThreadClockSchema>;
export type ClockPause = z.infer<typeof ClockPauseSchema>;
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
 * wall second, and never past the window end; anything else shows the server's time as it is.
 */
export function extrapolate(clock: Pick<ThreadClock, "clock" | "running" | "speed" | "window_end" | "state">, elapsedMs: number): string | null {
  if (clock.clock === null) return null;
  if (!clock.running || clock.state !== "running" || elapsedMs <= 0) return clock.clock;
  const target = ms(clock.clock) + elapsedMs * clock.speed;
  return new Date(clock.window_end === null ? target : Math.min(target, ms(clock.window_end))).toISOString();
}

/** The pill beside the time. */
export function clockStateText(clock: Pick<ThreadClock, "state" | "speed">): string {
  switch (clock.state) {
    case "running": return practiceText("clockStateRunning", { speed: clock.speed });
    case "at_close": return PRACTICE_COPY.clockStateClose;
    case "listed": return PRACTICE_COPY.clockStateListed;
    case "paused": return PRACTICE_COPY.clockStatePaused;
    case "no_day": return "";
  }
}

/** The sentence under the controls when a clock that was running stopped, or null while there is nothing to explain. */
export function pauseText(pause: ClockPause | null): string | null {
  if (pause === null) return null;
  if (pause.kind === "close") return PRACTICE_COPY.clockPausedClose;
  return practiceText("clockPausedStop", { symbol: pause.symbol ?? "A name", price: pause.stop_price == null ? "its stop" : formatPrice(pause.stop_price) });
}

/** What the controls may do now: Play needs a started day that is not at the close; Step, Jump need a started day; Skip needs any open day. */
export function clockControls(clock: Pick<ThreadClock, "state"> | null) {
  const started = clock !== null && (clock.state === "running" || clock.state === "paused" || clock.state === "at_close");
  return {
    play: clock !== null && (clock.state === "paused" || clock.state === "running"),
    jump: clock !== null && (clock.state === "paused" || clock.state === "running"),
    started,
    skip: clock !== null && clock.state !== "no_day",
  };
}

/** How far through the window the clock is, 0 to 1 (0 before the day starts). */
export function clockProgress(clock: Pick<ThreadClock, "clock" | "window_start" | "window_end">, shown: string | null): number {
  if (shown === null || clock.window_start === null || clock.window_end === null) return 0;
  const span = ms(clock.window_end) - ms(clock.window_start);
  return span <= 0 ? 0 : Math.min(1, Math.max(0, (ms(shown) - ms(clock.window_start)) / span));
}

/** The line after Skip day: where the next day stands. */
export const skippedText = (result: SkipDay): string =>
  result.next_day_list_id !== null ? PRACTICE_COPY.clockSkipped : result.clock.state === "no_day" ? PRACTICE_COPY.clockSkippedDone : PRACTICE_COPY.clockSkippedPreparing;
