import assert from "node:assert/strict";
import { test } from "node:test";
import { PracticeBlockV1Schema } from "../src/practice-block-v1.ts";
import { PRACTICE_SETUP_RULES, PracticeSetupV2Schema } from "../src/practice-setup-v2.ts";
import { jsonFiles } from "./fixtures.ts";

const setups = { valid: jsonFiles("fixtures/practice-setup-v2/valid"), invalid: jsonFiles("fixtures/practice-setup-v2/invalid") };

test("fixture folders are not empty", () => {
  assert.ok(setups.valid.length >= 10 && setups.invalid.length >= 50);
});

for (const [name, spec] of setups.valid) {
  test(`setup accepts ${name}`, () => {
    const result = PracticeSetupV2Schema.safeParse(spec);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
}

for (const [name, spec] of setups.invalid) {
  test(`setup rejects ${name}`, () => {
    assert.equal(PracticeSetupV2Schema.safeParse(spec).success, false);
  });
}

// v2 lands beside v1: the two never accept each other's documents (schemaVersion 1 against 2, and the removed keys).
test("no practice-block-v1 fixture is a practice-setup-v2 and no v2 fixture is a v1 block", () => {
  for (const [name, block] of jsonFiles("fixtures/practice-block-v1/valid")) {
    assert.equal(PracticeSetupV2Schema.safeParse(block).success, false, `v1 ${name}`);
  }
  for (const [name, setup] of setups.valid) {
    assert.equal(PracticeBlockV1Schema.safeParse(setup).success, false, `v2 ${name}`);
  }
});

const base = setups.valid.find(([name]) => name === "default-open-edt.json")![1] as Record<string, unknown>;

const RULE_CASES: Record<string, unknown> = {
  "start-at-real": { ...base, startAt: "2026-02-31T09:30:00-05:00" },
  "start-at-floor": { ...base, startAt: "2016-01-03T23:59:59-05:00" },
};

for (const rule of PRACTICE_SETUP_RULES) {
  test(`rule ${rule.id} rejects its case with its message`, () => {
    const result = PracticeSetupV2Schema.safeParse(RULE_CASES[rule.id]);
    assert.ok(
      !result.success && result.error.issues.some((issue) => issue.message === rule.description),
      `expected "${rule.description}"`,
    );
  });
}

test("the floor is the first ET day: its midnight in EST is the first instant accepted", () => {
  const at = (startAt: string) => PracticeSetupV2Schema.safeParse({ ...base, startAt }).success;
  assert.equal(at("2016-01-04T00:00:00-05:00"), true);
  assert.equal(at("2016-01-04T05:00:00Z"), true);
  assert.equal(at("2016-01-04T04:59:59Z"), false);
});
