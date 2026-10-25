import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { activeThread, freshThread, thread, threadBrief, threadDays } from "./threadFixtures.ts";
import {
  adherenceTrendText,
  briefLine,
  formatBalance,
  formatDayResult,
  hasNoDays,
  improvementOf,
  planRows,
  startedWithText,
  threadName,
  threadStartedText,
  threadTiles,
  todayLine,
  weeksInText,
  weeksOf,
  winRateText,
} from "./threadView.ts";

test("money is whole dollars with the sign as the cue, and never prints NaN", () => {
  assert.equal(formatBalance(50123.4), "$50,123");
  assert.equal(formatBalance(-1200), "−$1,200");
  assert.equal(formatBalance(null), "—");
  assert.equal(formatDayResult(112), "+$112");
  assert.equal(formatDayResult(-246.6), "−$247");
  assert.equal(formatDayResult(0.2), "$0");
  assert.equal(formatDayResult(-0.2), "$0");
  assert.equal(formatDayResult(Number.NaN), "—");
});

test("the thread card reads in plain words", () => {
  assert.equal(threadName(activeThread.thread), "October thread");
  assert.equal(threadStartedText(activeThread.thread), "Started Oct 5");
  assert.equal(startedWithText(activeThread.thread), "Started with $50,000 · +$123 so far");
  assert.equal(startedWithText(freshThread.thread), "Started with $50,000 · no change yet");
  assert.equal(winRateText(0.64), "64%");
  assert.equal(winRateText(undefined), "—");
  assert.equal(adherenceTrendText(activeThread.thread.stats), "71% → 83%");
  assert.equal(adherenceTrendText({ adherenceFirstPct: 80, adherenceLastPct: 80 }), "80%");
  assert.equal(adherenceTrendText({}), "—");
  assert.equal(todayLine(null as never), "No practice day open · the next list opens when you resume");
  assert.equal(todayLine(activeThread.today), "+$112 realized so far · 1 practice trade");
  assert.equal(briefLine(threadBrief), "Thread balance $50,123 · today +$112");
  assert.equal(briefLine({ ...threadBrief, today_pnl_usd: null }), "Thread balance $50,123");
  assert.equal(weeksInText(1), "first week");
  assert.equal(weeksInText(4), "4 weeks in");
});

test("weeks group the days by calendar week in the order she practised, with skipped days counted", () => {
  const weeks = weeksOf(threadDays);
  assert.deepEqual(weeks.map((week) => [week.label, week.detail, week.pnl]), [
    ["Week 1", "4 days practiced · 1 skipped", 33],
    ["Week 2 · latest", "2 days practiced · 1 skipped", 90],
  ]);
  assert.equal(weeks[0]!.won, 2);
  assert.equal(weeks[0]!.adherencePct, 75);
  assert.equal(weeksOf([]).length, 0);
});

test("improvement stays a caveat until two weeks each have three practice days", () => {
  const few = improvementOf(weeksOf(threadDays));
  assert.equal(few.trend, false);
  assert.equal(few.verdict, null);
  assert.equal(few.caveat?.title, "Too few days to call a trend yet");
  assert.match(few.caveat?.reason ?? "", /week 2 has 2 practice days so far/);
  assert.deepEqual(few.compared?.rows.map((row) => [row.label, row.first, row.latest]), [
    ["Day results", "+$33", "+$90"],
    ["Days won", "2 of 4", "1 of 2"],
    ["Adherence", "75%", "92%"],
    ["Days practiced", "4", "2"],
  ]);
  const one = improvementOf(weeksOf(threadDays.slice(0, 3)));
  assert.equal(one.compared, null);
  assert.match(one.caveat?.reason ?? "", /waits for at least 2 weeks/);

  const day = (n: number, week: number, pnl: number) => ({ ...threadDays[0]!, n, day: `2026-0${week + 1}-0${((n - 1) % 3) + 2}`, pnl_usd: pnl, kind: "practiced" as const });
  const enough = improvementOf(weeksOf([day(1, 1, -30), day(2, 1, -30), day(3, 1, -30), day(4, 2, 30), day(5, 2, 30), day(6, 2, 30)]));
  assert.equal(enough.trend, true);
  assert.equal(enough.caveat, null);
  assert.equal(enough.verdict, "Week 2 averaged +$30 a practice day; week 1 averaged −$30.");
});

test("the ten tiles carry the stats, and an empty thread has no days", () => {
  const tiles = threadTiles(thread);
  assert.equal(tiles.length, 10);
  const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
  assert.deepEqual([byId.practiced!.value, byId.practiced!.sub], ["6", "of 8 days opened"]);
  assert.deepEqual([byId.win_rate!.value, byId.win_rate!.sub], ["64%", "9 of 14 trades"]);
  assert.deepEqual([byId.best!.value, byId.best!.sub, byId.best!.tone], ["+$240", "day 5", "up"]);
  assert.deepEqual([byId.worst!.value, byId.worst!.sub, byId.worst!.tone], ["−$182", "day 1", "down"]);
  assert.equal(byId.adherence!.value, "71% → 83%");
  const fresh = Object.fromEntries(threadTiles(freshThread).map((tile) => [tile.id, tile]));
  assert.deepEqual([fresh.win_rate!.value, fresh.win_rate!.sub], ["—", "no closed trade yet"]);
  assert.equal(hasNoDays(freshThread), true);
  assert.equal(hasNoDays(thread), false);
});

test("the plan recap reads yes, no and none in plain words, and no thread copy trips the banned-term check", () => {
  assert.deepEqual(planRows(activeThread.thread.plan).map((row) => row.value), ["Yes", "Yes", "$600", "3"]);
  assert.deepEqual(planRows({ stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" }).map((row) => row.value), ["No", "No", "None", "None"]);
  const built = [
    briefLine(threadBrief),
    startedWithText(activeThread.thread),
    todayLine(activeThread.today),
    ...threadTiles(thread).flatMap((tile) => [tile.label, tile.sub]),
    ...planRows(activeThread.thread.plan).flatMap((row) => [row.label, row.value]),
    ...(() => {
      const improvement = improvementOf(weeksOf(threadDays));
      return [improvement.compared?.intro ?? "", improvement.caveat?.reason ?? ""];
    })(),
  ];
  for (const text of built) assert.equal(containsPracticeBannedTerm(text), false, text);
});
