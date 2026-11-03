import { z } from "zod";
import type { components } from "../api/openapi.js";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "../desk/api.ts";
import { formatEtDateClock } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { SPEEDS, type Speed } from "./clock.ts";
import { MarketSchema } from "./schemas.ts";
import { etWallToUtcIso, ms } from "./time.ts";

// The freestyle thread's clock as the Summary sees it (ADR-0025). The clock, the positions and the balance live on the server; this file
// only reads them and asks for changes. The clock is real time, shifted: it runs through the close, the night and the weekend, and it stops
// on its own at one place only, the horizon (the latest time the data reaches). `extrapolate` moves the TIME LABEL between two polls
// (clock + elapsed x speed). It never prices anything: a balance needs prices after the clock, which the server must not send, so it comes
// from the next poll. Nothing happens at a close or an open: no position closes and no order lapses because time passed. Every dollar is SIMULATED.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const speed = z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]);

export const ClockAccountSchema = z.object({
  balance: finite,
  open_pnl_usd: finite,
  equity_usd: finite,
  buying_power_usd: finite,
  /** Equity minus the starting balance. */
  since_start_usd: finite,
  positions: finite.int(),
  as_of: timestamp,
}) satisfies z.ZodType<components["schemas"]["ClockAccountOut"]>;

export const ThreadClockSchema = z.object({
  thread_id: finite.int(),
  /** `not_started`: the thread has no setup yet, so no time. */
  state: z.enum(["not_started", "paused", "running"]),
  running: z.boolean(),
  speed,
  clock: timestamp.nullable(),
  start_at: timestamp.nullable(),
  /** The latest time the clock can reach: the extended close of the newest session the data embargo has released. */
  horizon: timestamp,
  /** The first regular open (9:30 ET) after the clock; null once the horizon is before it. */
  next_open: timestamp.nullable(),
  /** `{ kind: "horizon" }` once the clock stopped itself at the horizon; null otherwise. */
  pause: z.record(z.string(), z.unknown()).nullable(),
  server_now: timestamp,
  market: MarketSchema.nullish(),
  account: ClockAccountSchema.nullable(),
  label: z.string(),
}) satisfies z.ZodType<components["schemas"]["ThreadClockOut"]>;

export type ThreadClock = z.infer<typeof ThreadClockSchema>;
export type ClockAccount = z.infer<typeof ClockAccountSchema>;
/** What the Play bar can ask: any mix of these (the server settles the time that passed first). `to` is a Jump or Next open and only goes forward. */
export type ClockCommand = { running?: boolean; speed?: Speed; step?: "bar"; to?: string };

export const loadThreadClock = (threadId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/clock`), ThreadClockSchema, readInit(options));

export const commandThreadClock = (threadId: number, command: ClockCommand, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/clock`), ThreadClockSchema, jsonInit("POST", command, options));

export const isSpeed = (value: number): value is Speed => (SPEEDS as readonly number[]).includes(value);

/** The clock stopped itself at the horizon: the data reaches no further, so it waits there until more of it exists. */
export const atHorizon = (clock: Pick<ThreadClock, "pause">): boolean => clock.pause?.kind === "horizon";

/**
 * The clock label `elapsedMs` of wall time after the poll that read `clock`. Only a running clock moves, at `speed` market seconds per
 * wall second, and it has no end of its own: the close, the night and the weekend are ordinary time. It never passes the horizon, where
 * the server stops it. Anything else shows the server's time as it is.
 */
export function extrapolate(clock: Pick<ThreadClock, "clock" | "running" | "speed" | "state"> & { horizon?: string }, elapsedMs: number): string | null {
  if (clock.clock === null) return null;
  if (!clock.running || clock.state !== "running" || elapsedMs <= 0) return clock.clock;
  const next = ms(clock.clock) + elapsedMs * clock.speed;
  return new Date(clock.horizon === undefined ? next : Math.min(next, ms(clock.horizon))).toISOString();
}

/**
 * The label to show: moved on by `elapsedMs` while the server keeps confirming the clock, HELD at the last confirmed time while a read is
 * failing (`stale`). A clock that keeps running with no answer behind it is a guess, so it is not shown as the time.
 */
export const shownClock = (clock: Pick<ThreadClock, "clock" | "running" | "speed" | "state"> & { horizon?: string }, elapsedMs: number, stale: boolean): string | null =>
  extrapolate(clock, stale ? 0 : elapsedMs);

/** The pill beside the time. */
export function clockStateText(clock: Pick<ThreadClock, "state" | "speed" | "pause">): string {
  switch (clock.state) {
    case "running": return practiceText("clockStateRunning", { speed: clock.speed });
    case "paused": return atHorizon(clock) ? PRACTICE_COPY.clockStateHorizon : PRACTICE_COPY.clockStatePaused;
    case "not_started": return "";
  }
}

/** What the clock bar may do: Play and Pause need a started thread, and Play has nowhere to go at the horizon (a Jump has none either). */
export function clockControls(clock: Pick<ThreadClock, "state" | "pause"> | null) {
  const started = clock !== null && clock.state !== "not_started";
  return { play: started && !(clock !== null && atHorizon(clock)), started };
}

/**
 * The Next open chip: the first 9:30 ET open after the clock, from the server (`next_open`), sent through the same Jump as a typed time.
 * Off, with the reason, when the horizon is before it (the data does not reach another open yet) or the clock has not started.
 */
export function nextOpenChip(clock: Pick<ThreadClock, "state" | "next_open"> | null): { to: string | null; label: string; disabledReason: string | null } {
  if (clock === null || clock.state === "not_started") return { to: null, label: PRACTICE_COPY.clockNextOpen, disabledReason: PRACTICE_COPY.clockNextOpenNone };
  if (clock.next_open === null) return { to: null, label: PRACTICE_COPY.clockNextOpen, disabledReason: PRACTICE_COPY.clockNextOpenNone };
  return { to: clock.next_open, label: practiceText("clockNextOpenAt", { when: formatEtDateClock(clock.next_open, { seconds: false }) }), disabledReason: null };
}

/**
 * The Jump boxes (an ET date and an ET time, as typed) as the instant the server is asked for, or why they cannot be sent. Empty or half-typed
 * boxes are no target and no problem. A time at or before the clock is no jump (forward only), and one past the horizon is refused here as
 * the server would.
 */
export function checkJump(clock: Pick<ThreadClock, "horizon">, shown: string | null, date: string, time: string): { to: string | null; problem: string | null } {
  const to = etWallToUtcIso(date, time);
  if (to === null) return { to: null, problem: null };
  if (ms(to) > ms(clock.horizon)) return { to: null, problem: practiceText("clockJumpPastHorizon", { horizon: formatEtDateClock(clock.horizon, { seconds: false }) }) };
  if (shown !== null && ms(to) <= ms(shown)) return { to: null, problem: PRACTICE_COPY.clockJumpBack };
  return { to, problem: null };
}
