import assert from "node:assert/strict";
import test from "node:test";
import { activeThread, freshThread, threadClockBrief } from "./threadFixtures.ts";
import {
  formatAxisDollars,
  formatBalance,
  formatDayResult,
  formatWhole,
  headlineFigure,
  startedWithText,
  threadName,
  threadStartedText,
  winRateText,
} from "./threadView.ts";

test("money is dollars and cents with the sign as the cue, and never prints NaN (D-044)", () => {
  assert.equal(formatBalance(50123.4), "$50,123.40");
  assert.equal(formatBalance(51565), "$51,565.00", "the recorded balance reads to the cent, like the trade lines");
  assert.equal(formatBalance(-1200), "−$1,200.00");
  assert.equal(formatBalance(-0.001), "$0.00");
  assert.equal(formatBalance(null), "—");
  assert.equal(formatDayResult(112), "+$112.00");
  assert.equal(formatDayResult(1565), "+$1,565.00");
  assert.equal(formatDayResult(-246.6), "−$246.60");
  assert.equal(formatDayResult(0.001), "$0.00");
  assert.equal(formatDayResult(-0.001), "$0.00");
  assert.equal(formatDayResult(Number.NaN), "—");
  assert.equal(formatWhole(50000), "$50,000", "an amount she chose stays whole dollars");
  assert.deepEqual([formatAxisDollars(50123.4), formatAxisDollars(1565, true), formatAxisDollars(-246.6, true), formatAxisDollars(0.2)], ["$50,123", "+$1,565", "−$247", "$0"]);
});

test("the thread card reads in plain words", () => {
  assert.equal(threadName(activeThread.thread), "Freestyle · Oct 5", "D-069: the name is the one the server stored, not one worked out from the month");
  assert.equal(threadName({ name: "Day thread · Oct 5" }), "Day thread · Oct 5", "a thread from before the freestyle model keeps its name");
  assert.equal(threadName({ name: "Freestyle · Oct 5 (2)" }), "Freestyle · Oct 5 (2)", "a second thread of the day reads apart from the first");
  assert.equal(threadStartedText(activeThread.thread), "Started Oct 5");
  // D-226: "Started" is the day the thread's clock starts, the day its name carries, not the day it was made (2026-02-23 09:30 ET here).
  assert.equal(threadStartedText(activeThread.thread, threadClockBrief), "Started Feb 23");
  assert.equal(threadStartedText(activeThread.thread, { start_at: null }), "Started Oct 5", "no setup yet: the day it was made");
  assert.equal(startedWithText(activeThread.thread), "Started with $50,000 · +$123.00 so far");
  assert.equal(startedWithText(freshThread.thread), "Started with $50,000 · no change yet");
  assert.equal(winRateText(0.64), "64%");
  assert.equal(winRateText(undefined), "—");
});




test("the Summary headline says Equity when it is equity and Balance when it is the realized figure (D-156)", () => {
  // A thread with its clock account read: equity (the realized balance plus the open P/L at the clock), labelled as such.
  assert.deepEqual(headlineFigure(50_000, { equity_usd: 49_761 }), { label: "Equity", value: "$49,761.00" });
  // No account (a closed thread, the clock not read yet): the ledger balance, labelled Balance.
  assert.deepEqual(headlineFigure(50_000, null), { label: "Balance", value: "$50,000.00" });
});


// D-170: a thread with a position open at the clock counts its open P/L apart, so a higher Equity never sits beside "no change yet".
test("a thread with a position open says what is realized and the open P/L, not \"no change yet\" (D-170)", () => {
  const flat = { startingBalance: 50000, stats: { ...activeThread.thread.stats, balance: 50000 } };
  assert.equal(startedWithText(flat, { balance: 50000, positions: 1, open_pnl_usd: -222 }), "Started with $50,000 · realized $0.00 · open P/L −$222.00");
  assert.equal(startedWithText(flat, { balance: 50200, positions: 2, open_pnl_usd: 31.5 }), "Started with $50,000 · realized +$200.00 · open P/L +$31.50", "realized is the account's balance, read with the open P/L");
  // A realized change alone, or nothing open, keeps the old sentences.
  assert.equal(startedWithText({ ...flat, stats: { ...flat.stats, balance: 50123 } }, { balance: 50123, positions: 0, open_pnl_usd: 0 }), "Started with $50,000 · +$123.00 so far");
  assert.equal(startedWithText(flat, { balance: 50000, positions: 0, open_pnl_usd: 0 }), "Started with $50,000 · no change yet");
  assert.equal(startedWithText(flat, null), "Started with $50,000 · no change yet");
  assert.equal(startedWithText(flat), "Started with $50,000 · no change yet");
});

// D-083: the swing modal and journal say per week; the overview's recap said "a day".
