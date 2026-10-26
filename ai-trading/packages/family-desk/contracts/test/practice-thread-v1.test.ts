import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_STARTING_BALANCE,
  PRACTICE_THREAD_RULES,
  PracticeLedgerEntryV1Schema,
  PracticeThreadCreateV1Schema,
  PracticeThreadPatchV1Schema,
  PracticeThreadV1Schema,
  SWING_SETUP_RULES,
} from "../src/practice-thread-v1.ts";
import { jsonFiles } from "./fixtures.ts";

const FAMILIES = {
  create: { schema: PracticeThreadCreateV1Schema, dir: "practice-thread-create-v1", valid: 7, invalid: 43 },
  patch: { schema: PracticeThreadPatchV1Schema, dir: "practice-thread-patch-v1", valid: 2, invalid: 9 },
  thread: { schema: PracticeThreadV1Schema, dir: "practice-thread-v1", valid: 7, invalid: 27 },
  ledger: { schema: PracticeLedgerEntryV1Schema, dir: "practice-ledger-entry-v1", valid: 7, invalid: 21 },
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

const fixture = (dir: string, kind: "valid" | "invalid", name: string) =>
  jsonFiles(`fixtures/${dir}/${kind}`).find(([file]) => file === name)![1];

// A rule is proven by its own message: a fixture could fail for some other reason.
const messages = (schema: { safeParse: (doc: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, doc: unknown) =>
  schema.safeParse(doc).error?.issues.map((issue) => issue.message) ?? [];

test("rule swing-block-matches-mode rejects a swing without its block and a day with one", () => {
  const rule = PRACTICE_THREAD_RULES[1].description;
  for (const doc of [
    fixture("practice-thread-create-v1", "invalid", "mode-swing-without-block.json"),
    fixture("practice-thread-create-v1", "invalid", "swing-on-day-thread.json"),
  ]) {
    assert.ok(messages(PracticeThreadCreateV1Schema, doc).includes(rule));
  }
  for (const doc of [
    fixture("practice-thread-v1", "invalid", "swing-without-block.json"),
    fixture("practice-thread-v1", "invalid", "day-thread-with-swing-block.json"),
  ]) {
    assert.ok(messages(PracticeThreadV1Schema, doc).includes(rule));
  }
});

test("rule universe-symbols-unique rejects a repeated symbol with its message", () => {
  const doc = fixture("practice-thread-create-v1", "invalid", "swing-universe-duplicate-symbol.json");
  assert.ok(messages(PracticeThreadCreateV1Schema, doc).includes(SWING_SETUP_RULES[0].description));
});

test("a swing ledger row needs neither a session nor a mark, only a hold", () => {
  const auto = fixture("practice-ledger-entry-v1", "valid", "swing-auto-exit.json") as Record<string, unknown>;
  assert.ok(!("sessionId" in auto) && !("markId" in auto) && auto.holdId === 4);
  assert.ok(PracticeLedgerEntryV1Schema.safeParse(auto).success);
});
