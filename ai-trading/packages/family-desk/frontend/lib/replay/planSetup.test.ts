import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import {
  LIST_TIMES,
  clock12,
  defaultFirstDay,
  defaultPlanDraft,
  effectiveFirstDay,
  earliestListAt,
  listTimeFrom,
  listTimeHeld,
  listTimeNeed,
  livePlanProblems,
  planDraftToSpec,
  planFieldOfPath,
  planProblems,
  startLabel,
  toggleFilter,
  validatePlanDraft,
  windowForList,
  withFilterToggled,
  withListTime,
  type FilterTimings,
  type PlanDraft,
} from "./planSetup.ts";

const NOW = new Date("2026-10-24T16:00:00Z");
const ready = (changes: Partial<PlanDraft> = {}): PlanDraft => ({ ...defaultPlanDraft(NOW), filterIds: [4], ...changes });

test("the default start is the first weekday of the month three months back", () => {
  assert.equal(defaultFirstDay(NOW), "2026-07-01");
  assert.equal(defaultFirstDay(new Date("2026-10-04T12:00:00Z")), "2026-07-01");
  assert.equal(defaultFirstDay(new Date("2026-04-10T12:00:00Z")), "2026-01-02"); // New Year's Day rolls on
  assert.equal(defaultFirstDay(new Date("2026-06-15T12:00:00Z")), "2026-03-02"); // March 1 is a Sunday
});

test("the first day is her pick, else the recorded-universe default when the server has one, else three months back", () => {
  const draft = defaultPlanDraft(NOW).firstDay;
  assert.equal(draft, "2026-07-01");
  assert.equal(effectiveFirstDay(draft, false, null), "2026-07-01");
  assert.equal(effectiveFirstDay(draft, false, "2026-09-28"), "2026-09-28");
  assert.equal(effectiveFirstDay("2026-08-03", true, "2026-09-28"), "2026-08-03");
});

test("a draft becomes the contract's JSON: yes/no words, no null, no shares and no risk plan (the thread's, D-007)", () => {
  const spec = planDraftToSpec(ready()) as Record<string, unknown>;
  assert.deepEqual(spec.screen, { filters: [{ id: 4 }], listAt: "08:30", maxList: 30 });
  assert.equal(spec.hideDates, "yes");
  assert.deepEqual((spec.setup as Record<string, unknown>).window, { from: "09:30", to: "11:30" });
  assert.deepEqual(Object.keys(spec.setup as object), ["window", "session", "interval", "armed"]);
  assert.equal(JSON.stringify(spec).includes("null"), false);
});

test("a plan has no names-a-day: the draft and the block carry no cap (a day opens any list name)", () => {
  assert.equal("maxSymbols" in defaultPlanDraft(NOW), false);
  assert.equal("maxSymbols" in (planDraftToSpec(ready()) as Record<string, unknown>), false);
  assert.equal(validatePlanDraft(ready()).ok, true);
});

test("a good draft validates; the window may not begin before the list time", () => {
  assert.equal(validatePlanDraft(ready()).ok, true);
  const early = validatePlanDraft(ready({ listAt: "10:00" }));
  assert.equal(early.ok, false);
  assert.equal(!early.ok && early.problems.window, "window.from must be at or after screen.listAt");
  const moved = withListTime(ready(), "10:00");
  assert.deepEqual([moved.setup.from, moved.setup.to], ["10:00", "11:30"]);
  assert.equal(validatePlanDraft(moved).ok, true);
});

test("each bound maps to the field that shows it", () => {
  const cases: Array<[Partial<PlanDraft>, string]> = [
    [{ filterIds: [] }, "filters"],
    [{ filterIds: [1, 2, 3, 4] }, "filters"],
    [{ sessions: "4" }, "sessions"],
    [{ maxList: "19" }, "maxList"],
    [{ firstDay: "2016-12-30" }, "firstDay"],
    [{ firstDay: "2026-07-04" }, "firstDay"], // a Saturday
    [{ listAt: "15:31", setup: { ...ready().setup, from: "15:31", to: "16:00" } }, "listAt"],
  ];
  for (const [changes, field] of cases) {
    const result = validatePlanDraft(ready(changes));
    assert.equal(result.ok, false, JSON.stringify(changes));
    assert.ok(!result.ok && field in result.problems, `${field}: ${JSON.stringify(!result.ok && result.problems)}`);
  }
});

