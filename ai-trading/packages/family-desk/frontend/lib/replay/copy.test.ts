import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm, PRACTICE_COPY, practiceBandText, practiceText, replayBadgeText } from "../desk/freshness.ts";
import { markLabel } from "./marks.ts";
import { fastTapeText } from "./tape.ts";
import { noTradesText, sessionOverText, tradesCountText } from "./journalView.ts";

test("every Practice copy string passes the banned-term check (Practice list and the global list)", () => {
  for (const [key, text] of Object.entries(PRACTICE_COPY)) {
    assert.equal(containsPracticeBannedTerm(text), false, `${key}: ${text}`);
  }
  assert.ok(Object.keys(PRACTICE_COPY).length > 40);
});

test("order, position, fill, broker and execute words are caught; Practice labels and dates are not", () => {
  for (const text of ["Place an order", "Open position", "Order filled", "Your broker", "Execute now"]) {
    assert.equal(containsPracticeBannedTerm(text), true, text);
  }
  for (const text of ["Practice long 100", "Border", "Replay · Fri 2026-10-23 · 10:07 AM ET"]) {
    assert.equal(containsPracticeBannedTerm(text), false, text);
  }
  for (const text of ["Fetch failed", "Error 503", "value is null"]) {
    assert.equal(containsPracticeBannedTerm(text), true, `global list: ${text}`);
  }
});

test("the band and the replay badge name the day, the hidden state and the playhead time", () => {
  assert.equal(practiceBandText(null), "Practice · replay of past days · nothing here reaches IBKR");
  assert.equal(practiceBandText("2026-10-23"), "Practice · replay of Fri 2026-10-23 · nothing here reaches IBKR");
  assert.equal(practiceBandText("2026-10-23", true), "Practice · replay of a hidden day · nothing here reaches IBKR");
  assert.equal(replayBadgeText("2026-10-23", "2026-10-23T14:07:00Z", false), "Replay · Fri 2026-10-23 · 10:07 AM ET");
  assert.equal(replayBadgeText("2026-10-23", "2026-10-23T14:07:00Z", true), "Replay · hidden day · 10:07 AM ET");
});

test("practiceText fills placeholders, and the strings the screens build contain no banned term", () => {
  assert.equal(practiceText("paused", { time: "10:07 AM ET" }), "Paused at 10:07 AM ET");
  assert.equal(practiceText("playing", { speed: 4 }), "Playing at 4x");
  assert.equal(practiceText("fastTape", { shown: "500", count: "1,043" }), "Fast tape · showing the latest 500 of 1,043 prints");
  const built = [
    fastTapeText({ shown: 500, count: 1043 })!,
    ...(["long_entry", "short_entry", "long_exit", "short_exit", "stop", "note"] as const).map((kind) => markLabel({ kind, shares: 100, stop_price: 186.9 })),
    sessionOverText(3),
    noTradesText(0),
    noTradesText(2),
    tradesCountText(1),
  ];
  for (const text of built) assert.equal(containsPracticeBannedTerm(text), false, text);
});
