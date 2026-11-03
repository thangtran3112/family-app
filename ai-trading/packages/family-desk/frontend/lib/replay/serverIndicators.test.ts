import assert from "node:assert/strict";
import test from "node:test";
import { serverSeries } from "./serverIndicators.ts";

const row = (minute: number, vwap: number | null, ema9 = 10 + minute) => ({ t: `2026-04-07T14:0${minute}:00Z`, vwap, ema9, ema21: 20 + minute, rsi14: 50 + minute, macd: minute / 10, macd_signal: minute / 20, macd_hist: minute / 40 });
const bars = [0, 1, 2].map((minute) => ({ t: `2026-04-07T14:0${minute}:00Z` }));
const table = (rows: ReturnType<typeof row>[], interval = "1m") => ({ interval: interval as "1m", asOfBar: null, rows });

test("the server's rows are laid on the bars by bar open, a bar with no row reads unknown", () => {
  const series = serverSeries(bars, table([row(0, 1), row(2, 3)]), "1m");
  assert.deepEqual(series.vwap, [1, null, 3]);
  assert.deepEqual(series.ema9, [10, null, 12]);
  assert.deepEqual(series.ema21, [20, null, 22]);
  assert.deepEqual(series.rsi14, [50, null, 52]);
  assert.deepEqual(series.macd, { dif: [0, null, 0.2], signal: [0, null, 0.1], histogram: [0, null, 0.05] });
});

test("a table for another interval, or none, reads unknown everywhere", () => {
  assert.deepEqual(serverSeries(bars, table([row(0, 1)], "5m"), "1m").ema9, [null, null, null]);
  assert.deepEqual(serverSeries(bars, null, "1m").vwap, [null, null, null]);
  assert.deepEqual(serverSeries([], null, "1m").macd, { dif: [], signal: [], histogram: [] });
});

test("the forming candle without a VWAP of its own reads the one before it (D-168), only when it has a row", () => {
  const forming = bars[2]!.t;
  assert.deepEqual(serverSeries(bars, table([row(0, 1), row(1, 2), row(2, null)]), "1m", forming).vwap, [1, 2, 2]);
  assert.deepEqual(serverSeries(bars, table([row(0, 1), row(1, 2)]), "1m", forming).vwap, [1, 2, null], "no row for it: not filled");
  assert.deepEqual(serverSeries(bars, table([row(0, 1), row(1, 2), row(2, null)]), "1m", null).vwap, [1, 2, null], "not the forming candle: not filled");
});
