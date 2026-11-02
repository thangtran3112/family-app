import assert from "node:assert/strict";
import test from "node:test";
import { orderNames } from "./orderView.ts";

const list = {
  candidates: [{ symbol: "TSLA" }, { symbol: "NVDA" }, { symbol: "AAPL" }],
  sessions: [
    { symbol: "NVDA", has_open_trade: true },
    { symbol: "AAPL", has_open_trade: false },
  ],
};

test("every name shows in list order, with a status on each row: not opened yet, opened, or an open trade", () => {
  assert.deepEqual(orderNames(list, ""), [
    { symbol: "TSLA", status: "Not opened yet" },
    { symbol: "NVDA", status: "Open trade" },
    { symbol: "AAPL", status: "Opened" },
  ]);
});

test("the find box matches part of a symbol, ignoring case and spaces", () => {
  assert.deepEqual(orderNames(list, " ts ").map((row) => row.symbol), ["TSLA"]);
  assert.deepEqual(orderNames(list, "a").map((row) => row.symbol), ["TSLA", "NVDA", "AAPL"]);
  assert.deepEqual(orderNames(list, "zzz"), []);
});
