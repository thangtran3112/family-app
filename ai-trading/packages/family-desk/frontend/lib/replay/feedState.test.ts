import assert from "node:assert/strict";
import test from "node:test";
import { applyAdvance, chartBars, isQuietTape, mergeBars, paceOf, syncTarget, TAPE_CAP, viewClock, viewFromFeed } from "./feedState.ts";
import { delta, feed, overnightDelta, overnightFeed } from "./fixtures.ts";
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

const bar = (minute: number, close = 2) => ({ t: `2026-04-07T14:${String(minute).padStart(2, "0")}:00Z`, o: 1, h: 3, l: 1, c: close, v: 10, ext: false });

test("mergeBars folds an answer into the tail and keeps every other bar the same object (D-206)", () => {
  const held = [bar(0), bar(1), bar(2)];
  const same = mergeBars(held, [bar(2)]);
  assert.equal(same, held, "the newest bar again, unchanged: nothing is rebuilt");
  const appended = mergeBars(held, [bar(2), bar(3)]);
  assert.deepEqual(appended.map((item) => item.t.slice(14, 16)), ["00", "01", "02", "03"]);
  assert.ok(appended.slice(0, 3).every((item, index) => item === held[index]), "the bars it already had stay the same objects");
  const revised = mergeBars(held, [bar(2, 9)]);
  assert.equal(revised.length, 3);
  assert.equal(revised[2]?.c, 9);
  assert.equal(revised[1], held[1]);
  assert.equal(held[2]?.c, 2, "the held array is not touched");
});

test("mergeBars still keys, sorts and dedupes an answer that does not continue the tail", () => {
  const held = [bar(0), bar(1), bar(2)];
  const reached = mergeBars(held, [bar(1, 7), bar(4), bar(3)]);
  assert.deepEqual(reached.map((item) => [item.t.slice(14, 16), item.c]), [["00", 2], ["01", 7], ["02", 2], ["03", 2], ["04", 2]]);
  assert.deepEqual(mergeBars([], [bar(2), bar(0), bar(2, 5)]).map((item) => [item.t.slice(14, 16), item.c]), [["00", 2], ["02", 5]]);
});

