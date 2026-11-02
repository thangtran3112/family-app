import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDeskApiClient } from "../api/client.ts";
import { formatEtClock } from "../desk/format.ts";
import { PRACTICE_COPY, replayBadgeText } from "../desk/freshness.ts";
import { replayStatusLine } from "./statusLine.ts";
import {
  checkJump,
  clockControls,
  clockProgress,
  clockStateText,
  commandThreadClock,
  extrapolate,
  isLastDay,
  shownClock,
  loadThreadClock,
  rolledText,
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
  window_end: "2026-09-28T20:00:00Z",
  focus_end: "2026-09-28T15:30:00Z",
  next_start: "2026-09-29T13:30:00Z",
  jump_limit: "2026-10-02T13:30:00Z",
  server_now: "2026-11-01T20:00:00Z",
  account: { balance: 50000, open_pnl_usd: 12.5, equity_usd: 50012.5, buying_power_usd: 49000, day_pnl_usd: 12.5, positions: 1, as_of: "2026-09-28T13:30:00Z" },
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

test("a running clock label moves with wall time at the chosen speed and never stops: not at her window, the close, the night or the weekend; a paused one does not move", () => {
  assert.equal(extrapolate(clock(), 2000), "2026-09-28T13:30:10.000Z"); // 2 s at 5x
  assert.equal(extrapolate(clock(), 0), "2026-09-28T13:30:00Z");
  assert.equal(extrapolate(clock({ speed: 10 }), 1_200_000), "2026-09-28T16:50:00.000Z"); // 200 market minutes: far past her 11:30 mark
  assert.equal(extrapolate(clock({ speed: 10 }), 3_600_000), "2026-09-28T23:30:00.000Z"); // an hour at 10x runs past the 20:00 tape end
  assert.equal(extrapolate(clock({ speed: 1, clock: "2026-09-28T20:00:00Z" }), 3_600_000), "2026-09-28T21:00:00.000Z"); // the evening goes on at 1x
  assert.equal(extrapolate(clock({ speed: 1, clock: "2026-10-02T20:00:00Z" }), 48 * 3_600_000), "2026-10-04T20:00:00.000Z"); // and so does the weekend
  assert.equal(extrapolate(clock({ state: "paused", running: false }), 60_000), "2026-09-28T13:30:00Z");
  assert.equal(extrapolate(clock({ clock: null, state: "no_day", running: false }), 60_000), null);
});

test("while a clock read is failing the label is held at the last confirmed time instead of running on", () => {
  assert.equal(shownClock(clock(), 60_000, false), extrapolate(clock(), 60_000)); // confirmed: it moves
  assert.equal(shownClock(clock(), 60_000, true), "2026-09-28T13:30:00Z"); // failing: held at what the server last said
  assert.equal(shownClock(clock({ clock: null, state: "no_day", running: false }), 60_000, true), null);
});

test("the state pill and what the board may do: it is always there for an open day and nothing but Pause stops the clock", () => {
  assert.equal(clockStateText(clock()), "Running at 5x");
  assert.equal(clockStateText(clock({ state: "paused", running: false })), "Paused");
  assert.deepEqual(clockControls(clock()), { play: true, started: true, skip: true });
  assert.deepEqual(clockControls(clock({ state: "paused", running: false })), { play: true, started: true, skip: true }); // no name opened yet: the same board
  assert.deepEqual(clockControls(clock({ state: "no_day" })), { play: false, started: false, skip: false });
  assert.deepEqual(clockControls(null), { play: false, started: false, skip: false });
});

test("progress runs 0 to 1 over the day's tape, is full after it and is 0 before the day starts", () => {
  assert.equal(clockProgress(clock(), "2026-09-28T16:45:00Z"), 0.5);
  assert.equal(clockProgress(clock(), "2026-09-28T20:00:00Z"), 1);
  assert.equal(clockProgress(clock(), "2026-09-29T02:00:00Z"), 1); // the night after the tape: the bar is full, the clock goes on
  assert.equal(clockProgress(clock({ window_start: null, window_end: null }), "2026-09-28T14:30:00Z"), 0);
  assert.equal(clockProgress(clock(), null), 0);
});

test("the clock reaching the next session is told once as a hand-over to the next day", () => {
  assert.equal(rolledText(2, { day_no: 3 }), "The clock reached the next session. Day 2 ended and every open position closed with it. Day 3 is on the Day list.");
  assert.equal(rolledText(2, { day_no: null }), "The clock reached the next session. Day 2 ended and every open position closed with it.");
});

test("Jump: a date and a time in New York time become the instant sent, forward only and no later than the plan's end (ADR-0023)", () => {
  const c = clock();
  const now = "2026-09-28T13:30:00Z";
  assert.deepEqual(checkJump(c, now, "2026-09-29", "11:15"), { to: "2026-09-29T15:15:00.000Z", problem: null }, "EDT: 11:15 ET is 15:15 UTC");
  assert.equal(checkJump(c, now, "2026-10-02", "09:30").to, "2026-10-02T13:30:00.000Z", "the plan's end itself is allowed");
  const late = checkJump(c, now, "2026-10-02", "09:31");
  assert.equal(late.to, null);
  assert.match(late.problem ?? "", /^The plan ends Fri 2026-10-02 · 9:30 AM ET · pick an earlier time$/);
  assert.equal(checkJump(c, now, "2026-09-28", "09:30").problem, PRACTICE_COPY.clockJumpBack, "the same minute is not ahead");
  assert.equal(checkJump(c, now, "2026-09-28", "09:00").to, null, "a past time is no target");
  // Half-typed or empty boxes are no target and no problem; no limit leaves the bound to the server.
  assert.deepEqual(checkJump(c, now, "", ""), { to: null, problem: null });
  assert.deepEqual(checkJump(c, now, "2026-09-29", ""), { to: null, problem: null });
  assert.equal(checkJump({ jump_limit: null }, now, "2027-01-04", "10:00").to, "2027-01-04T15:00:00.000Z", "EST in January");
  assert.equal(checkJump(c, null, "2026-09-29", "10:00").problem, null, "no confirmed time yet: only the limit applies");
});

test("the last day of the plan is the one whose next open is also where the plan ends", () => {
  assert.equal(isLastDay(clock()), false);
  assert.equal(isLastDay(clock({ next_start: "2026-10-02T13:30:00Z" })), true);
  assert.equal(isLastDay(clock({ next_start: null })), false);
});

test("the clock answer parses and a wrong speed or state is a plain error", () => {
  assert.equal(ThreadClockSchema.parse(clock()).account?.equity_usd, 50012.5);
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), speed: 3 }).success, false);
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), state: "playing" }).success, false);
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), state: "at_close" }).success, false); // the close stops nothing: no state waits there
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), state: "listed" }).success, false); // a day's clock exists before any name is opened
  assert.equal(SkipDaySchema.safeParse({ ended_day_list_id: 12, next_day_list_id: null, clock: clock({ state: "no_day", day_list_id: null, clock: null }) }).success, true);
});

