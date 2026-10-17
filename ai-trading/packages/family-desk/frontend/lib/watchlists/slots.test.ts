import assert from "node:assert/strict";
import test from "node:test";
import { slotsText } from "./slots.ts";

test("slot meter formats server-reported usage without replacing zero or missing values", () => {
  assert.equal(slotsText({ used: 41, max: 70 }), "41 of 70");
  assert.equal(slotsText({ used: 0, max: 70 }), "0 of 70");
  assert.equal(slotsText(undefined), "not available");
});
