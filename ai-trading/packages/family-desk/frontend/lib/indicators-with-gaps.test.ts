import assert from "node:assert/strict";
import test from "node:test";
import { calcRSIWithGaps } from "./indicators-with-gaps.ts";

test("RSI remains unknown at a nullable close and re-warms on the original bar indices", () => {
  const closes = [1, 2, 3, 2, 1, 2, null, 1, 2, 3, 2, 1, 2];
  const rsi = calcRSIWithGaps(closes, 3);

  assert.equal(rsi.length, closes.length);
  assert.deepEqual(rsi.slice(0, 3), [null, null, null]);
  assert.ok(rsi[4] !== null && Math.abs(rsi[4] - 44.4444444444) < 1e-8);
  assert.equal(rsi[6], null);
  assert.deepEqual(rsi.slice(7, 10), [null, null, null]);
  assert.ok(rsi[10] !== null && Math.abs(rsi[10] - 66.6666666667) < 1e-8);
});
