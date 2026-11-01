import assert from "node:assert/strict";
import test from "node:test";
import { alertNewHref, filterHref, strategyHref } from "./hrefs.ts";

test("alertNewHref: each starting point has its own query, and a symbol is encoded", () => {
  assert.equal(alertNewHref(), "/alerts/new");
  assert.equal(alertNewHref({ symbol: "AAPL" }), "/alerts/new?source=symbol:AAPL");
  assert.equal(alertNewHref({ symbol: "BRK.B" }), "/alerts/new?source=symbol:BRK.B");
  assert.equal(alertNewHref({ symbol: "A&B C" }), "/alerts/new?source=symbol:A%26B%20C");
  assert.equal(alertNewHref({ watchlist: 7 }), "/alerts/new?source=watchlist:7");
  assert.equal(alertNewHref({ filter: 3 }), "/alerts/new?from=filter:3");
  assert.equal(alertNewHref({ edit: 12 }), "/alerts/new?edit=12");
});

test("filterHref and strategyHref open the editor and the builder on an id", () => {
  assert.equal(filterHref(5), "/screener/filters?id=5");
  assert.equal(strategyHref(9), "/strategies?id=9");
});
