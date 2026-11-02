import assert from "node:assert/strict";
import test from "node:test";
import { heldBlocked, heldHref, orderNames } from "./orderView.ts";

const list = {
  candidates: [{ symbol: "TSLA" }, { symbol: "NVDA" }, { symbol: "AAPL" }],
  sessions: [
    { symbol: "NVDA", has_open_trade: true },
    { symbol: "AAPL", has_open_trade: false },
  ],
  held_elsewhere: [] as { session_id: number; symbol: string; day_list_id: number | null; thread_id: number | null; thread_name: string | null }[],
};

test("every name shows in list order, with a status on each row: not opened yet, opened, or an open trade", () => {
  assert.deepEqual(orderNames(list, ""), [
    { symbol: "TSLA", status: "Not opened yet", held: null },
    { symbol: "NVDA", status: "Open trade", held: null },
    { symbol: "AAPL", status: "Opened", held: null },
  ]);
});

test("a name open in another thread's day reads open there, not 'Not opened yet', and points to the day that ends it", () => {
  const held = { session_id: 9, symbol: "TSLA", day_list_id: 4, thread_id: 2, thread_name: "Thread 2" };
  const [tsla, nvda] = orderNames({ ...list, held_elsewhere: [held] }, "");
  assert.deepEqual(tsla, { symbol: "TSLA", status: "Open in Thread 2", held });
  assert.equal(nvda?.held, null, "only the held name changes");
  assert.equal(heldHref(held), "/practice/day?id=4");
  assert.equal(heldBlocked(held), "TSLA is open in Thread 2 · end that day first, then open it here");
});

test("a standalone session has no day to end: it points to its own page", () => {
  const held = { session_id: 9, symbol: "TSLA", day_list_id: null, thread_id: null, thread_name: null };
  assert.equal(orderNames({ ...list, held_elsewhere: [held] }, "")[0]?.status, "Open in a standalone session");
  assert.equal(heldHref(held), "/practice/replay?id=9");
});

test("the find box matches part of a symbol, ignoring case and spaces", () => {
  assert.deepEqual(orderNames(list, " ts ").map((row) => row.symbol), ["TSLA"]);
  assert.deepEqual(orderNames(list, "a").map((row) => row.symbol), ["TSLA", "NVDA", "AAPL"]);
  assert.deepEqual(orderNames(list, "zzz"), []);
});
