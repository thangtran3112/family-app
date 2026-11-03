import type { PracticeMarkV1 } from "@ai-trading/contracts/replay-session-v1";
import { z } from "zod";
import {
  MarkResultSchema,
  MarkUndoSchema,
  OrderCancelSchema,
  OrderResultSchema,
  ReplayDeltaSchema,
  ReplayFeedSchema,
  ReplaySessionSchema,
  type ReplayInterval,
} from "../replay/schemas.ts";
import { PortfolioSchema } from "../replay/portfolio.ts";
import { ScreenSchema, UniverseDaysSchema } from "../replay/screen.ts";
import { ThreadCapacitySchema, ThreadSchema, ThreadsSchema } from "../replay/threads.ts";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "./api.ts";

// Loaders for the Practice endpoints (ADR-0025): one function per route. Replay screens use only these; they never
// call /bars, /technicals, /charts/…/markers or /quotes (the live store would mismatch replayed raw prices).
// A name is a LANE of a thread (`openLane`), never a session of one day: the thread's clock moves it, and no route here moves a lane's time.

export const loadReplaySession = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}`), ReplaySessionSchema, readInit(options));

/** Notes and the 1 to 5 self-rating only. */
export const patchReplaySession = (id: number, body: { notes?: string | null; rating?: number | null }, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}`), ReplaySessionSchema, jsonInit("PATCH", body, options));

export type TapeParams = { interval?: ReplayInterval; minSize?: number; minNotional?: number; maxPrints?: number };
/**
 * `sync`: follow the thread's server-side clock (ADR-0018) - bring it to now, then reveal this name through it. `since` is the playhead
 * this window last read: the answer carries every bar closed after it, also the ones another window of the same lane already took (D-198).
 * A lane cannot move time: `to` and `step` are refused by the server (ADR-0025), so they are not offered here.
 */
export type AdvanceTarget = { sync: true; since?: string };

const tapeBody = ({ interval, minSize, minNotional, maxPrints }: TapeParams) => ({
  interval,
  min_size: minSize ? minSize : undefined,
  min_notional: minNotional ? minNotional : undefined,
  max_prints: maxPrints,
});

/** Reveals what the thread clock has passed since `since` and returns it. */
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

/** A limit, stop or stop-limit order (`orderType`); a market order is a mark. Prices are dollars. `timeInForce`: `gtc` (the default) rests until it fills or is cancelled; `day` lapses at the extended close of the session it was placed in. */
export type OrderBody = { side: "buy" | "sell"; orderType: "limit" | "stop" | "stop_limit"; shares?: number; limitPrice?: number; stopPrice?: number; timeInForce?: "gtc" | "day" };

export const placeOrder = (id: number, order: OrderBody, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/orders`), OrderResultSchema, jsonInit("POST", order, options));

export const cancelOrder = (id: number, orderId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/orders/${orderId}`), OrderCancelSchema, { method: "DELETE", signal: options?.signal });

export const undoMark = (id: number, markId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/sessions/${id}/marks/${markId}`), MarkUndoSchema, { method: "DELETE", signal: options?.signal });

/** The recorded universe (02o-b2): coverage, the first day a new thread defaults to, and with `day` that morning's names. */
export const loadUniverseDays = (params: { day?: string } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/universe-days", { day: params.day }), UniverseDaysSchema, readInit(options));

// ---- the Screen and lanes (ADR-0025) -----------------------------------------------------------------------------

/** The thread's Screen: the latest scan of her filters at the thread's time, her stars, the names she holds. `peek` adds the pre-open
 *  chart data of one candidate (cut at the scan's data time). `live` adds each candidate's `live` block: the name priced at `T`. */
export const loadScreen = (threadId: number, params: { peek?: string; live?: boolean } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/screen`, { peek: params.peek, live: params.live ? "true" : undefined }), ScreenSchema, readInit(options));

/** Stars (at most five names from the Screen), notes and the 1 to 5 self-rating; a key left out is left alone. */
export const patchScreen = (threadId: number, body: { watch?: string[]; notes?: string | null; rating?: number | null }, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/screen`), ScreenSchema, jsonInit("PATCH", body, options));

/** Re-runs her filters at the thread's time (02o-b2). The answer is the Screen with `rescan_job` running; poll `loadScreen` until it is done.
 *  A 409 on a closed thread and for a filter whose bars cannot have closed at `T` yet. A second scan at the same `T` is the first. */
export const rescanScreen = (threadId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/screen/rescan`), ScreenSchema, jsonInit("POST", {}, options));

/** Opens her lane on a name (or resumes it): one book per name for the thread's life, at the thread's time. Any name of the Screen or of the thread's universe opens. */
export const openLane = (threadId: number, symbol: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/lanes`), ReplaySessionSchema, jsonInit("POST", { symbol }, options));

/** The thread's Portfolio at `T`: every open position with its price at `T` and its gain or loss, the working orders, the account. */
export const loadPortfolio = (threadId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/portfolio`), PortfolioSchema, readInit(options));

// ---- practice threads (ADR-0025) ---------------------------------------------------------------------------------

/** Her threads, the active ones first, each with its clock and open-position count (the hub's "Your practice threads"). */
export const loadThreads = (options?: RequestOptions) => clientOf(options)(deskPath("/replay/threads"), ThreadsSchema, readInit(options));

/** The thread slots in use across all users (the hub's "Thread slots n of 10"). */
export const loadThreadCapacity = (options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/threads/capacity"), ThreadCapacitySchema, readInit(options));

/** One thread: plan, stats, its clock, the realized P/L by ET date and the balance curve, all read back from the ledger. */
export const loadThread = (id: number, options?: RequestOptions) => clientOf(options)(deskPath(`/replay/threads/${id}`), ThreadSchema, readInit(options));

/** Body is a `PracticeThreadCreateV1` plus an optional `setup` (a `PracticeSetupV2`): the setup starts the thread's clock, paused at `startAt`, and its Screen. */
export const createThread = (spec: unknown, options?: RequestOptions) =>
  clientOf(options)(deskPath("/replay/threads"), ThreadSchema, jsonInit("POST", spec, options));

/** Saves the thread's setup (a `PracticeSetupV2`). The first one starts the clock paused at `startAt`; a later one replaces the filters and never moves time. */
export const putThreadSetup = (id: number, setup: unknown, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${id}/setup`), ThreadSchema, jsonInit("PUT", setup, options));

/** Body is a `PracticeThreadPatchV1`: the risk plan only, while the thread is active. It applies from the next lane. */
export const patchThread = (id: number, body: unknown, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${id}`), ThreadSchema, jsonInit("PATCH", body, options));

/** Closes the thread: its working orders are cancelled, its plan and balance freeze, and its clock stops where it is. Every open position stays open, valued at that time; nothing is sold. */
export const closeThread = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${id}/close`), ThreadSchema, jsonInit("POST", {}, options));

/** Deletes the thread with its lanes, ledger and Screen; it cannot be undone. */
export const deleteThread = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${id}`), z.undefined(), { method: "DELETE", signal: options?.signal });
