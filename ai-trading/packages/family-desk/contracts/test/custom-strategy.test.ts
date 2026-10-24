import assert from "node:assert/strict";
import { test } from "node:test";
import { CUSTOM_RULES, CustomStrategySchema } from "../src/custom-strategy.ts";
import { jsonEqual } from "../src/json-pointer.ts";
import { jsonFiles } from "./fixtures.ts";

const validStrategies = jsonFiles("fixtures/custom-strategy/valid");
const invalidStrategies = jsonFiles("fixtures/custom-strategy/invalid");

test("fixture folders are not empty", () => {
  assert.ok(validStrategies.length >= 6 && invalidStrategies.length >= 20);
});

for (const [name, strategy] of validStrategies) {
  test(`accepts ${name}`, () => {
    const result = CustomStrategySchema.safeParse(strategy);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
    assert.ok(jsonEqual(result.data, strategy));
  });
}

for (const [name, strategy] of invalidStrategies) {
  test(`rejects ${name}`, () => {
    assert.equal(CustomStrategySchema.safeParse(strategy).success, false);
  });
}

test("every CUSTOM_RULES id is the prefix of an invalid fixture name", () => {
  for (const rule of CUSTOM_RULES) {
    assert.ok(
      invalidStrategies.some(([name]) => name.startsWith(rule.id)),
      `no invalid fixture named after ${rule.id}`,
    );
  }
});

// A rule fixture must fail on its own rule, not on a shape error that skips the superRefine.
for (const rule of CUSTOM_RULES) {
  test(`${rule.id} fixtures fail on that rule`, () => {
    for (const [name, strategy] of invalidStrategies.filter(([file]) => file.startsWith(rule.id))) {
      const result = CustomStrategySchema.safeParse(strategy);
      const issues = result.error?.issues ?? [];
      const rules: unknown[] = issues.map((issue) => ("params" in issue ? issue.params?.rule : undefined));
      assert.ok(rules.includes(rule.id), `${name} is not rejected by ${rule.id}: ${JSON.stringify(issues)}`);
    }
  });
}
