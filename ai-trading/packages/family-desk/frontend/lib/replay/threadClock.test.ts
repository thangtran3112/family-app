import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDeskApiClient } from "../api/client.ts";
import { formatEtClock } from "../desk/format.ts";
import { PRACTICE_COPY, containsPracticeBannedTerm, replayBadgeText } from "../desk/freshness.ts";
import { replayStatusLine } from "./statusLine.ts";
import {
  atHorizon,
  checkJump,
  clockControls,
  clockStateText,
  commandThreadClock,
  extrapolate,
  loadThreadClock,
  nextOpenChip,
  shownClock,
  ThreadClockSchema,
  type ThreadClock,
} from "./threadClock.ts";

// Mon 2026-09-28, 9:30 AM ET. The next open is Tue 09-29 at 9:30 AM ET; the data reaches Fri 10-02 at 8:00 PM ET.
const clock = (over: Partial<ThreadClock> = {}): ThreadClock => ({
  thread_id: 7,
  state: "running",
  running: true,
  speed: 5,
  clock: "2026-09-28T13:30:00Z",
  start_at: "2026-09-28T13:30:00Z",
  horizon: "2026-10-03T00:00:00Z",
  next_open: "2026-09-29T13:30:00Z",
  pause: null,
  server_now: "2026-11-01T20:00:00Z",
  account: { balance: 50000, open_pnl_usd: 12.5, equity_usd: 50012.5, buying_power_usd: 49000, since_start_usd: 12.5, positions: 1, as_of: "2026-09-28T13:30:00Z" },
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

test("a running clock label moves with wall time at the chosen speed through the close, the night and the weekend; a paused one does not move", () => {
  assert.equal(extrapolate(clock(), 2000), "2026-09-28T13:30:10.000Z"); // 2 s at 5x
  assert.equal(extrapolate(clock(), 0), "2026-09-28T13:30:00Z");
  assert.equal(extrapolate(clock({ speed: 10 }), 1_200_000), "2026-09-28T16:50:00.000Z"); // 200 market minutes
  assert.equal(extrapolate(clock({ speed: 10 }), 3_600_000), "2026-09-28T23:30:00.000Z"); // an hour at 10x runs past the 4:00 PM close
  assert.equal(extrapolate(clock({ speed: 1, clock: "2026-09-28T20:00:00Z" }), 3_600_000), "2026-09-28T21:00:00.000Z"); // the evening goes on at 1x
  assert.equal(extrapolate(clock({ speed: 1, clock: "2026-10-02T20:00:00Z" }), 48 * 3_600_000), "2026-10-03T00:00:00.000Z"); // the weekend is ordinary time, up to the horizon
  assert.equal(extrapolate(clock({ state: "paused", running: false }), 60_000), "2026-09-28T13:30:00Z");
  assert.equal(extrapolate(clock({ clock: null, state: "not_started", running: false }), 60_000), null);
});

test("the label never passes the horizon, where the server stops the clock", () => {
  assert.equal(extrapolate(clock({ speed: 10, clock: "2026-10-02T23:59:00Z" }), 60_000), "2026-10-03T00:00:00.000Z");
  assert.equal(extrapolate({ clock: "2026-10-02T23:59:00Z", running: true, speed: 10, state: "running" }, 60_000), "2026-10-03T00:09:00.000Z", "a caller with no horizon is not capped");
});

test("while a clock read is failing the label is held at the last confirmed time instead of running on", () => {
  assert.equal(shownClock(clock(), 60_000, false), extrapolate(clock(), 60_000)); // confirmed: it moves
  assert.equal(shownClock(clock(), 60_000, true), "2026-09-28T13:30:00Z"); // failing: held at what the server last said
  assert.equal(shownClock(clock({ clock: null, state: "not_started", running: false }), 60_000, true), null);
});

test("the state pill: running says its speed, paused says paused, and the horizon says the data ends there", () => {
  assert.equal(clockStateText(clock()), "Running at 5x");
  assert.equal(clockStateText(clock({ state: "paused", running: false })), "Paused");
  const stopped = clock({ state: "paused", running: false, pause: { kind: "horizon" } });
  assert.equal(clockStateText(stopped), "Paused at the latest available data");
  assert.equal(atHorizon(stopped), true);
  assert.equal(atHorizon(clock()), false);
  assert.equal(atHorizon(clock({ pause: { kind: "other" } })), false);
  assert.equal(clockStateText(clock({ state: "not_started", running: false })), "");
});

test("what the board may do: Play and the rest need a started thread, and Play has nowhere to go at the horizon", () => {
  assert.deepEqual(clockControls(clock()), { play: true, started: true });
  assert.deepEqual(clockControls(clock({ state: "paused", running: false })), { play: true, started: true });
  assert.deepEqual(clockControls(clock({ state: "paused", running: false, pause: { kind: "horizon" } })), { play: false, started: true });
  assert.deepEqual(clockControls(clock({ state: "not_started", clock: null })), { play: false, started: false });
  assert.deepEqual(clockControls(null), { play: false, started: false });
});

test("Next open is the server's next 9:30 ET open sent as a Jump, and it is off when the data reaches no later open", () => {
  const chip = nextOpenChip(clock());
  assert.equal(chip.to, "2026-09-29T13:30:00Z");
  assert.equal(chip.label, "Next open · Tue 2026-09-29 · 9:30 AM ET");
  assert.equal(chip.disabledReason, null);
  assert.equal(nextOpenChip(clock({ next_open: null })).to, null, "past the horizon");
  assert.equal(nextOpenChip(clock({ next_open: null })).disabledReason, PRACTICE_COPY.clockNextOpenNone);
  assert.equal(nextOpenChip(clock({ state: "not_started", clock: null })).to, null);
  assert.equal(nextOpenChip(null).to, null);
  assert.equal(nextOpenChip(null).label, "Next open");
  // The open after a Friday close is Monday's: whatever the server says is what is sent, not a date the browser worked out.
  assert.equal(nextOpenChip(clock({ clock: "2026-10-02T20:00:00Z", next_open: "2026-10-05T13:30:00Z" })).to, "2026-10-05T13:30:00Z");
});

test("Jump: a date and a time in New York time become the instant sent, forward only and no later than the horizon (ADR-0025)", () => {
  const c = clock();
  const now = "2026-09-28T13:30:00Z";
  assert.deepEqual(checkJump(c, now, "2026-09-29", "11:15"), { to: "2026-09-29T15:15:00.000Z", problem: null }, "EDT: 11:15 ET is 15:15 UTC");
  assert.equal(checkJump(c, now, "2026-10-02", "20:00").to, "2026-10-03T00:00:00.000Z", "the horizon itself is allowed");
  const late = checkJump(c, now, "2026-10-02", "20:01");
  assert.equal(late.to, null);
  assert.equal(late.problem, "The data reaches Fri 2026-10-02 · 8:00 PM ET · pick an earlier time");
  assert.equal(checkJump(c, now, "2026-09-28", "09:30").problem, PRACTICE_COPY.clockJumpBack, "the same minute is not ahead");
  assert.equal(checkJump(c, now, "2026-09-28", "09:00").to, null, "a past time is no target");
  assert.equal(checkJump(c, now, "2026-09-28", "09:00").problem, PRACTICE_COPY.clockJumpBack, "and it says why: Jump never goes back");
  // Half-typed or empty boxes are no target and no problem.
  assert.deepEqual(checkJump(c, now, "", ""), { to: null, problem: null });
  assert.deepEqual(checkJump(c, now, "2026-09-29", ""), { to: null, problem: null });
  assert.equal(checkJump(clock({ horizon: "2027-02-01T00:00:00Z" }), now, "2027-01-04", "10:00").to, "2027-01-04T15:00:00.000Z", "EST in January");
  assert.equal(checkJump(c, null, "2026-09-29", "10:00").problem, null, "no confirmed time yet: only the horizon applies");
});

test("the clock answer parses and a wrong speed or state is a plain error", () => {
  assert.equal(ThreadClockSchema.parse(clock()).account?.equity_usd, 50012.5);
  assert.equal(ThreadClockSchema.parse(clock({ pause: { kind: "horizon" }, state: "paused", running: false })).pause?.kind, "horizon");
  assert.equal(ThreadClockSchema.parse(clock({ state: "not_started", clock: null, start_at: null, next_open: null, running: false, account: null })).state, "not_started");
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), speed: 3 }).success, false);
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), state: "playing" }).success, false);
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), state: "no_day" }).success, false, "there is no day to wait for any more");
  assert.equal(ThreadClockSchema.safeParse({ ...clock(), state: "at_close" }).success, false); // the close stops nothing: no state waits there
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- an answer without the horizon
  const { horizon: _horizon, ...noHorizon } = clock();
  assert.equal(ThreadClockSchema.safeParse(noHorizon).success, false, "the horizon is part of every answer");
});

