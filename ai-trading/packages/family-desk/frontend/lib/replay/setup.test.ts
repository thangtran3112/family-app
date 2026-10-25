import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import {
  defaultDraft,
  dayProblem,
  draftToSpec,
  fieldOfPath,
  fieldProblems,
  latestReplayDay,
  problemMessage,
  toggleArmed,
  validateDraft,
  withNotableDay,
  withSession,
  withTypedDay,
  type SetupDraft,
} from "./setup.ts";

// Sat 2026-10-24, 11:00 AM ET.
const SATURDAY = new Date("2026-10-24T15:00:00Z");
const valid = (): SetupDraft => ({ ...defaultDraft(), symbol: "nvda", day: "2026-10-23", armed: [{ source: "alert_strategy", id: 7 }], maxLossUsd: "200" });

test("a filled draft validates against the contract and becomes the contract JSON", () => {
  const result = validateDraft(valid(), SATURDAY);
  assert.equal(result.ok, true);
  assert.deepEqual(draftToSpec(valid()), {
    schemaVersion: 1,
    symbol: "NVDA",
    day: "2026-10-23",
    window: { from: "09:30", to: "16:00" },
    session: "regular",
    interval: "5m",
    shares: 100,
    armed: [{ source: "alert_strategy", id: 7 }],
    plan: { stopRequired: "yes", signalOnly: "no", maxLossUsd: 200 },
    hideDate: "no",
  });
});

test("an empty draft reports a message per field, never a raw Zod message", () => {
  const result = validateDraft(defaultDraft(), SATURDAY);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problems.day, "Pick a day");
  assert.match(result.problems.symbol ?? "", /stock or ETF symbol/);
});

test("bad numbers and windows land on the field that shows them", () => {
  const cases: Array<[Partial<SetupDraft>, string, RegExp]> = [
    [{ shares: "0" }, "shares", /1 to 10,000/],
    [{ shares: "1.5" }, "shares", /whole number/],
    [{ shares: "" }, "shares", /whole number/],
    [{ maxLossUsd: "-5" }, "maxLossUsd", /whole dollars/],
    [{ maxTrades: "51" }, "maxTrades", /1 to 50/],
    [{ from: "11:00", to: "10:00" }, "window", /before/],
    [{ from: "08:00" }, "window", /09:30-16:00/],
    [{ symbol: "/ES" }, "symbol", /stock or ETF/],
    [{ note: "x".repeat(501) }, "note", /500/],
  ];
  for (const [patch, field, message] of cases) {
    const result = validateDraft({ ...valid(), ...patch }, SATURDAY);
    assert.equal(result.ok, false, JSON.stringify(patch));
    if (!result.ok) assert.match(result.problems[field as keyof typeof result.problems] ?? "", message, JSON.stringify(patch));
  }
});

test("the extended session takes 04:00 to 20:00; switching resets the window", () => {
  const extended = withSession(valid(), "extended");
  assert.deepEqual([extended.from, extended.to], ["04:00", "20:00"]);
  assert.equal(validateDraft(extended, SATURDAY).ok, true);
  assert.deepEqual([withSession(extended, "regular").from, withSession(extended, "regular").to], ["09:30", "16:00"]);
});

test("no more than 5 strategies arm, and toggling twice removes one", () => {
  let armed = [] as SetupDraft["armed"];
  for (let id = 1; id <= 7; id += 1) armed = toggleArmed(armed, { source: "filter", id });
  assert.equal(armed.length, 5);
  assert.equal(toggleArmed(armed, { source: "filter", id: 3 }).length, 4);
  assert.equal(toggleArmed([], { source: "filter", id: 1 }).length, 1);
});

test("a hidden notable day stays masked and is stored hidden; a typed date is shown", () => {
  const picked = withNotableDay(defaultDraft(), { symbol: "NVDA", day: "2026-04-07" }, true);
  assert.equal(picked.dayHidden, true);
  assert.equal((draftToSpec({ ...picked, shares: "100" }) as { hideDate: string }).hideDate, "yes");
  const typed = withTypedDay(picked, "2026-04-08");
  assert.equal(typed.dayHidden, false);
  assert.equal(withNotableDay(defaultDraft(), { symbol: "NVDA", day: "2026-04-07" }, false).dayHidden, false);
});

test("local day checks use the plan's wording", () => {
  assert.equal(dayProblem("2026-10-24", SATURDAY), "No trading on Sat 2026-10-24 · pick a weekday");
  assert.equal(dayProblem("2015-12-31", SATURDAY), "Replay goes back to Jan 4, 2016");
  assert.equal(dayProblem("2016-01-04", SATURDAY), null);
  assert.equal(dayProblem("2026-10-23", SATURDAY), null);
  assert.equal(dayProblem("2026-10-26", SATURDAY), "This session isn't finished yet · replay opens at 4:15 PM ET");
  assert.equal(dayProblem("not a day", SATURDAY), "Pick a day");
});

test("the latest day opens at 4:15 PM ET on a weekday, else it is the previous weekday", () => {
  assert.equal(latestReplayDay(new Date("2026-10-23T20:14:00Z")), "2026-10-22", "Fri 4:14 PM ET");
  assert.equal(latestReplayDay(new Date("2026-10-23T20:15:00Z")), "2026-10-23", "Fri 4:15 PM ET");
  assert.equal(latestReplayDay(new Date("2026-10-24T15:00:00Z")), "2026-10-23", "Saturday");
  assert.equal(latestReplayDay(new Date("2026-10-25T15:00:00Z")), "2026-10-23", "Sunday");
  assert.equal(latestReplayDay(new Date("2026-10-26T12:00:00Z")), "2026-10-23", "Monday morning");
});

test("server problems map to fields and keep the server's plain message", () => {
  assert.equal(fieldOfPath("plan.maxLossUsd"), "maxLossUsd");
  assert.equal(fieldOfPath("plan.stopRequired"), "stopRequired");
  assert.equal(fieldOfPath("window.from"), "window");
  assert.equal(fieldOfPath("armed.2.id"), "armed");
  assert.equal(fieldOfPath("other"), "form");
  const error = new DeskApiError("http", 422, { problems: [{ path: "day", message: "No trades for XYZ on Fri 2026-10-23" }, { path: "day", message: "second" }] });
  assert.deepEqual(fieldProblems(error.problems), { day: "No trades for XYZ on Fri 2026-10-23" });
  assert.equal(problemMessage(error, "fallback"), "No trades for XYZ on Fri 2026-10-23");
  assert.equal(problemMessage(new DeskApiError("http", 409, { detail: "The playhead moved" }), "fallback"), "The playhead moved");
  assert.equal(problemMessage(new DeskApiError("http", 500), "fallback"), "fallback");
  assert.equal(problemMessage(new Error("boom"), "fallback"), "fallback");
});
