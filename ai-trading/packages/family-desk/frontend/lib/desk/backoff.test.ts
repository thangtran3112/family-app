import assert from "node:assert/strict";
import test from "node:test";
import { backoffMs, BACKOFF_CAP_MS } from "./backoff.ts";

test("a healthy poll keeps its rhythm; each failure doubles the wait up to the cap", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((failures) => backoffMs(2000, failures)), [2000, 4000, 8000, 16000, 32000, BACKOFF_CAP_MS]);
  assert.equal(backoffMs(2000, 500), BACKOFF_CAP_MS);
  assert.equal(backoffMs(2000, -1), 2000);
});
