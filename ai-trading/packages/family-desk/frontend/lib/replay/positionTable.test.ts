import assert from "node:assert/strict";
import test from "node:test";
import { heldRows, portfolioRows } from "./dayView.ts";
import { dayPositionRow, positionCells, swingPositionRow } from "./positionTable.ts";
import type { Hold } from "./schemas.ts";

const trade = { trade_no: 1, side: "long" as const, shares: 100, entry_price: 812.4, entry_at: "2026-03-10T13:40:00Z", stop_price: null, last_price: 814.54, unrealized_usd: 214, r: null };
const session = (symbol: string, changes = {}) => ({
  id: 1, symbol, status: "active" as const, revealed_through: "2026-03-10T14:00:00Z", behind_clock: false, has_open_trade: false, trades: 0, realized_usd: 0, position: null, ...changes,
});
const rowsOf = (sessions: ReturnType<typeof session>[], closes: Record<string, number | null> = {}) =>
  heldRows(portfolioRows({ sessions, candidates: Object.entries(closes).map(([symbol, prior_close]) => ({ symbol, prior_close })) as never })).map(dayPositionRow);

test("a held long reads last, day change vs the prior close, signed position, average price, value and P/L", () => {
  const [long] = rowsOf([session("SMCI", { has_open_trade: true, position: trade })], { SMCI: 810 });
  const cells = positionCells(long!);
  assert.deepEqual(cells.last, { text: "814.54", tone: null });
  assert.deepEqual(cells.change, { text: "+$4.54", tone: "up" });
  assert.deepEqual(cells.changePct, { text: "+0.56%", tone: "up" });
  assert.deepEqual(cells.position, { text: "100", tone: null });
  assert.deepEqual(cells.avg, { text: "812.40", tone: null });
  assert.deepEqual(cells.value, { text: "$81,454.00", tone: null });
  assert.deepEqual(cells.unrealized, { text: "+$214.00", tone: "up" });
  assert.deepEqual(Object.keys(cells), ["last", "change", "changePct", "position", "avg", "value", "unrealized"], "no realized or total column: the table holds open positions only");
});

test("a short is a negative position and a negative value; its P/L is its own, not the stock's", () => {
  const [short] = rowsOf([session("NVDA", { has_open_trade: true, position: { ...trade, side: "short", shares: 50, entry_price: 200, last_price: 190, unrealized_usd: 500 } })], { NVDA: 195 });
  const cells = positionCells(short!);
  assert.deepEqual([cells.position.text, cells.value.text], ["−50", "−$9,500.00"]);
  assert.deepEqual([cells.change, cells.unrealized], [{ text: "−$5.00", tone: "down" }, { text: "+$500.00", tone: "up" }], "the stock fell (red) while the short gained (green)");
});

test("a held name that also has a closed trade shows only its open P/L: the closed result is in Trades", () => {
  const [row] = rowsOf([session("SMCI", { has_open_trade: true, position: trade, trades: 1, realized_usd: -38 })]);
  assert.equal(positionCells(row!).unrealized.text, "+$214.00", "not +$176.00: the −$38.00 closed trade is not added in");
});

test("the Portfolio holds only what is held now: exited and untouched names are not rows", () => {
  const rows = rowsOf([
    session("GDX", { id: 1, has_open_trade: true, position: { ...trade, side: "short", shares: 40 } }),
    session("MUU", { id: 2, trades: 1, realized_usd: 120 }), // opened, closed at a gain
    session("COHR", { id: 3, trades: 2, realized_usd: -38 }), // opened, closed at a loss
    session("AXTI", { id: 4 }), // opened, never traded
  ]);
  assert.deepEqual(rows.map((row) => [row.symbol, positionCells(row).position.text]), [["GDX", "−40"]], "a short is negative shares; the three exited names are not listed");
  assert.deepEqual(rowsOf([session("MUU", { trades: 1, realized_usd: 120 })]), [], "nothing held: an empty table, not a row of dashes");
});

test("no prior close means no change: dashes, never a change from the entry price", () => {
  const [row] = rowsOf([session("SMCI", { has_open_trade: true, position: trade })]);
  const cells = positionCells(row!);
  assert.deepEqual([cells.change.text, cells.changePct.text], ["—", "—"]);
  assert.equal(cells.last.text, "814.54");
});

test("a day row carries the flags the status column shows", () => {
  const [row] = rowsOf([session("SMCI", { has_open_trade: true, position: { ...trade, stop_hit_at: "2026-03-10T14:21:00Z" }, behind_clock: true })]);
  assert.deepEqual([row!.behind, row!.stop], [true, "Stop crossed 10:21"]);
});

const hold = (changes: Partial<Hold> = {}): Hold => ({
  id: 7, symbol: "NVDA", side: "long", shares: 300, entry_day_no: 3, entry_weekday: "Wed", entry_price: 184.2, days_held: 2, stop_at_entry: null, stop_price: 182.5, stop_hit: "no",
  status: "open", exit_day_no: null, exit_price: null, exit_source: null, last_close: 187.4, price_basis: "prior_close", unrealized_usd: 960, pnl_usd: null, r: null, gap_usd: null,
  earnings: null, split_note: null, ...changes,
});

test("an open swing hold reads at its last close, with no change", () => {
  const row = swingPositionRow(hold());
  const cells = positionCells(row);
  assert.deepEqual([cells.last.text, cells.avg.text, cells.position.text, cells.value.text], ["187.40", "184.20", "300", "$56,220.00"]);
  assert.deepEqual([cells.change.text, cells.changePct.text], ["—", "—"]);
  assert.deepEqual(cells.unrealized, { text: "+$960.00", tone: "up" });
  assert.deepEqual([row.held, row.stop], ["Day 2 of hold", null]);
  assert.equal(swingPositionRow(hold({ stop_hit: "yes" })).stop, "Stop 182.50 crossed");
});

test("a swing hold with no price yet has no last, value or P/L", () => {
  const cells = positionCells(swingPositionRow(hold({ last_close: null, unrealized_usd: null })));
  assert.deepEqual([cells.last.text, cells.value.text, cells.unrealized.text], ["—", "—", "—"]);
});
