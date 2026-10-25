import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { DailySchema, DayListSchema, OpenNextSchema } from "./daily.ts";
import { dayList, endedDayList, plan } from "./dailyFixtures.ts";
import {
  cellText,
  cellTone,
  dayTitle,
  filtersText,
  journalLine,
  listHeaderText,
  listWarning,
  moveText,
  ordinal,
  peekDailyBars,
  planCard,
  selectionText,
  syntheticDays,
  toggledStars,
} from "./dayView.ts";

test("the daily payloads parse, and the contract's required fields are required", () => {
  assert.equal(DayListSchema.parse(dayList).candidates.length, 2);
  assert.equal(DayListSchema.parse(endedDayList).review?.rows[0]?.picked, "traded");
  assert.equal(DailySchema.parse({ plan }).plan?.next_weekday, "Tue");
  assert.equal(DailySchema.parse({ plan: null }).plan, null);
  assert.equal(OpenNextSchema.parse({ plan, day_list_id: null }).day_list_id, null);
  assert.equal(DayListSchema.safeParse({ ...dayList, universe: undefined }).success, false);
  assert.equal(DayListSchema.safeParse({ ...dayList, status: "open" }).success, false);
});

test("the day title names the weekday and shows the date only when dates are on", () => {
  assert.equal(dayTitle(dayList, true), "Day 7 of 20 · Tue");
  assert.equal(dayTitle(dayList, false), "Day 7 of 20 · Tue 2026-03-10");
});

test("the list header says when the list was built and from which data", () => {
  assert.equal(
    listHeaderText(dayList),
    "List at 8:30 AM ET from data through 8:15 AM · 118 of 131 scanned · 34 matched, showing 2",
  );
});

test("the hub card reads Day N of M, next weekday, Continue; preparing and finished have their own lines", () => {
  assert.deepEqual(planCard(null), { headline: "No daily plan yet · set one up to start Day 1", detail: null, action: "new" });
  const next = planCard(plan);
  assert.equal(next.headline, "Day 7 of 20 · next: Tue");
  assert.equal(next.action, "continue");
  assert.equal(next.detail, "2 symbols could not be loaded and read as no data");
  const shown = planCard({ ...plan, spec: { ...plan.spec, hideDates: "no" } });
  assert.equal(shown.headline, "Day 7 of 20 · next: Tue 2026-03-10");
  const open = planCard({ ...plan, current: { id: 42, day_no: 7, status: "practicing" } });
  assert.deepEqual([open.headline, open.action], ["Day 7 of 20 · in progress", "continue"]);
  const first = planCard({ ...plan, days_opened: 0, current: null, next_day_no: 1, next_weekday: "Mon", next_day: "2026-03-02", prep: { state: "done", done: 3, total: 3, failed: 0 } });
  assert.deepEqual([first.headline, first.action], ["Day 1 of 20 · next: Mon", "start"]);
  const preparing = planCard({ ...plan, days_opened: 0, current: null, prep: { state: "running", done: 12, total: 131, failed: 0 } });
  assert.deepEqual([preparing.headline, preparing.action], ["Preparing data · 12 of 131", "none"]);
  const done = planCard({ ...plan, finished: true, next_day: null, next_weekday: null, next_day_no: null });
  assert.equal(done.headline, "All 20 days done");
});

test("cells use the column's format and never print null; the since column is a time", () => {
  const [price, change, , , volume, rvol, since] = dayList.columns;
  const smci = dayList.candidates[0]!;
  const anet = dayList.candidates[1]!;
  assert.equal(cellText(price!, smci), "41.12");
  assert.equal(cellText(change!, smci), "+8.50%");
  assert.equal(cellText(volume!, smci), "1.8M");
  assert.equal(cellText(rvol!, anet), "—");
  assert.equal(cellText(since!, smci), "8:30 AM");
  assert.equal(cellText({ key: "volume", format: "mystery" }, smci), "1,820,000");
  assert.equal(cellTone(change!, smci), "up");
  assert.equal(cellTone(price!, smci), null);
  assert.equal(filtersText(smci), "Gap up · Abnormal volume");
});

test("stars toggle, keep order, and refuse a sixth name", () => {
  assert.deepEqual(toggledStars([{ symbol: "A" }], "B"), ["A", "B"]);
  assert.deepEqual(toggledStars([{ symbol: "A" }, { symbol: "B" }], "A"), ["B"]);
  assert.equal(toggledStars(["A", "B", "C", "D", "E"].map((symbol) => ({ symbol })), "F"), null);
});

test("warnings: a short list says so, an empty list says none matched", () => {
  assert.equal(listWarning(dayList), "Only 2 names matched · add a filter or lower its threshold");
  assert.equal(listWarning({ ...dayList, candidates: [] }), "No names matched this morning");
  assert.equal(listWarning({ warnings: [], candidates: dayList.candidates }), null);
});

test("the review reads the picks' moves, the list median and their ranks", () => {
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(2), "2nd");
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(23), "23rd");
  const review = endedDayList.review!;
  assert.equal(selectionText(review), "Your names moved +3.1% · list median 1.7% · ranked 1st of 2");
  const two = { ...review, of: 30, selection: { ...review.selection, picks: [{ symbol: "A", kind: "traded" as const, move_pct: 3.1, rank: 4 }, { symbol: "B", kind: "starred" as const, move_pct: -0.4, rank: 11 }] } };
  assert.equal(selectionText(two), "Your names moved +3.1% and −0.4% · list median 1.7% · ranked 4th and 11th of 30");
  assert.equal(selectionText({ ...review, selection: { ...review.selection, picks: [] } }), null);
  assert.equal(moveText(null), "—");
  assert.equal(moveText(-0.31), "−0.31%");
  assert.equal(journalLine(endedDayList.journal!), "1 practice trade · +$63.00");
  assert.equal(journalLine({ sessions: [], trades: 0, pnl_usd: 0 }), "0 practice trades · $0.00");
});

test("the strings the day screens build contain no banned term", () => {
  const built = [
    planCard(plan).headline,
    planCard(null).headline,
    listHeaderText(dayList),
    dayTitle(dayList, true),
    selectionText(endedDayList.review!)!,
    journalLine(endedDayList.journal!),
    ...dayList.warnings,
    dayList.universe.footnote,
  ];
  for (const text of built) assert.equal(containsPracticeBannedTerm(text), false, text);
});

test("with dates hidden the Peek chart gets a stand-in timeline, never the real dates", () => {
  const bars = [
    { t: "2026-03-06", o: 1, h: 2, l: 1, c: 2, v: 10 },
    { t: "2026-03-09", o: 2, h: 3, l: 2, c: 3, v: 12 },
  ];
  assert.deepEqual(peekDailyBars(bars, false), bars);
  const hidden = peekDailyBars(bars, true);
  assert.deepEqual(hidden.map((bar) => bar.t), ["2001-01-01", "2001-01-02"]);
  assert.deepEqual(hidden.map((bar) => bar.c), [2, 3]);
  assert.equal(syntheticDays(6).at(-1), "2001-01-08"); // weekends are skipped
  assert.equal(JSON.stringify(hidden).includes("2026"), false);
});
