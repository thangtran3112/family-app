import assert from "node:assert/strict";
import test from "node:test";
import { DailySchema, DayListSchema } from "./daily.ts";
import { dayList, plan } from "./dailyFixtures.ts";
import { MarkResultSchema, ReplaySessionSchema } from "./schemas.ts";
import { markResult, session } from "./fixtures.ts";
import { activeThread, closedThread, freshThread, thread, threadBrief } from "./threadFixtures.ts";
import { ThreadBriefSchema, ThreadSchema, ThreadSummarySchema, ThreadsSchema } from "./threads.ts";

test("the thread payloads parse, and the curve and daily rows agree with the stats", () => {
  assert.equal(ThreadSchema.parse(thread).daily.length, 8);
  assert.equal(ThreadsSchema.parse([activeThread]).length, 1);
  assert.equal(ThreadSchema.parse(freshThread).curve.length, 1);
  assert.equal(ThreadSchema.parse(closedThread).thread.status, "closed");
  assert.equal(thread.curve.at(-1)?.balance, thread.thread.stats.balance);
  assert.equal(thread.daily.at(-1)?.balance, thread.thread.stats.balance);
  assert.equal(thread.daily.filter((day) => day.kind === "practiced").length, thread.thread.stats.daysPracticed);
  assert.equal(thread.daily.filter((day) => day.kind === "skipped").length, thread.thread.stats.daysSkipped);
});

test("a thread keeps the contract's rules: closedAt exactly when closed, strict keys, no null stats", () => {
  assert.equal(ThreadSummarySchema.safeParse({ ...activeThread, thread: { ...activeThread.thread, closedAt: "2026-03-06T21:00:00Z" } }).success, false);
  assert.equal(ThreadSummarySchema.safeParse({ ...closedThread, thread: { ...closedThread.thread, closedAt: undefined } }).success, false);
  assert.equal(ThreadSummarySchema.safeParse({ ...activeThread, thread: { ...activeThread.thread, extra: 1 } }).success, false);
  assert.equal(ThreadSummarySchema.safeParse({ ...activeThread, thread: { ...activeThread.thread, stats: { ...activeThread.thread.stats, winRate: null } } }).success, false);
});

test("the thread header strip parses, with and without a day under way, and rejects a bad status", () => {
  assert.equal(ThreadBriefSchema.parse(threadBrief).balance, 50123);
  assert.equal(ThreadBriefSchema.parse({ ...threadBrief, today_pnl_usd: null }).today_pnl_usd, null);
  assert.equal(ThreadBriefSchema.safeParse({ ...threadBrief, status: "paused" }).success, false);
  assert.equal(ThreadBriefSchema.safeParse({ ...threadBrief, balance: Number.NaN }).success, false);
});

test("the daily card, the day list, the session and a mark carry the thread", () => {
  assert.equal(DailySchema.parse({ plan, thread: activeThread }).thread?.thread.id, 1);
  assert.equal(DailySchema.parse({ plan: null, thread: null }).thread, null);
  assert.equal(DailySchema.safeParse({ plan }).success, false, "the thread key is part of the answer");
  assert.equal(DayListSchema.parse(dayList).thread?.balance, 50123);
  assert.equal(ReplaySessionSchema.parse({ ...session, thread_id: 1, thread: threadBrief }).thread?.today_pnl_usd, 112);
  assert.equal(ReplaySessionSchema.parse(session).thread, null);
  assert.equal(MarkResultSchema.parse({ ...markResult, thread: threadBrief }).thread?.balance, 50123);
});