test("server paths land on the form fields, and a server sentence is shown as it is", () => {
  assert.equal(planFieldOfPath("firstDay"), "firstDay");
  assert.equal(planFieldOfPath("screen.filters.1.id"), "filters");
  assert.equal(planFieldOfPath("screen.listAt"), "listAt");
  assert.equal(planFieldOfPath("setup.plan.maxLossUsd"), "form");
  assert.equal(planFieldOfPath("setup.armed.0.id"), "armed");
  assert.equal(planFieldOfPath("window"), "window");
  assert.equal(planFieldOfPath("plan.stopRequired"), "form");
  assert.equal(planFieldOfPath("mystery"), "form");
  const error = new DeskApiError("http", 422, { problems: [{ path: "screen.listAt", message: "Premarket filters need a list time of 8:30 AM or later" }] });
  assert.deepEqual(planProblems(error.problems), { listAt: "Premarket filters need a list time of 8:30 AM or later" });
});

test("filters toggle in order and stop at three; the window follows the list time", () => {
  assert.deepEqual(toggleFilter([1], 2), [1, 2]);
  assert.deepEqual(toggleFilter([1, 2], 1), [2]);
  assert.deepEqual(toggleFilter([1, 2, 3], 4), [1, 2, 3]);
  assert.deepEqual(windowForList("08:30"), { from: "09:30", to: "11:30" });
  assert.deepEqual(windowForList("10:45"), { from: "10:45", to: "12:45" });
  assert.deepEqual(windowForList("15:30"), { from: "15:30", to: "16:00" });
});

// The same rows as `tests/replay/test_replay_screen.py`: the form and the server must agree on the earliest list time.
test("the earliest list time of a filter is the one the server enforces", () => {
  const rows: Array<[string, "regular" | "extended", string]> = [
    ["premarket_0830", "extended", "08:30"],
    ["bar_close_15m", "regular", "10:00"],
    ["bar_close_5m", "regular", "09:50"],
    ["bar_close_1m", "regular", "09:46"],
    ["bar_close_1h", "regular", "10:45"],
    ["bar_close_15m", "extended", "04:30"],
    ["daily_close", "regular", "04:30"],
    ["weekly", "regular", "04:30"],
  ];
  for (const [run_on, session, expected] of rows) assert.equal(earliestListAt({ run_on, session }), expected, `${run_on} ${session}`);
  assert.equal(clock12("10:00"), "10:00 AM");
  assert.equal(clock12("12:05"), "12:05 PM");
  assert.equal(clock12("08:30"), "8:30 AM");
});

const timings: FilterTimings = new Map([
  [1, { run_on: "premarket_0830", session: "extended" }],
  [2, { run_on: "bar_close_15m", session: "regular" }],
  [3, { run_on: "daily_close", session: "regular" }],
  [4, { run_on: "bar_close_1h", session: "regular" }],
]);

test("the list time follows the latest filter: the first offered time that works", () => {
  assert.deepEqual(listTimeNeed([1, 3], timings), { time: "08:30", ids: [1] });
  assert.deepEqual(listTimeNeed([1, 2], timings), { time: "10:00", ids: [2] });
  assert.deepEqual(listTimeNeed([3], timings), { time: "04:30", ids: [] });
  assert.deepEqual(listTimeNeed([], timings), { time: "04:30", ids: [] });
  assert.deepEqual(listTimeNeed([2, 99], timings), { time: "10:00", ids: [2] }); // a filter not in the list is skipped
  assert.deepEqual(LIST_TIMES.map((item) => listTimeFrom(item.value)), ["08:30", "10:00", "10:45"]);
  assert.equal(listTimeFrom("09:50"), "10:00");
  assert.equal(listTimeFrom("10:46"), "10:45"); // nothing later is offered
});

