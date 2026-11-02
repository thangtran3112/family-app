// Golden tests: the browser's indicators pinned to values that do not come from the code under test, and (through the
// shared fixture) to the backend's `core/indicators.py`. The backend pins the same file in `tests/test_indicator_golden.py`.
//
// References: closed forms derived by hand (a ramp's EMA and MACD, a 14-bar RSI, a three-bar VWAP); TA-Lib 0.8.3 on the
// classic 33-close Wilder RSI series and at the last of 300 REAL daily TSLA bars (Alpaca SIP); plain-Python loops over
// REAL one-minute TSLA bars (Alpaca SIP). Regenerate the fixture with `backend/tests/make_indicator_golden.py`.
//
// Conventions (the backend's, which these functions follow): Wilder smoothing seeded by the mean of the first `period`
// values; EMA seeded with the FIRST value and unknown until `period` bars; VWAP of the typical price (h+l+c)/3 over the
// regular session only (pre- and after-hours bars read unknown), restarting each New York trading day.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calcVWAPWithGaps } from "./indicators-with-gaps.ts";
import { calcEMA, calcMACD, calcRSI, calcVWAP } from "./indicators.ts";

type Pinned = [index: number, value: number];
const golden = JSON.parse(readFileSync(new URL("../../contracts/fixtures/indicator-golden-v1/golden.json", import.meta.url), "utf8")) as {
  daily: { rows: [string, number, number, number][] };
  daily_last: Record<string, number>;
  daily_warmup: Record<string, Pinned[]>;
  minutes: { rows: [string, number, number, number, number, string][] };
  vwap: (number | null)[];
};
const closes = golden.daily.rows.map((row) => row[3]);
const near = (actual: number | null | undefined, expected: number, tolerance: number, label = "") => {
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} ± ${tolerance}, got ${actual}`);
};
const last = <T>(values: T[]): T => values[values.length - 1]!;

// ---- RSI ----

// The classic 14-period RSI worked example (Wilder / StockCharts): 33 closes give 19 values. TA-Lib 0.8.3 `RSI(close, 14)` on
// exactly these closes, bars 14..32, rounded to the cent.
const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25,
  45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];
const WILDER_RSI = [70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34, 54.67, 50.39, 40.02, 41.49, 41.9, 45.5, 37.32, 33.09, 37.79];

test("RSI 14 matches the Wilder worked example", () => {
  const rsi = calcRSI(WILDER_CLOSES, 14);
  assert.deepEqual(rsi.slice(0, 14), new Array(14).fill(null));
  WILDER_RSI.forEach((expected, i) => near(rsi[14 + i], expected, 0.005, `bar ${14 + i}`));
});

test("RSI is Wilder's smoothing, not a simple moving average", () => {
  // 15 closes alternating +1/-1 (seven ups, seven downs): average gain = average loss = 0.5, so RSI = 50.
  const data = Array.from({ length: 15 }, (_, i) => 10 + (i % 2));
  near(calcRSI(data, 14)[14], 50, 1e-12);
  // A +2 bar. Wilder: gain 8.5/14, loss 6.5/14, RSI = 100 * 8.5 / 15. A simple 14-bar average would read 100 * 8 / 15 = 53.33.
  data.push(12);
  near(calcRSI(data, 14)[15], (100 * 8.5) / 15, 1e-12);
  // Then a -1 bar: gain = 8.5 * 13 / 196, loss = (6.5 * 13 + 14) / 196, RSI = 100 * 110.5 / 209.
  data.push(11);
  near(calcRSI(data, 14)[16], (100 * 110.5) / 209, 1e-12);
});

test("RSI extremes: no losses 100, no gains 0, nothing moved 50 (as the backend), too few bars unknown", () => {
  assert.equal(last(calcRSI(Array.from({ length: 29 }, (_, i) => i + 1), 14)), 100);
  assert.equal(last(calcRSI(Array.from({ length: 29 }, (_, i) => 30 - i), 14)), 0);
  assert.equal(last(calcRSI(new Array(30).fill(5), 14)), 50);
  assert.ok(calcRSI(Array.from({ length: 14 }, (_, i) => i + 1), 14).every((value) => value === null)); // 13 deltas: one short
});

// ---- EMA and MACD ----

test("EMA is seeded with the first value and unknown until `period` bars", () => {
  // Two bars, period 2 (alpha 2/3): seeded with 10 -> 2/3 * 20 + 1/3 * 10 = 16.667. An SMA seed would read 15.
  const ema = calcEMA([10, 20], 2);
  assert.equal(ema[0], null);
  near(ema[1], 50 / 3, 1e-12);
});

test("EMA of a ramp follows its closed form EMA_t = t - ((1 - a) / a) * (1 - (1 - a)^t)", () => {
  for (const period of [9, 21]) {
    const alpha = 2 / (period + 1);
    const ema = calcEMA(Array.from({ length: 120 }, (_, t) => t), period);
    assert.deepEqual(ema.slice(0, period - 1), new Array(period - 1).fill(null));
    for (let t = period - 1; t < 120; t++) near(ema[t], t - ((1 - alpha) / alpha) * (1 - (1 - alpha) ** t), 1e-10, `EMA ${period} bar ${t}`);
  }
  // The lag settles at (period - 1) / 2 bars: 4 for an EMA 9, 10 for an EMA 21.
  near(last(calcEMA(Array.from({ length: 400 }, (_, t) => t), 9)), 399 - 4, 1e-9);
  near(last(calcEMA(Array.from({ length: 400 }, (_, t) => t), 21)), 399 - 10, 1e-9);
});

test("MACD of a ramp follows its closed form and settles at 7 with a zero histogram", () => {
  // line_t = 12.5 * (1 - (25/27)^t) - 5.5 * (1 - (11/13)^t) (the EMA 26 lag of 12.5 minus the EMA 12 lag of 5.5).
  const { dif, signal, histogram } = calcMACD(Array.from({ length: 400 }, (_, t) => t));
  assert.ok(dif.slice(0, 25).every((v) => v === null) && dif.slice(25).every((v) => v !== null)); // unknown until `slow` (26) bars
  assert.ok(signal.slice(0, 33).every((v) => v === null) && signal.slice(33).every((v) => v !== null)); // slow + signal - 1 = 34 bars
  assert.ok(histogram.slice(0, 33).every((v) => v === null));
  for (let t = 25; t < 400; t++) near(dif[t], 12.5 * (1 - (25 / 27) ** t) - 5.5 * (1 - (11 / 13) ** t), 1e-10, `line bar ${t}`);
  for (let t = 33; t < 400; t++) assert.equal(histogram[t], dif[t]! - signal[t]!);
  near(last(dif), 7, 1e-9);
  near(last(signal), 7, 1e-9);
  near(last(histogram), 0, 1e-9);
});

test("MACD signal is the EMA 9 of the MACD line, seeded with the first MACD value", () => {
  const data = Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 5));
  const { dif, signal } = calcMACD(data);
  const alpha = 2 / 10;
  let ema = dif[25]!;
  for (let i = 26; i < 80; i++) {
    ema = alpha * dif[i]! + (1 - alpha) * ema;
    if (i >= 33) near(signal[i], ema, 1e-12, `signal bar ${i}`);
  }
  assert.equal(signal[32], null);
});

// ---- Real daily TSLA bars: TA-Lib at the last bar, and the early bars from independent loops ----

test("real TSLA daily indicators match TA-Lib at the last bar", () => {
  assert.equal(closes.length, 300);
  const macd = calcMACD(closes);
  near(last(calcEMA(closes, 9)), golden.daily_last.ema_9!, 1e-6, "EMA 9");
  near(last(calcEMA(closes, 21)), golden.daily_last.ema_21!, 1e-6, "EMA 21");
  near(last(calcRSI(closes, 14)), golden.daily_last.rsi_14!, 1e-6, "RSI 14");
  near(last(macd.dif), golden.daily_last.macd_line!, 1e-6, "MACD line");
  near(last(macd.signal), golden.daily_last.macd_signal!, 1e-6, "MACD signal");
  near(last(macd.histogram), golden.daily_last.macd_histogram!, 1e-6, "MACD histogram");
});

test("real TSLA daily early bars match the independent loops (the first-value seed's transient)", () => {
  const macd = calcMACD(closes);
  const computed: Record<string, (number | null)[]> = {
    ema_9: calcEMA(closes, 9),
    ema_21: calcEMA(closes, 21),
    rsi_14: calcRSI(closes, 14),
    macd_line: macd.dif,
    macd_signal: macd.signal,
    macd_histogram: macd.histogram,
  };
  for (const [name, values] of Object.entries(computed)) {
    const pinned = golden.daily_warmup[name]!;
    assert.equal(pinned.length, 3, name);
    pinned.forEach(([index, expected]) => near(values[index], expected, 1e-9, `${name} bar ${index}`));
    assert.ok(values.slice(0, pinned[0]![0]).every((value) => value === null), `${name} is unknown before bar ${pinned[0]![0]}`);
  }
});

// ---- VWAP ----

const barAt = (t: string, h: number, l: number, c: number, v: number, ext = false) => ({ t, h, l, c, v, ext });

test("VWAP weights the typical price, not the close", () => {
  // typical = (108 + 96 + 99) / 3 = 101 (the close is 99); then (106 + 100 + 103) / 3 = 103 on three times the volume.
  const vwap = calcVWAP([barAt("2026-10-06T13:30:00Z", 108, 96, 99, 1000), barAt("2026-10-06T13:31:00Z", 106, 100, 103, 3000)]);
  near(vwap[0], 101, 1e-12);
  near(vwap[1], (101 * 1000 + 103 * 3000) / 4000, 1e-12);
});

test("VWAP restarts each New York trading day and skips pre- and after-hours bars", () => {
  const vwap = calcVWAP([
    barAt("2026-10-05T19:59:00Z", 300, 300, 300, 9_000_000), // yesterday's last regular minute
    barAt("2026-10-06T08:00:00Z", 500, 500, 500, 9_000_000, true), // today, pre-market
    barAt("2026-10-06T13:30:00Z", 200, 200, 200, 500),
    barAt("2026-10-06T13:31:00Z", 100, 100, 100, 1000),
    barAt("2026-10-06T20:00:00Z", 700, 700, 700, 9_000_000, true), // today, after-hours
  ]);
  assert.equal(vwap[0], 300);
  assert.equal(vwap[1], null); // no VWAP before the open
  assert.equal(vwap[2], 200); // neither yesterday's volume nor the pre-market volume is in it
  near(vwap[3], (200 * 500 + 100 * 1000) / 1500, 1e-12);
  assert.equal(vwap[4], null); // none after the close
});

test("VWAP is unknown until the first traded minute", () => {
  const vwap = calcVWAP([barAt("2026-10-06T13:30:00Z", 105, 99, 102, 0), barAt("2026-10-06T13:31:00Z", 108, 96, 99, 100)]);
  assert.equal(vwap[0], null);
  near(vwap[1], 101, 1e-12);
});

test("real TSLA minute VWAP matches the independent loop, restarting at the 09-25 open", () => {
  const bars = golden.minutes.rows.map(([t, h, l, c, v, phase]) => ({ t, h, l, c, v, ext: phase !== "regular" }));
  assert.equal(bars.length, 150);
  assert.equal(golden.vwap.length, 150);
  for (const compute of [calcVWAP, (input: typeof bars) => calcVWAPWithGaps(input)]) {
    const got = compute(bars);
    got.forEach((value, i) => {
      const expected = golden.vwap[i];
      if (expected === null || expected === undefined) assert.equal(value, null, `bar ${i}`);
      else near(value, expected, Math.abs(expected) * 1e-12, `bar ${i}`);
    });
  }
  const open = bars.findIndex((bar) => bar.t === "2026-09-25T13:30:00Z");
  near(calcVWAP(bars)[open], (bars[open]!.h + bars[open]!.l + bars[open]!.c) / 3, 1e-12); // its own typical price
  assert.ok(bars.slice(0, open).filter((bar) => !bar.ext).length === 20 && bars.filter((bar) => bar.ext).length === 40);
});
