import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { PracticeMarkV1 } from "@ai-trading/contracts/replay-session-v1";
import { createDeskApiClient, DeskApiError } from "../api/client.ts";
import { daysResponse, delta, feed, markResult, session, sessionSummary, spec } from "../replay/fixtures.ts";
import { advanceReplay, closeThread, createReplaySession, createThread, deleteThread, endReplay, loadDaily, loadReplayDays, loadReplayFeed, loadReplaySession, loadReplaySessions, loadThread, loadThreads, openNextDay, patchReplaySession, relistDay, patchThread, placeMark, undoMark } from "./replay.ts";
import { activeThread, closedThread, thread } from "../replay/threadFixtures.ts";

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
});

test("the read loaders GET their documented paths with the query they are given", async () => {
  let d = fakeDesk(daysResponse);
  assert.equal((await loadReplayDays({ symbol: "NVDA", limit: 20 }, { client: d.client })).days.length, 3);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/days?symbol=NVDA&limit=20", body: undefined });
  d = fakeDesk(daysResponse);
  await loadReplayDays({}, { client: d.client });
  assert.equal(d.calls[0]!.path, "/api/desk/replay/days");

  d = fakeDesk([sessionSummary]);
  assert.equal((await loadReplaySessions({ status: "active", limit: 5 }, { client: d.client })).length, 1);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/sessions?status=active&limit=5", body: undefined });

  d = fakeDesk(session);
  assert.equal((await loadReplaySession(12, { client: d.client })).id, 12);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/sessions/12", body: undefined });
});

test("create posts the spec itself; patch and end send their own bodies", async () => {
  let d = fakeDesk(session);
  assert.equal((await createReplaySession(spec, { client: d.client })).id, 12);
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/sessions", body: spec });

  d = fakeDesk(session);
  await patchReplaySession(12, { notes: "ORB held", rating: 4 }, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PATCH", path: "/api/desk/replay/sessions/12", body: { notes: "ORB held", rating: 4 } });

  d = fakeDesk(session);
  await endReplay(12, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/sessions/12/end", body: {} });
});

test("advance sends either a target time or a step, with only the tape settings that are set", async () => {
  let d = fakeDesk(delta);
  await advanceReplay(12, { to: "2026-04-07T14:08:00Z" }, { interval: "5m", minSize: 100, minNotional: 0, maxPrints: 500 }, { client: d.client });
  assert.deepEqual(d.calls[0], {
    method: "POST",
    path: "/api/desk/replay/sessions/12/advance",
    body: { to: "2026-04-07T14:08:00Z", interval: "5m", min_size: 100, max_prints: 500 },
  });

  d = fakeDesk(delta);
  await advanceReplay(12, { step: "next_signal" }, {}, { client: d.client });
  assert.deepEqual(d.calls[0]!.body, { step: "next_signal" });

  d = fakeDesk(delta);
  const result = await advanceReplay(12, { step: "bar" }, { minNotional: 200_000 }, { client: d.client });
  assert.deepEqual(d.calls[0]!.body, { step: "bar", min_notional: 200_000 });
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

test("a payload that does not match the contract rejects as malformed", async () => {
  const days = await loadReplayDays({}, { client: fakeDesk({ days: "nope" }).client }).catch((error: unknown) => error);
  assert.ok(days instanceof DeskApiError);
  assert.equal(days.kind, "malformed");

  const one = await loadReplaySession(12, { client: fakeDesk({ ...session, marks: [{ id: 1 }] }).client }).catch((error: unknown) => error);
  assert.ok(one instanceof DeskApiError);
  assert.equal(one.kind, "malformed");
});

test("a 422 with spec problems rejects with the problems attached", async () => {
  const problems = [{ path: "day", message: "day must be a trading day" }];
  const error = await createReplaySession(spec, { client: fakeDesk({ detail: { problems } }, 422).client }).catch((caught: unknown) => caught);
  assert.ok(error instanceof DeskApiError);
  assert.deepEqual([error.kind, error.status, error.problems], ["http", 422, problems]);
});

test("the thread loaders use the thread routes: list, read, create, patch the plan, close", async () => {
  let d = fakeDesk([activeThread]);
  assert.equal((await loadThreads({ client: d.client })).length, 1);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/threads", body: undefined });

  d = fakeDesk(thread);
  assert.equal((await loadThread(1, { client: d.client })).daily.length, 8);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/threads/1", body: undefined });

  const create = { schemaVersion: 1, mode: "day", startingBalance: 50000, plan: { stopNoteOnEntry: "yes", tradeOnlyOnSignal: "no" } };
  d = fakeDesk(thread);
  await createThread(create, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/threads", body: create });

  const patch = { schemaVersion: 1, plan: { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" } };
  d = fakeDesk(thread);
  await patchThread(1, patch, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PATCH", path: "/api/desk/replay/threads/1", body: patch });

  d = fakeDesk(closedThread);
  assert.equal((await closeThread(3, { client: d.client })).thread.status, "closed");
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/threads/3/close", body: {} });
});

test("a new daily plan names its thread; continuing sends an empty body", async () => {
  const answer = { plan: (await import("../replay/dailyFixtures.ts")).plan, day_list_id: null };
  let d = fakeDesk(answer);
  await openNextDay({ schemaVersion: 1 }, { client: d.client, threadId: 4 });
  assert.deepEqual(d.calls[0]!.body, { plan: { schemaVersion: 1 }, threadId: 4 });
  d = fakeDesk(answer);
  await openNextDay({ schemaVersion: 1 }, { client: d.client });
  assert.deepEqual(d.calls[0]!.body, { plan: { schemaVersion: 1 } });
  d = fakeDesk(answer);
  await openNextDay(undefined, { client: d.client });
  assert.deepEqual(d.calls[0]!.body, {});
  d = fakeDesk(answer);
  await openNextDay(undefined, { client: d.client, threadId: 4 }); // several day threads: continue THIS thread's plan
  assert.deepEqual(d.calls[0]!.body, { threadId: 4 });
});

test("the daily card reads the named thread's plan, else the newest day thread's", async () => {
  const answer = { plan: null, thread: null };
  let d = fakeDesk(answer);
  await loadDaily({ client: d.client, threadId: 9 });
  assert.equal(d.calls[0]!.path, "/api/desk/replay/daily?threadId=9");
  d = fakeDesk(answer);
  await loadDaily({ client: d.client });
  assert.equal(d.calls[0]!.path, "/api/desk/replay/daily");
});

test("deleting a thread sends DELETE to its route and expects no body", async () => {
  const d = fakeDesk(undefined, 204);
  assert.equal(await deleteThread(6, { client: d.client }), undefined);
  assert.deepEqual(d.calls[0], { method: "DELETE", path: "/api/desk/replay/threads/6", body: undefined });
});

test("re-listing a day posts the new list time to the day's relist route (D-012)", async () => {
  const d = fakeDesk((await import("../replay/dailyFixtures.ts")).dayList);
  const list = await relistDay(7, "10:00", { client: d.client });
  assert.equal(list.relist, null);
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/day-lists/7/relist", body: { listAt: "10:00" } });
});
