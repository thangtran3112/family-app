import assert from "node:assert/strict";
import test from "node:test";
import { PracticeThreadCreateV1Schema } from "@ai-trading/contracts/practice-thread-v1";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import {
  calendarLine,
  defaultSwingDraft,
  defaultSwingFirstDay,
  firstDayProblem,
  isDailyRunOn,
  isMondayHoliday,
  previewKey,
  previewProblems,
  previewRequest,
  swingBlock,
  swingCreateBody,
  swingFieldOfPath,
  swingProblems,
  targetProblem,
  toggleArmedRef,
  toggleFillFilter,
  toggleWatchlist,
  validateSwingDraft,
  type SwingDraft,
} from "./swingSetup.ts";
import { universePreview } from "./swingFixtures.ts";
import { defaultThreadDraft } from "./threadSetup.ts";
import { addSymbol, noEdits, removeSymbol } from "./universeView.ts";

const NOW = new Date("2026-10-25T15:00:00Z"); // a Sunday: the latest finished day is Fri 2026-10-23
const draft = (over: Partial<SwingDraft> = {}): SwingDraft => ({ ...defaultSwingDraft(NOW), ...over });
const rows = universePreview.rows;

test("the first day defaults to the Monday session about three months back", () => {
  assert.equal(defaultSwingFirstDay(NOW), "2026-07-20");
  assert.equal(new Date(`${defaultSwingFirstDay(NOW)}T12:00:00Z`).getUTCDay(), 1);
  assert.equal(defaultSwingFirstDay(new Date("2026-12-07T15:00:00Z")), "2026-09-08", "Labor Day rolls to Tuesday");
  assert.equal(defaultSwingFirstDay(new Date("2026-04-30T15:00:00Z")), "2026-01-26", "a Monday that is not a holiday stays");
  assert.equal(defaultSwingFirstDay(new Date("2026-04-22T15:00:00Z")), "2026-01-20", "MLK Day rolls to Tuesday");
});

test("holiday Mondays: the four fixed Mondays and the fixed dates kept on a Monday", () => {
  for (const day of ["2026-01-19", "2022-01-17", "2026-02-16", "2026-05-25", "2026-09-07", "2022-06-20", "2027-07-05", "2022-12-26", "2023-01-02", "2024-01-01"]) {
    assert.equal(isMondayHoliday(new Date(`${day}T12:00:00Z`)), true, day);
  }
  for (const day of ["2026-01-12", "2026-02-09", "2026-05-18", "2026-09-14", "2026-07-20", "2026-01-20", "2022-01-03"]) {
    assert.equal(isMondayHoliday(new Date(`${day}T12:00:00Z`)), false, day);
  }
  assert.equal(isMondayHoliday(new Date("2021-01-01T12:00:00Z")), false, "a Friday");
});

test("the form starts as 02p c1 says", () => {
  const start = defaultSwingDraft(NOW);
  assert.deepEqual(start, {
    firstDay: "2026-07-20",
    sessions: "20",
    hideDates: true,
    interval: "15m",
    tape: "off",
    maxOpenHolds: "3",
    riskPerHoldUsd: "",
    armed: [],
    watchlistIds: [],
    filterIds: [],
    fill: "liquidity",
    target: "50",
    edits: { add: [], remove: [] },
  });
});

test("the calendar line counts the weeks the sessions touch", () => {
  assert.equal(calendarLine({ firstDay: "2026-07-20", sessions: "20" }), "20 sessions · 4 weeks · ends on day 20");
  assert.equal(calendarLine({ firstDay: "2026-07-20", sessions: "15" }), "15 sessions · 3 weeks · ends on day 15");
  assert.equal(calendarLine({ firstDay: "2026-07-21", sessions: "20" }), "20 sessions · 5 weeks · ends on day 20", "starting Tuesday spills into a fifth week");
  assert.equal(calendarLine({ firstDay: "2026-07-20", sessions: "23" }), "23 sessions · 5 weeks · ends on day 23");
  assert.equal(calendarLine({ firstDay: "not a day", sessions: "20" }), "20 sessions · 4 weeks · ends on day 20");
  assert.equal(calendarLine({ firstDay: "2026-07-20", sessions: "14" }), null);
  assert.equal(calendarLine({ firstDay: "2026-07-20", sessions: "" }), null);
});

