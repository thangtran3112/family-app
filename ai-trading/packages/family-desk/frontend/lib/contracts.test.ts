import assert from "node:assert/strict";
import test from "node:test";
import { StrategySpecV1Schema } from "@ai-trading/contracts";

test("the linked contracts package parses a real minimal strategy spec", () => {
  const spec = {
    schemaVersion: 1,
    name: "Contract smoke",
    watch: {
      universe: { symbols: ["AAPL"] },
      session: "regular",
      runOn: "daily_close",
    },
    when: { op: "time_between", start: "09:30", end: "16:00" },
    then: { alert: { channels: ["inbox"] } },
  };

  assert.deepEqual(StrategySpecV1Schema.parse(spec), spec);
});
