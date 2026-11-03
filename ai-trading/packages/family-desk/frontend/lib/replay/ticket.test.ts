import assert from "node:assert/strict";
import test from "node:test";
import { SHARES_TOO_BIG } from "./markInput.ts";
import { buildTicket, buyingPowerMessage, initialTicket, orderLine, orderStatusText, ticketSummary, TICKET_TYPES, typeOption, type PowerBasis, type TicketDraft } from "./ticket.ts";
import type { PracticeOrder } from "./schemas.ts";

const base: TicketDraft = { side: "buy", type: "market", shares: "100", limitPrice: "", stopPrice: "", tif: "gtc" };
const order = (changes: Partial<PracticeOrder> = {}): PracticeOrder => ({
  id: 1, side: "buy", type: "limit", shares: 10, limit_price: 49.5, stop_price: null, status: "working",
  placed_at: "2026-09-28T13:35:00Z", triggered_at: null, closed_at: null, fill_price: null, mark_id: null, reason: null,
  tif: "gtc", expires_at: null, reduce_only: false, ...changes,
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
  assert.deepEqual(limit.ok && limit.action, { kind: "order", order: { side: "buy", orderType: "limit", shares: 100, limitPrice: 49.5, timeInForce: "gtc" } });
  const stop = buildTicket({ ...base, side: "sell", type: "stop", stopPrice: "48", limitPrice: "ignored" });
  assert.deepEqual(stop.ok && stop.action, { kind: "order", order: { side: "sell", orderType: "stop", shares: 100, stopPrice: 48, timeInForce: "gtc" } });
  const both = buildTicket({ ...base, type: "stop_limit", stopPrice: "51", limitPrice: "51.2" });
  assert.deepEqual(both.ok && both.action, { kind: "order", order: { side: "buy", orderType: "stop_limit", shares: 100, limitPrice: 51.2, stopPrice: 51, timeInForce: "gtc" } });
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
  assert.equal(ticketSummary({ ...base, side: "sell", type: "stop_limit", stopPrice: "51", limitPrice: "51.2", shares: "2500" }, "AAPL"), "Sell 2,500 AAPL · Stop-limit · stop 51.00 · limit 51.20 · GTC");
  assert.equal(ticketSummary({ ...base, type: "limit", limitPrice: "", tif: "day" }, "AAPL"), "Buy 100 AAPL · Limit · limit — · Day");
  assert.equal(orderLine(order()), "Buy 10 · Limit 49.50 · GTC");
  assert.equal(orderLine(order({ side: "sell", type: "stop_limit", stop_price: 51, limit_price: 51.2, tif: "day" })), "Sell 10 · Stop-limit 51.00 / 51.20 · Day");
  assert.equal(orderStatusText(order()), "Working");
  assert.equal(orderStatusText(order({ triggered_at: "2026-09-28T14:21:00Z" })), "Working · stop triggered");
  assert.equal(orderStatusText(order({ tif: "day", expires_at: "2026-09-29T00:00:00Z" })), "Working · lapses Mon 2026-09-28 · 8:00 PM ET", "a Day order says when it lapses (the 8:00 PM ET extended close)");
  assert.equal(orderStatusText(order({ reduce_only: true })), "Working · reduce only");
  assert.equal(orderStatusText(order({ status: "cancelled", tif: "day", expires_at: "2026-09-29T00:00:00Z", reason: "Expired" })), "Cancelled · Expired");
  assert.equal(orderStatusText(order({ status: "filled", fill_price: 49.5 })), "Filled at 49.50");
  assert.equal(orderStatusText(order({ status: "cancelled", reason: "Not enough practice cash · $450 free" })), "Cancelled · Not enough practice cash · $450 free");
  assert.equal(orderStatusText(order({ status: "cancelled" })), "Cancelled");
});

