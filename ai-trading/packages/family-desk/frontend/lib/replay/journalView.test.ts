import assert from "node:assert/strict";
import test from "node:test";
import { formatSignedUsd } from "../desk/mask.ts";
import { adherenceHint, dateLabel, formatR, hasNoTrades, noTradesText, openPositionsText, planRows, shortDate, signalRows, summaryTiles, threadTiles, tradeRows, tradesCountText } from "./journalView.ts";
import { journal as journalFixture } from "./fixtures.ts";
import { JournalSchema, type ReplayJournal } from "./schemas.ts";
import type { Thread } from "./threads.ts";

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
  assert.equal(formatSignedUsd(63, { cents: true }), "+$63.00");
  assert.equal(formatSignedUsd(-42, { cents: true }), "−$42.00");
  assert.equal(formatSignedUsd(1234.5, { cents: true }), "+$1,234.50");
  assert.equal(formatSignedUsd(0, { cents: true }), "$0.00");
  assert.equal(formatSignedUsd(-0.001, { cents: true }), "$0.00", "a rounds-to-zero loss shows no sign");
  assert.equal(formatSignedUsd(null, { cents: true }), "—");
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

test("trade rows show ET times, prices, P/L and R, and mark an auto exit", () => {
  assert.deepEqual(tradeRows(journal.trades), [
    { no: 1, side: "Long", entry: "9:47 AM · 187.42", exit: "10:02 AM · 188.05", shares: "100", pnl: "+$63.00", pnlTone: "up", r: "+1.21R", stop: "186.90", onSignal: "Yes" },
    { no: 2, side: "Short", entry: "10:20 AM · 188.40", exit: "10:31 AM · 189.10", shares: "100", pnl: "−$70.00", pnlTone: "down", r: "−1.00R", stop: "189.10", onSignal: "No" },
    { no: 3, side: "Long", entry: "11:10 AM · 189.50", exit: "4:00 PM · 189.45 (auto)", shares: "100", pnl: "−$5.00", pnlTone: "down", r: "—", stop: "none", onSignal: "No" },
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

test("the no-trades line pluralises correctly and says nothing about a session ending", () => {
  assert.equal(noTradesText(0), "No practice trades on this name yet");
  assert.equal(noTradesText(1), "No practice trades on this name yet · 1 signal would have fired");
  assert.equal(noTradesText(3), "No practice trades on this name yet · 3 signals would have fired");
  assert.equal(tradesCountText(0), "0 practice trades");
  assert.equal(tradesCountText(1), "1 practice trade");
});

// ---- the thread's journal, by ET date -----------------------------------------------------------------------------------

const stats = { balance: 50228, daysPracticed: 3, daysSkipped: 0, wins: 4, losses: 2, winRate: 0.667, avgWinUsd: 61.25, avgLossUsd: -37.5, bestDayUsd: 240, worstDayUsd: -75 };
const daily: Thread["daily"] = [
  { n: 1, day: "2026-03-02", weekday: "Mon", trades: 2, pnl_usd: -75, balance: 49925 },
  { n: 2, day: "2026-03-07", weekday: "Sat", trades: 1, pnl_usd: 63, balance: 49988 },
  { n: 3, day: "2026-03-11", weekday: "Wed", trades: 3, pnl_usd: 240, balance: 50228 },
];
const threadWith = (over: Partial<typeof stats>) => ({ thread: { stats: { ...stats, ...over } }, daily }) as unknown as Pick<Thread, "thread" | "daily">;

test("a date is named by weekday and ET date, a weekend date included, and its axis form drops the year", () => {
  assert.equal(dateLabel("2026-03-11"), "Wed 2026-03-11");
  assert.equal(dateLabel("2026-03-07"), "Sat 2026-03-07", "the clock runs through a weekend: a Saturday date is a date like any other");
  assert.equal(shortDate("2026-03-11"), "03-11");
});

test("the summary tiles count dates and closed trades, name the best and worst date, and never mention a passed day", () => {
  const tiles = threadTiles(threadWith({}));
  assert.deepEqual(tiles.map(({ id, value, sub, tone }) => [id, value, sub, tone]), [
    ["dates", "3", "with a closed trade", "flat"],
    ["wins", "4", "practice trades", "flat"],
    ["losses", "2", "practice trades", "flat"],
    ["win_rate", "67%", "4 of 6 trades", "flat"],
    ["avg_win", "+$61.25", "per winning trade", "up"],
    ["avg_loss", "−$37.50", "per losing trade", "down"],
    ["best", "+$240.00", "Wed 2026-03-11", "up"],
    ["worst", "−$75.00", "Mon 2026-03-02", "down"],
  ]);
  assert.equal(tiles.some((tile) => /pass|skip|adherence/i.test(`${tile.label} ${tile.sub}`)), false);
});

test("a thread with no closed trade shows dashes; a worst date that is still a gain says no date lost", () => {
  const none = threadTiles({ thread: { stats: { balance: 50000, daysPracticed: 0, daysSkipped: 0, wins: 0, losses: 0 } }, daily: [] } as unknown as Pick<Thread, "thread" | "daily">);
  assert.deepEqual(none.map((tile) => tile.value), ["0", "0", "0", "—", "—", "—", "—", "—"]);
  assert.equal(none.find((tile) => tile.id === "win_rate")!.sub, "no wins or losses yet");
  const gain = threadTiles(threadWith({ worstDayUsd: 63 })).find((tile) => tile.id === "worst")!;
  assert.deepEqual([gain.value, gain.sub, gain.tone], ["+$63.00", "Sat 2026-03-07 · no losing date", "up"]);
  assert.equal(hasNoTrades({ daily: [] }), true);
  assert.equal(hasNoTrades({ daily }), false);
});

test("open positions are counted in words and the plan rows count the two limits per ET date", () => {
  assert.equal(openPositionsText(1), "1 open position");
  assert.equal(openPositionsText(3), "3 open positions");
  const plan = { stopNoteOnEntry: "no", tradeOnlyOnSignal: "yes", maxLossUsd: 1500, maxTrades: 5 } as const;
  assert.deepEqual(planRows(plan, 200).map((row) => [row.id, row.value]), [["shares", "200"], ["signal", "Yes"], ["max_loss", "$1,500"], ["max_trades", "5"]]);
  assert.match(planRows(plan)[2]!.label, /ET date/);
  assert.match(planRows(plan)[3]!.label, /ET date/);
  const open = planRows({ stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" });
  assert.deepEqual(open.map((row) => row.value), ["Not set", "No", "None", "None"]);
});
