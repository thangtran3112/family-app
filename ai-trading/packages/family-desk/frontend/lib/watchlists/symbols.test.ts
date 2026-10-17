import assert from "node:assert/strict";
import test from "node:test";
import { canonicalWatchlistSymbol, marketSymbolForItem, watchlistItemDeletePath } from "./symbols.ts";

test("future identity keeps a root prefix while plain CL remains a stock symbol", () => {
  assert.equal(canonicalWatchlistSymbol(" es ", "future"), "/ES");
  assert.equal(canonicalWatchlistSymbol("/cl", "future"), "/CL");
  assert.equal(canonicalWatchlistSymbol(" cl ", "stock"), "CL");
  assert.throws(() => canonicalWatchlistSymbol("/ES", "stock"));
});

test("legacy future market identity canonicalizes without changing the stored delete key", () => {
  const storedFuture = "CL";
  const futureMarket = marketSymbolForItem(storedFuture, "future");
  assert.equal(futureMarket, "/CL");
  assert.equal(marketSymbolForItem("/ES", "future"), "/ES");
  assert.equal(marketSymbolForItem("CL", "stock"), "CL");
  assert.equal(watchlistItemDeletePath(8, storedFuture), "/api/desk/watchlists/8/items/CL");
  assert.notEqual(watchlistItemDeletePath(8, futureMarket!), "/api/desk/watchlists/8/items/CL");
});
