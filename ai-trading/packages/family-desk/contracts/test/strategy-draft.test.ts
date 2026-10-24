import assert from "node:assert/strict";
import { test } from "node:test";
import { AlertStrategySpecV1Schema } from "../src/alert-strategy.ts";
import { FilterStrategySpecV1Schema } from "../src/filter-strategy-spec-v1.ts";
import { applyEdits, jsonEqual } from "../src/json-pointer.ts";
import { DRAFT_RULES, StrategyDraftSchema } from "../src/strategy-draft.ts";
import { jsonFiles } from "./fixtures.ts";

const validDrafts = jsonFiles("fixtures/strategy-draft/valid");
const invalidDrafts = jsonFiles("fixtures/strategy-draft/invalid");

test("fixture folders are not empty", () => {
  assert.ok(validDrafts.length >= 9 && invalidDrafts.length >= 36);
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
  assert.ok(finalDrafts.length >= 4);
});

for (const [name, draft] of finalDrafts) {
  test(`round trip ${name}: draftConfig + edits = finalConfig`, () => {
    const parsed = StrategyDraftSchema.parse(draft);
    assert.ok(parsed.finalConfig);
    const spec = parsed.target === "filter" ? FilterStrategySpecV1Schema : AlertStrategySpecV1Schema;
    const replayed = spec.parse(applyEdits(parsed.draftConfig, parsed.edits));
    assert.ok(jsonEqual(replayed, parsed.finalConfig));
  });
}

test("both targets appear among the valid drafts", () => {
  const targets = new Set(validDrafts.map(([, draft]) => (draft as { target: string }).target));
  assert.deepEqual([...targets].sort(), ["alert", "filter"]);
});
