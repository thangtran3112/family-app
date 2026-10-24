import assert from "node:assert/strict";
import test from "node:test";
import { viewFromHash } from "./useHash.ts";

test("the hash picks the technicals view and defaults to the chart", () => {
  assert.equal(viewFromHash("summary"), "summary");
  assert.equal(viewFromHash("chart"), "chart");
  assert.equal(viewFromHash(""), "chart");
  assert.equal(viewFromHash("nonsense"), "chart");
});
