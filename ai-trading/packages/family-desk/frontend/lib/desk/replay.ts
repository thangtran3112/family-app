import type { PracticeMarkV1 } from "@ai-trading/contracts/replay-session-v1";
import {
  MarkResultSchema,
  MarkUndoSchema,
  ReplayDaysSchema,
  ReplayDeltaSchema,
  ReplayFeedSchema,
  ReplaySessionSchema,
  ReplaySessionsSchema,
  type ReplayInterval,
} from "../replay/schemas.ts";
import { DailySchema, DayListSchema, OpenNextSchema } from "../replay/daily.ts";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "./api.ts";

// Loaders for the Practice endpoints (02o §b1): one function per route. Replay screens use only these; they never
// call /bars, /technicals, /charts/…/markers or /quotes (the live store would mismatch replayed raw prices).

export const loadReplayDays = (params: { symbol?: string; limit?: number } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/days", { symbol: params.symbol, limit: params.limit }), ReplayDaysSchema, readInit(options));

export const loadReplaySessions = (params: { status?: "active" | "ended"; limit?: number } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/sessions", { status: params.status, limit: params.limit }), ReplaySessionsSchema, readInit(options));

/** Body is the `ReplaySessionV1` itself. A second call for an active symbol-day returns the existing session. */
export const createReplaySession = (spec: unknown, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/sessions"), ReplaySessionSchema, jsonInit("POST", spec, options));

export const loadReplaySession = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}`), ReplaySessionSchema, readInit(options));

/** Notes and the 1 to 5 self-rating only. */
export const patchReplaySession = (id: number, body: { notes?: string | null; rating?: number | null }, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}`), ReplaySessionSchema, jsonInit("PATCH", body, options));

export type TapeParams = { interval?: ReplayInterval; minSize?: number; minNotional?: number; maxPrints?: number };
export type AdvanceTarget = { to: string } | { step: "bar" | "next_signal" };

const tapeBody = ({ interval, minSize, minNotional, maxPrints }: TapeParams) => ({
  interval,
  min_size: minSize ? minSize : undefined,
  min_notional: minNotional ? minNotional : undefined,
  max_prints: maxPrints,
});

/** Moves the playhead forward and returns what it revealed. `to` at or before the playhead is an empty delta. */
export const advanceReplay = (id: number, target: AdvanceTarget, tape: TapeParams = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/advance`), ReplayDeltaSchema, jsonInit("POST", { ...target, ...tapeBody(tape) }, options));

/** Re-reads everything revealed so far (resume, interval switch, tape filter change). */
export const loadReplayFeed = (id: number, tape: TapeParams = {}, options?: RequestOptions) =>
  clientOf(options)(
    deskPath(`/replay/sessions/${id}/feed`, { interval: tape.interval, min_size: tape.minSize || undefined, min_notional: tape.minNotional || undefined }),
    ReplayFeedSchema,
    readInit(options),
  );

export const placeMark = (id: number, mark: PracticeMarkV1, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/marks`), MarkResultSchema, jsonInit("POST", mark, options));

export const undoMark = (id: number, markId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/marks/${markId}`), MarkUndoSchema, { method: "DELETE", signal: options?.signal });

export const endReplay = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/end`), ReplaySessionSchema, jsonInit("POST", {}, options));

// ---- daily-list practice (02o-b v1) -----------------------------------------------------------------------------

/** The hub card: her plan and its cursor, or `{ plan: null }`. */
export const loadDaily = (options?: RequestOptions) => clientOf(options)(deskPath("/replay/daily"), DailySchema, readInit(options));

/** Opens the next day's list or continues the current one. With `plan` (a `PracticeBlockV1`) it first saves that plan. */
export const openNextDay = (plan?: unknown, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/daily/next"), OpenNextSchema, jsonInit("POST", plan === undefined ? {} : { plan }, options));

/** One practice day. `peek` adds the pre-open chart data of one candidate (cut at the list's data time). */
export const loadDayList = (id: number, params: { peek?: string } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}`, { peek: params.peek }), DayListSchema, readInit(options));

/** Stars (at most five names from the list), notes and the 1 to 5 self-rating; a key left out is left alone. */
export const patchDayList = (id: number, body: { watch?: string[]; notes?: string | null; rating?: number | null }, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}`), DayListSchema, jsonInit("PATCH", body, options));

/** Starts the day's practice session on a name from the list (the plan's setup, from the day clock). */
export const startDaySession = (id: number, symbol: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}/sessions`), ReplaySessionSchema, jsonInit("POST", { symbol }, options));

/** Ends the day: the open practice trade exits at the last price and the list review unseals. Idempotent. */
export const endDay = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}/end`), DayListSchema, jsonInit("POST", {}, options));
