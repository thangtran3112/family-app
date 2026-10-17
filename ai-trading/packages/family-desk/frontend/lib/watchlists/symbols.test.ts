import assert from "node:assert/strict";
import test from "node:test";
import { canonicalWatchlistSymbol } from "./symbols.ts";

test("future identity keeps a root prefix while plain CL remains a stock symbol", () => {
  assert.equal(canonicalWatchlistSymbol(" es ", "future"), "/ES");
  assert.equal(canonicalWatchlistSymbol("/cl", "future"), "/CL");
  assert.equal(canonicalWatchlistSymbol(" cl ", "stock"), "CL");
  assert.throws(() => canonicalWatchlistSymbol("/ES", "stock"));
});