test("the loaders hit the thread clock route with the body the server reads; Next open is a Jump, and no skip route exists", async () => {
  const read = fakeDesk(clock());
  assert.equal((await loadThreadClock(7, { client: read.client })).speed, 5);
  const play = fakeDesk(clock());
  await commandThreadClock(7, { running: true, speed: 10 }, { client: play.client });
  assert.deepEqual(play.calls.map((c) => [c.method, c.path, JSON.parse(c.body ?? "{}")]), [["POST", "/api/desk/replay/threads/7/clock", { running: true, speed: 10 }]]);
  const jump = fakeDesk(clock());
  await commandThreadClock(7, { to: "2026-09-29T15:15:00.000Z" }, { client: jump.client });
  assert.deepEqual(jump.calls.map((c) => [c.method, c.path, JSON.parse(c.body ?? "{}")]), [["POST", "/api/desk/replay/threads/7/clock", { to: "2026-09-29T15:15:00.000Z" }]]);
  const next = fakeDesk(clock());
  await commandThreadClock(7, { to: nextOpenChip(clock()).to! }, { client: next.client });
  assert.deepEqual(next.calls.map((c) => [c.method, c.path, JSON.parse(c.body ?? "{}")]), [["POST", "/api/desk/replay/threads/7/clock", { to: "2026-09-29T13:30:00Z" }]]);
});

