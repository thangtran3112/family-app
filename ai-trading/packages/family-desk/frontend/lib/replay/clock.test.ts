import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SPEED, SPEEDS, isSpeed } from "./clock.ts";

test("the speeds are 1x 2x 5x 10x, and 1x is the default", () => {
  assert.deepEqual([...SPEEDS], [1, 2, 5, 10]);
  assert.equal(DEFAULT_SPEED, 1);
  assert.equal(isSpeed(5), true);
  assert.equal(isSpeed(3), false);
});
