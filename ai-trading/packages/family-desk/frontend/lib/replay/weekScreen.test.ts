import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { swingOpenNext, swingOpenNextWaiting, swingState, swingThreadFinished, swingThreadReviewReady, weekClosed, weekToDate } from "./swingFixtures.ts";
import {
  WEEK_TEXT,
  dayBoardHref,
  dayListIdOf,
  equityCaption,
  equityRows,
  linkDayRows,
  parseWeekParams,
  startOutcome,
  threadHref,
  weekAction,
  weekLoadProblem,
  weekSubtitle,
  weekTitle,
} from "./weekScreen.ts";
import { weekDayRows, weekEquitySeries } from "./weekView.ts";

test("every line of the screen's own copy passes the Practice banned-word list", () => {
  for (const [key, text] of Object.entries(WEEK_TEXT)) assert.equal(containsPracticeBannedTerm(text), false, `${key}: ${text}`);
});

test("the URL needs a thread and a week that are whole numbers above zero", () => {
  assert.deepEqual(parseWeekParams("7", "2"), { threadId: 7, weekNo: 2 });
  for (const [thread, week] of [[null, "2"], ["7", null], [null, null], ["0", "2"], ["7", "0"], ["-1", "2"], ["7", "1.5"], ["abc", "2"], ["7", ""], ["7", "2x"]] as const) {
    assert.equal(parseWeekParams(thread, week), null, `${thread} ${week}`);
  }
  assert.equal(parseWeekParams("99999999999999999999", "1"), null);
});

test("links are the thread journal and a day's board", () => {
  assert.equal(threadHref(7), "/practice/journal?thread=7");
  assert.equal(dayBoardHref(71), "/practice/day?id=71");
});

test("the header names the week, its days, and what 'to date' means", () => {
  assert.equal(weekTitle(weekClosed), "Week 1 · 5 days");
  assert.equal(weekSubtitle(weekClosed), "Days 1 to 5");
  assert.equal(weekTitle(weekToDate), "Week 2 to date");
  assert.equal(weekSubtitle(weekToDate), "Through Day 7 · 2 of 5 days so far");
  // A short week and an early close already carry their count in the API's label.
  assert.equal(weekTitle({ ...weekClosed, label: "Week 1 · 3 days" }), "Week 1 · 3 days");
  assert.equal(weekTitle({ ...weekClosed, label: "Week 3 · 2 of 5 days" }), "Week 3 · 2 of 5 days");
  const oneDay = { ...weekClosed, review: { ...weekClosed.review, week: { ...weekClosed.review.week, first_day_no: 5, last_day_no: 5 } } };
  assert.equal(weekTitle(oneDay), "Week 1 · 1 day");
  assert.equal(weekSubtitle(oneDay), "Day 5");
  assert.equal(weekSubtitle({ ...weekToDate, label: "Week 2" }), "Through Day 7");
});

test("the button starts the next week only when this week just ended and the thread waits", () => {
  const waiting = { ...swingState, next: "week_review", week_no: 3 } as const;
  assert.deepEqual(weekAction({ weekNo: 2, toDate: false, lastDayNo: 10, state: waiting }), { kind: "start", label: "Start Week 3", weekNo: 3 });
  // Week 1 reviewed with the thread waiting on week 2.
  assert.deepEqual(weekAction({ weekNo: 1, toDate: false, lastDayNo: 5, state: swingThreadReviewReady.swing }), { kind: "start", label: "Start Week 2", weekNo: 2 });
});

test("the final week, an old week and an unloaded thread read 'Back to your thread'", () => {
  const link = { kind: "link", label: "Back to your thread", href: null };
  assert.deepEqual(weekAction({ weekNo: 4, toDate: false, lastDayNo: 20, state: swingThreadFinished.swing }), link);
  // Week 1 again after week 2 is under way.
  assert.deepEqual(weekAction({ weekNo: 1, toDate: false, lastDayNo: 5, state: swingState }), link);
  assert.deepEqual(weekAction({ weekNo: 1, toDate: false, lastDayNo: 5, state: null }), link);
  assert.deepEqual(weekAction({ weekNo: 1, toDate: false, lastDayNo: 5, state: undefined }), link);
});