test("the preview request is the draft in the API's names", () => {
  const request = previewRequest(draft({ watchlistIds: [3, 4], filterIds: [9], fill: "none", target: "30", edits: { add: ["NVDA"], remove: ["AAPL"] } }));
  assert.deepEqual(request, { first_day: "2026-07-20", sessions: 20, watchlist_ids: [3, 4], filter_ids: [9], fill: "none", add: ["NVDA"], remove: ["AAPL"], target: 30 });
  assert.equal(previewRequest(draft({ target: "" })).target, 50);
  assert.equal(previewRequest(draft({ target: "500" })).target, 50);
  assert.equal(previewKey(previewRequest(draft())), previewKey(previewRequest(draft())));
  assert.notEqual(previewKey(previewRequest(draft())), previewKey(previewRequest(draft({ fill: "none" }))));
  const edited = addSymbol(noEdits(), "msft").edits;
  assert.notEqual(previewKey(previewRequest(draft({ edits: edited }))), previewKey(previewRequest(draft())));
  assert.equal(previewKey(previewRequest(draft({ edits: removeSymbol(edited, "msft") }))), previewKey(previewRequest(draft())));
});

test("the swing block and the create body carry the contract's names and no empty optional", () => {
  const block = swingBlock(draft(), rows);
  assert.deepEqual(Object.keys(block), ["firstDay", "sessions", "hideDates", "universe", "interval", "tape", "armed", "maxOpenHolds"]);
  assert.deepEqual([block.firstDay, block.sessions, block.hideDates, block.interval, block.tape, block.maxOpenHolds], ["2026-07-20", 20, "yes", "15m", "off", 3]);
  assert.equal((block.universe as unknown[]).length, 50);
  const withRisk = swingBlock(draft({ riskPerHoldUsd: "1,500", hideDates: false, tape: "on", armed: [{ source: "filter", id: 4 }] }), rows);
  assert.deepEqual([withRisk.riskPerHoldUsd, withRisk.hideDates, withRisk.tape, withRisk.armed], [1500, "no", "on", [{ source: "filter", id: 4 }]]);

  const body = swingCreateBody(defaultThreadDraft(), draft(), rows) as Record<string, unknown>;
  assert.deepEqual([body.schemaVersion, body.mode, body.startingBalance], [1, "swing", 50000]);
  assert.deepEqual(body.plan, { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" });
  assert.equal(PracticeThreadCreateV1Schema.safeParse(body).success, true, "the body is a PracticeThreadCreateV1");
});

test("a good draft validates to the contract's own parse", () => {
  const result = validateSwingDraft(defaultThreadDraft(), draft({ riskPerHoldUsd: "100", armed: [{ source: "filter", id: 4 }] }), rows, NOW);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.spec.mode, "swing");
    assert.equal(result.spec.swing?.universe.length, 50);
    assert.equal(result.spec.swing?.riskPerHoldUsd, 100);
    assert.equal(result.spec.startingBalance, 50000);
  }
});

