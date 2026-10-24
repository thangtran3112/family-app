import assert from "node:assert/strict";
import test from "node:test";
import { BarsSchema } from "./api/schemas.ts";
import {
  TODAY_CHART_INTERVALS,
  chartBarsFromResponse,
  chartBarsPath,
  chartContextKey,
  chartResponseMatchesSelection,
  chartPresentation,
  chartOverlays,
  chartSnapshotFor,
  firstChartSelection,
  type TodayChartSelection,
} from "./today-chart.ts";

test("chart bar conversion preserves source OHLC, null gaps, real zero, and order", () => {
  const bars = BarsSchema.parse({
    symbol: "AAPL",
    interval: "5m",
    quality: "delayed-15m",
    as_of: "2026-10-16T14:01:00Z",
    stamp: { as_of: "2026-10-16T14:01:00Z", source: "alpaca", quality: "delayed-15m", freshness: "delayed" },
    bars: [
      { t: "2026-10-16T14:00:00Z", o: 10, h: 12, l: 9, c: 0, v: 4, ext: false },
      { t: "2026-10-16T14:01:00Z", o: null, h: null, l: null, c: null, v: null, ext: false },
    ],
  }).bars;

  assert.deepEqual(chartBarsFromResponse(bars), [
    { t: "2026-10-16T14:00:00Z", o: 10, h: 12, l: 9, c: 0 },
    { t: "2026-10-16T14:01:00Z", o: null, h: null, l: null, c: null },
  ]);
  assert.deepEqual(chartBarsFromResponse([]), []);
});

test("chart presentation passes source quality and as-of without altering OHLC", () => {
  const source = BarsSchema.parse({
    symbol: "AAPL",
    interval: "5m",
    quality: "delayed-15m",
    as_of: "2026-10-16T14:00:00Z",
    stamp: { as_of: "2026-10-16T14:00:00Z", source: "alpaca", quality: "delayed-15m", freshness: "delayed" },
    bars: [{ t: "2026-10-16T14:00:00Z", o: 10, h: 12, l: 9, c: 0, v: 4, ext: false }],
  });

  const data = chartPresentation(source);

  assert.equal(data.quality, "delayed-15m");
  assert.equal(data.asOf, "2026-10-16T14:00:00Z");
  assert.deepEqual(data.bars, [{ t: source.bars[0].t, o: 10, h: 12, l: 9, c: 0 }]);
});

test("future bar paths preserve ROOT prefix and only use supported API intervals", () => {
  const selection: TodayChartSelection = { symbol: "ES", asset_type: "future", interval: "5m" };

  assert.equal(chartBarsPath(selection), "/api/desk/bars/%2FES?interval=5m&days=90");
  assert.deepEqual(TODAY_CHART_INTERVALS, ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]);
  assert.equal((TODAY_CHART_INTERVALS as readonly string[]).includes("2m"), false);
});

test("selected chart context distinguishes stock CL, future CL, and timeframe", () => {
  const stock: TodayChartSelection = { symbol: "CL", asset_type: "stock", interval: "1d" };
  const future: TodayChartSelection = { symbol: "CL", asset_type: "future", interval: "1d" };
  const intraday: TodayChartSelection = { ...future, interval: "5m" };

  assert.notEqual(chartContextKey(stock), chartContextKey(future));
  assert.notEqual(chartContextKey(future), chartContextKey(intraday));
  assert.equal(chartSnapshotFor({ context: chartContextKey(stock), value: [1] }, future), null);
  assert.deepEqual(chartSnapshotFor({ context: chartContextKey(future), value: [2] }, future), [2]);
});

test("default chart selection comes only from active watchlist and skips unsupported assets", () => {
  assert.deepEqual(firstChartSelection([
    { symbol: "ODD", asset_type: "crypto" },
    { symbol: "CL", asset_type: "future" },
  ]), { symbol: "CL", asset_type: "future" });
  assert.equal(firstChartSelection([]), null);
  assert.equal(firstChartSelection([{ symbol: "ODD", asset_type: "crypto" }]), null);
});

test("chart response must match selected canonical symbol and interval", () => {
  const source = BarsSchema.parse({
    symbol: "/CL",
    interval: "5m",
    quality: "delayed-15m",
    as_of: "2026-10-16T14:00:00Z",
    stamp: { as_of: "2026-10-16T14:00:00Z", source: "alpaca", quality: "delayed-15m", freshness: "delayed" },
    bars: [],
  });
  const selection: TodayChartSelection = { symbol: "CL", asset_type: "future", interval: "5m" };

  assert.equal(chartResponseMatchesSelection(source, selection), true);
  assert.equal(chartResponseMatchesSelection({ ...source, symbol: "CL" }, selection), false);
  assert.equal(chartResponseMatchesSelection({ ...source, interval: "1d" }, selection), false);
});

test("SMA and EMA overlays align to actual bars and re-warm after null close gaps", () => {
  const closes = Array.from({ length: 41 }, (_, index) => index + 1);
  closes[20] = Number.NaN;
  const bars = closes.map((close, index) => ({
    t: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    o: Number.isFinite(close) ? close : null,
    h: Number.isFinite(close) ? close : null,
    l: Number.isFinite(close) ? close : null,
    c: Number.isFinite(close) ? close : null,
  }));
  const overlays = chartOverlays(bars);
  const sma = overlays.find(({ id }) => id === "sma20")?.values;
  const ema = overlays.find(({ id }) => id === "ema20")?.values;

  assert.ok(sma && ema);
  assert.equal(sma.length, bars.length);
  assert.equal(ema.length, bars.length);
  assert.equal(sma[19], 10.5);
  assert.equal(ema[19], 10.5);
  assert.equal(sma[20], null);
  assert.equal(ema[20], null);
  assert.equal(sma[39], null);
  assert.equal(ema[39], null);
  assert.equal(sma[40], 31.5);
  assert.equal(ema[40], 31.5);
});
