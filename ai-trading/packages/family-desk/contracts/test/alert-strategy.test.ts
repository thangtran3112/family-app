import assert from "node:assert/strict";
import { test } from "node:test";
import { ALERT_RULES, AlertStrategySpecV1Schema } from "../src/alert-strategy.ts";
import { StrategySpecV1Schema } from "../src/strategy-spec-v1.ts";
import { jsonFiles } from "./fixtures.ts";

const valid = jsonFiles("fixtures/alert-strategy/valid");
const invalid = jsonFiles("fixtures/alert-strategy/invalid");

test("fixture folders are not empty", () => {
  assert.ok(valid.length >= 10 && invalid.length >= 22);
});

for (const [name, spec] of valid) {
  test(`accepts ${name}`, () => {
    const result = AlertStrategySpecV1Schema.safeParse(spec);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  test(`${name} is also a plain StrategySpecV1`, () => {
    assert.ok(StrategySpecV1Schema.safeParse(spec).success);
  });
}

for (const [name, spec] of invalid) {
  test(`rejects ${name}`, () => {
    assert.equal(AlertStrategySpecV1Schema.safeParse(spec).success, false);
  });
}

const RULE_FIXTURES: Record<string, string[]> = {
  "channels-unique": ["channels-duplicate-inbox.json", "channels-duplicate-telegram.json"],
  "channels-inbox-first": [
    "channels-telegram-first.json",
    "channels-no-inbox.json",
    "channels-slack-first-inbox-last.json",
  ],
};

for (const rule of ALERT_RULES) {
  test(`rule ${rule.id} rejects its fixtures with its message`, () => {
    for (const fixture of RULE_FIXTURES[rule.id]!) {
      const spec = invalid.find(([name]) => name === fixture)?.[1];
      assert.ok(spec, `missing invalid fixture ${fixture}`);
      const result = AlertStrategySpecV1Schema.safeParse(spec);
      assert.ok(
        !result.success && result.error.issues.some((issue) => issue.message === rule.description),
        `${fixture}: expected "${rule.description}"`,
      );
    }
  });
}

test("a paperOrder is an unrecognized key, not a rule", () => {
  const spec = invalid.find(([name]) => name === "paper-order-present.json")?.[1];
  const result = AlertStrategySpecV1Schema.safeParse(spec);
  assert.ok(!result.success && result.error.issues.some((issue) => issue.code === "unrecognized_keys"));
});
