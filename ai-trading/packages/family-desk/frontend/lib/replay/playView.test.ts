import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import type { CrosshairPoint } from "../chart-data.ts";
import {
  CHART_MODES,
  SWING_PLAY_COPY,
  chartModeLabel,
  dailyChartModel,
  dailyLegend,
  exitKindFor,
  initialChartMode,
  intradayOf,
  isSwingSession,
  pauseExit,
  stripHoldCount,
  swingDayChip,
  swingMoneyLine,
  swingPlanItems,
  tapeNote,
  weekFigures,
  weekRange,
} from "./playView.ts";
import { amdHold, closedHold, dailyBlock, nvdaHold, pausedCross, stripRows, swingBrief, weekRows } from "./swingFixtures.ts";
import { swingBriefLine } from "./swing.ts";

const point = (time: CrosshairPoint["time"], close: number): CrosshairPoint => ({ time, open: close - 1, high: close + 1, low: close - 2, close, volume: 10, values: {} });

test("the chart toggle reads Daily, 15m, 5m and opens on the session's own interval", () => {
  assert.deepEqual(CHART_MODES.map(chartModeLabel), ["Daily", "15m", "5m"]);
  assert.equal(initialChartMode("15m"), "15m");
  assert.equal(initialChartMode("5m"), "5m");
  assert.equal(initialChartMode("1m"), "5m");
  assert.equal(intradayOf("15m"), "15m");
});

test("a swing session is one whose thread is a swing thread", () => {
  assert.equal(isSwingSession({ thread: swingBrief }), true);
  assert.equal(isSwingSession({ thread: { ...swingBrief, mode: "day" } }), false);
  assert.equal(isSwingSession({ thread: null }), false);
});

test("the Daily chart is the rebased bars plus the forming candle, with her hold's marker and lines", () => {
  const model = dailyChartModel(dailyBlock, false);
  assert.deepEqual(model.bars.map((bar) => bar.t), ["2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14"]);
  assert.equal(model.bars.at(-1)!.c, 191.4);
  assert.equal(model.offsets, null);
  assert.deepEqual(model.markers, [{ time: "2026-07-10T12:00:00Z", kind: "practice_long", label: "Practice long 184.20" }]);
  assert.deepEqual(model.levels.map((level) => [level.label, level.price, level.style]), [
    ["Practice entry", 184.2, "dotted"],
    ["Practice stop", 178.5, "dashed"],
  ]);
  assert.equal(model.note, "Daily bars through the prior close · today's candle is still forming");
});

test("without a forming candle the chart ends at the prior close, and a hold without a stop draws no stop line", () => {
  const model = dailyChartModel({ ...dailyBlock, forming: null, holds: [{ ...dailyBlock.holds[0]!, stop_price: null, side: "short" }] }, false);
  assert.equal(model.bars.length, 3);
  assert.equal(model.note, "Daily bars through the prior close");
  assert.deepEqual(model.levels.map((level) => level.label), ["Practice entry"]);
  assert.equal(model.markers[0]!.kind, "practice_short");
  assert.deepEqual(dailyChartModel({ bars: dailyBlock.bars, forming: null, holds: [] }, false).markers, []);
});

test("with dates hidden no real date reaches the chart and the marker follows the bar by index", () => {
  const model = dailyChartModel(dailyBlock, true);
  const real = new Set([...dailyBlock.bars.map((bar) => bar.t), dailyBlock.forming!.t]);
  for (const bar of model.bars) assert.equal(real.has(bar.t), false, bar.t);
  for (const marker of model.markers) assert.equal(real.has(marker.time.slice(0, 10)), false, marker.time);
  // the hold entered on the second real bar: its marker sits on the second stand-in bar
  assert.equal(model.markers[0]!.time.slice(0, 10), model.bars[1]!.t);
  assert.deepEqual(model.offsets, ["D-3", "D-2", "D-1", "Today"]);
  assert.equal(model.bars.length, dailyBlock.bars.length + 1);
});

