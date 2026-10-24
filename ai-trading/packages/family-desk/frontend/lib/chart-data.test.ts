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

import { crosshairPoint, seriesMarkers, shadingData, volumeData } from "./chart-data.ts";

const intraday = [
  { t: "2026-10-23T13:30:00Z", o: 10, h: 12, l: 9, c: 11, v: 100, ext: false },
  { t: "2026-10-23T13:45:00Z", o: 11, h: 12, l: 9, c: 10, v: 50, ext: false },
  { t: "2026-10-23T12:00:00Z", o: 10, h: 11, l: 9, c: 10, v: null, ext: true },
];

test("volume columns are coloured by direction and unknown volume is whitespace", () => {
  const data = volumeData(intraday);
  assert.equal(data.length, 3);
  assert.deepEqual(data[0], { time: chartTime(intraday[2]!.t) });
  assert.deepEqual(data[1], { time: chartTime(intraday[0]!.t), value: 100, color: "#30D15866" });
  assert.deepEqual(data[2], { time: chartTime(intraday[1]!.t), value: 50, color: "#FF453A66" });
});

test("only extended-hours bars get a shading column", () => {
  const data = shadingData(intraday);
  assert.deepEqual(data[0], { time: chartTime(intraday[2]!.t), value: 1, color: "#141416" });
  assert.deepEqual(data[1], { time: chartTime(intraday[0]!.t) });
});

test("markers: patterns below, bells above, sorted, unmatched dropped", () => {
  const markers = seriesMarkers(intraday, [
    { time: "2026-10-23T13:45:00Z", kind: "fire", label: "ORB 15m" },
    { time: "2026-10-23T13:30:00Z", kind: "pattern", label: "Hammer" },
    { time: "2026-10-23T09:00:00Z", kind: "pattern", label: "Doji" },
  ]);
  assert.equal(markers.length, 2);
  assert.deepEqual(markers[0], { time: chartTime("2026-10-23T13:30:00Z"), position: "belowBar", shape: "arrowUp", color: "#F2F2F4", text: "Hammer" });
  assert.equal(markers[1]!.position, "aboveBar");
  assert.equal(markers[1]!.color, "#FFB020");
  assert.deepEqual(seriesMarkers([], [{ time: "2026-10-23T13:30:00Z", kind: "pattern", label: "x" }]), []);
});

test("daily bars match markers by New York date", () => {
  const daily = [{ t: "2026-10-22", o: 1, h: 2, l: 1, c: 2 }, { t: "2026-10-23", o: 1, h: 2, l: 1, c: 2 }];
  const markers = seriesMarkers(daily, [{ time: "2026-10-23T13:30:00Z", kind: "fire", label: "x" }]);
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0]!.time, { year: 2026, month: 10, day: 23 });
});

test("crosshair points carry candle, volume and series values with null for missing", () => {
  const point = crosshairPoint(chartTime("2026-10-23T13:30:00Z"), { open: 1, high: 3, low: 0.5, close: 2 }, { value: 900 }, { ema9: { value: 1.5 }, vwap: undefined });
  assert.deepEqual([point.open, point.high, point.low, point.close, point.volume], [1, 3, 0.5, 2, 900]);
  assert.deepEqual(point.values, { ema9: 1.5, vwap: null });
  assert.equal(crosshairPoint(chartTime("2026-10-23T13:30:00Z"), undefined, undefined, {}).close, null);
});
