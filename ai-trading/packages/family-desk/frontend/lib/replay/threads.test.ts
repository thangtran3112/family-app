import assert from "node:assert/strict";
import test from "node:test";
import { MarkResultSchema, ReplaySessionSchema } from "./schemas.ts";
import { markResult, session } from "./fixtures.ts";
import { activeThread, closedThread, freshThread, thread, threadBrief } from "./threadFixtures.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { ThreadBriefSchema, ThreadCapacitySchema, ThreadClockBriefSchema, ThreadDateSchema, ThreadSchema, ThreadSummarySchema, ThreadsSchema } from "./threads.ts";

test("the thread payloads parse, and the curve and the dated rows agree with the stats", () => {
  assert.equal(ThreadSchema.parse(thread).daily.length, 6);
  assert.equal(ThreadsSchema.parse([activeThread]).length, 1);
  assert.equal(ThreadSchema.parse(freshThread).curve.length, 1);
  assert.equal(ThreadSchema.parse(closedThread).thread.status, "closed");
  assert.equal(thread.curve.at(-1)?.balance, thread.thread.stats.balance);
  assert.equal(thread.daily.at(-1)?.balance, thread.thread.stats.balance);
  assert.deepEqual(thread.daily.map((day) => day.n), [1, 2, 3, 4, 5, 6], "one row per ET date with a trade, numbered in order");
  assert.equal(new Set(thread.daily.map((day) => day.day)).size, thread.daily.length, "an ET date appears once");
});

test("a summary carries the thread's clock and its open-position count, and no day or mode state", () => {
  const parsed = ThreadSummarySchema.parse(activeThread);
  assert.equal(parsed.clock?.clock, "2026-03-10T13:41:00Z");
  assert.equal(parsed.positions_open, 2);
  for (const gone of ["today", "last_day", "swing"]) assert.equal(gone in parsed, false, gone);
  assert.equal(ThreadSummarySchema.parse({ ...activeThread, clock: null }).clock, null, "a thread with no setup has no time yet");
  assert.equal(ThreadSummarySchema.safeParse({ ...activeThread, positions_open: undefined }).success, false);
  assert.equal(ThreadSummarySchema.safeParse({ ...activeThread, clock: { ...activeThread.clock, speed: 3 } }).success, false);
});

test("the clock brief takes a horizon pause and rejects a speed the server does not offer", () => {
  assert.equal(ThreadClockBriefSchema.parse({ clock: "2026-03-10T13:41:00Z", running: false, speed: 10, start_at: null, pause: { kind: "horizon" } }).pause?.kind, "horizon");
  assert.equal(ThreadClockBriefSchema.safeParse({ clock: "2026-03-10T13:41:00Z", running: false, speed: 7, start_at: null, pause: null }).success, false);
});

test("a thread keeps the contract's rules: closedAt exactly when closed, strict keys, no null stats", () => {
  assert.equal(ThreadSummarySchema.safeParse({ ...activeThread, thread: { ...activeThread.thread, closedAt: "2026-03-06T21:00:00Z" } }).success, false);
  assert.equal(ThreadSummarySchema.safeParse({ ...closedThread, thread: { ...closedThread.thread, closedAt: undefined } }).success, false);
  assert.equal(ThreadSummarySchema.safeParse({ ...activeThread, thread: { ...activeThread.thread, extra: 1 } }).success, false);
  assert.equal(ThreadSummarySchema.safeParse({ ...activeThread, thread: { ...activeThread.thread, stats: { ...activeThread.thread.stats, winRate: null } } }).success, false);
});

test("a dated row is an ET date: a weekend is allowed, a date that is not one is not", () => {
  assert.equal(ThreadDateSchema.parse({ n: 1, day: "2026-03-07", weekday: "Sat", trades: 1, pnl_usd: 12, balance: 50012 }).weekday, "Sat");
  assert.equal(ThreadDateSchema.safeParse({ n: 1, day: "2026-03-07", weekday: "Funday", trades: 1, pnl_usd: 12, balance: 50012 }).success, false);
  assert.equal(ThreadDateSchema.safeParse({ n: 1, day: "March 7", weekday: "Sat", trades: 1, pnl_usd: 12, balance: 50012 }).success, false);
});

test("the thread header strip parses (the realized balance only) and rejects a bad status", () => {
  assert.equal(ThreadBriefSchema.parse(threadBrief).balance, 50123);
  assert.equal("today_pnl_usd" in ThreadBriefSchema.parse(threadBrief), false);
  assert.equal(ThreadBriefSchema.safeParse({ ...threadBrief, status: "paused" }).success, false);
  assert.equal(ThreadBriefSchema.safeParse({ ...threadBrief, balance: Number.NaN }).success, false);
});

test("the session and a mark carry the thread's balance", () => {
  assert.equal(ReplaySessionSchema.parse({ ...session, thread_id: 1, thread: threadBrief }).thread?.balance, 50123);
  assert.equal(ReplaySessionSchema.parse(session).thread, null);
  assert.equal(MarkResultSchema.parse({ ...markResult, thread: threadBrief }).thread?.balance, 50123);
});

test("the thread slots parse, and their words are the server's sentence (ADR-0025)", () => {
  assert.deepEqual(ThreadCapacitySchema.parse({ day_active: 7, day_max: 10 }), { day_active: 7, day_max: 10 });
  assert.equal(ThreadCapacitySchema.safeParse({ day_active: "7", day_max: 10 }).success, false);
  assert.equal(practiceText("threadSlots", { active: 7, max: 10 }), "Thread slots 7 of 10");
  assert.equal(practiceText("threadSlotsFull", { max: 10 }), "All 10 thread slots are in use · close a thread to start another", "the form says what the server's 409 says");
  assert.equal(PRACTICE_COPY.threadSlots.includes("{active}"), true);
});