test("the clock copy says what a move does to positions and never the old hand-over or skip wording", () => {
  const copy = [
    PRACTICE_COPY.clockHint,
    PRACTICE_COPY.clockJumpHint.replace("{horizon}", "Fri"),
    PRACTICE_COPY.clockNextOpenStays,
    PRACTICE_COPY.clockNextOpenStaysOne,
    PRACTICE_COPY.clockStateHorizon,
    PRACTICE_COPY.clockHorizonNote,
  ];
  for (const text of copy) assert.equal(containsPracticeBannedTerm(text), false, text);
  for (const text of copy) assert.doesNotMatch(text, /day ends|hands over|closes with it|skip day|\bDay \d+ of\b|\bblock\b/i, text);
  assert.match(PRACTICE_COPY.clockNextOpenStaysOne, /stays open and is priced at the new time/);
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
  assert.match(workspace, /useReportPracticeChrome\(\{[^}]*playhead: shownClock, status: replayStatusLine\([^)]*shownClock\)/);
  // The report is a layout effect (a passive one ran after the chart's effects and the paint, so the footer trailed the readout by about
  // 400 ms), and it reads only the setter, so a report does not re-render the screen that made it.
  const chrome = source("../../components/shell/desktop/PracticeChrome.tsx");
  const report = chrome.slice(chrome.indexOf("export function useReportPracticeChrome"), chrome.indexOf("export function PracticeBand"));
  assert.doesNotMatch(report, /useEffect|usePracticeChrome|StateContext/);
  assert.equal((report.match(/useLayoutEffect\(/g) ?? []).length, 3);
  assert.match(report, /useSetter\(\)/);
});