test("the loaders hit the thread clock and skip routes with the body the server reads", async () => {
  const read = fakeDesk(clock());
  assert.equal((await loadThreadClock(7, { client: read.client })).speed, 5);
  const play = fakeDesk(clock());
  await commandThreadClock(7, { running: true, speed: 10 }, { client: play.client });
  assert.deepEqual(play.calls.map((c) => [c.method, c.path, JSON.parse(c.body ?? "{}")]), [["POST", "/api/desk/replay/threads/7/clock", { running: true, speed: 10 }]]);
  const jump = fakeDesk(clock());
  await commandThreadClock(7, { to: "2026-09-29T15:15:00.000Z" }, { client: jump.client });
  assert.deepEqual(jump.calls.map((c) => [c.method, c.path, JSON.parse(c.body ?? "{}")]), [["POST", "/api/desk/replay/threads/7/clock", { to: "2026-09-29T15:15:00.000Z" }]]);
  const skip = fakeDesk({ ended_day_list_id: 12, next_day_list_id: 13, clock: clock({ state: "paused", running: false }) });
  const result = await skipThreadDay(7, { client: skip.client });
  assert.deepEqual(skip.calls.map((c) => [c.method, c.path]), [["POST", "/api/desk/replay/threads/7/skip-day"]]);
  assert.match(skippedText(result), /next day is ready/);
  assert.match(skippedText({ ...result, next_day_list_id: null }), /still being prepared/);
  assert.match(skippedText({ ...result, next_day_list_id: null, clock: clock({ state: "no_day" }) }), /last day/);
});

test("one visible clock: the readout, the status bar and the chip read the same ticking value, not the poll (D-166)", () => {
  // The poll answered 9:32:05 and the clock runs at 10x: two wall seconds later the screen says 9:32:25 everywhere.
  const shown = extrapolate({ clock: "2026-09-25T13:32:05Z", running: true, speed: 10, state: "running" }, 2000);
  assert.equal(shown, "2026-09-25T13:32:25.000Z");
  assert.equal(formatEtClock(shown), "9:32:25 AM ET");
  assert.equal(replayStatusLine("sip", shown as string).right[0], "Replay clock 9:32:25 AM ET");
  assert.equal(replayBadgeText(shown), "Replay · Fri 2026-09-25 · 9:32:25 AM ET");
  // Paused: no second reading of the polled value moves it.
  assert.equal(extrapolate({ clock: "2026-09-25T13:32:05Z", running: false, speed: 10, state: "paused" }, 2000), "2026-09-25T13:32:05Z");
});

test("the status bar and the chip are reported in the commit that draws the readout, from the same value (D-172)", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const workspace = source("../../components/practice/replay/ReplayWorkspace.tsx");
  // One value feeds all three: the readout, the chip's playhead and the status line.
  assert.match(workspace, /<span data-testid="thread-clock-time">\{formatEtDateClock\(shownClock\)\}<\/span>/);
  assert.match(workspace, /useReportPracticeChrome\(\{[^}]*playhead: shownClock, status: replayStatusLine\(session\.tape_feed, shownClock\)/);
  // The report is a layout effect (a passive one ran after the chart's effects and the paint, so the footer trailed the readout by about
  // 400 ms), and it reads only the setter, so a report does not re-render the screen that made it.
  const chrome = source("../../components/shell/desktop/PracticeChrome.tsx");
  const report = chrome.slice(chrome.indexOf("export function useReportPracticeChrome"), chrome.indexOf("export function PracticeBand"));
  assert.doesNotMatch(report, /useEffect|usePracticeChrome|StateContext/);
  assert.equal((report.match(/useLayoutEffect\(/g) ?? []).length, 3);
  assert.match(report, /useSetter\(\)/);
});
