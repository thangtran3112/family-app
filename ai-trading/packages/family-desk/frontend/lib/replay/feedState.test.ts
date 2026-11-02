import assert from "node:assert/strict";
import test from "node:test";
import { applyAdvance, applyFeedSwing, chartBars, dailyBlock, dismissPause, isQuietTape, mergeBars, paceOf, syncTarget, TAPE_CAP, viewClock, viewFromFeed, withHoldMarker } from "./feedState.ts";
import { delta, feed, overnightDelta, overnightFeed } from "./fixtures.ts";
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

test("a follow poll sends the playhead the window holds, and a catch-up answer fills every bar the other window took (D-198)", () => {
  const bar = (minute: number) => ({ t: `2026-04-07T14:${String(minute).padStart(2, "0")}:00Z`, o: 1, h: 2, l: 1, c: 2, v: 10, ext: false });
  const window = applyAdvance(base(), next({ revealed_through: "2026-04-07T14:11:00Z", bars: [bar(10)] }));
  assert.deepEqual(syncTarget(window), { sync: true, since: "2026-04-07T14:11:00Z" });
  assert.deepEqual(syncTarget(null), { sync: true }, "a screen with no view yet has nothing to send");
  // The other window took the 14:11 to 14:13 bars: this window's answer starts at its own `since` and carries all three, and the one it already had.
  const caughtUp = applyAdvance(window, next({ revealed_through: "2026-04-07T14:14:00Z", bars: [bar(10), bar(11), bar(12), bar(13)] }));
  assert.deepEqual(caughtUp.bars.map((item) => item.t.slice(11, 16)), ["14:10", "14:11", "14:12", "14:13"]);
  assert.equal(caughtUp.revealedThrough, "2026-04-07T14:14:00Z");
  // The next poll starts from the new playhead, and an answer with nothing new changes no bar.
  assert.deepEqual(syncTarget(caughtUp), { sync: true, since: "2026-04-07T14:14:00Z" });
  const quiet = applyAdvance(caughtUp, next({ revealed_through: "2026-04-07T14:14:00Z", bars: [] }));
  assert.equal(quiet.bars, caughtUp.bars);
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

test("the view carries the payload's own thread time, data end and market, from a feed and from an advance (ADR-0022)", () => {
  const plain = viewFromFeed(ReplayFeedSchema.parse(feed), "5m");
  assert.deepEqual([plain.threadTime, plain.dataThrough, plain.market], [null, "2026-04-07T14:07:12Z", null], "a standalone session has no thread time; its data runs to its playhead");
  const overnight = viewFromFeed(ReplayFeedSchema.parse(overnightFeed), "5m");
  assert.deepEqual([overnight.threadTime, overnight.dataThrough, overnight.market?.phase], ["2026-04-08T05:22:24Z", "2026-04-08T00:00:00Z", "closed"]);
  const later = applyAdvance(overnight, ReplayDeltaSchema.parse({ ...overnightDelta, thread_time: "2026-04-08T05:22:26Z" }));
  assert.equal(later.threadTime, "2026-04-08T05:22:26Z", "T moves with the answer while data_through stays at the tape end");
  assert.equal(later.dataThrough, "2026-04-08T00:00:00Z");
});

test("one time source: the thread time of the payload, else the playhead or the day clock a name was left behind", () => {
  const overnight = viewFromFeed(ReplayFeedSchema.parse(overnightFeed), "5m");
  assert.equal(viewClock(overnight), "2026-04-08T05:22:24Z", "past the tape T still ticks; the name's capped playhead never stands in for it");
  const behind = { threadTime: null, revealedThrough: "2026-04-07T14:00:00Z", dayClock: "2026-04-07T14:30:00Z" };
  assert.equal(viewClock(behind), "2026-04-07T14:30:00Z", "a swing name left behind shows the thread's time");
  assert.equal(viewClock({ ...behind, dayClock: "2026-04-07T13:00:00Z" }), "2026-04-07T14:00:00Z", "the playhead is never pulled back by a stale clock");
  assert.equal(viewClock({ ...behind, dayClock: null }), "2026-04-07T14:00:00Z", "a standalone session has only its own playhead");
});

test("indicator rows merge by bar open: a later answer replaces the forming bar's row and new bars append (one payload, one cut)", () => {
  const first = viewFromFeed(ReplayFeedSchema.parse(overnightFeed), "5m");
  assert.deepEqual(first.indicators?.rows.map((row) => row.t), ["2026-04-07T23:50:00Z", "2026-04-07T23:55:00Z"]);
  const second = applyAdvance(
    first,
    ReplayDeltaSchema.parse({
      ...overnightDelta,
      indicators: { interval: "5m", as_of_bar: "2026-04-08T00:00:00Z", rows: [{ t: "2026-04-07T23:55:00Z", ema9: 188.1, ema21: 187.7, vwap: 187.72, rsi14: 60, macd: 0.5, macd_signal: 0.35, macd_hist: 0.15 }, { t: "2026-04-08T00:00:00Z", ema9: 188.2, ema21: 187.8, vwap: 187.73, rsi14: 61, macd: 0.52, macd_signal: 0.36, macd_hist: 0.16 }] },
    }),
  );
  assert.deepEqual(second.indicators?.rows.map((row) => [row.t, row.ema9]), [["2026-04-07T23:50:00Z", 187.9], ["2026-04-07T23:55:00Z", 188.1], ["2026-04-08T00:00:00Z", 188.2]]);
  assert.equal(second.indicators?.asOfBar, "2026-04-08T00:00:00Z");
  const without = applyAdvance(second, ReplayDeltaSchema.parse({ ...overnightDelta, indicators: undefined }));
  assert.equal(without.indicators, second.indicators, "an answer without indicators leaves the table as it was");
  const switched = viewFromFeed(ReplayFeedSchema.parse({ ...overnightFeed, interval: "15m", indicators: { ...overnightFeed.indicators, interval: "15m", rows: [overnightFeed.indicators.rows[1]] } }), "15m");
  assert.equal(switched.indicators?.rows.length, 1, "a new feed (an interval switch) starts the table again");
});
