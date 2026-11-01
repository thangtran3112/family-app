import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chartOrderDraft, chartOrderLabel, chartOrderType, LEVEL_HIT_PX, nearestLevel, roundToCents } from "./chartOrder.ts";
import { buildTicket, initialTicket } from "./ticket.ts";

test("a click's price is whole cents", () => {
  assert.equal(roundToCents(184.2049), 184.2);
  assert.equal(roundToCents(184.206), 184.21);
  assert.equal(roundToCents(0.1 + 0.2), 0.3);
});

test("a buy below the last print is a limit, above it a stop; a sell mirrors it; at the print it is market", () => {
  assert.equal(chartOrderType("buy", 184, 184.5), "limit");
  assert.equal(chartOrderType("buy", 185, 184.5), "stop");
  assert.equal(chartOrderType("sell", 185, 184.5), "limit");
  assert.equal(chartOrderType("sell", 184, 184.5), "stop");
  assert.equal(chartOrderType("buy", 184.5, 184.5), "market");
  assert.equal(chartOrderType("sell", 184.5, 184.5), "market");
  assert.equal(chartOrderType("buy", 184.5, 184.503), "market", "the same cent is the last print");
});

test("the draft keeps the ticket's quantity and sets only the one price its type takes", () => {
  const ticket = { ...initialTicket(25), type: "stop_limit" as const, limitPrice: "1", stopPrice: "2" };
  assert.deepEqual(chartOrderDraft(ticket, "buy", 184, 184.5), { side: "buy", type: "limit", shares: "25", limitPrice: "184.00", stopPrice: "" });
  assert.deepEqual(chartOrderDraft(ticket, "buy", 185, 184.5), { side: "buy", type: "stop", shares: "25", limitPrice: "", stopPrice: "185.00" });
  assert.deepEqual(chartOrderDraft(ticket, "sell", 184.5, 184.5), { side: "sell", type: "market", shares: "25", limitPrice: "", stopPrice: "" });
});

test("a chart draft builds through the ordinary ticket: a limit and a stop become orders, market an entry mark; no cash rule is bypassed here", () => {
  const ticket = initialTicket(10);
  const limit = buildTicket(chartOrderDraft(ticket, "buy", 184, 184.5));
  assert.ok(limit.ok && limit.action.kind === "order");
  assert.deepEqual(limit.action.kind === "order" && limit.action.order, { side: "buy", orderType: "limit", shares: 10, limitPrice: 184 });
  const stop = buildTicket(chartOrderDraft(ticket, "sell", 184, 184.5));
  assert.ok(stop.ok && stop.action.kind === "order");
  assert.deepEqual(stop.action.kind === "order" && stop.action.order, { side: "sell", orderType: "stop", shares: 10, stopPrice: 184 });
  const market = buildTicket(chartOrderDraft(ticket, "buy", 184.5, 184.5));
  assert.ok(market.ok && market.action.kind === "mark");
  const bad = buildTicket(chartOrderDraft({ ...ticket, shares: "abc" }, "buy", 184, 184.5));
  assert.equal(bad.ok, false, "a bad quantity is the ticket's own refusal");
});

test("the button names the order it places", () => {
  assert.equal(chartOrderLabel("buy", 184, 184.5), "Buy limit 184.00");
  assert.equal(chartOrderLabel("sell", 184, 184.5), "Sell stop 184.00");
  assert.equal(chartOrderLabel("buy", 184.5, 184.5), "Buy market");
});

test("the nearest level within the hit distance is named, and none beyond it", () => {
  const levels = [{ label: "Session high", price: 190 }, { label: "Session low", price: 180 }, { label: "Hidden", price: null }];
  const toY = (price: number) => 1000 - price * 4; // 4 px per dollar, up is smaller y
  assert.equal(nearestLevel(levels, toY(190) + 2, toY)?.label, "Session high");
  assert.equal(nearestLevel(levels, toY(180) - LEVEL_HIT_PX, toY)?.label, "Session low");
  assert.equal(nearestLevel(levels, toY(185), toY), null, "midway between two lines");
  assert.equal(nearestLevel(levels, toY(190) + LEVEL_HIT_PX + 1, toY), null);
  assert.equal(nearestLevel(levels, 0, () => null), null, "a price off the scale has no pixel");
  assert.equal(nearestLevel([{ label: "a", price: 100 }, { label: "b", price: 100.5 }], toY(100.4), toY)?.label, "b", "the closer of two");
});

test("the live replay chart draws none of her marks: no entry, exit or stop arrow or label (the Marks list and the journal chart keep them)", () => {
  const source = readFileSync(new URL("../../components/practice/replay/ReplayChart.tsx", import.meta.url), "utf8");
  for (const word of ["practiceMarkers", "markLabel", "practice_long", "practice_short", "practice_exit"]) assert.equal(source.includes(word), false, word);
});
