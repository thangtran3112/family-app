import assert from "node:assert/strict";
import test from "node:test";
import { delta, mark, openTrade } from "./fixtures.ts";
import { barStartFor, canUndoLast, windowIndex, levelLines, levelRows, markLabel, markRows, openSide, practiceMarkers, pnlValues, signalMarkers, stopLevel } from "./marks.ts";
import { ReplaySignalSchema, type ReplayBar, type ReplayMark } from "./schemas.ts";
import { ms } from "./time.ts";

const bar = (t: string): ReplayBar => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });
const bars = ["13:30", "13:35", "13:40", "13:45", "13:50"].map((hm) => bar(`2026-04-07T${hm}:00Z`));
const withMark = (overrides: Partial<ReplayMark>): ReplayMark => ({ ...mark, ...overrides });

test("barStartFor is the last bar starting at or before the instant", () => {
  assert.equal(barStartFor(bars, ms("2026-04-07T13:37:00Z")), "2026-04-07T13:35:00Z");
  assert.equal(barStartFor(bars, ms("2026-04-07T13:35:00Z")), "2026-04-07T13:35:00Z", "a bar's own start belongs to that bar");
  assert.equal(barStartFor(bars, ms("2026-04-07T14:30:00Z")), "2026-04-07T13:50:00Z", "after the last bar it stays on the last bar");
  assert.equal(barStartFor(bars, ms("2026-04-07T13:29:59Z")), null, "before the first bar there is none");
  assert.equal(barStartFor([], ms("2026-04-07T13:37:00Z")), null);
});

test("markLabel reads every mark kind as Practice text", () => {
  assert.equal(markLabel({ kind: "long_entry", shares: 100, stop_price: null }), "Practice long 100");
  assert.equal(markLabel({ kind: "short_entry", shares: 50, stop_price: null }), "Practice short 50");
  assert.equal(markLabel({ kind: "long_entry", shares: null, stop_price: null }), "Practice long", "no share count trims cleanly");
  assert.equal(markLabel({ kind: "long_exit", shares: null, stop_price: null }), "Practice exit");
  assert.equal(markLabel({ kind: "short_exit", shares: null, stop_price: null }), "Practice exit");
  assert.equal(markLabel({ kind: "stop", shares: null, stop_price: 186.9 }), "Practice stop 186.90");
  assert.equal(markLabel({ kind: "note", shares: null, stop_price: null }), "Practice note");
});

test("practice markers snap to the bar open at the mark time and skip stop, note and pre-session marks", () => {
  const marks = [
    mark, // long entry at 13:47 -> the 13:45 bar
    withMark({ id: 4, seq: 2, kind: "short_entry", at: "2026-04-07T13:36:00Z", shares: 50 }),
    withMark({ id: 5, seq: 3, kind: "long_exit", at: "2026-04-07T13:52:00Z", shares: null }),
    withMark({ id: 6, seq: 4, kind: "stop", at: "2026-04-07T13:40:00Z", stop_price: 186.9 }),
    withMark({ id: 7, seq: 5, kind: "note", at: "2026-04-07T13:41:00Z", note: "watch the open" }),
    withMark({ id: 8, seq: 6, kind: "long_entry", at: "2026-04-07T13:20:00Z" }), // before the first bar
  ];
  assert.deepEqual(practiceMarkers(marks, bars), [
    { time: "2026-04-07T13:45:00Z", kind: "practice_long", label: "Practice long 100" },
    { time: "2026-04-07T13:35:00Z", kind: "practice_short", label: "Practice short 50" },
    { time: "2026-04-07T13:50:00Z", kind: "practice_exit", label: "Practice exit" },
  ]);
});

test("a signal is placed on the bar open one second before its bar close", () => {
  const signal = ReplaySignalSchema.parse(delta.signals[0]); // bar_close 13:45:00 -> 13:44:59 -> the 13:40 bar
  const early = { ...signal, bar_close: "2026-04-07T13:36:00Z", name: "VWAP reclaim" }; // 13:35:59 -> the 13:35 bar
  const tooEarly = { ...signal, bar_close: "2026-04-07T13:30:00Z" }; // 13:29:59 -> before the first bar
  assert.deepEqual(signalMarkers([signal, early, tooEarly], bars), [
    { time: "2026-04-07T13:40:00Z", kind: "would_fire", label: "ORB 15m" },
    { time: "2026-04-07T13:35:00Z", kind: "would_fire", label: "VWAP reclaim" },
  ]);
});

