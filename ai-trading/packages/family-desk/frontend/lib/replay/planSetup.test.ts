import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import {
  defaultFirstDay,
  defaultPlanDraft,
  planDraftToSpec,
  planFieldOfPath,
  planProblems,
  toggleFilter,
  validatePlanDraft,
  windowForList,
  withListTime,
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

test("a draft becomes the contract's JSON: yes/no words, no null, optional plan fields left out", () => {
  const spec = planDraftToSpec(ready()) as Record<string, unknown>;
  assert.deepEqual(spec.screen, { filters: [{ id: 4 }], listAt: "08:30", maxList: 30 });
  assert.equal(spec.hideDates, "yes");
  assert.deepEqual((spec.setup as Record<string, unknown>).window, { from: "09:30", to: "11:30" });
  assert.deepEqual((spec.setup as { plan: unknown }).plan, { stopRequired: "yes", signalOnly: "no" });
  assert.equal(JSON.stringify(spec).includes("null"), false);
  const withPlan = ready({ setup: { ...ready().setup, maxLossUsd: "200", note: "stay small" } });
  assert.deepEqual((planDraftToSpec(withPlan) as { setup: { plan: unknown } }).setup.plan, { stopRequired: "yes", signalOnly: "no", maxLossUsd: 200, note: "stay small" });
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
  assert.equal(planFieldOfPath("setup.plan.maxLossUsd"), "maxLossUsd");
  assert.equal(planFieldOfPath("setup.armed.0.id"), "armed");
  assert.equal(planFieldOfPath("window"), "window");
  assert.equal(planFieldOfPath("plan.stopRequired"), "stopRequired");
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
