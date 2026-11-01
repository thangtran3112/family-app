import assert from "node:assert/strict";
import test from "node:test";
import { createDeskApiClient } from "../api/client.ts";
import {
  clockControls,
  clockProgress,
  clockStateText,
  commandThreadClock,
  extrapolate,
  loadThreadClock,
  pauseText,
  skippedText,
  skipThreadDay,
  SkipDaySchema,
  ThreadClockSchema,
  type ThreadClock,
} from "./threadClock.ts";

const clock = (over: Partial<ThreadClock> = {}): ThreadClock => ({
  thread_id: 7,
  state: "running",
  day_list_id: 12,
  day_no: 2,
  running: true,
  speed: 5,
  clock: "2026-09-28T13:30:00Z",
  window_start: "2026-09-28T13:30:00Z",
  window_end: "2026-09-28T15:30:00Z",
  server_now: "2026-11-01T20:00:00Z",
  pause: null,
  account: { balance: 50000, open_pnl_usd: 12.5, equity_usd: 50012.5, day_pnl_usd: 12.5, positions: 1, as_of: "2026-09-28T13:30:00Z" },
  label: "Simulated money · practice only, never a real account",
  ...over,
});

function fakeDesk(answer: unknown, status = 200) {
  const calls: { path: string; method: string; body: string | null }[] = [];
  const client = createDeskApiClient(
    async (input, init) => {
      const url = input as URL;
      calls.push({ path: url.pathname, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
      return Response.json(answer, { status });
    },
    () => ({ href: "https://trading.test/" }),
  );
  return { client, calls };
}

test("a running clock label moves with wall time at the chosen speed and stops at the close; a paused one does not move", () => {
  assert.equal(extrapolate(clock(), 2000), "2026-09-28T13:30:10.000Z"); // 2 s at 5x
  assert.equal(extrapolate(clock(), 0), "2026-09-28T13:30:00Z");
  assert.equal(extrapolate(clock({ speed: 10 }), 3_600_000), "2026-09-28T15:30:00.000Z"); // capped at the window end
  assert.equal(extrapolate(clock({ state: "paused", running: false }), 60_000), "2026-09-28T13:30:00Z");
  assert.equal(extrapolate(clock({ clock: null, state: "listed", running: false }), 60_000), null);
});

test("the state pill, the pause sentence and what the controls may do", () => {
  assert.equal(clockStateText(clock()), "Running at 5x");
  assert.equal(clockStateText(clock({ state: "paused", running: false })), "Paused");
  assert.equal(clockStateText(clock({ state: "at_close", running: false })), "At the close");
  assert.equal(pauseText(null), null);
  assert.match(pauseText({ kind: "stop", at: "2026-09-28T14:21:00Z", symbol: "FLAT", stop_price: 49, price: 50, crossing: "cross", also: [] })!, /FLAT crossed its stop at 49\.00/);
  assert.match(pauseText({ kind: "close", at: "2026-09-28T15:30:00Z", also: [] })!, /reached the close/);
  assert.deepEqual(clockControls(clock()), { play: true, jump: true, started: true, skip: true });
  assert.deepEqual(clockControls(clock({ state: "at_close", running: false })), { play: false, jump: false, started: true, skip: true });
  assert.deepEqual(clockControls(clock({ state: "listed", running: false, clock: null })), { play: false, jump: false, started: false, skip: true });
  assert.deepEqual(clockControls(clock({ state: "no_day" })), { play: false, jump: false, started: false, skip: false });
  assert.deepEqual(clockControls(null), { play: false, jump: false, started: false, skip: false });
});

test("progress runs 0 to 1 over the window and is 0 before the day starts", () => {
  assert.equal(clockProgress(clock(), "2026-09-28T14:30:00Z"), 0.5);
  assert.equal(clockProgress(clock(), "2026-09-28T20:00:00Z"), 1);
  assert.equal(clockProgress(clock({ window_start: null, window_end: null }), "2026-09-28T14:30:00Z"), 0);
  assert.equal(clockProgress(clock(), null), 0);
});

test("the clock answer parses and a wrong speed or state is a plain error", () => {
  assert.equal(ThreadClockSchema.parse(clock()).account?.equity_usd, 50012.5);
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), speed: 3 }).success, false);
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), state: "playing" }).success, false);
  assert.equal(SkipDaySchema.safeParse({ ended_day_list_id: 12, next_day_list_id: null, clock: clock({ state: "no_day", day_list_id: null, clock: null }) }).success, true);
});

test("the loaders hit the thread clock and skip routes with the body the server reads", async () => {
  const read = fakeDesk(clock());
  assert.equal((await loadThreadClock(7, { client: read.client })).speed, 5);
  const play = fakeDesk(clock());
  await commandThreadClock(7, { running: true, speed: 10 }, { client: play.client });
  assert.deepEqual(play.calls.map((c) => [c.method, c.path, JSON.parse(c.body ?? "{}")]), [["POST", "/api/desk/replay/threads/7/clock", { running: true, speed: 10 }]]);
  const skip = fakeDesk({ ended_day_list_id: 12, next_day_list_id: 13, clock: clock({ state: "listed", running: false, clock: null }) });
  const result = await skipThreadDay(7, { client: skip.client });
  assert.deepEqual(skip.calls.map((c) => [c.method, c.path]), [["POST", "/api/desk/replay/threads/7/skip-day"]]);
  assert.match(skippedText(result), /next day is ready/);
  assert.match(skippedText({ ...result, next_day_list_id: null }), /still being prepared/);
  assert.match(skippedText({ ...result, next_day_list_id: null, clock: clock({ state: "no_day" }) }), /last day/);
});
