import type { PracticeMarkV1 } from "@ai-trading/contracts/replay-session-v1";
import { z } from "zod";
import {
  MarkResultSchema,
  MarkUndoSchema,
  OrderCancelSchema,
  OrderResultSchema,
  ReplayDaysSchema,
  ReplayDeltaSchema,
  ReplayFeedSchema,
  ReplaySessionSchema,
  ReplaySessionsSchema,
  type ReplayInterval,
} from "../replay/schemas.ts";
import { DailySchema, DayListSchema, OpenNextSchema, UniverseDaysSchema } from "../replay/daily.ts";
import { ThreadSchema, ThreadsSchema } from "../replay/threads.ts";
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

/** A limit, stop or stop-limit entry (`orderType`); a market entry is a mark. Prices are dollars. */
export type OrderBody = { side: "buy" | "sell"; orderType: "limit" | "stop" | "stop_limit"; shares?: number; limitPrice?: number; stopPrice?: number };

export const placeOrder = (id: number, order: OrderBody, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/orders`), OrderResultSchema, jsonInit("POST", order, options));

export const cancelOrder = (id: number, orderId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/orders/${orderId}`), OrderCancelSchema, { method: "DELETE", signal: options?.signal });

export const undoMark = (id: number, markId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/marks/${markId}`), MarkUndoSchema, { method: "DELETE", signal: options?.signal });

export const endReplay = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/end`), ReplaySessionSchema, jsonInit("POST", {}, options));

/** The recorded universe (02o-b2): coverage, the first day a new plan defaults to, and with `day` that morning's names. */
export const loadUniverseDays = (params: { day?: string } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/universe-days", { day: params.day }), UniverseDaysSchema, readInit(options));

// ---- daily-list practice (02o-b v1) -----------------------------------------------------------------------------

/** The daily card: a plan and its cursor, or `{ plan: null }`. With `threadId` it is that thread's own plan (several day
 *  threads can run at once); without it, her most recently started day thread's. */
export const loadDaily = (options?: RequestOptions & { threadId?: number }) =>
  clientOf(options)(deskPath("/replay/daily", { threadId: options?.threadId }), DailySchema, readInit(options));

/** Opens the next day's list or continues the current one. With `plan` (a `PracticeBlockV1`) it first saves that plan,
 *  bound to `threadId` or else her most recent day thread (02r). With `threadId` alone it continues that thread's day,
 *  so name the thread whenever more than one can be active. */
export const openNextDay = (plan?: unknown, options?: RequestOptions & { threadId?: number }) =>
  clientOf(options)(
    deskPath("/replay/daily/next"),
    OpenNextSchema,
    jsonInit("POST", { ...(plan === undefined ? {} : { plan }), ...(options?.threadId === undefined ? {} : { threadId: options.threadId }) }, options),
  );

/** One practice day. `peek` adds the pre-open chart data of one candidate (cut at the list's data time). */
export const loadDayList = (id: number, params: { peek?: string } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}`, { peek: params.peek }), DayListSchema, readInit(options));

/** Stars (at most five names from the list), notes and the 1 to 5 self-rating; a key left out is left alone. */
export const patchDayList = (id: number, body: { watch?: string[]; notes?: string | null; rating?: number | null }, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}`), DayListSchema, jsonInit("PATCH", body, options));

/** Re-lists a day she has not started at a later list time (D-012): moves the plan's list time and rebuilds this list in place. */
export const relistDay = (id: number, listAt: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}/relist`), DayListSchema, jsonInit("POST", { listAt }, options));

/** Starts the day's practice session on a name from the list (the plan's setup, from the day clock). */
export const startDaySession = (id: number, symbol: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}/sessions`), ReplaySessionSchema, jsonInit("POST", { symbol }, options));

/** Re-runs the day's filters at the day clock (02o-b2). The answer is the day list with `rescan` set; the frozen list is unchanged.
 *  A 409 before the first name is practised and after the day ends. A second scan at the same clock is the first. */
export const rescanDay = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}/rescan`), DayListSchema, jsonInit("POST", {}, options));

/** Ends the day: the open practice trade exits at the last price and the list review unseals. Idempotent. */
export const endDay = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/day-lists/${id}/end`), DayListSchema, jsonInit("POST", {}, options));

// ---- practice threads (02r) --------------------------------------------------------------------------------------

/** Her threads, the active ones first, each with its plan, stats and today (the hub's "Your practice threads"). */
export const loadThreads = (options?: RequestOptions) => clientOf(options)(deskPath("/replay/threads"), ThreadsSchema, readInit(options));

/** One thread: plan, stats, the daily P/L rows (one per ended day) and the balance curve, all read back from the ledger. */
export const loadThread = (id: number, options?: RequestOptions) => clientOf(options)(deskPath(`/replay/threads/${id}`), ThreadSchema, readInit(options));

/** Body is a `PracticeThreadCreateV1`. Any number of threads of a mode may be active. */
export const createThread = (spec: unknown, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/threads"), ThreadSchema, jsonInit("POST", spec, options));

/** Body is a `PracticeThreadPatchV1`: the risk plan only, while the thread is active. It applies from the next session. */
export const patchThread = (id: number, body: unknown, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${id}`), ThreadSchema, jsonInit("PATCH", body, options));

/** Closes the thread: its journal and final balance stay, its plan and balance freeze. An open practice day is a 409. */
export const closeThread = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${id}/close`), ThreadSchema, jsonInit("POST", {}, options));

/** Deletes the thread with its days, ledger and (swing) holds and weeks; it cannot be undone. An open practice day is a 409 in plain words. */
export const deleteThread = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${id}`), z.undefined(), { method: "DELETE", signal: options?.signal });
