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

test("every name shows in list order, with an open trade and an opened name marked", () => {
  assert.deepEqual(orderNames(list, ""), [
    { symbol: "TSLA", status: "" },
    { symbol: "NVDA", status: "Open trade" },
    { symbol: "AAPL", status: "Opened" },
  ]);
});

test("the find box matches part of a symbol, ignoring case and spaces", () => {
  assert.deepEqual(orderNames(list, " ts ").map((row) => row.symbol), ["TSLA"]);
  assert.deepEqual(orderNames(list, "a").map((row) => row.symbol), ["TSLA", "NVDA", "AAPL"]);
  assert.deepEqual(orderNames(list, "zzz"), []);
});