test("a hold entered today puts its marker on the forming candle, and an entry older than the chart has no marker", () => {
  const today = dailyChartModel({ ...dailyBlock, holds: [{ ...dailyBlock.holds[0]!, entry_t: "2026-07-14" }] }, true);
  assert.equal(today.markers[0]!.time.slice(0, 10), today.bars.at(-1)!.t);
  const old = dailyChartModel({ ...dailyBlock, holds: [{ ...dailyBlock.holds[0]!, entry_t: "2025-01-02" }] }, true);
  assert.deepEqual(old.markers, []);
  assert.equal(old.levels.length, 2);
});

test("the hidden offsets before any price end at D-1", () => {
  assert.deepEqual(dailyChartModel({ ...dailyBlock, forming: null }, true).offsets, ["D-3", "D-2", "D-1"]);
});

test("the Daily legend names the bar under the crosshair by offset while dates are hidden", () => {
  const model = dailyChartModel(dailyBlock, true);
  assert.equal(dailyLegend("NVDA", model, null).title, "NVDA · Daily · Today · O 190.30 H 191.90 L 189.80 C 191.40");
  const second = model.bars[1]!.t.split("-").map(Number);
  const hover = point({ year: second[0]!, month: second[1]!, day: second[2]! }, 188.2);
  assert.equal(dailyLegend("NVDA", model, hover).title, "NVDA · Daily · D-2 · O 187.20 H 189.20 L 186.20 C 188.20");
  const shown = dailyLegend("NVDA", dailyChartModel(dailyBlock, false), null);
  assert.equal(shown.title, "NVDA · Daily · O 190.30 H 191.90 L 189.80 C 191.40");
  assert.deepEqual(shown.items, []);
});

test("the stop pause's Exit targets the paused name, on the chart or through another name's strip row", () => {
  assert.equal(exitKindFor("long"), "long_exit");
  assert.equal(exitKindFor("short"), "short_exit");
  // AMD (a short in the strip) paused while NVDA is on the chart
  assert.deepEqual(pauseExit(pausedCross, { sessionSymbol: "NVDA", openSide: "long", strip: stripRows }), { symbol: "AMD", kind: "short_exit", here: false });
  // the paused name is the chart's own: its open hold decides
  assert.deepEqual(pauseExit({ symbol: "NVDA" }, { sessionSymbol: "NVDA", openSide: "long", strip: null }), { symbol: "NVDA", kind: "long_exit", here: true });
  assert.deepEqual(pauseExit({ symbol: "NVDA" }, { sessionSymbol: "NVDA", openSide: "flat", strip: stripRows }), { symbol: "NVDA", kind: "long_exit", here: true });
  // a side that is not known leaves Exit off
  assert.equal(pauseExit({ symbol: "COIN" }, { sessionSymbol: "NVDA", openSide: "long", strip: stripRows }), null);
  assert.equal(pauseExit({ symbol: "AMD" }, { sessionSymbol: "NVDA", openSide: "long", strip: null }), null);
  // A day has no strip: another name's side comes from the portfolio.
  const held = [{ symbol: "ANET", side: "short" as const }, { symbol: "SMCI", side: null }];
  assert.deepEqual(pauseExit({ symbol: "ANET" }, { sessionSymbol: "NVDA", openSide: "long", strip: null, held }), { symbol: "ANET", kind: "short_exit", here: false });
  assert.equal(pauseExit({ symbol: "SMCI" }, { sessionSymbol: "NVDA", openSide: "long", strip: null, held }), null);
});

test("open holds are counted from the strip", () => {
  assert.equal(stripHoldCount(stripRows), 2);
  assert.equal(stripHoldCount(null), 0);
});

test("the week's entries and realized result come from the holds that fall inside its days", () => {
  const range = weekRange(weekRows, 2);
  assert.deepEqual(range, { first: 6, last: 10 });
  assert.equal(weekRange(weekRows, 9), null);
  assert.equal(weekRange(weekRows, null), null);
  // NVDA (Day 5) is last week's entry, AMD (Day 6) this week's; TSLA closed on Day 4 and Day 7 exits count today
  const holds = [nvdaHold, amdHold, closedHold, { ...closedHold, id: 20, entry_day_no: 6, exit_day_no: 7, pnl_usd: -150 }, { ...amdHold, id: 21, entry_day_no: 7 }];
  assert.deepEqual(weekFigures(holds, range!), { entries: 3, realizedUsd: -150 });
  assert.deepEqual(weekFigures(holds, { first: 1, last: 5 }), { entries: 2, realizedUsd: 612 });
  assert.deepEqual(weekFigures([], range!), { entries: 0, realizedUsd: 0 });
});

