import assert from "node:assert/strict";
import test from "node:test";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { AlertStrategiesSchema, BarsSchema, TechnicalsSchema } from "../api/schemas.ts";
import { crosshairPoint, chartTime } from "../chart-data.ts";
import {
  alertLevels,
  biasTone,
  buildChartSeries,
  buildLevels,
  changeText,
  defaultIndicators,
  headerSummary,
  keyLevelRows,
  noMarketData,
  legendModel,
  priceSummary,
  signalKindLabel,
  toggleIndicator,
} from "./workspace.ts";
import { chartDays, CHART_TIMEFRAMES, isIntraday, SUMMARY_TIMEFRAMES, timeframeFromQuery, timeframeLabel } from "./timeframes.ts";

const bars = BarsSchema.parse(loadDeskFixture("bars_nvda_15m"));
const technicals = TechnicalsSchema.parse(loadDeskFixture("technicals_nvda_15m"));
const strategies = AlertStrategiesSchema.parse(loadDeskFixture("alert_strategies"));

test("default indicators follow 02l §b5: VWAP, EMA 9, EMA 21, volume, RSI and MACD on; SMA 50/200 off", () => {
  assert.deepEqual([...defaultIndicators()].sort(), ["ema21", "ema9", "macd", "rsi", "volume", "vwap"]);
  const toggled = toggleIndicator(defaultIndicators(), "sma50");
  assert.equal(toggled.has("sma50"), true);
  assert.equal(toggleIndicator(toggled, "sma50").has("sma50"), false);
  assert.equal(defaultIndicators().has("sma50"), false, "toggling does not mutate the input");
});

test("series: VWAP amber solid, EMA 9 text solid, EMA 21 muted dashed; RSI/MACD panes 120 px with bands", () => {
  const series = buildChartSeries(bars.bars, defaultIndicators(), "15m");
  assert.deepEqual(series.overlays.map((o) => [o.id, o.color, o.style ?? "solid"]), [
    ["vwap", "#FFB020", "solid"],
    ["ema9", "#F2F2F4", "solid"],
    ["ema21", "#9B9BA1", "dashed"],
  ]);
  for (const overlay of series.overlays) assert.equal(overlay.values.length, bars.bars.length);
  assert.deepEqual(series.panes.map((p) => [p.id, p.height]), [["rsi", 120], ["macd", 120]]);
  assert.deepEqual(series.panes[0]!.references?.map((r) => r.value), [70, 30]);
  assert.equal(series.panes[1]!.series.length, 3);
  assert.equal(series.volume, true);
});

test("VWAP is not drawn on daily bars and a hidden pane is not built", () => {
  const daily = buildChartSeries(bars.bars, defaultIndicators(), "1d");
  assert.equal(daily.overlays.some((o) => o.id === "vwap"), false);
  const none = buildChartSeries(bars.bars, new Set(), "15m");
  assert.deepEqual([none.overlays.length, none.panes.length, none.volume], [0, 0, false]);
});

test("pivots, prior close and session high/low are dotted muted; alert levels amber dashed with a bell", () => {
  const levels = buildLevels(technicals, [{ price: 212, name: "Break 212", strategyId: 9 }]);
  const pivots = levels.filter((l) => ["S3", "S2", "S1", "P", "R1", "R2", "R3"].includes(l.label));
  assert.equal(pivots.length, 7);
  assert.ok(pivots.every((l) => l.style === "dotted" && l.color === "#9B9BA1"));
  assert.deepEqual(levels.filter((l) => /Prior close|Session/.test(l.label)).map((l) => l.price), [212.21, 213.85, 210.18]);
  assert.deepEqual(levels.at(-1), { label: "🔔 Break 212", price: 212, color: "#FFB020", style: "dashed" });
  assert.deepEqual(buildLevels(null, []), []);
});

test("key levels list highest first and skip unknown values", () => {
  const rows = keyLevelRows(technicals);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => r.price), [...rows.map((r) => r.price)].sort((a, b) => b - a));
  assert.equal(rows.find((r) => r.label === "Pivot")?.price, technicals.pivots.classic.P);
  assert.deepEqual(keyLevelRows(null), []);
});

test("alert levels come from price-versus-number conditions of live strategies only", () => {
  const base = strategies.find((s) => s.spec.when !== undefined)!;
  const withLevel = (id: number, status: "active" | "paused", price: number) => ({
    ...base,
    id,
    status,
    name: `S${id}`,
    spec: { ...base.spec, when: { op: "crosses_above", left: { series: "close" }, right: { value: price } } },
  });
  const levels = alertLevels([withLevel(1, "active", 215.5), withLevel(2, "paused", 300)]);
  assert.deepEqual(levels, [{ price: 215.5, name: "S1", strategyId: 1 }]);
  assert.deepEqual(alertLevels([{ ...base, spec: { nonsense: true } }]), []);
});

test("legend shows the last bar until the cursor moves, then the cursor values", () => {
  const { overlays } = buildChartSeries(bars.bars, defaultIndicators(), "15m");
  const idle = legendModel("NVDA", "15m", bars.bars, overlays, null);
  assert.match(idle.title, /^NVDA · 15m · O [\d,.]+ H [\d,.]+ L [\d,.]+ C [\d,.]+$/);
  assert.deepEqual(idle.items.map((i) => i.label), ["VWAP", "EMA 9", "EMA 21"]);
  const point = crosshairPoint(chartTime(bars.bars[3]!.t), { open: 1, high: 3, low: 0.5, close: 2 }, { value: 9 }, { vwap: { value: 1.25 } });
  const hover = legendModel("NVDA", "15m", bars.bars, overlays, point);
  assert.equal(hover.title, "NVDA · 15m · O 1.00 H 3.00 L 0.50 C 2.00");
  assert.equal(hover.items[0]!.value, "1.25");
  assert.equal(hover.items[1]!.value, "—");
});

