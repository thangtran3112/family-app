import assert from "node:assert/strict";
import test from "node:test";
import { cardBackValue } from "./cardBack.ts";

test("missing card-back values are unavailable while real zero stays zero", () => {
  assert.equal(cardBackValue(undefined), "not available");
  assert.equal(cardBackValue(null), "not available");
  assert.equal(cardBackValue(0), "0");
});
