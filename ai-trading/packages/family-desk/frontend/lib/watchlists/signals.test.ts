import assert from "node:assert/strict";
import test from "node:test";
import { signalCountsBySymbol, signalsSinceEtStart } from "./signals.ts";

test("signal day starts at New York midnight across standard and daylight offsets", () => {
  assert.equal(signalsSinceEtStart(new Date("2026-01-15T18:00:00Z")), "2026-01-15T05:00:00.000Z");
  assert.equal(signalsSinceEtStart(new Date("2026-07-15T18:00:00Z")), "2026-07-15T04:00:00.000Z");
  assert.equal(signalsSinceEtStart(new Date("2026-10-16T03:30:00Z")), "2026-10-15T04:00:00.000Z");
});

test("signal counts preserve stock/future identity and real zero remains a caller-visible zero", () => {
  assert.deepEqual(signalCountsBySymbol([
    { symbol: "AAPL" }, { symbol: "/ES" }, { symbol: "AAPL" }, { symbol: "CL" }, { symbol: "/CL" },
  ]), {
    AAPL: 2,
    "/ES": 1,
    CL: 1,
    "/CL": 1,
  });
});
