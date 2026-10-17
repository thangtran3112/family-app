import assert from "node:assert/strict";
import test from "node:test";
import { shouldStartTechnicalLoad, loadTechnicalData } from "./load.ts";

test("same symbol and timeframe are a no-op, changed selection starts a load", () => {
  assert.equal(shouldStartTechnicalLoad({ symbol: "AAPL", timeframe: "15m" }, { symbol: "AAPL", timeframe: "15m" }), false);
  assert.equal(shouldStartTechnicalLoad({ symbol: "AAPL", timeframe: "15m" }, { symbol: "AAPL", timeframe: "1d" }), true);
  assert.equal(shouldStartTechnicalLoad({ symbol: "AAPL", timeframe: "15m" }, { symbol: "/ES", timeframe: "15m" }), true);
});

test("technical data loader URI-encodes future roots and keeps API intervals lowercase", async () => {
  const requests: string[] = [];
  const bars = { symbol: "/ES", interval: "1d" };
  const technicals = { symbol: "/ES", timeframe: "1d" };
  const result = await loadTechnicalData("/ES", "1d", {
    bars: async (path) => { requests.push(path); return bars; },
    technicals: async (path) => { requests.push(path); return technicals; },
  });

  assert.deepEqual(requests, [
    "/api/desk/bars/%2FES?interval=1d&days=3650&session=regular",
    "/api/desk/technicals/%2FES?timeframe=1d&days=3650",
  ]);
  assert.deepEqual(result, { bars, technicals });
});