test("the stop level is an amber dashed line, present only with a stop", () => {
  assert.deepEqual(stopLevel(openTrade), [{ label: "Practice stop", price: 186.9, color: "#FFB020", style: "dashed" }]);
  assert.deepEqual(stopLevel({ stop_price: null }), []);
  assert.deepEqual(stopLevel(null), []);
  assert.equal(openSide(null), "flat");
  assert.equal(openSide({ side: "short" }), "short");
});

test("key levels are dotted lines in a fixed order; the table sorts them highest first", () => {
  const lines = levelLines(delta.levels);
  assert.deepEqual(lines.map((line) => line.label), ["Prior close", "Session high", "Session low", "OR high", "OR low"]);
  assert.ok(lines.every((line) => line.color === "#9B9BA1" && line.style === "dotted"));
  assert.deepEqual(levelRows(delta.levels), [
    { label: "Prior close", price: 195.4 },
    { label: "Session high", price: 188.6 },
    { label: "OR high", price: 187.3 },
    { label: "OR low", price: 184.9 },
    { label: "Session low", price: 183.2 },
  ]);
  assert.deepEqual(levelLines({ session_high: 190 }).map((line) => line.label), ["Session high"], "missing levels are skipped");
});

test("the Marks tab lists newest first; undo only reaches her last mark while the playhead sits on it", () => {
  const marks = [
    withMark({ id: 5, seq: 3, kind: "note", at: "2026-04-07T13:50:00Z", price: null, note: "watch the open" }),
    withMark({ id: 6, seq: 4, kind: "long_exit", at: "2026-04-07T20:00:00Z", price: 189.45, source: "auto", shares: null, note: null }),
    mark,
    withMark({ id: 4, seq: 2, kind: "stop", at: "2026-04-07T13:48:00Z", price: null, stop_price: 186.9, note: null }),
  ];
  assert.deepEqual(markRows(marks).map((row) => row.id), [6, 5, 4, 3]);
  assert.deepEqual(markRows(marks)[3], { id: 3, time: "9:47:00 AM ET", label: "Practice long 100", price: "187.42", note: "ORB hold", auto: false });
  assert.deepEqual(markRows(marks)[1], { id: 5, time: "9:50:00 AM ET", label: "Practice note", price: "", note: "watch the open", auto: false });
  assert.deepEqual(markRows(marks)[0], { id: 6, time: "4:00:00 PM ET", label: "Practice exit", price: "189.45", note: null, auto: true });
  assert.equal(canUndoLast(marks, "2026-04-07T20:00:00Z"), false, "the last mark is an auto exit");
  assert.equal(canUndoLast([mark], "2026-04-07T13:47:00Z"), true);
  assert.equal(canUndoLast([mark], "2026-04-07T13:48:00Z"), false, "the playhead has moved");
  assert.equal(canUndoLast([], "2026-04-07T13:47:00Z"), false);
});

test("P/L steps forward at each realized point and is null before the first one", () => {
  const series = [{ t: "2026-04-07T14:31:00Z", pnl_usd: -7 }, { t: "2026-04-07T14:02:00Z", pnl_usd: 63 }];
  const starts = ["2026-04-07T14:00:00Z", "2026-04-07T14:02:00Z", "2026-04-07T14:05:00Z", "2026-04-07T14:30:00Z", "2026-04-07T14:35:00Z"];
  assert.deepEqual(pnlValues(starts.map(bar), series), [null, 63, 63, 63, -7], "a point at a bar's start counts; one a minute later does not");
  assert.deepEqual(pnlValues(starts.map(bar), []), [null, null, null, null, null]);
});

test("the journal chart starts at the first bar of the window, after the lookback", () => {
  assert.equal(windowIndex(bars, "2026-04-07T13:30:00Z"), 0);
  assert.equal(windowIndex(bars, "2026-04-07T13:40:00Z"), 2);
  assert.equal(windowIndex(bars, "2026-04-07T13:41:00Z"), 3);
  assert.equal(windowIndex(bars, "2026-04-07T23:00:00Z"), 0, "a window after every bar falls back to the start");
});
