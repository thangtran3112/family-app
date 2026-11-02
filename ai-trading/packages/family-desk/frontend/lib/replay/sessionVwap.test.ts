import assert from "node:assert/strict";
import test from "node:test";
import { currentValue } from "../chart-data.ts";
import { calcVWAPWithGaps } from "../indicators-with-gaps.ts";
import { chartBars } from "./feedState.ts";
import type { ReplayBar } from "./schemas.ts";
import { sessionVwap, type MinuteBars } from "./sessionVwap.ts";

// TSLA on Fri 2026-09-25 (EDT: 13:30Z is 09:30 ET). One-minute bars from 09:00 ET to 09:35 ET: the first 30 are pre-market (`ext`), the rest regular.
const OPEN = Date.UTC(2026, 8, 25, 13, 30);
const minute = (index: number): ReplayBar => {
  const t = new Date(OPEN + index * 60_000);
  const c = 377 + Math.sin(index / 3) * 2;
  return { t: t.toISOString(), o: c - 0.2, h: c + 0.5, l: c - 0.7, c, v: 1000 + (index % 7) * 150, ext: index < 0 };
};
const minuteBars = (from: number, to: number): ReplayBar[] => Array.from({ length: to - from + 1 }, (_, i) => minute(from + i));
const ready = (bars: readonly ReplayBar[]): MinuteBars => ({ bars, status: "ready" });

/** The coarser bars the server would send: each one folds the minutes that start inside it. */
const fold = (bars: readonly ReplayBar[], minutes: number): ReplayBar[] => {
  const step = minutes * 60_000;
  const groups = new Map<number, ReplayBar[]>();
  for (const bar of bars) {
    const start = Math.floor(Date.parse(bar.t) / step) * step;
    groups.set(start, [...(groups.get(start) ?? []), bar]);
  }
  return [...groups.entries()].map(([start, group]) => ({
    t: new Date(start).toISOString(),
    o: group[0]!.o,
    h: Math.max(...group.map((bar) => bar.h)),
    l: Math.min(...group.map((bar) => bar.l)),
    c: group.at(-1)!.c,
    v: group.reduce((sum, bar) => sum + bar.v, 0),
    ext: group[0]!.ext,
  }));
};

// The playhead is 09:35: the minutes from 09:00 through 09:35 are in (the 09:35 one is the forming bar).
const all = minuteBars(-30, 5);
const expected = (() => {
  const regular = all.filter((bar) => !bar.ext);
  return regular.reduce((sum, bar) => sum + ((bar.h + bar.l + bar.c) / 3) * bar.v, 0) / regular.reduce((sum, bar) => sum + bar.v, 0);
})();

test("one session VWAP at 09:35 on 1m, 5m and 15m: the header, the rail and the chart read the same number (D-168)", () => {
  const onOneMinute = sessionVwap(all, "1m", ready([]));
  const onFiveMinutes = sessionVwap(fold(all, 5), "5m", ready(all));
  const onFifteenMinutes = sessionVwap(fold(all, 15), "15m", ready(all));
  for (const result of [onOneMinute, onFiveMinutes, onFifteenMinutes]) {
    assert.equal(result.status, "ready");
    assert.ok(Math.abs((currentValue(result.values!) ?? NaN) - expected) < 1e-9, `${currentValue(result.values!)} vs ${expected}`);
  }
  // The coarse series is not what a chart-interval VWAP would say: on 5m bars the typical price is of the whole bar.
  assert.notEqual(currentValue(calcVWAPWithGaps(fold(all, 5))), expected);
});

test("a 15m chart has a VWAP from the first regular minute, not from its second bar", () => {
  const onFifteen = fold(all, 15); // 09:00 and 09:15 pre-market, 09:30 holds 09:30 to 09:35
  assert.deepEqual(onFifteen.map((bar) => bar.ext), [true, true, false]);
  const { values } = sessionVwap(onFifteen, "15m", ready(all));
  assert.deepEqual(values!.map((value) => value === null), [true, true, false]);
});

test("the newest chart bar keeps the last value while the next minute is still on its way", () => {
  const behind = minuteBars(-30, 4); // the 5m chart already has its 09:35 bar; the minutes stop at 09:34
  const { values } = sessionVwap(fold(minuteBars(-30, 5), 5), "5m", ready(behind));
  const asOf0934 = sessionVwap(fold(behind, 5), "5m", ready(behind)).values!;
  assert.equal(values!.at(-1), asOf0934.at(-1), "09:35 shows the 09:34 value, not a dash");
  assert.notEqual(values!.at(-1), null);
});

test("no one-minute bars: no value, and the status says why instead of the chart's interval deciding", () => {
  assert.deepEqual(sessionVwap(fold(all, 15), "15m", { bars: [], status: "loading" }), { values: null, status: "loading" });
  assert.deepEqual(sessionVwap(fold(all, 15), "15m", { bars: [], status: "unavailable" }), { values: null, status: "unavailable" });
  // Ready with nothing regular yet (the pre-market only): unknown for every bar, which is the one case "Warming up" is for.
  const early = minuteBars(-30, -1);
  assert.deepEqual(sessionVwap(fold(early, 15), "15m", ready(early)).values, [null, null]);
});

test("a forming bar's session comes from its own start, so the 09:30 bar is regular and the 16:00 bar is not", () => {
  const closed = minuteBars(-30, 0).slice(0, -1); // the last closed bar is 09:29, pre-market
  const atOpen = chartBars({ bars: closed, forming: { t: new Date(OPEN).toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1 } });
  assert.equal(atOpen.at(-1)!.ext, false, "09:30 starts the regular session even though the bar before it is pre-market");
  const atClose = chartBars({ bars: [minute(0)], forming: { t: "2026-09-25T20:00:00.000Z", o: 1, h: 1, l: 1, c: 1, v: 1 } });
  assert.equal(atClose.at(-1)!.ext, true, "16:00 starts after-hours even though the bar before it is regular");
});
