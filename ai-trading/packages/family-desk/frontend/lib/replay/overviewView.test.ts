import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { adherenceStat, overviewDayRows, overviewWeekRows, swingGate, threadProgress } from "./overviewView.ts";
import { swingThreadFinished, swingThreadReviewReady, swingThreadSummary, weekRows } from "./swingFixtures.ts";
import { activeThread, closedThread, freshThread, threadDays } from "./threadFixtures.ts";

test("the Progress column says the day number once, with the practiced and skipped counts beneath", () => {
  // A day thread with its day open: Day 8 is the thread's own number, the counts are the stats.
  assert.deepEqual(threadProgress(activeThread), { main: "Day 8", sub: "6 practiced · 2 skipped", gate: null });
  // Between days the last ended day reads done, not a day number the thread has not opened.
  assert.equal(threadProgress({ ...activeThread, today: null, last_day: threadDays.at(-1)! }).main, "Day 8 done");
  assert.equal(threadProgress(freshThread).main, "No day yet");
  assert.equal(threadProgress(freshThread).sub, "No days yet");
  assert.match(threadProgress(closedThread).main, /^\d+ days$/);
  // A swing thread reads "Day 7 of 20", and a finished one "Finished".
  const swing = threadProgress(swingThreadSummary);
  assert.deepEqual([swing.main, swing.sub, swing.gate], ["Day 7 of 20", "5 practiced · 1 skipped", null]);
  assert.equal(threadProgress(swingThreadFinished).main, "Finished");
});

test("a swing thread that owes its week review names it as a non-interactive gate, not as the progress text", () => {
  const progress = threadProgress(swingThreadReviewReady);
  assert.equal(progress.main, "Day 6 of 20");
  assert.equal(progress.gate, "Week 1 review due");
  assert.deepEqual(swingGate(swingThreadReviewReady), { weekNo: 1, step: "Week 1 review", locked: "Day 6 unlocks after the Week 1 review" });
  assert.equal(swingGate(swingThreadSummary), null, "an ungated thread has no gate");
  assert.equal(swingGate(activeThread), null, "a day thread has none either");
});

test("adherence is never a bare number: it says which day it is, and first to last when they differ", () => {
  assert.deepEqual(adherenceStat({ adherenceFirstPct: 71, adherenceLastPct: 83 }), { value: "71% → 83%", hint: "first to last scored day" });
  assert.deepEqual(adherenceStat({ adherenceFirstPct: 0, adherenceLastPct: 0 }), { value: "0%", hint: "last scored day" });
  assert.deepEqual(adherenceStat({ adherenceLastPct: 40 }), { value: "40%", hint: "last scored day" });
  assert.deepEqual(adherenceStat({}), { value: "—", hint: "no scored day yet" });
});

test("the days table lists the newest day first, by number and weekday, and never a calendar date", () => {
  const rows = overviewDayRows(threadDays);
  assert.equal(rows.length, threadDays.length);
  assert.deepEqual(rows.map((row) => row.n), [...threadDays.map((day) => day.n)].sort((a, b) => b - a));
  const skipped = rows.find((row) => !row.practiced)!;
  assert.deepEqual([skipped.status, skipped.trades, skipped.result, skipped.resultTone], ["Skipped", "—", "—", "flat"]);
  const practiced = rows.find((row) => row.practiced)!;
  assert.equal(practiced.status, "Practiced");
  assert.match(practiced.result, /^[+−]\$|^\$0\.00$/);
  for (const row of rows) {
    assert.match(row.title, /^Day \d+ · (Mon|Tue|Wed|Thu|Fri)$/);
    assert.match(row.href, /^\/practice\/day\?id=\d+$/);
    assert.equal(/20\d\d-\d\d-\d\d/.test(JSON.stringify(row)), false, "no calendar date");
  }
});

test("the week list covers every week: done, the review owed, the current one, and the weeks to come", () => {
  const state = swingThreadSummary.swing!; // week 2 of 4, Day 7, not gated
  const list = overviewWeekRows(7, state, weekRows);
  assert.deepEqual(list.map((row) => [row.label, row.status]), [["Week 1", "done"], ["Week 2", "current"], ["Week 3", "upcoming"], ["Week 4", "upcoming"]]);
  assert.equal(list[0]!.href, "/practice/week?thread=7&week=1");
  assert.equal(list[0]!.realized, "+$612.00");
  assert.equal(list[3]!.href, null, "a week with no ended day has no review to open");

  // The gate: Week 1 is owed its review and Week 2 waits behind it.
  const gated = overviewWeekRows(7, swingThreadReviewReady.swing!, weekRows.slice(0, 1));
  assert.deepEqual(gated.map((row) => row.status), ["review", "upcoming", "upcoming", "upcoming"]);
  assert.equal(gated[0]!.statusText, "Review due");
  assert.equal(gated[0]!.href, "/practice/week?thread=7&week=1");

  // The weeks answer failed or is loading: the list still reads from the thread's own state.
  assert.deepEqual(overviewWeekRows(7, state, null).map((row) => row.status), ["done", "current", "upcoming", "upcoming"]);
  assert.equal(overviewWeekRows(7, swingThreadFinished.swing!, null).every((row) => row.status === "done"), true);
});

test("the strings the overview builds contain no banned word", () => {
  const built = [
    ...[activeThread, freshThread, closedThread, swingThreadSummary, swingThreadReviewReady, swingThreadFinished].flatMap((summary) => {
      const progress = threadProgress(summary);
      return [progress.main, progress.sub, progress.gate ?? ""];
    }),
    ...overviewDayRows(threadDays).flatMap((row) => [row.title, row.status]),
    ...overviewWeekRows(7, swingThreadReviewReady.swing!, weekRows).flatMap((row) => [row.label, row.statusText]),
    swingGate(swingThreadReviewReady)!.step,
    swingGate(swingThreadReviewReady)!.locked,
    adherenceStat({}).hint,
  ];
  for (const text of built) assert.equal(containsPracticeBannedTerm(text), false, text);
});
