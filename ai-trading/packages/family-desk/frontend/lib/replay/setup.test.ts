import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import { INTERVALS, dayProblem, latestReplayDay, problemMessage } from "./setup.ts";

// Sat 2026-10-24, 11:00 AM ET.
const SATURDAY = new Date("2026-10-24T15:00:00Z");

test("the chart intervals are 1m, 5m and 15m", () => {
  assert.deepEqual([...INTERVALS], ["1m", "5m", "15m"]);
});

test("local day checks use the plan's wording", () => {
  assert.equal(dayProblem("2026-10-24", SATURDAY), "No trading on Sat 2026-10-24 · pick a weekday");
  assert.equal(dayProblem("2015-12-31", SATURDAY), "Replay goes back to Jan 4, 2016");
  assert.equal(dayProblem("2016-01-04", SATURDAY), null);
  assert.equal(dayProblem("2026-10-23", SATURDAY), null);
  assert.equal(dayProblem("2026-10-26", SATURDAY), "No replay for a date after today · pick Fri 2026-10-23 or earlier");
  assert.equal(dayProblem("2030-01-01", SATURDAY), "No replay for a date after today · pick Fri 2026-10-23 or earlier");
  assert.equal(dayProblem("2026-10-26", new Date("2026-10-26T13:00:00Z")), "This session isn't finished yet · replay opens at 4:15 PM ET", "today, before 4:15 PM ET");
  assert.equal(dayProblem("not a day", SATURDAY), "Pick a day");
});

test("the latest day opens at 4:15 PM ET on a weekday, else it is the previous weekday", () => {
  assert.equal(latestReplayDay(new Date("2026-10-23T20:14:00Z")), "2026-10-22", "Fri 4:14 PM ET");
  assert.equal(latestReplayDay(new Date("2026-10-23T20:15:00Z")), "2026-10-23", "Fri 4:15 PM ET");
  assert.equal(latestReplayDay(new Date("2026-10-24T15:00:00Z")), "2026-10-23", "Saturday");
  assert.equal(latestReplayDay(new Date("2026-10-25T15:00:00Z")), "2026-10-23", "Sunday");
  assert.equal(latestReplayDay(new Date("2026-10-26T12:00:00Z")), "2026-10-23", "Monday morning");
});

test("a failed request shows the server's first plain message, else its detail, else the fallback", () => {
  const error = new DeskApiError("http", 422, { problems: [{ path: "startAt", message: "No trades for XYZ on Fri 2026-10-23" }, { path: "startAt", message: "second" }] });
  assert.equal(problemMessage(error, "fallback"), "No trades for XYZ on Fri 2026-10-23");
  assert.equal(problemMessage(new DeskApiError("http", 409, { detail: "The playhead moved" }), "fallback"), "The playhead moved");
  assert.equal(problemMessage(new DeskApiError("http", 500), "fallback"), "fallback");
  assert.equal(problemMessage(new Error("boom"), "fallback"), "fallback");
});
