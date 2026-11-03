import assert from "node:assert/strict";
import test from "node:test";
import { PracticeSetupV2Schema } from "@ai-trading/contracts/practice-setup-v2";
import { DeskApiError } from "../api/client.ts";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import {
  DEFAULT_START_TIME,
  defaultPlanDraft,
  defaultStartDay,
  effectiveStartDay,
  livePlanProblems,
  planDraftToSetup,
  planFieldOfPath,
  planProblems,
  startAtOf,
  toggleFilter,
  validatePlanDraft,
  type PlanDraft,
} from "./planSetup.ts";

// Sat 2026-10-24, 11:00 AM ET.
const NOW = new Date("2026-10-24T15:00:00Z");
const valid = (): PlanDraft => ({ ...defaultPlanDraft(NOW), startDay: "2026-03-10", filterIds: [7] });

test("a new thread starts at the 9:30 ET open, on a weekday three months back, 5m, with nothing picked", () => {
  const draft = defaultPlanDraft(NOW);
  assert.equal(draft.startTime, DEFAULT_START_TIME);
  assert.equal(DEFAULT_START_TIME, "09:30");
  assert.equal(draft.startDay, "2026-07-01");
  assert.deepEqual([draft.interval, draft.maxList, draft.filterIds], ["5m", "30", []]);
  assert.equal(defaultStartDay(new Date("2026-04-15T12:00:00Z")), "2026-01-02", "New Year's Day rolls on to the next weekday");
});

test("the setup body is the v2 contract: one start instant, the Screen, and the chart setup; no sessions, window, list time or hide-dates", () => {
  const body = planDraftToSetup(valid()) as Record<string, unknown>;
  assert.deepEqual(body, {
    schemaVersion: 2,
    startAt: "2026-03-10T13:30:00Z", // 9:30 EDT (DST began Mar 8)
    screen: { filters: [{ id: 7 }], maxList: 30 },
    setup: { interval: "5m", session: "regular", armed: [] },
  });
  assert.equal(PracticeSetupV2Schema.safeParse(body).success, true, "the contract's own schema takes it");
  for (const gone of ["sessions", "firstDay", "hideDates"]) assert.equal(gone in body, false, gone);
  assert.equal("listAt" in (body.screen as object), false);
  assert.equal("window" in (body.setup as object), false);
});

test("startAt is whole seconds in UTC with the winter and summer offsets right", () => {
  assert.equal(startAtOf("2026-01-14", "09:30"), "2026-01-14T14:30:00Z", "EST");
  assert.equal(startAtOf("2026-07-14", "09:30"), "2026-07-14T13:30:00Z", "EDT");
  assert.equal(startAtOf("2026-07-14", ""), "");
  assert.equal(startAtOf("", "09:30"), "");
  assert.equal(startAtOf("2026-07-14", "9:30"), "", "a half-typed time is no instant");
});

test("a filled draft validates; the first message per field wins and none is a raw Zod message", () => {
  assert.equal(validatePlanDraft(valid(), NOW).ok, true);
  const empty = validatePlanDraft({ ...valid(), filterIds: [], maxList: "5", startDay: "" }, NOW);
  assert.equal(empty.ok, false);
  if (empty.ok) return;
  assert.equal(empty.problems.filters, "Pick one to three filters");
  assert.equal(empty.problems.maxList, "Screen size: a whole number from 20 to 49");
  assert.equal(empty.problems.startAt, "Pick a day");
});

test("the start day and time are read locally: a weekend, a day before 2016, a session not finished, a time in no session", () => {
  const at = (patch: Partial<PlanDraft>) => {
    const result = validatePlanDraft({ ...valid(), ...patch }, NOW);
    return result.ok ? null : (result.problems.startAt ?? null);
  };
  assert.equal(at({ startDay: "2026-10-24" }), "No trading on Sat 2026-10-24 · pick a weekday");
  assert.equal(at({ startDay: "2015-12-31" }), "Replay goes back to Jan 4, 2016");
  assert.equal(at({ startDay: "2026-10-26" }), "This session isn't finished yet · replay opens at 4:15 PM ET");
  assert.match(at({ startTime: "03:00" }) ?? "", /between 4:00 AM and 8:00 PM ET/);
  assert.match(at({ startTime: "21:15" }) ?? "", /between 4:00 AM and 8:00 PM ET/);
  assert.equal(at({ startDay: "2026-10-23", startTime: "04:00" }), null, "the extended open is a start");
  assert.equal(at({ startDay: "2016-01-04" }), null, "the first day of the practice calendar");
});

test("the contract's size bounds hold: 20 to 49 names, one to three filters", () => {
  for (const [maxList, ok] of [["19", false], ["20", true], ["49", true], ["50", false], ["", false], ["x", false]] as const) {
    assert.equal(validatePlanDraft({ ...valid(), maxList }, NOW).ok, ok, maxList);
  }
  assert.equal(validatePlanDraft({ ...valid(), filterIds: [1, 2, 3] }, NOW).ok, true);
  assert.equal(validatePlanDraft({ ...valid(), filterIds: [1, 2, 3, 4] }, NOW).ok, false);
});

test("filters toggle on and off, at most three", () => {
  let ids: number[] = [];
  for (const id of [1, 2, 3, 4]) ids = toggleFilter(ids, id);
  assert.deepEqual(ids, [1, 2, 3]);
  assert.deepEqual(toggleFilter(ids, 2), [1, 3]);
});

test("the live form leaves the missing filter to the footer", () => {
  assert.deepEqual(livePlanProblems({ ...valid(), filterIds: [] }, NOW), {});
  assert.equal(livePlanProblems({ ...valid(), startDay: "2026-10-24" }, NOW).startAt, "No trading on Sat 2026-10-24 · pick a weekday");
});

test("the recorded start day applies until she picks one", () => {
  assert.equal(effectiveStartDay("2026-07-01", false, "2025-09-02"), "2025-09-02");
  assert.equal(effectiveStartDay("2026-07-01", true, "2025-09-02"), "2026-07-01");
  assert.equal(effectiveStartDay("2026-07-01", false, null), "2026-07-01");
});

test("server problems map to fields and keep the server's plain message", () => {
  assert.equal(planFieldOfPath("startAt"), "startAt");
  assert.equal(planFieldOfPath("setup.startAt"), "startAt");
  assert.equal(planFieldOfPath("screen.filters.0.id"), "filters");
  assert.equal(planFieldOfPath("screen.maxList"), "maxList");
  assert.equal(planFieldOfPath("setup.interval"), "interval");
  assert.equal(planFieldOfPath("other"), "form");
  const error = new DeskApiError("http", 422, { problems: [{ path: "startAt", message: "That session has not finished yet" }, { path: "startAt", message: "second" }] });
  assert.deepEqual(planProblems(error.problems), { startAt: "That session has not finished yet" });
  assert.equal(planProblems([{ path: "screen.maxList", message: "" }]).maxList, "Screen size: a whole number from 20 to 49");
  assert.equal(planProblems([{ path: "startAt", message: "startAt must be on or after 2016-01-04 ET" }]).startAt, "Replay goes back to Jan 4, 2016");
});

test("the form's own sentences pass the banned-term check", () => {
  for (const text of ["Pick a trading day and a time between 4:00 AM and 8:00 PM ET", "Screen size: a whole number from 20 to 49", "Pick one to three filters"]) {
    assert.equal(containsPracticeBannedTerm(text), false, text);
  }
});