test("a poll that brings nothing new hands back the same bars, forming candle, levels, open trade, signals and indicator rows (D-206)", () => {
  const withRows = (rows: Array<{ t: string; ema9: number }>) =>
    next({ indicators: { interval: "5m", as_of_bar: rows.at(-1)!.t, rows: rows.map((row) => ({ ...row, ema21: 1, vwap: 1, rsi14: 50, macd: 0, macd_signal: 0, macd_hist: 0 })) } });
  const first = applyAdvance(base(), withRows([{ t: "2026-04-07T14:00:00Z", ema9: 1 }, { t: "2026-04-07T14:05:00Z", ema9: 2 }]));
  const again = applyAdvance(first, withRows([{ t: "2026-04-07T14:05:00Z", ema9: 2 }]));
  assert.notEqual(again, first, "the view moves (the clock, the tape)");
  assert.equal(again.bars, first.bars);
  assert.equal(again.forming, first.forming);
  assert.equal(again.levels, first.levels);
  assert.equal(again.openTrade, first.openTrade);
  assert.equal(again.signals, first.signals);
  assert.equal(again.indicators, first.indicators);
  assert.equal(chartBars(again).length, chartBars(first).length);
  // A revised newest row and a new one: only those change, and the older row stays the same object.
  const moved = applyAdvance(again, withRows([{ t: "2026-04-07T14:05:00Z", ema9: 3 }, { t: "2026-04-07T14:10:00Z", ema9: 4 }]));
  assert.deepEqual(moved.indicators?.rows.map((row) => [row.t.slice(11, 16), row.ema9]), [["14:00", 1], ["14:05", 3], ["14:10", 4]]);
  assert.equal(moved.indicators?.rows[0], first.indicators?.rows[0]);
  const forming = applyAdvance(moved, next({ forming: { ...delta.forming, c: 190 } }));
  assert.equal(forming.forming?.c, 190, "a forming candle that moved is the new one");
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

// ---- a lane across days (ADR-0025) -------------------------------------------------------------------------------

const dayBar = (day: string, hhmm: string, close: number) => ({ t: `${day}T${hhmm}:00Z`, o: close, h: close + 1, l: close - 1, c: close, v: 100, ext: false });

test("a Jump over a weekend folds bars of several data days into one ascending series, and the forming candle follows T", () => {
  // Friday's close, held by the lane; then a poll that carries Monday's and Tuesday's bars after a Jump (since = Friday's playhead).
  const friday = applyAdvance(base(), next({ revealed_through: "2026-04-10T19:55:00Z", bars: [dayBar("2026-04-10", "19:50", 10), dayBar("2026-04-10", "19:55", 11)], forming: null, thread_time: "2026-04-10T19:56:00Z" }));
  const jumped = applyAdvance(friday, next({
    revealed_through: "2026-04-14T14:35:00Z",
    thread_time: "2026-04-14T14:36:30Z",
    bars: [dayBar("2026-04-13", "13:30", 12), dayBar("2026-04-13", "19:55", 13), dayBar("2026-04-14", "13:30", 14), dayBar("2026-04-14", "14:30", 15)],
    forming: { t: "2026-04-14T14:35:00Z", o: 15, h: 16, l: 15, c: 15.5, v: 50 },
  }));
  assert.deepEqual(jumped.bars.map((item) => item.t.slice(5, 16)), ["04-10T19:50", "04-10T19:55", "04-13T13:30", "04-13T19:55", "04-14T13:30", "04-14T14:30"]);
  assert.equal(jumped.bars[0], friday.bars[0], "Friday's bars stay the same objects: a Jump rebuilds nothing it already had");
  assert.equal(chartBars(jumped).at(-1)?.t, "2026-04-14T14:35:00Z", "the forming candle is Tuesday's, at T");
  assert.equal(viewClock(jumped), "2026-04-14T14:36:30Z");
  // The next poll starts where this window ended, not at the Friday it held before the Jump.
  assert.deepEqual(syncTarget(jumped), { sync: true, since: "2026-04-14T14:35:00Z" });
  // An answer that reaches back across a day boundary (another window took the Monday bars first) still sorts into place.
  const reached = mergeBars(jumped.bars, [dayBar("2026-04-13", "15:00", 99)]);
  assert.deepEqual(reached.map((item) => item.t.slice(5, 16)), ["04-10T19:50", "04-10T19:55", "04-13T13:30", "04-13T15:00", "04-13T19:55", "04-14T13:30", "04-14T14:30"]);
});

test("a day thread's position travels with the view: the open trade is the lane's, whatever data day the bars are from", () => {
  const held = applyAdvance(base(), next({ revealed_through: "2026-04-09T14:00:00Z", thread_time: "2026-04-09T14:00:00Z" }));
  assert.equal(held.openTrade?.shares, 100);
  const later = applyAdvance(held, next({ revealed_through: "2026-04-14T14:00:00Z", thread_time: "2026-04-14T14:00:00Z", open_trade: { ...delta.open_trade, last_price: 191.2, unrealized_usd: 378 } }));
  assert.equal(later.openTrade?.last_price, 191.2, "the first read after a Jump prices the position at the new T");
  assert.equal(later.openTrade?.entry_price, held.openTrade?.entry_price);
});

test("the view carries the thread clock and whether this name is behind it, from a feed and from an advance", () => {
  const behind = viewFromFeed(ReplayFeedSchema.parse({ ...feed, day_clock: "2026-04-07T14:30:00Z", behind_clock: true }), "5m");
  assert.deepEqual([behind.threadClock, behind.behindClock], ["2026-04-07T14:30:00Z", true]);
  const caught = applyAdvance(behind, ReplayDeltaSchema.parse({ ...delta, revealed_through: "2026-04-07T14:30:00Z", day_clock: "2026-04-07T14:30:00Z", behind_clock: false }));
  assert.deepEqual([caught.threadClock, caught.behindClock], ["2026-04-07T14:30:00Z", false]);
  assert.equal(viewFromFeed(ReplayFeedSchema.parse(feed), "5m").threadClock, null);
});

test("the view carries the payload's own thread time, data end and market, from a feed and from an advance (ADR-0022)", () => {
  const plain = viewFromFeed(ReplayFeedSchema.parse(feed), "5m");
  assert.deepEqual([plain.threadTime, plain.dataThrough, plain.market], [null, "2026-04-07T14:07:12Z", null], "a legacy standalone session has no thread time; its data runs to its playhead");
  const overnight = viewFromFeed(ReplayFeedSchema.parse(overnightFeed), "5m");
  assert.deepEqual([overnight.threadTime, overnight.dataThrough, overnight.market?.phase], ["2026-04-08T05:22:24Z", "2026-04-08T00:00:00Z", "closed"]);
  const later = applyAdvance(overnight, ReplayDeltaSchema.parse({ ...overnightDelta, thread_time: "2026-04-08T05:22:26Z" }));
  assert.equal(later.threadTime, "2026-04-08T05:22:26Z", "T moves with the answer while data_through stays at the tape end");
  assert.equal(later.dataThrough, "2026-04-08T00:00:00Z");
});

test("one time source: the thread time of the payload, else the playhead or the thread clock a name was left behind", () => {
  const overnight = viewFromFeed(ReplayFeedSchema.parse(overnightFeed), "5m");
  assert.equal(viewClock(overnight), "2026-04-08T05:22:24Z", "past the tape T still ticks; the name's capped playhead never stands in for it");
  const behind = { threadTime: null, revealedThrough: "2026-04-07T14:00:00Z", threadClock: "2026-04-07T14:30:00Z" };
  assert.equal(viewClock(behind), "2026-04-07T14:30:00Z", "a name left behind shows the thread's time");
  assert.equal(viewClock({ ...behind, threadClock: "2026-04-07T13:00:00Z" }), "2026-04-07T14:00:00Z", "the playhead is never pulled back by a stale clock");
  assert.equal(viewClock({ ...behind, threadClock: null }), "2026-04-07T14:00:00Z", "a legacy standalone session has only its own playhead");
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
