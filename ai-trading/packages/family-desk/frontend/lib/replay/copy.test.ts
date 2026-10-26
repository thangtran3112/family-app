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

// ---- swing practice (02p) ---------------------------------------------------------------------------------------

const swingRows = Object.entries(PRACTICE_COPY).filter(([key]) => key.startsWith("swing")) as Array<[keyof typeof PRACTICE_COPY, string]>;

test("the swing copy rows are all there, plain, and free of banned words", () => {
  assert.ok(swingRows.length > 120, `${swingRows.length} swing rows`);
  for (const [key, text] of swingRows) {
    assert.equal(containsPracticeBannedTerm(text), false, `${key}: ${text}`);
    assert.equal(text, text.trim(), key);
    assert.equal(/\b(?:position|order|filled|broker|execute)/i.test(key), false, `the key ${key} names a banned word`);
  }
});

test("a swing row with placeholders fills completely, and a row without any has no braces", () => {
  for (const [key, text] of swingRows) {
    const names = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
    const filled = practiceText(key, Object.fromEntries(names.map((name) => [name, "x"])));
    assert.equal(/[{}]/.test(filled), false, `${key}: ${filled}`);
    if (names.length === 0) assert.equal(filled, text);
  }
});

test("the swing strings the screens quote word for word", () => {
  assert.equal(PRACTICE_COPY.swingTapeOff, "Tape off · swing prices are one-minute closes");
  assert.equal(PRACTICE_COPY.swingTapeOffFootnote, "Swing prices are one-minute closes · turn the tape on for exact prints");
  assert.equal(PRACTICE_COPY.swingDividends, "Dividends are not credited in practice");
  assert.equal(PRACTICE_COPY.swingScoredWeekly, "Scored weekly");
  assert.equal(PRACTICE_COPY.swingMarketNotOpen, "Market not open yet · step to the first bar");
  assert.equal(PRACTICE_COPY.swingPassDay, "Pass this day");
  assert.equal(PRACTICE_COPY.swingWeekToDate, "Week to date");
  assert.equal(PRACTICE_COPY.swingSimulated, "SIMULATED");
  assert.equal(practiceText("swingStartDay", { n: 7 }), "Start Day 7");
  assert.equal(practiceText("swingContinueDay", { n: 7 }), "Continue Day 7");
  assert.equal(practiceText("swingStartWeek", { n: 3 }), "Start Week 3");
  assert.equal(practiceText("swingEntryLabel", { day: 3, price: "184.20" }), "Day 3 · 184.20");
  assert.equal(practiceText("swingCalendarLine", { sessions: 20, weeks: 4, noun: "weeks" }), "20 sessions · 4 weeks · ends on day 20");
  assert.equal(practiceText("swingFinished", { days: 20 }), "Finished · Day 20 of 20");
  assert.equal(practiceText("swingPrepProgress", { done: 96, total: 133 }), "Preparing as-of data · 96 of 133 · watchlist and manual picks are ready");
});

test("the swing copy never says position, order, filled, broker or execute, in a row or in a quoted spec sentence", () => {
  for (const text of [
    "Swing · 50 names · Week 2 of 4 · Day 7 of 20 · Balance $51,240 · Equity $52,010 · 2 holds open",
    "End Day 7 at 11:40? Your 2 holds stay open through the close, unwatched.",
    "NVDA crossed your stop 182.50 at 11:42 · Exit or keep",
    "Split 10-for-1 before today's open · 100 shares are now 1,000 at 120.38",
  ]) {
    assert.equal(containsPracticeBannedTerm(text), false, text);
  }
});