test("the open week reads 'Back to Day N' and goes to that day's board; with no board to go to it says 'Back to your thread' (M2)", () => {
  const daily = [{ n: 5, day_list_id: 65 }, { n: 6, day_list_id: 66 }];
  const today = { day_no: 7, day_list_id: 67 };
  // The day she is on is open: its board.
  assert.deepEqual(weekAction({ weekNo: 2, toDate: true, lastDayNo: 6, state: swingState, daily, today }), { kind: "link", label: "Back to Day 7", href: "/practice/day?id=67" });
  // The thread cannot be read: the day the week is through (an ended day has its board in the thread's days).
  assert.deepEqual(weekAction({ weekNo: 2, toDate: true, lastDayNo: 6, state: null, daily, today: null }), { kind: "link", label: "Back to Day 6", href: "/practice/day?id=66" });
  // Day 7 has not been opened yet (she has not pressed Continue): no board, so the label does not name a day.
  assert.deepEqual(weekAction({ weekNo: 2, toDate: true, lastDayNo: 6, state: swingState, daily, today: null }), { kind: "link", label: "Back to your thread", href: null });
  assert.deepEqual(weekAction({ weekNo: 2, toDate: true, lastDayNo: 6, state: swingState }), { kind: "link", label: "Back to your thread", href: null }, "no thread at all");
  // Never a Start button for the open week, even when the state says a review is next.
  assert.equal(weekAction({ weekNo: 2, toDate: true, lastDayNo: 6, state: { ...swingState, next: "week_review", week_no: 3 } }).kind, "link");
});

test("Start Week opens the day's board, or says why nothing opened", () => {
  assert.deepEqual(startOutcome(swingOpenNext), { kind: "open", href: "/practice/day?id=71" });
  assert.deepEqual(startOutcome(swingOpenNextWaiting), {
    kind: "wait",
    text: "Preparing the swing data · 12 of 51 · The next day opens when the data is ready. You can leave this page.",
  });
  const done = startOutcome({ ...swingOpenNextWaiting, plan: { ...swingOpenNextWaiting.plan, finished: true } });
  assert.deepEqual(done, { kind: "wait", text: "Thread finished · every hold closed at the last close" });
  for (const outcome of [startOutcome(swingOpenNextWaiting), done]) assert.equal(outcome.kind === "wait" && containsPracticeBannedTerm(outcome.text), false);
});

test("a day row opens that day's ended board once the thread's day list is known", () => {
  const daily = [
    { n: 1, day_list_id: 61 },
    { n: 2, day_list_id: 62 },
    { n: 4, day_list_id: 64 },
  ];
  assert.equal(dayListIdOf(daily, 2), 62);
  assert.equal(dayListIdOf(daily, 3), null);
  assert.equal(dayListIdOf(null, 2), null);
  assert.equal(dayListIdOf(undefined, 2), null);
  const rows = linkDayRows(weekDayRows(weekClosed.review), daily);
  assert.deepEqual(rows.map((row) => [row.dayNo, row.href]), [
    [1, "/practice/day?id=61"],
    [2, "/practice/day?id=62"],
    [3, null],
    [4, "/practice/day?id=64"],
    [5, null],
  ]);
  assert.equal(rows[0]!.title, "Day 1 · Mon");
  assert.ok(linkDayRows(weekDayRows(weekClosed.review), null).every((row) => row.href === null));
});

test("the equity chart has a text twin: a caption and one row per close", () => {
  const series = weekEquitySeries(weekToDate.review);
  assert.equal(equityCaption(series), "Day 1 to Day 7 · this week is Days 6 to 7, shaded");
  assert.equal(equityCaption(weekEquitySeries(weekClosed.review)), "Day 1 to Day 5 · this week is Days 1 to 5, shaded");
  const rows = equityRows(series);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], { dayNo: 1, day: "Day 1", balance: "$50,000", equity: "$50,085", inWeek: false });
  assert.deepEqual(rows[6], { dayNo: 7, day: "Day 7", balance: "$51,240", equity: "$52,010", inWeek: true });
  assert.deepEqual(rows.map((row) => row.inWeek), [false, false, false, false, false, true, true]);
  const oneDay = { points: series.points.slice(0, 1), weekFirstDay: 1, weekLastDay: 1 };
  assert.equal(equityCaption(oneDay), "Day 1 to Day 1 · this week is Day 1, shaded");
});

test("a 404 shows the server's sentence; any other failure is a plain failed load", () => {
  assert.deepEqual(weekLoadProblem(new DeskApiError("http", 404, { problems: [{ path: "week", message: "Week 3 has not started yet" }] })), {
    kind: "missing",
    message: "Week 3 has not started yet",
  });
  assert.deepEqual(weekLoadProblem(new DeskApiError("http", 404, { detail: "Thread not found" })), { kind: "missing", message: "Thread not found" });
  assert.deepEqual(weekLoadProblem(new DeskApiError("http", 404)), { kind: "missing", message: "This week has not started yet" });
  assert.deepEqual(weekLoadProblem(new DeskApiError("http", 500)), { kind: "failed" });
  assert.deepEqual(weekLoadProblem(new DeskApiError("malformed", 200)), { kind: "failed" });
  assert.deepEqual(weekLoadProblem(new Error("network")), { kind: "failed" });
  assert.deepEqual(weekLoadProblem(null), { kind: "failed" });
});