test("limit and stop prices are plain decimals, and a quantity over the column names its top", () => {
  for (const limitPrice of ["0x10", "1e2", "Infinity"]) {
    const built = buildTicket({ ...base, type: "limit", limitPrice });
    assert.ok(!built.ok && built.field === "limitPrice", limitPrice);
  }
  assert.ok(buildTicket({ ...base, type: "limit", limitPrice: "49.50" }).ok);
  const big = buildTicket({ ...base, type: "limit", limitPrice: "49.5", shares: "2147483648" });
  assert.ok(!big.ok && big.field === "shares" && big.message === SHARES_TOO_BIG);
});

// -- buying power: the one size rule, said in the ticket before anything is sent ------------------------------------------

const day: PowerBasis = { balance: 50_000, trade: null, last: 11.98 };

test("an order that costs more than the balance is refused with its cost and the buying power, and one that fits is not", () => {
  // 5,000 CNH at 11.98 is $59,900 against $50,000
  assert.equal(buyingPowerMessage({ ...base, shares: "5000" }, day), "Exceeds buying power · this order costs $59,900, buying power is $50,000");
  assert.equal(buyingPowerMessage({ ...base, shares: "4000" }, day), null); // $47,920
  assert.equal(buyingPowerMessage({ ...base, shares: "5000", side: "sell" }, day), "Exceeds buying power · this order costs $59,900, buying power is $50,000"); // a short is cash-secured the same
});

test("a limit costs its limit, a stop its trigger, and a draft without its price says nothing yet", () => {
  assert.equal(buyingPowerMessage({ ...base, type: "limit", shares: "1000", limitPrice: "60" }, day), "Exceeds buying power · this order costs $60,000, buying power is $50,000");
  assert.equal(buyingPowerMessage({ ...base, type: "limit", shares: "1000", limitPrice: "49" }, day), null);
  assert.equal(buyingPowerMessage({ ...base, type: "stop", shares: "1000", stopPrice: "50.01" }, day), "Exceeds buying power · this order costs $50,010, buying power is $50,000");
  assert.equal(buyingPowerMessage({ ...base, type: "stop_limit", shares: "1000", stopPrice: "99", limitPrice: "50" }, day), null); // the limit prices it, as the server does
  assert.equal(buyingPowerMessage({ ...base, type: "limit", shares: "1000" }, day), null);
  assert.equal(buyingPowerMessage({ ...base, shares: "5000" }, { ...day, last: null }), null); // no print yet
  assert.equal(buyingPowerMessage({ ...base, shares: "abc" }, day), null); // the field's own message, not this one
  assert.equal(buyingPowerMessage({ ...base, shares: "5000" }, null), null); // no thread: the server's own account decides
});

test("there is no share cap: the cost to the cent is the only limit, and an exact fit is taken", () => {
  assert.equal(buyingPowerMessage({ ...base, shares: "50000" }, { ...day, last: 1 }), null); // exactly $50,000
  assert.equal(buyingPowerMessage({ ...base, shares: "50001" }, { ...day, last: 1 }), "Exceeds buying power · this order costs $50,001, buying power is $50,000");
  assert.equal(buyingPowerMessage({ ...base, shares: "46" }, { ...day, balance: 450.6, last: 10 }), "Exceeds buying power · this order costs $460, buying power is $450"); // free cash reads rounded down, as the server says it
});

test("shares that close the position need no cash; a flip pays only for the shares it opens, with the closed position's cash back", () => {
  const long100 = { side: "long", shares: 100, entry_price: 100 } as const;
  const held: PowerBasis = { balance: 40_000, trade: long100, last: 110 }; // day: $10,000 of the balance is this position
  assert.equal(buyingPowerMessage({ ...base, side: "sell", shares: "100" }, held), null); // exit
  assert.equal(buyingPowerMessage({ ...base, side: "sell", shares: "300" }, held), null); // flip: opens 200 short at 110 = $22,000; free is 40,000 plus the 1,000 gain
  assert.equal(buyingPowerMessage({ ...base, side: "sell", shares: "400" }, held), null); // opens 300 at 110 = $33,000, fits
  assert.equal(buyingPowerMessage({ ...base, side: "sell", shares: "500" }, held), "Exceeds buying power · this order costs $44,000, buying power is $41,000"); // opens 400
});

