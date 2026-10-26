import assert from "node:assert/strict";
import test from "node:test";
import { applyAdvance, applyFeedSwing, chartBars, dailyBlock, dismissPause, isQuietTape, mergeBars, paceOf, TAPE_CAP, viewFromFeed, withHoldMarker } from "./feedState.ts";
import { delta, feed } from "./fixtures.ts";
import { ReplayDeltaSchema, ReplayFeedSchema } from "./schemas.ts";
import { amdHold, closedHold, nvdaHold, pausedCross, stripRows, swingDelta, swingDeltaQuiet, swingFeed } from "./swingFixtures.ts";

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
  const view = applyAdvance(base(), next({ bars: [{ t: "2026-04-07T14:00:00Z", o: 1, h: 2, l: 1, c: 2, v: 10, ext: false }] }));
  const again = applyAdvance(view, next({ revealed_through: "2026-04-07T14:07:13Z", bars: [{ t: "2026-04-07T14:00:00Z", o: 1, h: 3, l: 1, c: 3, v: 20, ext: false }, { t: "2026-04-07T14:05:00Z", o: 3, h: 3, l: 3, c: 3, v: 5, ext: false }] }));
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
  const bars = [{ t: "2026-04-07T14:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 1, ext: false }];
  assert.equal(mergeBars(bars, []), bars);
});

