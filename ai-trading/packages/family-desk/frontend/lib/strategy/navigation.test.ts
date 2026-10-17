import assert from "node:assert/strict";
import test from "node:test";
import { navigateToStrategyBuilder } from "./navigation.ts";

test("successful template navigation uses full-document location assignment", () => {
  const assigned: string[] = [];
  navigateToStrategyBuilder(42, { assign: (url) => assigned.push(String(url)) });
  assert.deepEqual(assigned, ["/strategies?id=42"]);
});
