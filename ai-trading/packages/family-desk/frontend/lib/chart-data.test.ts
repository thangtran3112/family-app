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

import { crosshairPoint, formatChartClock, paneHeights, replayTickLabel, seriesMarkers, shadingData, sourceTimeLabel, volumeData } from "./chart-data.ts";

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

test("a Practice long entry is a green arrow below the bar, labelled", () => {
  assert.deepEqual(seriesMarkers(intraday, [{ time: "2026-10-23T13:30:00Z", kind: "practice_long", label: "Practice long 100" }]), [
    { time: chartTime("2026-10-23T13:30:00Z"), position: "belowBar", shape: "arrowUp", color: "#30D158", text: "Practice long 100" },
  ]);
});

test("a Practice short entry is a red arrow above the bar; a Practice exit is a circle inside it", () => {
  assert.deepEqual(
    seriesMarkers(intraday, [
      { time: "2026-10-23T13:45:00Z", kind: "practice_exit", label: "Practice exit" },
      { time: "2026-10-23T13:30:00Z", kind: "practice_short", label: "Practice short 100" },
    ]),
    [
      { time: chartTime("2026-10-23T13:30:00Z"), position: "aboveBar", shape: "arrowDown", color: "#FF453A", text: "Practice short 100" },
      { time: chartTime("2026-10-23T13:45:00Z"), position: "inBar", shape: "circle", color: "#F2F2F4", text: "Practice exit" },
    ],
  );
});

test("a would-fire signal is an amber bell above the bar, labelled with the strategy name", () => {
  assert.deepEqual(seriesMarkers(intraday, [{ time: "2026-10-23T13:45:00Z", kind: "would_fire", label: "ORB 15m" }]), [
    { time: chartTime("2026-10-23T13:45:00Z"), position: "aboveBar", shape: "circle", color: "#FFB020", text: "\u{1F514} ORB 15m" },
  ]);
});

test("pattern and fire markers keep their styles next to the Practice kinds", () => {
  assert.deepEqual(
    seriesMarkers(intraday, [
      { time: "2026-10-23T13:45:00Z", kind: "fire", label: "ORB 15m" },
      { time: "2026-10-23T13:30:00Z", kind: "pattern", label: "Hammer" },
    ]),
    [
      { time: chartTime("2026-10-23T13:30:00Z"), position: "belowBar", shape: "arrowUp", color: "#F2F2F4", text: "Hammer" },
      { time: chartTime("2026-10-23T13:45:00Z"), position: "aboveBar", shape: "circle", color: "#FFB020", text: "\u{1F514}" },
    ],
  );
});

test("Practice markers on a bar that is not loaded are dropped; the rest come out sorted by time", () => {
  const markers = seriesMarkers(intraday, [
    { time: "2026-10-23T13:45:00Z", kind: "would_fire", label: "ORB 15m" },
    { time: "2026-10-23T13:40:00Z", kind: "practice_long", label: "Practice long 100" }, // no bar starts at 13:40
    { time: "2026-10-23T13:30:00Z", kind: "practice_long", label: "Practice long 100" },
  ]);
  assert.deepEqual(markers.map((marker) => marker.time), [chartTime("2026-10-23T13:30:00Z"), chartTime("2026-10-23T13:45:00Z")]);
});

test("replay axes read as time of day, with the date only on day ticks and never when hidden", () => {
  const time = chartTime("2026-10-23T14:07:00Z");
  assert.equal(formatChartClock(time), "10:07 AM");
  assert.equal(formatChartClock({ year: 2026, month: 10, day: 23 }), "");
  assert.equal(replayTickLabel(time, 3, false), "10:07 AM");
  assert.equal(replayTickLabel(time, 4, true), "10:07 AM");
  assert.equal(replayTickLabel(time, 2, false), "Oct 23");
  assert.equal(replayTickLabel(time, 2, true), "");
  assert.equal(replayTickLabel({ year: 2026, month: 10, day: 23 }, 2, false), "");
});

test("the data table's source time: the bar's ET day and time, the caller's label while dates are hidden, else the clock (M4, V-Technicals-05)", () => {
  const stamp = "2001-01-02"; // a stand-in date: its clock time reads "07:00 PM" and says nothing
  assert.equal(sourceTimeLabel("2026-10-23T14:07:00Z", 0, false), "Fri 2026-10-23 10:07 AM", "dates shown: New York day and time, never a raw UTC string");
  assert.equal(sourceTimeLabel("2026-10-23", 0, false), "Fri 2026-10-23", "a daily bar has no clock");
  assert.equal(sourceTimeLabel("2026-10-23T14:07:00Z", 0, false, ["D-1"]), "Fri 2026-10-23 10:07 AM", "labels are for hidden dates only");
  assert.equal(sourceTimeLabel("2026-10-23T14:07:00Z", 0, true), "10:07 AM", "hidden, no labels: the time of day, as intraday charts keep it");
  assert.equal(sourceTimeLabel(stamp, 1, true, ["D-2", "D-1"]), "D-1");
  assert.equal(sourceTimeLabel(stamp, 2, true, ["D-2", "D-1"]), formatChartClock(chartTime(`${stamp}T00:00:00Z`)), "a row without a label falls back");
});

test("the price pane keeps at least 60% of the chart; indicator panes shrink to fit, never past their own height (V-Technicals-04)", () => {
  // 1440x900 workspace: about 406 px for price + RSI + MACD. Two 120 px panes would leave the price pane 166 px.
  const [price, rsi, macd] = paneHeights(406, [120, 120]);
  assert.ok(price! >= 406 * 0.6, `price pane ${price} px`);
  assert.equal(Math.round(price! + rsi! + macd!), 406);
  assert.equal(rsi, macd, "panes shrink in proportion");
  // Room to spare: indicator panes keep their own height and the price pane takes the rest.
  assert.deepEqual(paneHeights(800, [120, 100]), [580, 120, 100]);
  assert.deepEqual(paneHeights(300, []), [300]);
});
