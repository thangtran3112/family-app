import assert from "node:assert/strict";
import test from "node:test";
import { attachPinchZoom, chartTime, candlestickData, changedFrom, currentValue, followsNewest, lineData, pinchFactor, pinnedRange, rightOffsetOption, syncSeries, valueRuns, zoomedRange, type ChartBar, type SeriesFed } from "./chart-data.ts";

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

import { defaultChartPrefs } from "./replay/chartPrefs.ts";
import { chartLevels, positionLevel, stopLevel } from "./replay/marks.ts";
import { TAG_CLEARANCE, TAG_HEIGHT, axisTagPrices, clearTickLabel, crosshairPoint, drawnTagYs, formatChartClock, paneHeights, replayTickLabel, seriesMarkers, shadingData, sourceTimeLabel, valueAtOrBefore, volumeData, wholeAxisLabel } from "./chart-data.ts";

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

test("replay axes read as time of day, with the date on day ticks", () => {
  const time = chartTime("2026-10-23T14:07:00Z");
  assert.equal(formatChartClock(time), "10:07 AM");
  assert.equal(formatChartClock({ year: 2026, month: 10, day: 23 }), "");
  assert.equal(replayTickLabel(time, 3), "10:07 AM");
  assert.equal(replayTickLabel(time, 4), "10:07 AM");
  assert.equal(replayTickLabel(time, 2), "Oct 23");
  assert.equal(replayTickLabel({ year: 2026, month: 10, day: 23 }, 2), "");
});

