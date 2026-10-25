import assert from "node:assert/strict";
import test from "node:test";
import { timelineModel } from "./timeline.ts";

// A one-hour window (13:30 to 14:30 UTC), so each minute is 1/60 of the span.
const START = "2026-04-07T13:30:00Z";
const END = "2026-04-07T14:30:00Z";

test("the revealed fraction is the playhead's place in the whole window, clamped to 0..1", () => {
  assert.equal(timelineModel(START, END, "2026-04-07T13:45:00Z", [], []).revealed, 0.25);
  assert.equal(timelineModel(START, END, "2026-04-07T13:30:00Z", [], []).revealed, 0);
  assert.equal(timelineModel(START, END, "2026-04-07T15:00:00Z", [], []).revealed, 1, "past the window end clamps to 1");
  assert.equal(timelineModel(START, END, "2026-04-07T13:00:00Z", [], []).revealed, 0, "before the window clamps to 0");
});

test("ticks show her marks and released signals only up to the playhead, notes excluded, in time order", () => {
  const model = timelineModel(
    START,
    END,
    "2026-04-07T13:45:00Z",
    [
      { at: "2026-04-07T13:40:00Z", kind: "long_entry" },
      { at: "2026-04-07T13:35:00Z", kind: "note" },
      { at: "2026-04-07T13:50:00Z", kind: "long_exit" },
    ],
    [
      { bar_close: "2026-04-07T13:45:00Z", name: "ORB 15m" },
      { bar_close: "2026-04-07T14:00:00Z", name: "VWAP reclaim" },
    ],
  );
  assert.deepEqual(model.ticks, [
    { kind: "mark", at: 1 / 6, label: "Practice mark" },
    { kind: "signal", at: 0.25, label: "ORB 15m" },
  ]);
});

test("a zero-length or reversed window has nothing to draw", () => {
  const marks = [{ at: "2026-04-07T13:40:00Z", kind: "long_entry" as const }];
  const signals = [{ bar_close: "2026-04-07T13:40:00Z", name: "ORB 15m" }];
  assert.deepEqual(timelineModel(START, START, "2026-04-07T13:40:00Z", marks, signals), { revealed: 0, ticks: [] });
  assert.deepEqual(timelineModel(END, START, "2026-04-07T13:40:00Z", marks, signals), { revealed: 0, ticks: [] });
});
