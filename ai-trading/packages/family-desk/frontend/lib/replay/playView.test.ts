import assert from "node:assert/strict";
import test from "node:test";
import { exitKindFor } from "./playView.ts";

test("closing a long sells it and closing a short buys it back", () => {
  assert.equal(exitKindFor("long"), "long_exit");
  assert.equal(exitKindFor("short"), "short_exit");
});
