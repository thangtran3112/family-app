import assert from "node:assert/strict";
import test from "node:test";
import { WATCHLIST_CARD_TIMEFRAMES, selectCardTimeframe, technicalsTimeframe } from "./timeframes.ts";

test("selected timeframe callback preserves five choices and maps daily/weekly API values", () => {
  assert.deepEqual(WATCHLIST_CARD_TIMEFRAMES, ["5m", "15m", "1h", "1D", "1W"]);
  assert.equal(selectCardTimeframe("15m", "1D"), "1D");
  assert.equal(selectCardTimeframe("15m", "unsupported"), "15m");
  assert.equal(technicalsTimeframe("1D"), "1d");
  assert.equal(technicalsTimeframe("1W"), "1w");
});
