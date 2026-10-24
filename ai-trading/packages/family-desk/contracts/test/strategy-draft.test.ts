import assert from "node:assert/strict";
import { test } from "node:test";
import { AlertStrategySchema } from "../src/alert-strategy.ts";
import { FilterStrategySchema } from "../src/filter-strategy.ts";
import { applyEdits, jsonEqual } from "../src/json-pointer.ts";
import { DRAFT_RULES, StrategyDraftSchema } from "../src/strategy-draft.ts";
import { jsonFiles } from "./fixtures.ts";

const validDrafts = jsonFiles("fixtures/strategy-draft/valid");
const invalidDrafts = jsonFiles("fixtures/strategy-draft/invalid");

test("fixture folders are not empty", () => {
  assert.ok(validDrafts.length >= 8 && invalidDrafts.length >= 20);
});

for (const [name, draft] of validDrafts) {
  test(`accepts ${name}`, () => {
    const result = StrategyDraftSchema.safeParse(draft);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
    assert.ok(jsonEqual(result.data, draft));
  });
}

for (const [name, draft] of invalidDrafts) {
  test(`rejects ${name}`, () => {
    assert.equal(StrategyDraftSchema.safeParse(draft).success, false);
  });
}

for (const rule of DRAFT_RULES) {
  const fixtures = invalidDrafts.filter(([name]) => name.startsWith(rule.id));

  test(`rule ${rule.id} has invalid fixtures, each rejected with its message`, () => {
    assert.ok(fixtures.length > 0, `no invalid fixture named ${rule.id}*`);
    for (const [name, draft] of fixtures) {
      const result = StrategyDraftSchema.safeParse(draft);
      assert.ok(
        !result.success && result.error.issues.some((issue) => issue.message === rule.description),
        `${name}: expected "${rule.description}"`,
      );
    }
  });
}

const finalDrafts = validDrafts.filter(([, draft]) => (draft as { status?: unknown }).status === "final");

test("there are valid final fixtures for the round trip", () => {
  assert.ok(finalDrafts.length >= 3);
});

for (const [name, draft] of finalDrafts) {
  test(`round trip ${name}: draftConfig + edits = finalConfig`, () => {
    const parsed = StrategyDraftSchema.parse(draft);
    assert.ok(parsed.finalConfig);
    const config = parsed.draftConfig.kind === "filter" ? FilterStrategySchema : AlertStrategySchema;
    const replayed = config.parse(applyEdits(parsed.draftConfig, parsed.edits));
    assert.ok(jsonEqual(replayed, parsed.finalConfig));
  });
}