// D-076: a new plan starts with nothing armed; ticking a filter only picks it for the list (the old silent auto-arm is gone).
test("picking a filter moves an early list time up and arms nothing; dropping it leaves the rest", () => {
  const start = defaultPlanDraft(NOW);
  assert.equal(start.listAt, "08:30");
  assert.deepEqual(start.setup.armed, []);
  const gap = withFilterToggled(start, 1, timings);
  assert.deepEqual([gap.filterIds, gap.listAt, gap.setup.armed], [[1], "08:30", []]); // premarket stays at 8:30, nothing armed
  const volume = withFilterToggled(gap, 2, timings);
  assert.deepEqual([volume.filterIds, volume.listAt, volume.setup.armed], [[1, 2], "10:00", []]);
  assert.deepEqual([volume.setup.from, volume.setup.to], ["10:00", "11:30"]); // the window follows the list time
  assert.equal(validatePlanDraft({ ...volume, filterIds: [1, 2] }).ok, true);
  const dropped = withFilterToggled(volume, 2, timings);
  assert.deepEqual([dropped.filterIds, dropped.setup.armed], [[1], []]);
  assert.equal(dropped.listAt, "10:00"); // a time she can still use is left alone
  const full = { ...start, filterIds: [1, 2, 3] };
  assert.equal(withFilterToggled(full, 4, timings), full); // the fourth filter is refused: nothing changes
});

// D-017: the "needs a list time of 10:00 AM or later" line showed with 10:00 selected, and "Gap up needs 8:30" with 10:00.
test("a list time is held only when it is earlier than the picked filters need", () => {
  const volume = withFilterToggled(defaultPlanDraft(NOW), 2, timings); // Abnormal volume: the list time moves up to 10:00
  const need = listTimeNeed(volume.filterIds, timings);
  assert.equal(volume.listAt, "10:00");
  assert.equal(listTimeHeld(volume.listAt, need), false, "10:00 satisfies a 15-minute filter: no line");
  assert.equal(listTimeHeld("10:45", need), false);
  assert.equal(listTimeHeld("08:30", need), true, "8:30 is off, with the reason on the button");
  const gap = withFilterToggled(withListTime(defaultPlanDraft(NOW), "10:00"), 1, timings);
  const gapNeed = listTimeNeed(gap.filterIds, timings);
  assert.equal(listTimeHeld(gap.listAt, gapNeed), false, "Gap up needs 8:30: 10:00 holds");
  assert.equal(listTimeHeld("10:00", listTimeNeed([], timings)), false, "no cadence filter, nothing to say");
  assert.equal(validatePlanDraft({ ...volume, filterIds: [2] }).ok, true, "and the draft submits");
});

// M-03: the form validates as she edits. The range check runs locally: a block of sessions cannot run past the last finished day.
test("a first day too late for the number of days is a problem as soon as the form is read, and a shorter run clears it", () => {
  const late = ready({ firstDay: "2026-10-12", sessions: "20" });
  const result = validatePlanDraft(late, NOW);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? (result.problems.firstDay ?? "") : "", /^20 sessions from .* run past the last finished day/);
  assert.equal(validatePlanDraft({ ...late, sessions: "5" }, NOW).ok, true); // 5 days from Oct 12 end Oct 16
  assert.equal(validatePlanDraft(late).ok, true, "without a clock the local range read is skipped");
});

test("the live problems leave out the missing filter (the footer already says it) and show the rest", () => {
  assert.deepEqual(livePlanProblems(defaultPlanDraft(NOW), NOW), {});
  assert.deepEqual(Object.keys(livePlanProblems(ready({ sessions: "3" }), NOW)), ["sessions"]);
  assert.deepEqual(Object.keys(livePlanProblems(ready({ maxList: "99" }), NOW)), ["maxList"]);
  assert.deepEqual(Object.keys(livePlanProblems(ready({ firstDay: "2026-10-12" }), NOW)), ["firstDay"]);
});

// M-07 (D-076): the one button says what it does.
test("the start button names the days; a bad or empty number reads plainly", () => {
  assert.equal(startLabel("20", false), "Start 20-day practice");
  assert.equal(startLabel("5", false), "Start 5-day practice");
  assert.equal(startLabel("20", true), "Start 20-day swing practice");
  assert.equal(startLabel("", false), "Start practice");
  assert.equal(startLabel("abc", true), "Start swing practice");
});
