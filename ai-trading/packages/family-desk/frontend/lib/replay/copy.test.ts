import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm, PRACTICE_COPY, practiceBandText, practiceText, replayBadgeText } from "../desk/freshness.ts";
import { markLabel } from "./marks.ts";
import { fastTapeText } from "./tape.ts";
import { noTradesText, tradesCountText } from "./journalView.ts";

test("every Practice copy string passes the banned-term check (the global list)", () => {
  for (const [key, text] of Object.entries(PRACTICE_COPY)) {
    assert.equal(containsPracticeBannedTerm(text), false, `${key}: ${text}`);
  }
  assert.ok(Object.keys(PRACTICE_COPY).length > 40);
});

test("the Practice lane may say order, position and fill; the desk-wide technical words are still caught", () => {
  for (const text of ["Place an order", "Open position", "Order filled", "Order type", "Close position"]) {
    assert.equal(containsPracticeBannedTerm(text), false, text);
  }
  for (const text of ["Fetch failed", "Error 503", "value is null"]) {
    assert.equal(containsPracticeBannedTerm(text), true, `global list: ${text}`);
  }
});

test("the band names the day and the replay badge names the thread clock's own date and time", () => {
  assert.equal(practiceBandText(null), "Practice · a pretend account with one clock · nothing here reaches a broker");
  assert.equal(practiceBandText("2026-10-23"), "Practice · replay of Fri 2026-10-23 · nothing here reaches a broker");
  assert.equal(replayBadgeText("2026-10-23T14:07:00Z"), "Replay · Fri 2026-10-23 · 10:07:00 AM ET");
  assert.equal(replayBadgeText("2026-10-23T05:22:24Z"), "Replay · Fri 2026-10-23 · 1:22:24 AM ET"); // the night after Thursday's list: Friday's date
});

test("practiceText fills placeholders, and the strings the screens build contain no banned term", () => {
  assert.equal(practiceText("paused", { time: "10:07 AM ET" }), "Paused at 10:07 AM ET");
  assert.equal(practiceText("playing", { speed: 4 }), "Playing at 4x");
  assert.equal(practiceText("fastTape", { shown: "500", count: "1,043" }), "Fast tape · showing the latest 500 of 1,043 prints");
  const built = [
    fastTapeText({ shown: 500, count: 1043 })!,
    ...(["long_entry", "short_entry", "long_exit", "short_exit", "stop", "note"] as const).map((kind) => markLabel({ kind, shares: 100, stop_price: 186.9 })),
    noTradesText(0),
    noTradesText(2),
    tradesCountText(1),
    practiceText("chartNotUpdating", { when: "Fri 2026-10-23 · 7:59:00 PM ET" }),
    practiceText("marketClosed", { time: "8:00 PM ET" }),
    practiceText("marketNextOpen", { when: "Fri 2026-10-23 · 10:00 AM ET" }),
  ];
  assert.equal(practiceText("chartNotUpdating", { when: "8:00 PM ET" }), "Not updating · last data 8:00 PM ET");
  assert.equal(practiceText("marketClosed", { time: "8:00 PM ET" }), "Market closed · data through 8:00 PM ET");
  for (const text of built) assert.equal(containsPracticeBannedTerm(text), false, text);
});
