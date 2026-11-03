import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { PracticeMarkV1 } from "@ai-trading/contracts/replay-session-v1";
import { createDeskApiClient, DeskApiError } from "../api/client.ts";
import { delta, feed, markResult, session } from "../replay/fixtures.ts";
import { screen as screenFixture } from "../replay/screenFixtures.ts";
import { activeThread, closedThread, thread } from "../replay/threadFixtures.ts";
import { commandThreadClock, loadThreadClock } from "../replay/threadClock.ts";
import {
  advanceReplay,
  cancelOrder,
  closeThread,
  createThread,
  deleteThread,
  loadPortfolio,
  loadReplayFeed,
  loadReplaySession,
  loadScreen,
  loadThread,
  loadThreads,
  openLane,
  patchReplaySession,
  patchScreen,
  patchThread,
  placeMark,
  placeOrder,
  putThreadSetup,
  rescanScreen,
  undoMark,
} from "./replay.ts";

type Call = { method: string; path: string; body: unknown };
const seen: Call[] = [];

/** A client over a fake fetch: answers with `answer` (undefined is an empty response) and records each request. */
function fakeDesk(answer: unknown, status = 200) {
  const calls: Call[] = [];
  const client = createDeskApiClient(
    async (input, init) => {
      const url = input as URL;
      const call = { method: init?.method ?? "GET", path: url.pathname + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
      calls.push(call);
      seen.push(call);
      return answer === undefined ? new Response(null, { status }) : Response.json(answer, { status });
    },
    () => ({ href: "https://trading.test/" }),
  );
  return { client, calls };
}

after(() => {
  assert.ok(seen.length > 0);
  assert.ok(seen.every((call) => call.path.startsWith("/api/desk/replay/")), "every Practice request goes through /api/desk/replay");
  // ADR-0025: no day list, no standalone session, no skip-day, no daily plan: those routes are gone from the client.
  assert.ok(seen.every((call) => !/\/(day-lists|daily|days|skip-day|holds|weeks)\b/.test(call.path) && !(call.method === "POST" && call.path === "/api/desk/replay/sessions")), "no removed route is called");
});

test("a lane reads and patches through its session routes", async () => {
  let d = fakeDesk(session);
  assert.equal((await loadReplaySession(12, { client: d.client })).id, 12);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/sessions/12", body: undefined });

  d = fakeDesk(session);
  await patchReplaySession(12, { notes: "ORB held", rating: 4 }, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PATCH", path: "/api/desk/replay/sessions/12", body: { notes: "ORB held", rating: 4 } });
});

test("a lane only syncs to the thread clock: advance sends the sync flag, the playhead it last read and the tape settings that are set", async () => {
  let d = fakeDesk(delta);
  await advanceReplay(12, { sync: true, since: "2026-04-07T14:00:00Z" }, { interval: "5m", minSize: 100, minNotional: 0, maxPrints: 500 }, { client: d.client });
  assert.deepEqual(d.calls[0], {
    method: "POST",
    path: "/api/desk/replay/sessions/12/advance",
    body: { sync: true, since: "2026-04-07T14:00:00Z", interval: "5m", min_size: 100, max_prints: 500 },
  });

  d = fakeDesk(delta);
  const result = await advanceReplay(12, { sync: true }, { minNotional: 200_000 }, { client: d.client });
  assert.deepEqual(d.calls[0]!.body, { sync: true, min_notional: 200_000 });
  assert.equal(result.revealed_through, delta.revealed_through);
});

test("feed sends its tape query; a mark posts the mark itself; undo deletes and accepts an empty 204", async () => {
  let d = fakeDesk(feed);
  await loadReplayFeed(12, { interval: "15m", minSize: 1000, minNotional: 0 }, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/sessions/12/feed?interval=15m&min_size=1000", body: undefined });
  d = fakeDesk(feed);
  await loadReplayFeed(12, {}, { client: d.client });
  assert.equal(d.calls[0]!.path, "/api/desk/replay/sessions/12/feed");

  const mark: PracticeMarkV1 = { schemaVersion: 1, kind: "long_entry", shares: 100, stopPrice: 186.9, note: "ORB hold" };
  d = fakeDesk(markResult);
  assert.equal((await placeMark(12, mark, { client: d.client })).mark.id, 3);
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/sessions/12/marks", body: mark });

  d = fakeDesk({ removed_mark_id: 3, open_trade: null, journal: markResult.journal, thread: null });
  assert.equal((await undoMark(12, 3, { client: d.client })).open_trade, null);
  assert.deepEqual(d.calls[0], { method: "DELETE", path: "/api/desk/replay/sessions/12/marks/3", body: undefined });
});

test("an order carries its time in force; cancel deletes the order", async () => {
  const order = { id: 4, side: "sell", type: "stop", shares: 100, limit_price: null, stop_price: 185, status: "working", placed_at: "2026-10-23T14:05:00Z", triggered_at: null, closed_at: null, fill_price: null, mark_id: null, reason: null, tif: "day", expires_at: "2026-10-24T00:00:00Z", reduce_only: true };
  const result = { order, orders: [order], mark: null, open_trade: null, journal: markResult.journal, warning: null, thread: null };
  let d = fakeDesk(result);
  const placed = await placeOrder(12, { side: "sell", orderType: "stop", shares: 100, stopPrice: 185, timeInForce: "day" }, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/sessions/12/orders", body: { side: "sell", orderType: "stop", shares: 100, stopPrice: 185, timeInForce: "day" } });
  assert.deepEqual([placed.order.tif, placed.order.reduce_only], ["day", true]);

  d = fakeDesk({ order: { ...order, status: "cancelled" }, orders: [] });
  assert.equal((await cancelOrder(12, 4, { client: d.client })).order.status, "cancelled");
  assert.deepEqual(d.calls[0], { method: "DELETE", path: "/api/desk/replay/sessions/12/orders/4", body: undefined });
});

test("the Screen reads at the thread's time, stars names, re-scans and opens a lane", async () => {
  let d = fakeDesk(screenFixture);
  assert.equal((await loadScreen(1, { peek: "NVDA", live: true }, { client: d.client })).thread_id, screenFixture.thread_id);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/threads/1/screen?peek=NVDA&live=true", body: undefined });
  d = fakeDesk(screenFixture);
  await loadScreen(1, {}, { client: d.client });
  assert.equal(d.calls[0]!.path, "/api/desk/replay/threads/1/screen");

  d = fakeDesk(screenFixture);
  await patchScreen(1, { watch: ["NVDA"] }, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PATCH", path: "/api/desk/replay/threads/1/screen", body: { watch: ["NVDA"] } });

  d = fakeDesk(screenFixture);
  await rescanScreen(1, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/threads/1/screen/rescan", body: {} });

  d = fakeDesk(session);
  assert.equal((await openLane(1, "NVDA", { client: d.client })).id, 12);
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/threads/1/lanes", body: { symbol: "NVDA" } });
});

test("the Portfolio reads the thread's positions at its clock", async () => {
  const d = fakeDesk({ thread_id: 1, as_of: null, positions: [], orders: [], account: null, label: "SIMULATED" });
  assert.deepEqual((await loadPortfolio(1, { client: d.client })).positions, []);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/threads/1/portfolio", body: undefined });
});

test("the clock reads, and a command sends any mix of run, speed, step and a forward jump", async () => {
  const clock = { thread_id: 1, state: "paused", running: false, speed: 1, clock: "2026-10-23T13:30:00Z", start_at: "2026-10-23T13:30:00Z", horizon: "2026-10-30T00:00:00Z", next_open: "2026-10-26T13:30:00Z", pause: null, server_now: "2026-11-02T20:00:00Z", account: null, label: "SIMULATED" };
  let d = fakeDesk(clock);
  assert.equal((await loadThreadClock(1, { client: d.client })).next_open, "2026-10-26T13:30:00Z");
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/threads/1/clock", body: undefined });
  d = fakeDesk(clock);
  await commandThreadClock(1, { to: "2026-10-26T13:30:00Z" }, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/threads/1/clock", body: { to: "2026-10-26T13:30:00Z" } });
  const refused = await commandThreadClock(1, { to: "2026-10-01T13:30:00Z" }, { client: fakeDesk({ detail: { problems: [{ path: "to", message: "Time only moves forward" }] } }, 422).client }).catch((error: unknown) => error);
  assert.ok(refused instanceof DeskApiError);
  assert.deepEqual([refused.status, refused.problems], [422, [{ path: "to", message: "Time only moves forward" }]]);
});

test("a payload that does not match the contract rejects as malformed", async () => {
  const one = await loadReplaySession(12, { client: fakeDesk({ ...session, marks: [{ id: 1 }] }).client }).catch((error: unknown) => error);
  assert.ok(one instanceof DeskApiError);
  assert.equal(one.kind, "malformed");
  const screenBad = await loadScreen(1, {}, { client: fakeDesk({ ...screenFixture, candidates: "nope" }).client }).catch((error: unknown) => error);
  assert.ok(screenBad instanceof DeskApiError);
  assert.equal(screenBad.kind, "malformed");
});

test("the thread loaders use the thread routes: list, read, create with its setup, save a setup, patch the plan, close", async () => {
  let d = fakeDesk([activeThread]);
  assert.equal((await loadThreads({ client: d.client })).length, 1);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/threads", body: undefined });

  d = fakeDesk(thread);
  assert.equal((await loadThread(1, { client: d.client })).daily.length, thread.daily.length);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/threads/1", body: undefined });

  const setup = { schemaVersion: 2, startAt: "2026-10-23T09:30:00-04:00", screen: { filters: [{ id: 4 }], maxList: 30 }, setup: { interval: "5m", session: "regular", armed: [] } };
  const create = { schemaVersion: 1, mode: "day", startingBalance: 50000, plan: { stopNoteOnEntry: "yes", tradeOnlyOnSignal: "no" }, setup };
  d = fakeDesk(thread);
  await createThread(create, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/threads", body: create });

  d = fakeDesk(thread);
  await putThreadSetup(1, setup, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PUT", path: "/api/desk/replay/threads/1/setup", body: setup });

  const patch = { schemaVersion: 1, plan: { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" } };
  d = fakeDesk(thread);
  await patchThread(1, patch, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PATCH", path: "/api/desk/replay/threads/1", body: patch });

  d = fakeDesk(closedThread);
  assert.equal((await closeThread(3, { client: d.client })).thread.status, "closed");
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/threads/3/close", body: {} });
});

test("a 422 with setup problems rejects with the problems attached", async () => {
  const problems = [{ path: "startAt", message: "startAt must be a trading day" }];
  const error = await createThread({ schemaVersion: 1 }, { client: fakeDesk({ detail: { problems } }, 422).client }).catch((caught: unknown) => caught);
  assert.ok(error instanceof DeskApiError);
  assert.deepEqual([error.kind, error.status, error.problems], ["http", 422, problems]);
});

test("deleting a thread sends DELETE to its route and expects no body", async () => {
  const d = fakeDesk(undefined, 204);
  assert.equal(await deleteThread(6, { client: d.client }), undefined);
  assert.deepEqual(d.calls[0], { method: "DELETE", path: "/api/desk/replay/threads/6", body: undefined });
});
