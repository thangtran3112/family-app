import assert from "node:assert/strict";
import test from "node:test";
import { nextRoll, READ_ROOTS, todayEt } from "./futuresRead.ts";

test("the next roll is the first date on or after today", () => {
  assert.equal(nextRoll(["2026-12-10", "2026-09-10", "2027-03-11"], "2026-10-29"), "2026-12-10");
  assert.equal(nextRoll(["2026-10-29"], "2026-10-29"), "2026-10-29");
  assert.equal(nextRoll(["2026-09-10"], "2026-10-29"), null);
  assert.equal(nextRoll([], "2026-10-29"), null);
});

test("today is the New York calendar day", () => {
  assert.equal(todayEt(new Date("2026-10-29T02:30:00Z")), "2026-10-28");
  assert.equal(todayEt(new Date("2026-10-29T14:30:00Z")), "2026-10-29");
});

test("the reading covers ES, NQ, CL and GC", () => {
  assert.deepEqual([...READ_ROOTS], ["ES", "NQ", "CL", "GC"]);
});
