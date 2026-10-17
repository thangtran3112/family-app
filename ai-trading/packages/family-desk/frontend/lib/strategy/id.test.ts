import assert from "node:assert/strict";
import test from "node:test";
import { positiveStrategyId } from "./id.ts";

test("only positive safe decimal query IDs select strategy detail", () => {
  assert.equal(positiveStrategyId("42"), 42);
  assert.equal(positiveStrategyId("0007"), 7);
  for (const raw of [null, "", "0", "-1", "1.5", "1e2", "0x10", "abc", "9007199254740992"]) {
    assert.equal(positiveStrategyId(raw), null, String(raw));
  }
});
