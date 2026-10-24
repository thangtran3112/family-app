import assert from "node:assert/strict";
import test from "node:test";
import { calcRSIWithGaps, calcVWAPWithGaps } from "./indicators-with-gaps.ts";

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

test("VWAP with gaps skips a missing bar without restarting the session sum", () => {
  const bars = [
    { t: "2026-10-23T13:30:00Z", h: 12, l: 8, c: 10, v: 100 },
    { t: "2026-10-23T13:45:00Z", h: null, l: null, c: null, v: null },
    { t: "2026-10-23T14:00:00Z", h: 15, l: 9, c: 12, v: 300 },
  ];
  const vwap = calcVWAPWithGaps(bars);
  assert.equal(vwap[0], 10);
  assert.equal(vwap[1], null);
  assert.ok(Math.abs((vwap[2] ?? 0) - (10 * 100 + 12 * 300) / 400) < 1e-9);
  assert.equal(calcVWAPWithGaps([]).length, 0);
});