test("the swing plan rows show open holds against the limit, then the week when it is known", () => {
  assert.deepEqual(swingPlanItems({ holdsOpen: 2, maxOpenHolds: 3, maxTrades: null, maxLossUsd: null, week: null }), [
    { id: "open_holds", label: "Open holds", state: "ok", detail: "2 of 3" },
  ]);
  assert.equal(swingPlanItems({ holdsOpen: 4, maxOpenHolds: 3, maxTrades: null, maxLossUsd: null, week: null })[0]!.state, "warn");
  assert.equal(swingPlanItems({ holdsOpen: 2, maxOpenHolds: null, maxTrades: null, maxLossUsd: null, week: null })[0]!.detail, "2");
  const full = swingPlanItems({ holdsOpen: 2, maxOpenHolds: 3, maxTrades: 6, maxLossUsd: 500, week: { entries: 3, realizedUsd: -120 } });
  assert.deepEqual(full.slice(1), [
    { id: "entries_week", label: "Entries this week · max 6", state: "ok", detail: "3 of 6" },
    { id: "week_loss", label: "Week loss limit $500.00", state: "ok", detail: "−$120.00 this week" },
  ]);
  const over = swingPlanItems({ holdsOpen: 1, maxOpenHolds: 3, maxTrades: 2, maxLossUsd: 500, week: { entries: 3, realizedUsd: -500 } });
  assert.deepEqual(over.slice(1).map((item) => item.state), ["warn", "warn"]);
  const none = swingPlanItems({ holdsOpen: 1, maxOpenHolds: 3, maxTrades: null, maxLossUsd: null, week: { entries: 0, realizedUsd: 0 } });
  assert.deepEqual(none.map((item) => [item.id, item.state]), [["open_holds", "ok"], ["entries_week", "pending"]]);
});

test("the header says the day, the money and the tape", () => {
  assert.equal(swingDayChip(swingBrief, "2026-07-14", true), "Day 7 of 20 · Week 2 · Tue");
  assert.match(swingDayChip(swingBrief, "2026-07-14", false)!, /^Day 7 of 20 · Week 2 · .*2026/);
  assert.equal(swingDayChip({ ...swingBrief, day_no: null }, "2026-07-14", true), null);
  assert.equal(swingDayChip(swingBrief, "2026-07-18", true), null);
  assert.equal(swingMoneyLine(swingBrief), "Balance $51,240.00 · Equity $52,010.00 · Free cash $24,720.00");
  assert.equal(swingBriefLine(swingBrief), `${swingMoneyLine(swingBrief)} · SIMULATED`);
  assert.equal(tapeNote("off"), "Tape off · swing prices are one-minute closes");
  assert.equal(tapeNote("sip"), null);
  assert.equal(tapeNote("iex"), null);
});

test("no workspace string says a banned word", () => {
  const strings: string[] = [
    ...Object.values(SWING_PLAY_COPY),
    dailyChartModel(dailyBlock, true).note,
    dailyLegend("NVDA", dailyChartModel(dailyBlock, true), null).title,
    ...swingPlanItems({ holdsOpen: 2, maxOpenHolds: 3, maxTrades: 6, maxLossUsd: 500, week: { entries: 3, realizedUsd: -120 } }).flatMap((item) => [item.label, item.detail]),
    ...dailyChartModel(dailyBlock, true).offsets!,
    ...dailyChartModel(dailyBlock, true).levels.map((level) => level.label),
    ...dailyChartModel(dailyBlock, true).markers.map((marker) => marker.label),
  ];
  for (const text of strings) assert.equal(containsPracticeBannedTerm(text), false, text);
});
