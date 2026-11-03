import assert from "node:assert/strict";
import test from "node:test";
import { PortfolioSchema, type PortfolioOrder, type PortfolioPosition } from "./portfolio.ts";
import { STALE_PRICE_S, heldForText, openPnl, orderRows, positionCells, positionRow, positionRows, positionsCountText } from "./positionTable.ts";

const position = (changes: Partial<PortfolioPosition> = {}): PortfolioPosition => ({
  session_id: 11, symbol: "SMCI", side: "long", shares: 100, avg_cost: 812.4, price: 814.54, price_at: "2026-03-10T13:40:00Z", price_age_s: 60,
  unrealized_usd: 214, entry_at: "2026-03-06T15:00:00Z", held_for_s: 3 * 86_400 + 4 * 3600, stop_price: null, stop_hit_at: null, ...changes,
});
const order = (changes: Partial<PortfolioOrder> = {}): PortfolioOrder => ({
  id: 5, session_id: 11, symbol: "SMCI", side: "sell", type: "stop", shares: 100, limit_price: null, stop_price: 790, status: "working", placed_at: "2026-03-06T15:05:00Z",
  triggered_at: null, closed_at: null, fill_price: null, mark_id: null, reason: null, tif: "gtc", expires_at: null, reduce_only: true, ...changes,
});

test("a held long reads side, shares, average cost, the price AT T, gain/loss and how long it has been held", () => {
  const cells = positionCells(positionRow(position()));
  assert.deepEqual(cells.side, { text: "Long", tone: null });
  assert.deepEqual(cells.shares, { text: "100", tone: null });
  assert.deepEqual(cells.avg, { text: "812.40", tone: null });
  assert.deepEqual(cells.price, { text: "814.54", tone: null });
  assert.deepEqual(cells.unrealized, { text: "+$214.00", tone: "up" });
  assert.deepEqual(cells.heldFor, { text: "3d 4h", tone: null });
  assert.deepEqual(Object.keys(cells), ["side", "shares", "avg", "price", "unrealized", "heldFor", "orders"], "open positions only: no realized or total column");
});

test("a short is negative shares and its gain/loss is its own, not the stock's", () => {
  const cells = positionCells(positionRow(position({ side: "short", shares: 50, avg_cost: 200, price: 205, unrealized_usd: -250 })));
  assert.deepEqual([cells.side.text, cells.shares.text], ["Short", "−50"]);
  assert.deepEqual(cells.unrealized, { text: "−$250.00", tone: "down" });
});

test("gain/loss is the payload's figure to the cent, and a flat one is muted", () => {
  assert.deepEqual(positionCells(positionRow(position({ unrealized_usd: 0 }))).unrealized, { text: "$0.00", tone: "flat" });
  assert.equal(openPnl([{ unrealized: 214 }, { unrealized: -250.1 }, { unrealized: 0.2 }]), -35.9);
});

test("held for is elapsed thread time: days and hours, hours and minutes, minutes, or under a minute", () => {
  assert.equal(heldForText(3 * 86_400 + 4 * 3600), "3d 4h");
  assert.equal(heldForText(2 * 86_400), "2d", "a zero unit is left out");
  assert.equal(heldForText(2 * 86_400 + 59 * 60), "2d", "minutes are dropped once days show");
  assert.equal(heldForText(4 * 3600 + 12 * 60), "4h 12m");
  assert.equal(heldForText(3600), "1h");
  assert.equal(heldForText(12 * 60), "12m");
  assert.equal(heldForText(59), "under a minute");
  assert.equal(heldForText(0), "under a minute");
});

test("an old price is flagged and a name that never had one says it is carried at cost; a fresh price says nothing", () => {
  assert.equal(positionRow(position()).priceNote, null);
  assert.equal(positionRow(position({ price_age_s: STALE_PRICE_S - 1 })).priceNote, null);
  assert.equal(positionRow(position({ price_age_s: 3 * 86_400 })).priceNote, "last price 3d old");
  assert.equal(positionRow(position({ price_at: null, price_age_s: null, price: 812.4 })).priceNote, "no price yet · carried at cost");
});

test("the stop line is an alert flag with its own date, never an exit", () => {
  assert.equal(positionRow(position()).stop, null);
  assert.equal(positionRow(position({ stop_price: 800, stop_hit_at: "2026-03-09T14:21:00Z" })).stop, "Stop crossed Mon 2026-03-09 · 10:21 AM ET");
});

test("working orders are counted on their name; filled and cancelled ones are not", () => {
  const orders = [order(), order({ id: 6, symbol: "NVDA" }), order({ id: 7, status: "cancelled" }), order({ id: 8, status: "filled" })];
  assert.equal(positionRow(position(), orders).orders, 1);
  assert.deepEqual(positionCells(positionRow(position(), orders)).orders, { text: "1", tone: null });
  assert.deepEqual(positionCells(positionRow(position(), [])).orders, { text: "—", tone: "flat" });
  assert.deepEqual(positionRows([position(), position({ session_id: 12, symbol: "NVDA" })], orders).map((row) => [row.symbol, row.orders]), [["SMCI", 1], ["NVDA", 1]]);
});

test("the order table shows type, size, price, time in force and a Day order's expiry", () => {
  const rows = orderRows([
    order(),
    order({ id: 6, side: "buy", type: "stop_limit", stop_price: 800, limit_price: 801, tif: "day", expires_at: "2026-03-10T00:00:00Z", reduce_only: false }),
    order({ id: 7, status: "filled" }),
  ]);
  assert.equal(rows.length, 2, "only working orders");
  assert.deepEqual(rows[0], { key: "5", symbol: "SMCI", kind: "Sell stop", shares: "100", price: "790.00", tif: "GTC", expires: "—", reduceOnly: true });
  assert.deepEqual([rows[1]!.kind, rows[1]!.price, rows[1]!.tif, rows[1]!.expires], ["Buy stop limit", "800.00 / 801.00", "Day", "until Mon 2026-03-09 · 8:00 PM ET"]);
});

test("counts read in words", () => {
  assert.deepEqual([0, 1, 3].map(positionsCountText), ["No open positions", "1 open position", "3 open positions"]);
});

test("the Portfolio payload parses with its schema, and an absent time-in-force reads as GTC", () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- an answer without the three order keys
  const { tif: _tif, expires_at: _expires, reduce_only: _reduce, ...bare } = order();
  const parsed = PortfolioSchema.parse({ thread_id: 1, as_of: "2026-03-10T13:41:00Z", positions: [position()], orders: [bare], account: null, label: "Simulated" });
  assert.equal(parsed.orders[0]!.tif, "gtc");
  assert.equal(parsed.orders[0]!.reduce_only, false);
  assert.equal(parsed.orders[0]!.expires_at, null);
});
