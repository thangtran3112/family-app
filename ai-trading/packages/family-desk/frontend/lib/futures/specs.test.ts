import assert from "node:assert/strict";
import test from "node:test";
import { marginText, rollEvents, sizeMicroFirst } from "./specs.ts";

test("margin text never presents missing margin as an estimate", () => {
  assert.equal(marginText(null, null), "not available");
  assert.equal(marginText(1234, "2026-10-01"), "≈ $1,234 (as of 2026-10-01)");
});

test("micro sizing uses actual multipliers and rounds down within the risk budget", () => {
  assert.deepEqual(sizeMicroFirst(501, 6820, 6770, 5, 50), {
    contracts: 2,
    riskPerContract: 250,
    miniRisk: 2500,
    reason: null,
  });
});

test("micro sizing reports zero when one micro exceeds the risk budget", () => {
  assert.deepEqual(sizeMicroFirst(249, 6820, 6770, 5, 50), {
    contracts: 0,
    riskPerContract: 250,
    miniRisk: 2500,
    reason: "Risk is too small for one micro contract.",
  });
});

test("micro sizing rejects invalid risk, stop distance, and contract multipliers", () => {
  for (const result of [
    sizeMicroFirst(0, 100, 90, 5, 50),
    sizeMicroFirst(100, 100, 100, 5, 50),
    sizeMicroFirst(100, 100, 90, Number.NaN, 50),
    sizeMicroFirst(Number.MAX_VALUE, 1, 1 + Number.EPSILON, 5, 50),
  ]) {
    assert.equal(result.contracts, null);
    assert.ok(result.reason);
  }
});

test("roll events keep each root schedule and combine roots only on exact shared dates", () => {
  assert.deepEqual(rollEvents([
    { root: "CL", roll_dates: ["2026-10-20"] },
    { root: "MCL", roll_dates: ["2026-10-19"] },
    { root: "GC", roll_dates: ["2026-11-30"] },
    { root: "MGC", roll_dates: ["2026-11-27"] },
    { root: "ES", roll_dates: ["2026-12-14"] },
    { root: "MES", roll_dates: ["2026-12-14"] },
  ]), [
    { date: "2026-10-19", roots: ["MCL"] },
    { date: "2026-10-20", roots: ["CL"] },
    { date: "2026-11-27", roots: ["MGC"] },
    { date: "2026-11-30", roots: ["GC"] },
    { date: "2026-12-14", roots: ["ES", "MES"] },
  ]);
});
