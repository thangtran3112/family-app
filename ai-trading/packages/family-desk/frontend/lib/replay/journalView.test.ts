import assert from "node:assert/strict";
import test from "node:test";
import { adherenceHint, formatR, formatUsd, noTradesText, sessionOverText, signalRows, summaryTiles, tradeRows, tradesCountText } from "./journalView.ts";
import { journal as journalFixture } from "./fixtures.ts";
import { JournalSchema, type ReplayJournal } from "./schemas.ts";

// The fixture is loosely typed (not `as const`), so it goes through the real schema, as the feed tests do.
const journal: ReplayJournal = JournalSchema.parse(journalFixture);

const emptyJournal: ReplayJournal = {
  ...journal,
  totals: { pnl_usd: 0, r_total: 0, trades: 0, wins: 0, losses: 0, scratches: 0, win_rate: null, avg_win_usd: null, avg_loss_usd: null, largest_loss_usd: null },
  trades: [],
  adherence: { score_pct: null, hint: null, checks: [] },
  signals_vs_trades: [],
  pnl_series: [],
};

test("money and R carry the sign, with a proper minus sign, and zero has none", () => {
  assert.equal(formatUsd(63), "+$63.00");
  assert.equal(formatUsd(-42), "−$42.00");
  assert.equal(formatUsd(1234.5), "+$1,234.50");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(-0.001), "$0.00", "a rounds-to-zero loss shows no sign");
  assert.equal(formatUsd(null), "—");
  assert.equal(formatR(1.21), "+1.21R");
  assert.equal(formatR(-0.4), "−0.40R");
  assert.equal(formatR(0), "0.00R");
  assert.equal(formatR(-0.001), "0.00R");
  assert.equal(formatR(undefined), "—");
});

test("the summary tiles read the fixture journal", () => {
  const tiles = summaryTiles(journal);
  assert.deepEqual(tiles.map((tile) => tile.label), ["Practice P/L", "Total R", "Trades", "Win rate", "Average win", "Average loss", "Largest loss", "Adherence"]);
  assert.deepEqual(tiles.map(({ id, value, tone }) => [id, value, tone]), [
    ["pnl", "−$42.00", "down"],
    ["r", "−0.40R", "down"],
    ["trades", "3", "flat"],
    ["win_rate", "33%", "flat"],
    ["avg_win", "+$63.00", "up"],
    ["avg_loss", "−$52.50", "down"],
    ["largest_loss", "−$71.00", "down"],
    ["adherence", "75%", "flat"],
  ]);
});

test("a journal with no trades shows dashes, not zeros, for the trade-based tiles; the adherence hint falls back to the plan hint", () => {
  const tiles = summaryTiles(emptyJournal);
  assert.deepEqual(tiles.map(({ id, value, tone }) => [id, value, tone]), [
    ["pnl", "$0.00", "flat"],
    ["r", "—", "flat"],
    ["trades", "0", "flat"],
    ["win_rate", "—", "flat"],
    ["avg_win", "—", "flat"],
    ["avg_loss", "—", "flat"],
    ["largest_loss", "—", "flat"],
    ["adherence", "—", "flat"],
  ]);
  assert.equal(adherenceHint(emptyJournal), "Add a plan to get an adherence score");
  assert.equal(adherenceHint({ ...emptyJournal, adherence: { score_pct: null, hint: "Set a stop first", checks: [] } }), "Set a stop first");
  assert.equal(adherenceHint(journal), null, "a score means no hint");
});

test("trade rows show ET times, prices, P/L and R, and mark an auto exit at window end", () => {
  assert.deepEqual(tradeRows(journal.trades), [
    { no: 1, side: "Long", entry: "9:47 AM · 187.42", exit: "10:02 AM · 188.05", shares: "100", pnl: "+$63.00", pnlTone: "up", r: "+1.21R", stop: "186.90", onSignal: "Yes" },
    { no: 2, side: "Short", entry: "10:20 AM · 188.40", exit: "10:31 AM · 189.10", shares: "100", pnl: "−$70.00", pnlTone: "down", r: "−1.00R", stop: "189.10", onSignal: "No" },
    { no: 3, side: "Long", entry: "11:10 AM · 189.50", exit: "4:00 PM · 189.45 (auto, window end)", shares: "100", pnl: "−$5.00", pnlTone: "down", r: "—", stop: "none", onSignal: "No" },
  ]);
});

test("signal rows show the close and the 15 and 30 minute moves, dashes for missing moves", () => {
  const [row] = signalRows(journal.signals_vs_trades);
  assert.deepEqual(row, {
    key: "2026-04-07T13:45:00Z:ORB 15m:0",
    time: "9:45 AM",
    name: "ORB 15m",
    close: "187.10",
    chg15: "+0.40%",
    chg30: "−0.20%",
    chg15Tone: "up",
    chg30Tone: "down",
    her: "entered 2 min later",
  });
  const [missing] = signalRows([{ ...journal.signals_vs_trades[0]!, chg_15m_pct: null, chg_30m_pct: 0 }]);
  assert.equal(missing!.chg15, "—");
  assert.equal(missing!.chg15Tone, "flat");
  assert.equal(missing!.chg30, "0.00%");
});

test("the no-trades and session-over lines pluralise correctly", () => {
  assert.equal(noTradesText(0), "No practice trades this session");
  assert.equal(noTradesText(1), "No practice trades this session · 1 signal would have fired");
  assert.equal(noTradesText(3), "No practice trades this session · 3 signals would have fired");
  assert.equal(tradesCountText(0), "0 practice trades");
  assert.equal(tradesCountText(1), "1 practice trade");
  assert.equal(sessionOverText(3), "Session over · 3 practice trades · See journal");
  assert.equal(sessionOverText(1), "Session over · 1 practice trade · See journal");
});
