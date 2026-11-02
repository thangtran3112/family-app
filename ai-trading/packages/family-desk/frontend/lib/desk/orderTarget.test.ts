import assert from "node:assert/strict";
import test from "node:test";
import { isOrderTarget } from "../../e2e/desk/orderTarget.ts";

// D-190: the Desk's screen guard learns the Order tab's own picker address and nothing else.
test("the Order tab's picker address is not an order target", () => {
  for (const href of ["/practice/order?thread=1", "/practice/order?thread=42"]) assert.equal(isOrderTarget(href), false, href);
});

test("ticket-shaped and broker addresses stay order targets", () => {
  for (const href of [
    "/practice/order?thread=1&side=buy",
    "/practice/order?thread=abc",
    "/practice/order?id=1",
    "/practice/order?",
    "/practice/order/1",
    "/orders",
    "/orders/7",
    "/positions",
    "/trade",
    "/trading",
    "/broker",
    "/paper",
    "/backtests",
    "/api/desk/replay/sessions/1/orders",
  ]) {
    assert.equal(isOrderTarget(href), true, href);
  }
});

test("a screen address with no order in it is not a target", () => {
  for (const href of ["/practice", "/practice/thread?id=1", "/practice/replay?id=3", "/screener?filter=1"]) assert.equal(isOrderTarget(href), false, href);
});