test("each field has its own plain message", () => {
  const check = (over: Partial<SwingDraft>, nodes = rows) => {
    const result = validateSwingDraft(defaultThreadDraft(), draft(over), nodes, NOW);
    assert.equal(result.ok, false);
    return result.ok ? {} : result.problems;
  };
  assert.equal(check({ sessions: "30" }).sessions, "Sessions: a whole number from 15 to 23");
  assert.equal(check({ sessions: "" }).sessions, "Sessions: a whole number from 15 to 23");
  assert.equal(check({ maxOpenHolds: "9" }).maxOpenHolds, "Open holds: a whole number from 1 to 5");
  assert.equal(check({ maxOpenHolds: "0" }).maxOpenHolds, "Open holds: a whole number from 1 to 5");
  assert.equal(check({ riskPerHoldUsd: "0" }).riskPerHoldUsd, "Risk per hold: whole dollars from 1 to 100,000");
  assert.equal(check({ riskPerHoldUsd: "2.5" }).riskPerHoldUsd, "Risk per hold: whole dollars from 1 to 100,000");
  const six = Array.from({ length: 6 }, (_, id) => ({ source: "filter" as const, id: id + 1 }));
  assert.equal(check({ armed: six }).armed, "Arm up to 5 strategies");
  assert.equal(check({}, rows.slice(0, 5)).universe, "Universe: 10 to 50 symbols, each once");
  assert.equal(check({}, [...rows.slice(0, 11), rows[0]!]).universe, "universe symbols must be unique");
  assert.equal(check({ firstDay: "2016-12-30" }).firstDay, "First day: pick a weekday from Jan 3, 2017");
  assert.equal(check({ firstDay: "" }).firstDay, "First day: pick a weekday from Jan 3, 2017");
  assert.equal(check({ firstDay: "2026-07-18" }).firstDay, "No trading on Sat 2026-07-18 · pick a weekday");
  assert.equal(check({ firstDay: "2026-10-12" }).firstDay, "20 sessions from Mon 2026-10-12 run past the last finished day · pick an earlier start");
});

test("the thread half keeps the day form's own rules", () => {
  const thread = { ...defaultThreadDraft(), startingBalance: "500", maxLossUsd: "70000", planNote: "x".repeat(501) };
  const result = validateSwingDraft(thread, draft(), rows, NOW);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.problems.startingBalance, "Starting balance: whole dollars from 1,000 to 10,000,000");
    assert.equal(result.problems.planNote, "Plan note: up to 500 plain characters");
  }
  const over = validateSwingDraft({ ...defaultThreadDraft(), maxLossUsd: "60000" }, draft(), rows, NOW);
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.problems.maxLossUsd ?? "", /Max loss can't be more than your simulated starting balance/);
});

test("the first day and range are read locally; holidays and missing data stay the server's call", () => {
  assert.equal(firstDayProblem({ firstDay: "2026-07-20", sessions: "20" }, NOW), null);
  assert.equal(firstDayProblem({ firstDay: "2026-09-07", sessions: "20" }, NOW), null, "a holiday Monday is the server's 422");
  assert.equal(firstDayProblem({ firstDay: "2017-01-03", sessions: "20" }, NOW), null);
  assert.equal(firstDayProblem({ firstDay: "2017-01-02", sessions: "20" }, NOW), "First day: pick a weekday from Jan 3, 2017");
  assert.equal(firstDayProblem({ firstDay: "2026-09-25", sessions: "15" }, NOW), null, "15 sessions end Oct 15");
  assert.equal(firstDayProblem({ firstDay: "2026-10-05", sessions: "15" }, NOW), null, "15 sessions end on the latest finished day");
  assert.equal(firstDayProblem({ firstDay: "2026-10-06", sessions: "15" }, NOW), "15 sessions from Tue 2026-10-06 run past the last finished day · pick an earlier start");
  assert.equal(targetProblem(""), null);
  assert.equal(targetProblem("25"), null);
  assert.equal(targetProblem("9"), "Target size: a whole number from 10 to 50");
  assert.equal(targetProblem("51"), "Target size: a whole number from 10 to 50");
  assert.equal(targetProblem("12.5"), "Target size: a whole number from 10 to 50");
  assert.deepEqual(previewProblems(draft(), NOW), {});
  assert.deepEqual(Object.keys(previewProblems(draft({ sessions: "9", firstDay: "2026-07-18", target: "3" }), NOW)).sort(), ["firstDay", "sessions", "target"]);
});