test("pace prefers the API's numbers, else counts the last 10 market seconds across advances", () => {
  const withApi = applyAdvance(base(), next({}));
  assert.deepEqual(paceOf(withApi), { windowS: 10, printsPerSecond: 12.4, sharesPerSecond: 3400, band: "busy", timesAverage: 1.8 });

  const noPace = (to: string, count: number, volume: number) => next({ revealed_through: to, prints: { feed: "sip", rows: [], count, volume, shown: 0, big_print_usd: 200000, pace: null } });
  let view = viewFromFeed(ReplayFeedSchema.parse({ ...feed, revealed_through: "2026-04-07T14:07:00Z", prints: { feed: "sip", rows: [], count: 0, volume: 0, shown: 0, big_print_usd: 200000, pace: null } }), "5m");
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

// ---- swing (02p): the day strip, the Daily block and the stop pause ---------------------------------------------

const swingBase = () => viewFromFeed(swingFeed, "15m");

test("a day session's view has no swing data", () => {
  const view = viewFromFeed(ReplayFeedSchema.parse(feed), "5m");
  assert.deepEqual([view.strip, view.daily, view.dailyForming, view.paused], [null, null, null, null]);
  const advanced = applyAdvance(view, ReplayDeltaSchema.parse(delta));
  assert.deepEqual([advanced.strip, advanced.dailyForming, advanced.paused], [null, null, null]);
  assert.equal(dailyBlock(advanced), null);
});

test("a feed answer brings the strip and the Daily block", () => {
  const view = swingBase();
  assert.equal(view.strip?.length, 4);
  assert.equal(view.daily?.bars.length, 3);
  assert.equal(view.dailyForming?.c, 191.4);
  assert.equal(view.paused, null);
});

test("an advance that found a crossed stop keeps the pause for the toast, and the next advance clears it", () => {
  const paused = applyAdvance(swingBase(), swingDelta);
  assert.deepEqual(paused.paused, pausedCross);
  assert.equal(paused.revealedThrough, "2026-07-14T15:42:00Z");
  const next = applyAdvance(paused, swingDeltaQuiet);
  assert.equal(next.paused, null);
  assert.equal(next.revealedThrough, "2026-07-14T15:43:00Z");
});

test("the strip and the forming candle are the latest answer; an answer without them leaves what the view had", () => {
  const moved = applyAdvance(swingBase(), { ...swingDelta, paused: null, strip: [stripRows[2]!], daily_forming: { t: "2026-07-14", o: 190.3, h: 192, l: 189.8, c: 192, v: 7_000_000 } });
  assert.deepEqual(moved.strip?.map((row) => row.symbol), ["COIN"]);
  assert.equal(moved.dailyForming?.c, 192);
  const kept = applyAdvance(moved, ReplayDeltaSchema.parse({ ...delta, revealed_through: "2026-07-14T15:50:00Z" }));
  assert.deepEqual(kept.strip?.map((row) => row.symbol), ["COIN"]);
  assert.equal(kept.dailyForming?.c, 192);
});

test("a late answer changes nothing, the pause included", () => {
  const paused = applyAdvance(swingBase(), swingDelta);
  assert.equal(applyAdvance(paused, { ...swingDeltaQuiet, revealed_through: "2026-07-14T15:30:00Z" }), paused);
});

test("dismissing the pause clears only the pause", () => {
  const paused = applyAdvance(swingBase(), swingDelta);
  const cleared = dismissPause(paused);
  assert.equal(cleared.paused, null);
  assert.equal(cleared.strip, paused.strip);
  assert.equal(cleared.revealedThrough, paused.revealedThrough);
  assert.equal(dismissPause(cleared), cleared, "nothing to clear, same view");
});

test("the Daily chart's data carries the newest forming candle over the feed's", () => {
  const moved = applyAdvance(swingBase(), { ...swingDelta, daily_forming: { t: "2026-07-14", o: 190.3, h: 193, l: 189.8, c: 193, v: 8_000_000 } });
  const block = dailyBlock(moved)!;
  assert.equal(block.forming?.c, 193);
  assert.equal(block.bars.length, 3);
  assert.equal(block.holds.length, 1);
  assert.equal(moved.daily?.forming?.c, 191.4, "the stored block is not rewritten");
});

test("a fresh feed answer replaces the strip and the Daily block but not the playhead, and an older one is ignored", () => {
  const view = applyAdvance(swingBase(), swingDelta);
  const refreshed = applyFeedSwing(view, ReplayFeedSchema.parse({ ...swingFeed, revealed_through: "2026-07-14T15:43:00Z", strip: [stripRows[2]], daily: { ...swingFeed.daily, holds: [] } }));
  assert.deepEqual(refreshed.strip?.map((row) => row.symbol), ["COIN"]);
  assert.deepEqual(refreshed.daily?.holds, []);
  assert.equal(refreshed.revealedThrough, view.revealedThrough, "only an advance moves the playhead");
  assert.deepEqual(refreshed.paused, view.paused);
  assert.equal(applyFeedSwing(view, swingFeed), view, "an older answer changes nothing");
});

test("a mark moves this name's hold marker on the Daily chart", () => {
  const view = swingBase();
  const entered = withHoldMarker(view, { ...amdHold, stop_price: 168 }, "2026-07-14");
  assert.deepEqual(entered.daily?.holds, [{ entry_t: "2026-07-10", side: "short", entry_price: 162, stop_price: 168 }], "a carried hold keeps its entry date");
  const first = withHoldMarker({ ...view, daily: { ...view.daily!, holds: [] } }, amdHold, "2026-07-14");
  assert.equal(first.daily?.holds[0]?.entry_t, "2026-07-14", "a hold entered today starts today");
  const moved = withHoldMarker(view, { ...nvdaHold, stop_price: 181 }, "2026-07-14");
  assert.equal(moved.daily?.holds[0]?.stop_price, 181);
  assert.deepEqual(withHoldMarker(view, closedHold, "2026-07-14").daily?.holds, []);
  assert.deepEqual(withHoldMarker(view, null, "2026-07-14").daily?.holds, []);
  const day = viewFromFeed(ReplayFeedSchema.parse(feed), "5m");
  assert.equal(withHoldMarker(day, nvdaHold, "2026-07-14"), day, "a day session has no Daily block");
});

test("the view carries the day clock and whether this name is behind it, from a feed and from an advance", () => {
  const behind = viewFromFeed(ReplayFeedSchema.parse({ ...feed, day_clock: "2026-04-07T14:30:00Z", behind_clock: true }), "5m");
  assert.deepEqual([behind.dayClock, behind.behindClock], ["2026-04-07T14:30:00Z", true]);
  const caught = applyAdvance(behind, ReplayDeltaSchema.parse({ ...delta, revealed_through: "2026-04-07T14:30:00Z", day_clock: "2026-04-07T14:30:00Z", behind_clock: false }));
  assert.deepEqual([caught.dayClock, caught.behindClock], ["2026-04-07T14:30:00Z", false]);
  assert.equal(viewFromFeed(ReplayFeedSchema.parse(feed), "5m").dayClock, null);
});
