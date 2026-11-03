import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { clockLine, clockPill, lastActivityText, overviewDateRows, overviewStats, sinceStartText, threadCard } from "./overviewView.ts";
import { activeThread, closedThread, freshThread, threadClockBrief, threadDays } from "./threadFixtures.ts";

test("the card reads the thread's time, its state, its open positions and its last activity: no day number, no progress", () => {
  const card = threadCard(activeThread);
  assert.deepEqual(card, { clock: "Tue 2026-03-10 · 9:41 AM ET", state: "Paused", running: false, positions: "2 open positions", lastActivity: "Oct 23" });
  assert.equal(threadCard(freshThread).positions, "No open positions");
  assert.equal(threadCard(freshThread).lastActivity, "No activity yet");
  assert.equal(threadCard({ ...activeThread, positions_open: 1 }).positions, "1 open position");
  for (const text of Object.values(threadCard(activeThread))) assert.doesNotMatch(String(text), /\bDay \d|practiced|passed|skipped/i);
});

test("a running clock says its speed and a clock stopped at the horizon says why", () => {
  assert.equal(clockPill({ ...threadClockBrief, running: true, speed: 5 }), "Running at 5x");
  assert.equal(clockPill({ ...threadClockBrief, running: false, pause: { kind: "horizon" } }), "Paused at the latest available data");
  assert.equal(clockPill({ ...threadClockBrief, running: false, pause: null }), "Paused");
  assert.equal(clockPill(null), "");
  assert.equal(threadCard({ ...activeThread, clock: { ...threadClockBrief, running: true, speed: 2 } }).running, true);
});

test("a thread with no setup has no clock: the card says so instead of a time", () => {
  const bare = { ...activeThread, clock: null };
  assert.equal(clockLine(bare.clock), "No start time yet");
  assert.equal(threadCard(bare).state, "");
});

test("last activity is the wall-clock day of the last trade or clock move", () => {
  assert.equal(lastActivityText("2026-10-25T03:30:00Z"), "Oct 24", "New York's calendar day, not UTC's");
  assert.equal(lastActivityText(null), "No activity yet");
});

test("the stats are closed trades, win rate, wins, losses and open positions; no days practiced or skipped, no adherence", () => {
  const rows = overviewStats(activeThread.thread.stats, 2);
  assert.deepEqual(rows.map((row) => [row.id, row.value]), [["closed", "14"], ["win_rate", "64%"], ["wins", "9"], ["losses", "5"], ["open", "2"]]);
  assert.deepEqual(overviewStats(freshThread.thread.stats, 0).map((row) => row.value), ["0", "—", "0", "0", "0"]);
  for (const row of rows) assert.doesNotMatch(row.label, /practiced|passed|skipped|adherence/i);
});

test("since start is the signed change from the starting balance", () => {
  assert.equal(sinceStartText(1234.5), "Since start +$1,234.50");
  assert.equal(sinceStartText(-80), "Since start −$80.00");
  assert.equal(sinceStartText(0), "Since start $0.00");
});

test("the results table lists the ET dates that have a trade, the newest first, with the weekday and the date", () => {
  const rows = overviewDateRows(threadDays);
  assert.equal(rows.length, threadDays.length);
  assert.deepEqual(rows.map((row) => row.key), [...threadDays.map((day) => day.day)].reverse());
  assert.deepEqual(rows[0], { key: "2026-03-04", date: "Wed 2026-03-04", trades: "1", result: "+$112.00", resultTone: "up", balance: "$50,123.00" });
  assert.deepEqual([rows.at(-1)!.result, rows.at(-1)!.resultTone], ["−$182.00", "down"]);
  assert.deepEqual(overviewDateRows([]), []);
});

test("nothing the Summary or the card says carries a banned term, and a closed thread keeps its card", () => {
  const texts = [
    ...Object.values(threadCard(activeThread)),
    ...Object.values(threadCard(closedThread)),
    ...overviewStats(activeThread.thread.stats, 2).map((row) => row.label),
    sinceStartText(5),
  ];
  for (const text of texts) assert.equal(containsPracticeBannedTerm(String(text)), false, String(text));
  assert.equal(threadCard(closedThread).positions, "2 open positions", "a closed thread still holds its positions, valued at the time it stopped");
});