test("server problems land on the field that shows them, in the server's own words", () => {
  assert.equal(swingFieldOfPath("swing.universe.3.symbol"), "universe");
  assert.equal(swingFieldOfPath("swing.firstDay"), "firstDay");
  assert.equal(swingFieldOfPath("swing.armed.0.id"), "armed");
  assert.equal(swingFieldOfPath("swing"), "form");
  assert.equal(swingFieldOfPath("plan.maxLossUsd"), "form");
  assert.deepEqual(
    swingProblems([
      { path: "swing.firstDay", message: "20 sessions from Mon 2026-10-12 run past the last finished day · pick an earlier start" },
      { path: "swing.universe.3.symbol", message: "XYZ has not enough price history for this whole range" },
      { path: "swing.armed.0.id", message: "Use a daily filter for a swing thread" },
      { path: "plan.maxLossUsd", message: "Max loss is too big" },
      { path: "mode", message: "This is not a swing thread" },
      { path: "first_day", message: "No trading on Sat 2026-07-18 · pick a weekday" },
      { path: "add.2", message: "12 is not a stock symbol" },
      { path: "filter_ids.0", message: "Use a daily filter for a swing thread" },
      { path: "target", message: "The target size is 10 to 50 symbols" },
      { path: "", message: "" },
    ]),
    {
      firstDay: "20 sessions from Mon 2026-10-12 run past the last finished day · pick an earlier start",
      universe: "XYZ has not enough price history for this whole range",
      armed: "Use a daily filter for a swing thread",
      maxLossUsd: "Max loss is too big",
      mode: "This is not a swing thread",
      target: "The target size is 10 to 50 symbols",
      form: "Check the swing thread and try again",
    },
  );
});

test("lists, filters and armed strategies toggle up to their limit", () => {
  assert.deepEqual(toggleWatchlist([1], 2), [1, 2]);
  assert.deepEqual(toggleWatchlist([1, 2], 2), [1]);
  assert.equal(toggleWatchlist(Array.from({ length: 20 }, (_, id) => id), 99).length, 20);
  assert.deepEqual(toggleFillFilter([1, 2, 3], 4), [1, 2, 3]);
  assert.deepEqual(toggleFillFilter([1, 2], 3), [1, 2, 3]);
  const five = Array.from({ length: 5 }, (_, id) => ({ source: "filter" as const, id: id + 1 }));
  assert.deepEqual(toggleArmedRef(five, { source: "filter", id: 9 }), five);
  assert.deepEqual(toggleArmedRef(five, { source: "filter", id: 2 }).map((ref) => ref.id), [1, 3, 4, 5]);
  assert.deepEqual(toggleArmedRef([], { source: "alert_strategy", id: 7 }), [{ source: "alert_strategy", id: 7 }]);
  assert.equal(isDailyRunOn("daily_close"), true);
  assert.equal(isDailyRunOn("weekly"), true);
  assert.equal(isDailyRunOn("bar_close_15m"), false);
});

test("every message the setup builds avoids the Practice banned words", () => {
  const messages = [
    calendarLine({ firstDay: "2026-07-20", sessions: "20" }),
    targetProblem("3"),
    firstDayProblem({ firstDay: "2026-07-18", sessions: "20" }, NOW),
    firstDayProblem({ firstDay: "2026-10-12", sessions: "20" }, NOW),
    ...Object.values(previewProblems(draft({ sessions: "9", firstDay: "", target: "3" }), NOW)),
    ...Object.values((validateSwingDraft(defaultThreadDraft(), draft({ maxOpenHolds: "9", riskPerHoldUsd: "0", sessions: "30" }), rows.slice(0, 3), NOW) as { problems: Record<string, string> }).problems),
    ...Object.values((validateSwingDraft(defaultThreadDraft(), draft(), [...rows.slice(0, 11), rows[0]!], NOW) as { problems: Record<string, string> }).problems),
  ];
  for (const text of messages) if (text != null) assert.equal(containsPracticeBannedTerm(text), false, text);
  assert.ok(messages.length >= 8);
});