test("the data table's source time is the bar's ET day and time, never a raw UTC string (M4, V-Technicals-05)", () => {
  assert.equal(sourceTimeLabel("2026-10-23T14:07:00Z"), "Fri 2026-10-23 10:07 AM");
  assert.equal(sourceTimeLabel("2026-10-23"), "Fri 2026-10-23", "a daily bar has no clock");
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

test("a followed replay chart waits at the session's first bar only before the open, and follows the newest bar from the first session bar on (D-099, D-186)", () => {
  // 40 lookback bars, the session opens at index 40; the view is 35 slots wide, with the last 10 lookback bars in view before the open.
  assert.deepEqual(pinnedRange(40, 40, 35, 10), { from: 30, to: 65 }, "before the open: the view waits, the lookback in view to the left of the open (D-220)");
  assert.equal(pinnedRange(41, 40, 35, 10), null, "1 bar in: the chart follows the newest bar, with the lookback to its left");
  // A few candles pinned at the left edge of a blank plot left the time axis with no label to print (D-186): 5 and 26 bars in follow too.
  assert.equal(pinnedRange(45, 40, 35, 10), null, "5 bars in: not bunched at the left edge");
  assert.equal(pinnedRange(66, 40, 35, 10), null, "26 bars in");
  // A lookback shorter than the view: the range starts at the first bar.
  assert.deepEqual(pinnedRange(3, 3, 35, 90), { from: 0, to: 35 }, "a short lookback: from the first bar");
});

test("an update moves a followed chart to its newest bar from the first session bar on, whatever the data came from (D-195)", () => {
  // 6000 lookback bars, the session opens at index 6000; the view is 100 slots wide with the newest bar 10 from its right edge.
  const open = pinnedRange(6000, 6000, 99, 90);
  assert.deepEqual(open, { from: 5910, to: 6009 }, "before the open the view waits, with 90 lookback bars in view and the open 9 slots from its right edge (D-220)");
  assert.equal(followsNewest(true, { from: 5998, to: 6097 }, 5999, open), false, "no session bar yet: it keeps waiting");
  // The first session bar arrives (the clock moved: Step, Play, a Pause in another window, the clock route): `waiting` is gone and the
  // view was parked on the old newest bar, so it follows. Nothing of this depends on where the data came from.
  assert.equal(followsNewest(true, { from: 5998, to: 6097 }, 5999, pinnedRange(6001, 6000, 99, 90)), true, "the first session bar");
  assert.equal(followsNewest(true, { from: 5911, to: 6010 }, 6003, pinnedRange(6005, 6000, 99, 90)), true, "four bars on: the newest bar and its pad are in view, so it follows");
  assert.equal(followsNewest(true, null, 6003, null), true, "no view yet");
  assert.equal(followsNewest(true, { from: 5905, to: 6001.5 }, 6003, null), true, "a bar and a half behind still counts as parked");
  assert.equal(followsNewest(true, { from: 5800, to: 5899 }, 6003, null), false, "she scrolled back to read the past: the view is hers");
  assert.equal(followsNewest(false, { from: 5911, to: 6010 }, 6003, null), false, "a chart that does not follow stays where it is");
});

test("a value line is one run per stretch of values: a gap of no value is never joined across (D-231)", () => {
  assert.deepEqual(valueRuns([1, 2, null, null, 3, 4]), [[0, 2], [4, 6]], "a session, the pre-market, the next session");
  assert.deepEqual(valueRuns([null, 1, 2, null, NaN]), [[1, 3]], "a leading gap, and a gap at the end is not a run");
  assert.deepEqual(valueRuns([5, 6, 7]), [[0, 3]], "one run when nothing is missing");
  assert.deepEqual(valueRuns([]), [], "no bars, no runs");
});

test("the right offset is sent to the time scale once, not on every data update (the library scrolls to it each time it is set)", () => {
  assert.deepEqual(rightOffsetOption(null, 10), { rightOffset: 10 }, "first draw");
  assert.deepEqual(rightOffsetOption(10, 10), {}, "a data update leaves her scroll position alone");
  assert.deepEqual(rightOffsetOption(0, 0), {}, "a chart that does not follow is left alone too");
  assert.deepEqual(rightOffsetOption(0, 10), { rightOffset: 10 }, "a chart that starts following takes its offset");
});

test("a time-axis label that would print cut at the edge is left out, a whole one stays (D-180)", () => {
  // Peek at 1440: "04:00 AM" sat on the first bar and read "0 AM"; the next hours were whole.
  assert.equal(wholeAxisLabel("04:00 AM", 0, 420), "");
  assert.equal(wholeAxisLabel("05:00 AM", 96, 420), "05:00 AM");
  // The right edge cuts as well.
  assert.equal(wholeAxisLabel("09:30 AM", 410, 420), "");
  // Replay at 1180 with the drawer open: a 520 px axis keeps the labels that fit and none that do not.
  const labels = [{ x: 14, text: "08:30 AM" }, { x: 150, text: "09:00 AM" }, { x: 300, text: "09:30 AM" }, { x: 516, text: "10:15 AM" }];
  assert.deepEqual(labels.map(({ x, text }) => wholeAxisLabel(text, x, 520)), ["", "09:00 AM", "09:30 AM", ""]);
  // Unknown place (the chart could not say) and an empty label pass through.
  assert.equal(wholeAxisLabel("04:00 AM", null, 420), "04:00 AM");
  assert.equal(wholeAxisLabel("", 0, 420), "");
});

test("a price-axis tick under a last-value tag is left out; the tick one step away stays (D-181)", () => {
  // Week review: the "Equity $51,457.00" tag sits 7 px from the "$51,500" tick and 61 px from "$51,000".
  assert.equal(clearTickLabel("$51,500", 100, [107]), "");
  assert.equal(clearTickLabel("$51,000", 161, [107]), "$51,000");
  assert.equal(clearTickLabel("$51,500", 100, [100 + TAG_CLEARANCE]), "$51,500", "exactly the clearance apart reads apart");
  assert.equal(clearTickLabel("$51,500", 100, [107, 300]), "", "any tag in reach hides it");
  assert.equal(clearTickLabel("$51,500", null, [107]), "$51,500", "no place, no verdict: the tick stays");
  assert.equal(clearTickLabel("$51,500", 100, []), "$51,500");
});

test("the replay price axis leaves out a tick that any tag sits on: levels, last price, position and stop (D-196)", () => {
  // TSLA at 9:34 AM ET. A tick label is 16 px clear of every tag or it is left out (D-181); dollars map to px at the scene's own scale.
  const keyLevels = chartLevels({ prior_close: 384.2, session_high: 386.83, session_low: 380.97 }, defaultChartPrefs());
  const ticks = (pxPerDollar: number, tags: readonly number[], labels: number[]) => {
    const y = (price: number) => (400 - price) * pxPerDollar;
    return labels.map((price) => clearTickLabel(price.toFixed(2), y(price), tags.map(y)));
  };
  const flat = axisTagPrices([], keyLevels, 372.47);
  assert.deepEqual([...flat].sort(), [372.47, 380.97, 384.2, 386.83], "the level tags and the last-price tag");
  // 1440: "372.00" sat under the red last-price tag (7 px), "386.00" under the session high (12 px), "380.00" under the session low (14 px).
  assert.deepEqual(ticks(14, flat, [372, 376, 380, 382.5, 386, 388]), ["", "376.00", "", "382.50", "", "388.00"]);
  // 1180 with the Practice drawer open (9 px a dollar): "387.50" sat under the session high (6 px), "382.50" under the session low (14 px).
  assert.deepEqual(ticks(9, flat, [382.5, 387.5, 390, 377.5]), ["", "", "390.00", "377.50"]);
  // A short opened at 374.94 with a stop at 378.50 adds two tags: "376.00" (15.9 px at 15 px a dollar) and "378.00" now sit under them.
  const held = axisTagPrices([], [...keyLevels, ...positionLevel({ side: "short", shares: 50, entry_price: 374.94 }), ...stopLevel({ stop_price: 378.5 })], 372.47);
  assert.deepEqual([...held].sort(), [372.47, 374.94, 378.5, 380.97, 384.2, 386.83], "the position and stop tags join them");
  assert.deepEqual(ticks(15, held, [376, 378, 370]), ["", "", "370.00"]);
  assert.deepEqual(ticks(15, flat, [376, 378, 370]), ["376.00", "378.00", "370.00"], "without them the same ticks stay");
});

test("a level line that prints no number, a missing price and a hidden last-price pill leave their ticks alone (D-196)", () => {
  assert.deepEqual(axisTagPrices([], [{ price: 376, plain: true }, { price: null }, { price: Number.NaN }, { price: 380 }], null), [380]);
  assert.deepEqual(axisTagPrices([375.2, null], [], 372.47), [375.2, 372.47], "the overlays' last values come first, then the last price");
});

// The wave-13 walk's TSLA 1m/15m pane at 1440: 286 px tall, 384.00 at y 99.5 and 11.5 px a dollar.
const WALK_PANE = 286;
const walkY = (price: number) => 99.5 + (384 - price) * 11.5;

test("a price tick the pane's edge would cut is left out; one that fits stays (D-199)", () => {
  // 9:34: "368.00" was centred 3 px above the bottom of the pane and read with its lower half gone; "370.26" above it is whole.
  assert.equal(clearTickLabel("368.00", WALK_PANE - 3, [], WALK_PANE), "");
  assert.equal(clearTickLabel("370.26", walkY(370.26), [], WALK_PANE), "370.26");
  assert.equal(clearTickLabel("388.00", 3, [], WALK_PANE), "", "the top edge cuts as well");
  assert.equal(clearTickLabel("368.00", WALK_PANE - 3, [], null), "368.00", "a pane the chart cannot measure gives no verdict");
  assert.equal(clearTickLabel("368.00", WALK_PANE - 3, [10]), "368.00", "and none is asked of a caller that sends no height");
});

test("the tags the chart draws are where it stacks them, not at their prices (D-200)", () => {
  // The 15m axis at 9:40: the white EMA tag and the grey tags above the red last-price tag sit within a tag height of each other, so the
  // chart pushes each one up from the one below it (the screenshot's 120.5, 137, 154, 171 and 214.5 px).
  const prices = [380.58, 380.15, 377.94, 377.74, 372.62];
  const last = walkY(372.57);
  const drawn = drawnTagYs([...prices.map(walkY), last], WALK_PANE, last);
  assert.deepEqual(drawn.map((y) => Math.round(y * 2) / 2), [120.5, 137.5, 154.5, 171.5, 214, 231]);
  assert.equal(TAG_HEIGHT, 17);
  // A tag with nothing near it stays on its price; the last price is the centre and never moves.
  assert.deepEqual(drawnTagYs([100, 250], WALK_PANE, 250), [100, 250]);
  // The pane's edge pulls a tag that overlaps it back inside (the library's own clamp).
  assert.deepEqual(drawnTagYs([2, 283], WALK_PANE, 143), [8, WALK_PANE - 8]);
});

test("a tick the chart's stacking put under a tag is left out, whatever its own price was (D-200)", () => {
  const prices = [386.83, 380.58, 380.15, 377.94, 377.74, 372.62];
  const last = walkY(372.57);
  const tags = [...prices.map(walkY), last];
  const ticks = [384, 382, 380, 376, 374, 370];
  const read = (against: readonly number[]) => ticks.map((price) => clearTickLabel(price.toFixed(2), walkY(price), against, WALK_PANE));
  // Measured from each tag's price (D-196), "382.00" stayed: 16.3 px from the nearest price, yet the chart drew the "380.58" tag 2 px from it.
  assert.deepEqual(read(tags), ["384.00", "382.00", "", "376.00", "", "370.00"]);
  assert.deepEqual(read(drawnTagYs(tags, WALK_PANE, last)), ["384.00", "", "", "376.00", "", "370.00"], "from where the tags are drawn, 382.00 is under one");
});

test("an axis tag shows the value at the last bar in view, so a chart scrolled back tags an older value (D-200)", () => {
  const ema = [10, 11, null, 13, null];
  assert.equal(valueAtOrBefore(ema, 4), 13, "the newest bar in view: the newest value, skipping a gap");
  assert.equal(valueAtOrBefore(ema, 14.6), 13, "a right edge past the data (the follow padding) is the newest bar");
  assert.equal(valueAtOrBefore(ema, 1.2), 11, "scrolled back: the edge rounds up to bar 2 as the library's does, bar 2 has no value, so bar 1's");
  assert.equal(valueAtOrBefore(ema, 0), 10);
  assert.equal(valueAtOrBefore(ema, -3), null, "nothing in view yet");
  assert.equal(valueAtOrBefore([null, null], 1), null);
});

// D-206: a followed chart is handed its bars again on every poll. The library's series are sent only what changed from the newest bar on.
type Point = { time: number; value?: number };
/** A stand-in for a library series: it keeps its points by time, refuses an `update` older than its newest (as the library does) and counts what it was sent. */
function fakeSeries() {
  const held = new Map<number, Point>();
  return {
    held,
    sent: { set: 0, updated: 0 },
    setData(points: Point[]) {
      this.sent.set += 1;
      held.clear();
      for (const point of points) held.set(point.time, point);
    },
    update(point: Point) {
      if (held.size > 0 && point.time < Math.max(...held.keys())) throw new Error("Cannot update oldest data");
      this.sent.updated += 1;
      held.set(point.time, point);
    },
  };
}
const minuteBar = (minute: number, close = 1): ChartBar => ({ t: `2026-10-16T13:${String(minute).padStart(2, "0")}:00Z`, o: 1, h: 2, l: 0.5, c: close, v: 5 });
const points = (bars: ChartBar[], values: Array<number | null>) => lineData(bars, values) as Point[];
const closes = (bars: readonly ChartBar[]) => bars.map((bar) => bar.c);
const dataOf = (series: ReturnType<typeof fakeSeries>) => [...series.held.values()].sort((a, b) => a.time - b.time);

test("a followed chart's refresh sends the series only the newest bar and the ones after it", () => {
  const fed = new WeakMap<object, SeriesFed>();
  const series = fakeSeries();
  const first = Array.from({ length: 6 }, (_, minute) => minuteBar(minute));
  assert.equal(syncSeries(series, fed, first, closes(first), "", points), -1, "the first draw sends everything");
  assert.deepEqual(series.sent, { set: 1, updated: 0 });

  // The forming candle (the last bar) moves: a new object for the same start, the older bars the very same objects.
  const moved = [...first.slice(0, 5), minuteBar(5, 9)];
  assert.equal(syncSeries(series, fed, moved, closes(moved), "", points), 5);
  // It closes and the next one forms: the newest point again, and one more.
  const grown = [...moved.slice(0, 5), minuteBar(5, 4), minuteBar(6, 3)];
  assert.equal(syncSeries(series, fed, grown, closes(grown), "", points), 5);
  // A bar appended after an unchanged newest one: one point.
  const longer = [...grown, minuteBar(7, 2)];
  assert.equal(syncSeries(series, fed, longer, closes(longer), "", points), 7);
  assert.deepEqual(series.sent, { set: 1, updated: 1 + 2 + 1 }, "never the whole series again");
  assert.deepEqual(dataOf(series), points(longer, closes(longer)), "what the series holds is what a full send would hold");

  // The same bars again (a poll that brought nothing, or an option changed): nothing is sent.
  assert.equal(syncSeries(series, fed, longer, closes(longer), "", points), longer.length);
  assert.deepEqual(series.sent, { set: 1, updated: 4 });
});

test("a series is sent everything when a bar behind the newest changed, the bars got fewer, the key changed or the values changed behind the newest", () => {
  const bars = Array.from({ length: 6 }, (_, minute) => minuteBar(minute));
  const fresh = () => {
    const fed = new WeakMap<object, SeriesFed>();
    const series = fakeSeries();
    syncSeries(series, fed, bars, closes(bars), "a", points);
    return { fed, series };
  };
  const cases: Array<[string, ChartBar[], Array<number | null>, string]> = [
    ["an older bar was revised", [...bars.slice(0, 2), minuteBar(2, 7), ...bars.slice(3)], closes(bars), "a"],
    ["fewer bars", bars.slice(0, 4), closes(bars).slice(0, 4), "a"],
    ["another key", bars, closes(bars), "b"],
    ["a value behind the newest changed", bars, [...closes(bars).slice(0, 3), 8, 1, 1], "a"],
  ];
  for (const [label, next, values, key] of cases) {
    const { fed, series } = fresh();
    assert.equal(syncSeries(series, fed, next, values, key, points), -1, label);
    assert.equal(series.sent.set, 2, `${label}: sent in full`);
    assert.deepEqual(dataOf(series), points(next, values), label);
  }
});

test("a series the library will not update falls back to sending everything", () => {
  const fed = new WeakMap<object, SeriesFed>();
  const series = fakeSeries();
  const bars = Array.from({ length: 4 }, (_, minute) => minuteBar(minute));
  syncSeries(series, fed, bars, closes(bars), "", points);
  // A bar list that is not ascending: the tail the feed sends would be older than the series' newest point.
  const odd = [...bars.slice(0, 3), minuteBar(1, 5), minuteBar(5)];
  assert.equal(syncSeries(series, fed, odd, closes(odd), "", points), -1);
  assert.deepEqual(dataOf(series), points(odd, closes(odd)));
});

test("changedFrom reads references, so a bar list rebuilt object by object is a first draw", () => {
  const bars = Array.from({ length: 3 }, (_, minute) => minuteBar(minute));
  const fed: SeriesFed = { bars, values: null, key: "" };
  assert.equal(changedFrom(fed, bars.map((bar) => ({ ...bar })), null, ""), -1);
  assert.equal(changedFrom(fed, [...bars, minuteBar(3)], null, ""), 3);
  assert.equal(changedFrom(undefined, bars, null, ""), -1);
});

test("volume points and markers still come out of the whole bar list", () => {
  const bars = Array.from({ length: 3 }, (_, minute) => minuteBar(minute));
  assert.equal(volumeData(bars).length, 3);
  assert.deepEqual(seriesMarkers(bars, []), [], "no markers: nothing to place");
});
