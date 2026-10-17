import assert from "node:assert/strict";
import test from "node:test";
import { calcMA, calcRSI } from "./indicators.ts";

test("calcMA keeps warm-up bars unknown and returns the trailing simple mean", () => {
  assert.deepEqual(calcMA([1, 2, 3, 4], 3), [null, null, 2, 3]);
});

test("calcRSI matches the fixed Wilder-seeded golden series", () => {
  const values = calcRSI([1, 2, 3, 2, 1, 2], 3);
  assert.deepEqual(values.slice(0, 3), [null, null, null]);
  assert.ok(Math.abs((values[3] ?? 0) - 66.6666666667) < 1e-8);
  assert.ok(Math.abs((values[4] ?? 0) - 44.4444444444) < 1e-8);
  assert.ok(Math.abs((values[5] ?? 0) - 62.962962963) < 1e-8);
});
