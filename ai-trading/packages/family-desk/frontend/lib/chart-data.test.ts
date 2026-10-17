import assert from "node:assert/strict";
import test from "node:test";
import { chartTime, candlestickData, currentValue, lineData } from "./chart-data.ts";

test("date-only chart times stay business days without an ET date shift", () => {
  assert.deepEqual(chartTime("2026-10-16"), { year: 2026, month: 10, day: 16 });
});

test("timestamp chart times use whole UTC seconds", () => {
  assert.equal(chartTime("2026-10-16T13:30:00Z"), Math.floor(Date.parse("2026-10-16T13:30:00Z") / 1000));
});

test("current chart values do not walk backward across trailing whitespace and preserve zero", () => {
  assert.equal(currentValue([12, null]), null);
  assert.equal(currentValue([12, 0]), 0);
});

test("bar and line points are sorted, unique, and use whitespace for missing values", () => {
  const bars = [
    { t: "2026-10-16T13:31:00Z", o: 2, h: 3, l: 1, c: 2, v: 10 },
    { t: "2026-10-16T13:30:00Z", o: null, h: 3, l: 1, c: 2, v: 10 },
    { t: "2026-10-16T13:31:00Z", o: 3, h: 4, l: 2, c: 3, v: 20 },
  ];
  assert.deepEqual(candlestickData(bars), [
    { time: chartTime(bars[1]!.t) },
    { time: chartTime(bars[0]!.t), open: 3, high: 4, low: 2, close: 3 },
  ]);
  assert.deepEqual(lineData(bars, [4, null, 5]), [
    { time: chartTime(bars[1]!.t) },
    { time: chartTime(bars[0]!.t), value: 5 },
  ]);
});
