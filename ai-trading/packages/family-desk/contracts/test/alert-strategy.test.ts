import assert from "node:assert/strict";
import { test } from "node:test";
import { ALERT_RULES, AlertStrategySchema } from "../src/alert-strategy.ts";
import { jsonEqual } from "../src/json-pointer.ts";
import { jsonFiles } from "./fixtures.ts";

const validAlerts = jsonFiles("fixtures/alert-strategy/valid");
const invalidAlerts = jsonFiles("fixtures/alert-strategy/invalid");

test("fixture folders are not empty", () => {
  assert.ok(validAlerts.length >= 8 && invalidAlerts.length >= 20);
});

for (const [name, alert] of validAlerts) {
  test(`accepts ${name}`, () => {
    const result = AlertStrategySchema.safeParse(alert);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
    assert.ok(jsonEqual(result.data, alert));
  });
}

for (const [name, alert] of invalidAlerts) {
  test(`rejects ${name}`, () => {
    assert.equal(AlertStrategySchema.safeParse(alert).success, false);
  });
}

for (const rule of ALERT_RULES) {
  const fixtures = invalidAlerts.filter(([name]) => name.startsWith(rule.id));

  test(`rule ${rule.id} has invalid fixtures, each rejected with its message`, () => {
    assert.ok(fixtures.length > 0, `no invalid fixture named ${rule.id}*`);
    for (const [name, alert] of fixtures) {
      const result = AlertStrategySchema.safeParse(alert);
      assert.ok(
        !result.success && result.error.issues.some((issue) => issue.message === rule.description),
        `${name}: expected "${rule.description}"`,
      );
    }
  });
}