test("price summary: live quote wins, change is against the prior close, unknown stays a dash", () => {
  assert.deepEqual(priceSummary(110, bars.bars, 100), { last: 110, change: 10, changePct: 10 });
  assert.equal(priceSummary(null, bars.bars, 100).last, bars.bars.at(-1)!.c);
  assert.deepEqual(priceSummary(110, bars.bars, null), { last: 110, change: null, changePct: null });
  assert.equal(changeText({ last: 110, change: 10, changePct: 10 }), "+10.00 (+10.00%)");
  assert.equal(changeText({ last: 90, change: -10, changePct: -10 }), "−10.00 (−10.00%)");
  assert.equal(changeText({ last: null, change: null, changePct: null }), "—");
});

test("the header change is always the day's change, whatever timeframe the chart shows (V-Technicals-01)", () => {
  const daily = BarsSchema.parse(loadDeskFixture("bars_nvda_1d")).bars; // ends Thu 10-22 212.21, Fri 10-23 210.96
  const weekly = [
    { t: "2026-10-12", o: 230, h: 231, l: 200, c: 226.32, v: null, ext: false },
    { t: "2026-10-19", o: 226, h: 227, l: 209, c: 210.96, v: null, ext: false },
  ];
  // A quote from the session after the last daily bar compares with that bar's close, not last week's.
  assert.deepEqual(headerSummary({ close: 211.11, as_of: "2026-10-26T20:00:00Z" }, daily, weekly), {
    last: 211.11,
    change: 211.11 - 210.96,
    changePct: ((211.11 - 210.96) / 210.96) * 100,
  });
  // A quote on the same ET day as the last daily bar (after hours) compares with the session before it.
  assert.equal(headerSummary({ close: 211.11, as_of: "2026-10-23T23:30:00Z" }, daily, weekly).change, 211.11 - 212.21);
  // No quote: the last daily close against the one before it; the chart's own bars never set the change.
  assert.deepEqual(headerSummary(null, daily, weekly), { last: 210.96, change: 210.96 - 212.21, changePct: ((210.96 - 212.21) / 212.21) * 100 });
  // No daily bars yet: the price still shows, the change stays a dash rather than a week's move.
  assert.deepEqual(headerSummary(null, [], weekly), { last: 210.96, change: null, changePct: null });
});

test("a symbol with no quote, no daily bars and no chart bars has no market data (V-Technicals-03)", () => {
  const daily = BarsSchema.parse(loadDeskFixture("bars_nvda_1d")).bars;
  assert.equal(noMarketData(null, [], []), true);
  assert.equal(noMarketData(null, daily, []), false, "a timeframe without bars is not an unknown symbol");
  assert.equal(noMarketData(null, [], bars.bars), false);
  assert.equal(noMarketData({ close: 1, as_of: "2026-10-26T20:00:00Z" }, [], []), false);
});

test("signal kinds and bias tones", () => {
  assert.equal(signalKindLabel("vwap_reclaim"), "VWAP reclaim");
  assert.equal(signalKindLabel("mystery"), "Signal");
  assert.deepEqual(["Strong Buy", "Sell", "Neutral", "warming up"].map(biasTone), ["up", "down", "flat", "flat"]);
});

test("timeframes: labels, API values, fallbacks, intraday and days", () => {
  assert.deepEqual(CHART_TIMEFRAMES.map((t) => t.label), ["1m", "5m", "15m", "1h", "4h", "1D", "1W"]);
  assert.deepEqual(SUMMARY_TIMEFRAMES.map((t) => t.label), ["5m", "15m", "30m", "1h", "4h", "1D", "1W"]);
  assert.equal(timeframeFromQuery("1D", CHART_TIMEFRAMES).api, "1d");
  assert.equal(timeframeFromQuery("1d", CHART_TIMEFRAMES).label, "1D");
  assert.equal(timeframeFromQuery("1m", SUMMARY_TIMEFRAMES).api, "15m", "1m is chart-only");
  assert.equal(timeframeFromQuery(null, CHART_TIMEFRAMES).api, "15m");
  assert.equal(timeframeLabel("1w"), "1W");
  assert.equal(isIntraday("1d"), false);
  assert.equal(isIntraday("5m"), true);
  assert.equal(chartDays("15m") > chartDays("1m"), true);
});

test("legend: a hidden overlay stays listed with its value replaced by 'hidden', and each item reports its dash (R-01)", () => {
  const { overlays } = buildChartSeries(bars.bars, defaultIndicators(), "15m");
  const legend = legendModel("NVDA", "15m", bars.bars, overlays, null, new Set(["ema21"]));
  assert.deepEqual(legend.items.map((item) => [item.id, item.hidden, item.style]), [["vwap", false, "solid"], ["ema9", false, "solid"], ["ema21", true, "dashed"]]);
  assert.equal(legend.items[2]!.value, "hidden");
  assert.notEqual(legend.items[0]!.value, "hidden");
  assert.equal(legendModel("NVDA", "15m", bars.bars, overlays, null).items.every((item) => !item.hidden), true, "none hidden by default");
});
