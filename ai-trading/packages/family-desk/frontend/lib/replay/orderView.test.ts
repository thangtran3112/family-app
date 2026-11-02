import assert from "node:assert/strict";
import test from "node:test";
import { heldBlocked, heldHref, heldWhere } from "./orderView.ts";

test("a name open in another thread's day points to the day that ends it, and the refusal names where", () => {
  const held = { session_id: 9, symbol: "TSLA", day_list_id: 4, thread_id: 2, thread_name: "Thread 2" };
  assert.equal(heldWhere(held), "Thread 2");
  assert.equal(heldHref(held), "/practice/day?id=4");
  assert.equal(heldBlocked(held), "TSLA is open in Thread 2 · end that day first, then open it here");
});

test("a standalone session has no day to end: it points to its own page", () => {
  const held = { session_id: 9, symbol: "TSLA", day_list_id: null, thread_id: null, thread_name: null };
  assert.equal(heldWhere(held), "a standalone session");
  assert.equal(heldHref(held), "/practice/replay?id=9");
});
