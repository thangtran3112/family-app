import assert from "node:assert/strict";
import test from "node:test";
import { calcMA, calcRSI, calcVWAP, tradingDay } from "./indicators.ts";

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

test("calcVWAP is the volume-weighted typical price and resets at each New York trading day", () => {
  // Two 15m bars on Thu 2026-10-22 (13:30Z and 13:45Z) and one on Fri 2026-10-23.
  const bars = [
    { t: "2026-10-22T13:30:00Z", h: 12, l: 8, c: 10, v: 100 },
    { t: "2026-10-22T13:45:00Z", h: 15, l: 9, c: 12, v: 300 },
    { t: "2026-10-23T13:30:00Z", h: 21, l: 19, c: 20, v: 50 },
  ];
  const vwap = calcVWAP(bars);
  assert.equal(vwap[0], 10);
  assert.ok(Math.abs((vwap[1] ?? 0) - (10 * 100 + 12 * 300) / 400) < 1e-9);
  assert.equal(vwap[2], 20);
});

test("a late-evening UTC bar belongs to the same New York day", () => {
  assert.equal(tradingDay("2026-10-23T03:30:00Z"), "2026-10-22");
  assert.equal(tradingDay("2026-10-23T13:30:00Z"), "2026-10-23");
  assert.equal(tradingDay("2026-10-23"), "2026-10-23");
});

test("zero volume leaves VWAP unknown", () => {
  assert.deepEqual(calcVWAP([{ t: "2026-10-23T13:30:00Z", h: 2, l: 1, c: 1, v: 0 }]), [null]);
});
