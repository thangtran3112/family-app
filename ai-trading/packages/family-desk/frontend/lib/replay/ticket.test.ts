import assert from "node:assert/strict";
import test from "node:test";
import { buildTicket, initialTicket, orderLine, orderStatusText, ticketSummary, TICKET_TYPES, typeOption, type TicketDraft } from "./ticket.ts";
import type { PracticeOrder } from "./schemas.ts";

const base: TicketDraft = { side: "buy", type: "market", shares: "100", limitPrice: "", stopPrice: "" };
const order = (changes: Partial<PracticeOrder> = {}): PracticeOrder => ({
  id: 1, side: "buy", type: "limit", shares: 10, limit_price: 49.5, stop_price: null, status: "working",
  placed_at: "2026-09-28T13:35:00Z", triggered_at: null, closed_at: null, fill_price: null, mark_id: null, reason: null, ...changes,
});

test("the ticket lists Market, Limit, Stop, Stop-limit and Bracket, and shows exactly the price fields each type needs", () => {
  assert.deepEqual(TICKET_TYPES.map((option) => option.label), ["Market", "Limit", "Stop", "Stop-limit", "Bracket"]);
  assert.deepEqual(TICKET_TYPES.map((option) => [option.value, option.limit, option.stop]), [
    ["market", false, false],
    ["limit", true, false],
    ["stop", false, true],
    ["stop_limit", true, true],
    ["bracket", false, true],
  ]);
  assert.deepEqual(TICKET_TYPES.filter((option) => option.unavailable).map((option) => option.value), ["bracket"]);
});

test("a market ticket is an entry mark with the quantity and no stop", () => {
  for (const [side, kind] of [["buy", "long_entry"], ["sell", "short_entry"]] as const) {
    const built = buildTicket({ ...base, side });
    assert.ok(built.ok && built.action.kind === "mark");
    assert.deepEqual(built.action.mark, { schemaVersion: 1, kind, shares: 100 });
  }
});

test("an entry needs no stop price, and a quantity over 10,000 is not refused by the ticket", () => {
  const built = buildTicket({ ...base, shares: "25000", stopPrice: "" });
  assert.ok(built.ok && built.action.kind === "mark" && built.action.mark.kind === "long_entry" && built.action.mark.shares === 25000);
  assert.equal("stopPrice" in (built.ok && built.action.kind === "mark" ? built.action.mark : {}), false);
});

test("limit, stop and stop-limit tickets are orders that carry only the prices their type takes", () => {
  const limit = buildTicket({ ...base, type: "limit", limitPrice: "49.5", stopPrice: "ignored" });
  assert.deepEqual(limit.ok && limit.action, { kind: "order", order: { side: "buy", orderType: "limit", shares: 100, limitPrice: 49.5 } });
  const stop = buildTicket({ ...base, side: "sell", type: "stop", stopPrice: "48", limitPrice: "ignored" });
  assert.deepEqual(stop.ok && stop.action, { kind: "order", order: { side: "sell", orderType: "stop", shares: 100, stopPrice: 48 } });
  const both = buildTicket({ ...base, type: "stop_limit", stopPrice: "51", limitPrice: "51.2" });
  assert.deepEqual(both.ok && both.action, { kind: "order", order: { side: "buy", orderType: "stop_limit", shares: 100, limitPrice: 51.2, stopPrice: 51 } });
});

test("the checks are the broker's own and name the field", () => {
  for (const shares of ["", "0", "1.5", "-3", "abc", " "]) {
    const built = buildTicket({ ...base, shares });
    assert.ok(!built.ok && built.field === "shares" && built.message === "Quantity: a whole number of 1 or more", shares);
  }
  for (const limitPrice of ["", "0", "-1", "abc", "Infinity"]) {
    const built = buildTicket({ ...base, type: "limit", limitPrice });
    assert.ok(!built.ok && built.field === "limitPrice" && built.message === "Limit price: a number above 0", limitPrice);
  }
  const stop = buildTicket({ ...base, type: "stop_limit", limitPrice: "50", stopPrice: "" });
  assert.ok(!stop.ok && stop.field === "stopPrice");
});

test("a bracket ticket is named and refused rather than pretended", () => {
  assert.equal(typeOption("bracket").unavailable, "Bracket · not simulated yet");
  const built = buildTicket({ ...base, type: "bracket", stopPrice: "48", limitPrice: "55" });
  assert.deepEqual(built, { ok: false, field: "type", message: "Bracket · not simulated yet" });
});

test("the summary and the order lines read like a broker's", () => {
  assert.equal(initialTicket(100).shares, "100");
  assert.equal(ticketSummary(base, "AAPL"), "Buy 100 AAPL · Market");
  assert.equal(ticketSummary({ ...base, side: "sell", type: "stop_limit", stopPrice: "51", limitPrice: "51.2", shares: "2500" }, "AAPL"), "Sell 2,500 AAPL · Stop-limit · stop 51.00 · limit 51.20");
  assert.equal(ticketSummary({ ...base, type: "limit", limitPrice: "" }, "AAPL"), "Buy 100 AAPL · Limit · limit —");
  assert.equal(orderLine(order()), "Buy 10 · Limit 49.50");
  assert.equal(orderLine(order({ side: "sell", type: "stop_limit", stop_price: 51, limit_price: 51.2 })), "Sell 10 · Stop-limit 51.00 / 51.20");
  assert.equal(orderStatusText(order()), "Working");
  assert.equal(orderStatusText(order({ triggered_at: "2026-09-28T14:21:00Z" })), "Working · stop triggered");
  assert.equal(orderStatusText(order({ status: "filled", fill_price: 49.5 })), "Filled at 49.50");
  assert.equal(orderStatusText(order({ status: "cancelled", reason: "Not enough practice cash · $450 free" })), "Cancelled · Not enough practice cash · $450 free");
  assert.equal(orderStatusText(order({ status: "cancelled" })), "Cancelled");
});
