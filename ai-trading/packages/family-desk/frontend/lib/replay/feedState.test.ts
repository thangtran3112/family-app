import assert from "node:assert/strict";
import test from "node:test";
import { applyAdvance, chartBars, isQuietTape, mergeBars, paceOf, TAPE_CAP, viewFromFeed } from "./feedState.ts";
import { delta, feed } from "./fixtures.ts";
import { ReplayDeltaSchema, ReplayFeedSchema } from "./schemas.ts";

const base = () => viewFromFeed(ReplayFeedSchema.parse({ ...feed, bars: [], prints: { ...feed.prints, rows: [] }, signals: [] }), "5m");
const next = (overrides: Record<string, unknown>) => ReplayDeltaSchema.parse({ ...delta, ...overrides });

test("a feed answer becomes the view without any cutting", () => {
  const view = viewFromFeed(ReplayFeedSchema.parse(feed), "5m");
  assert.equal(view.bars.length, 1);
  assert.equal(view.windowStart, "2026-04-07T13:30:00Z");
  assert.equal(view.signals.length, 1);
  assert.equal(view.tapeMeta?.bigPrintUsd, 200000);
});

test("advance merges bars by start time and the playhead only moves forward", () => {
  const view = applyAdvance(base(), next({ bars: [{ t: "2026-04-07T14:00:00Z", o: 1, h: 2, l: 1, c: 2, v: 10 }] }));
  const again = applyAdvance(view, next({ revealed_through: "2026-04-07T14:07:13Z", bars: [{ t: "2026-04-07T14:00:00Z", o: 1, h: 3, l: 1, c: 3, v: 20 }, { t: "2026-04-07T14:05:00Z", o: 3, h: 3, l: 3, c: 3, v: 5 }] }));
  assert.deepEqual(again.bars.map((bar) => [bar.t, bar.h]), [["2026-04-07T14:00:00Z", 3], ["2026-04-07T14:05:00Z", 3]]);
  const late = applyAdvance(again, next({ revealed_through: "2026-04-07T14:07:05Z" }));
  assert.equal(late, again);
  assert.equal(late.revealedThrough, "2026-04-07T14:07:13Z");
});

test("signals dedupe and stay in bar-close order; levels, last and the open trade follow the newest answer", () => {
  const first = applyAdvance(base(), next({}));
  const second = applyAdvance(first, next({
    revealed_through: "2026-04-07T14:08:00Z",
    signals: [delta.signals[0], { ...delta.signals[0], id: 8, name: "VWAP reclaim", bar_close: "2026-04-07T13:40:00Z" }],
    open_trade: null,
    last: null,
    levels: { session_high: 190 },
  }));
  assert.deepEqual(second.signals.map((signal) => signal.name), ["VWAP reclaim", "ORB 15m"]);
  assert.equal(second.openTrade, null);
  assert.equal(second.last?.price, 188.05, "a missing last print keeps the previous one");
  assert.equal(second.levels.session_high, 190);
});

test("the tape keeps the newest rows up to the cap", () => {
  const rows = Array.from({ length: TAPE_CAP + 50 }, (_, index) => [`2026-04-07T14:07:${String(index % 60).padStart(2, "0")}.000Z`, 100 + index, 100, 1]);
  const view = applyAdvance(base(), next({ prints: { ...delta.prints, rows, shown: rows.length } }));
  assert.equal(view.tape.length, TAPE_CAP);
  assert.equal(view.tape.at(-1)?.price, 100 + TAPE_CAP + 49);
});

test("the chart gets closed bars plus the forming bar, replacing a closed bar with the same start", () => {
  const view = applyAdvance(base(), next({}));
  assert.equal(chartBars(view).length, 2);
  assert.equal(chartBars(view).at(-1)?.t, "2026-04-07T14:05:00Z");
  const same = { ...view, forming: { ...view.forming!, t: view.bars[0]!.t, c: 999 } };
  assert.equal(chartBars(same).length, 1);
  assert.equal(chartBars(same)[0]?.c, 999);
});

test("mergeBars returns the same array when nothing arrived", () => {
  const bars = [{ t: "2026-04-07T14:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 1 }];
  assert.equal(mergeBars(bars, []), bars);
});

test("pace prefers the API's numbers, else counts the last 10 market seconds across advances", () => {
  const withApi = applyAdvance(base(), next({}));
  assert.deepEqual(paceOf(withApi), { printsPerSecond: 12.4, sharesPerSecond: 3400, band: "busy", timesAverage: 1.8 });

  const noPace = (to: string, count: number, volume: number) => next({ revealed_through: to, prints: { feed: "sip", rows: [], count, volume, shown: 0 } });
  let view = viewFromFeed(ReplayFeedSchema.parse({ ...feed, revealed_through: "2026-04-07T14:07:00Z", prints: { feed: "sip", rows: [], count: 0, volume: 0, shown: 0 } }), "5m");
  view = applyAdvance(view, noPace("2026-04-07T14:07:05Z", 50, 5000));
  view = applyAdvance(view, noPace("2026-04-07T14:07:10Z", 100, 20000));
  const pace = paceOf(view);
  assert.equal(pace?.printsPerSecond, 15);
  assert.equal(pace?.sharesPerSecond, 2500);
  view = applyAdvance(view, noPace("2026-04-07T14:07:20Z", 10, 1000));
  assert.equal(paceOf(view)?.printsPerSecond, 1, "only the last 10 seconds count");
  assert.equal(paceOf({ tapeMeta: null, paceSamples: [], revealedThrough: "2026-04-07T14:07:20Z" }), null);
});

test("a quiet tape is 30 market seconds without a print", () => {
  const view = applyAdvance(base(), next({ prints: { ...delta.prints, rows: [["2026-04-07T14:07:11.482Z", 188.05, 200, 1]], shown: 1 } }));
  assert.equal(isQuietTape(view), false);
  assert.equal(isQuietTape({ ...view, revealedThrough: "2026-04-07T14:07:42Z" }), true);
  assert.equal(isQuietTape({ tape: [], revealedThrough: "2026-04-07T13:30:10Z", windowStart: "2026-04-07T13:30:00Z" }), false);
  assert.equal(isQuietTape({ tape: [], revealedThrough: "2026-04-07T13:31:00Z", windowStart: "2026-04-07T13:30:00Z" }), true);
});
