import assert from "node:assert/strict";
import test from "node:test";
import { qualityLabel, type Quality } from "./labels.ts";

const qualities: Quality[] = ["realtime", "delayed-15m", "eod", "fallback", "unavailable"];

test("qualityLabel preserves each supported quality string", () => {
  assert.deepEqual(qualities.map(qualityLabel), ["realtime", "delayed-15m", "eod", "fallback", "unavailable"]);
});
