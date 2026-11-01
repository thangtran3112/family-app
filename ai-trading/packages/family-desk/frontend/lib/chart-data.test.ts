import assert from "node:assert/strict";
import test from "node:test";
import { attachPinchZoom, chartTime, candlestickData, currentValue, lineData, pinchFactor, zoomedRange } from "./chart-data.ts";

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

// -- trackpad pinch (defect: pinch-zoom was about a tenth as fast as the fingers) ------------------------------------------
// Chrome and Edge send a trackpad pinch as ctrl+wheel events with a deltaY of a few px. lightweight-charts 5.2 treats them as
// a mouse wheel (a tenth of the bar spacing per 100 px), so 30 events of 2 px zoomed the chart by 1.06x (measured in Chromium).

test("a pinch of a few px per event zooms at least 2% per event, in and out, symmetrically", () => {
  assert.ok(pinchFactor(-2) >= 1.02, `${pinchFactor(-2)}`);
  assert.ok(pinchFactor(2) <= 1 / 1.02 + 1e-9);
  assert.equal(pinchFactor(0), 1);
  assert.ok(Math.abs(pinchFactor(-7) * pinchFactor(7) - 1) < 1e-12);
});

test("one event is capped, so a ctrl+mouse-wheel notch (100 px) is not a jump of 2.7x; line-mode deltas count as lines", () => {
  assert.equal(pinchFactor(-100), pinchFactor(-30));
  assert.ok(pinchFactor(-100) < 1.4);
  assert.equal(pinchFactor(-1, 1), pinchFactor(-16, 0));
});

/** The bar index under `x`, as the library computes it (float): the right edge is `to`, a bar is `width / count` px. */
const barAt = (range: { from: number; to: number }, x: number, width: number) => range.to - (width - 1 - x) / (width / (range.to - range.from + 1));

test("zooming keeps the bar under the cursor in place and scales the visible bars by the factor; factor 1 changes nothing", () => {
  const range = { from: 290, to: 389 };
  for (const [x, factor] of [[0, 2], [450, 1.37], [899, 0.5], [123, 1.0201]] as const) {
    const next = zoomedRange(range, x, 900, factor);
    assert.ok(Math.abs(barAt(next, x, 900) - barAt(range, x, 900)) < 1e-9, `anchor at ${x}px`);
    assert.ok(Math.abs((next.to - next.from + 1) * factor - (range.to - range.from + 1)) < 1e-9, `visible bars at ${factor}x`);
  }
  const same = zoomedRange(range, 300, 900, 1);
  assert.ok(Math.abs(same.from - 290) < 1e-9 && Math.abs(same.to - 389) < 1e-9);
});

type Wheel = Event & { ctrlKey: boolean; deltaY: number; deltaMode: number; clientX: number };
const wheel = (init: { ctrlKey: boolean; deltaY: number; clientX?: number; deltaMode?: number }) =>
  Object.assign(new Event("wheel", { cancelable: true }), { deltaMode: 0, clientX: 0, ...init }) as Wheel;

function pinchRig(range: { from: number; to: number } | null = { from: 290, to: 389 }) {
  const target = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 100 }) }) as unknown as HTMLElement;
  const calls: Array<{ from: number; to: number }> = [];
  // The library queues a range and answers `getVisibleLogicalRange` with the old one until it draws (the next frame).
  const chart = {
    timeScale: () => ({
      width: () => 900,
      getVisibleLogicalRange: () => range,
      setVisibleLogicalRange: (next: { from: number; to: number }) => { calls.push(next); },
    }),
  };
  const frames: Array<() => void> = [];
  const nextFrame = (callback: () => void) => frames.push(callback);
  const drawFrame = (drawn?: { from: number; to: number }) => {
    if (drawn) range = drawn;
    frames.splice(0).forEach((callback) => callback());
  };
  return { target, chart, calls, nextFrame, drawFrame };
}

test("a ctrl+wheel pinch zooms the chart about the cursor and stops the library's slower handler", () => {
  const { target, chart, calls, nextFrame } = pinchRig();
  const detach = attachPinchZoom(target, chart, nextFrame);
  const event = wheel({ ctrlKey: true, deltaY: -2, clientX: 500 });
  let stopped = false;
  event.stopImmediatePropagation = () => { stopped = true; };
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, "the browser does not zoom the page");
  assert.equal(stopped, true, "the library's own wheel handler never sees it");
  assert.deepEqual(calls, [zoomedRange({ from: 290, to: 389 }, 400, 900, pinchFactor(-2))], "the cursor x is taken relative to the chart's left edge");
  detach();
  target.dispatchEvent(wheel({ ctrlKey: true, deltaY: -2, clientX: 500 }));
  assert.equal(calls.length, 1, "detached: nothing more is handled");
});

test("events in one frame build on each other (the library has not drawn yet); the next frame starts from what it drew", () => {
  const { target, chart, calls, nextFrame, drawFrame } = pinchRig();
  attachPinchZoom(target, chart, nextFrame);
  const start = { from: 290, to: 389 };
  for (let i = 0; i < 3; i++) target.dispatchEvent(wheel({ ctrlKey: true, deltaY: -2, clientX: 500 }));
  const step = pinchFactor(-2);
  const once = zoomedRange(start, 400, 900, step);
  const twice = zoomedRange(once, 400, 900, step);
  assert.deepEqual(calls, [once, twice, zoomedRange(twice, 400, 900, step)]);
  drawFrame(calls[2]);
  target.dispatchEvent(wheel({ ctrlKey: true, deltaY: -2, clientX: 500 }));
  assert.deepEqual(calls[3], zoomedRange(calls[2]!, 400, 900, step), "after the draw it reads the library's range again");
});

test("a plain wheel (mouse wheel, two-finger scroll) is left to the library", () => {
  const { target, chart, calls, nextFrame } = pinchRig();
  attachPinchZoom(target, chart, nextFrame);
  const event = wheel({ ctrlKey: false, deltaY: -40 });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(calls.length, 0);
});

test("a pinch on a chart with no visible range yet is swallowed without a zoom", () => {
  const { target, chart, calls, nextFrame } = pinchRig(null);
  attachPinchZoom(target, chart, nextFrame);
  const event = wheel({ ctrlKey: true, deltaY: -2 });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(calls.length, 0);
});
