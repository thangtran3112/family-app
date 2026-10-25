import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_STARTING_BALANCE,
  PRACTICE_THREAD_RULES,
  PracticeLedgerEntryV1Schema,
  PracticeThreadCreateV1Schema,
  PracticeThreadPatchV1Schema,
  PracticeThreadV1Schema,
} from "../src/practice-thread-v1.ts";
import { jsonFiles } from "./fixtures.ts";

const FAMILIES = {
  create: { schema: PracticeThreadCreateV1Schema, dir: "practice-thread-create-v1", valid: 6, invalid: 24 },
  patch: { schema: PracticeThreadPatchV1Schema, dir: "practice-thread-patch-v1", valid: 2, invalid: 9 },
  thread: { schema: PracticeThreadV1Schema, dir: "practice-thread-v1", valid: 6, invalid: 24 },
  ledger: { schema: PracticeLedgerEntryV1Schema, dir: "practice-ledger-entry-v1", valid: 5, invalid: 18 },
};

for (const [family, { schema, dir, valid, invalid }] of Object.entries(FAMILIES)) {
  const files = { valid: jsonFiles(`fixtures/${dir}/valid`), invalid: jsonFiles(`fixtures/${dir}/invalid`) };

  test(`${family} fixture folders are not empty`, () => {
    assert.ok(files.valid.length >= valid && files.invalid.length >= invalid);
  });

  for (const [name, doc] of files.valid) {
    test(`${family} accepts ${name}`, () => {
      const result = schema.safeParse(doc);
      assert.ok(result.success, JSON.stringify(result.error?.issues));
    });
  }

  for (const [name, doc] of files.invalid) {
    test(`${family} rejects ${name}`, () => {
      assert.equal(schema.safeParse(doc).success, false);
    });
  }
}

const base = jsonFiles("fixtures/practice-thread-create-v1/valid").find(([name]) => name === "minimal-day.json")![1];

test("a create without a starting balance gets the default", () => {
  const parsed = PracticeThreadCreateV1Schema.parse(base);
  assert.equal(parsed.startingBalance, DEFAULT_STARTING_BALANCE);
  assert.equal(DEFAULT_STARTING_BALANCE, 50_000);
});

test("rule closed-at-matches-status rejects both mismatches with its message", () => {
  const active = jsonFiles("fixtures/practice-thread-v1/valid").find(([name]) => name === "active-fresh.json")![1] as object;
  const closed = jsonFiles("fixtures/practice-thread-v1/valid").find(([name]) => name === "closed.json")![1] as {
    closedAt: string;
  };
  const rule = PRACTICE_THREAD_RULES[0];
  for (const doc of [{ ...active, closedAt: closed.closedAt }, { ...closed, closedAt: undefined }]) {
    const result = PracticeThreadV1Schema.safeParse(doc);
    assert.ok(!result.success && result.error.issues.some((issue) => issue.message === rule.description));
  }
});
