import assert from "node:assert/strict";
import { test } from "node:test";
import { PRACTICE_BLOCK_RULES, PracticeBlockV1Schema } from "../src/practice-block-v1.ts";
import { jsonFiles } from "./fixtures.ts";

const blocks = { valid: jsonFiles("fixtures/practice-block-v1/valid"), invalid: jsonFiles("fixtures/practice-block-v1/invalid") };

test("fixture folders are not empty", () => {
  assert.ok(blocks.valid.length >= 6 && blocks.invalid.length >= 30);
});

for (const [name, spec] of blocks.valid) {
  test(`block accepts ${name}`, () => {
    const result = PracticeBlockV1Schema.safeParse(spec);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
}

for (const [name, spec] of blocks.invalid) {
  test(`block rejects ${name}`, () => {
    assert.equal(PracticeBlockV1Schema.safeParse(spec).success, false);
  });
}

const base = blocks.valid.find(([name]) => name === "boundary-min.json")![1] as {
  screen: Record<string, unknown>;
  setup: Record<string, unknown>;
};
const withSetup = (setup: Record<string, unknown>, screen: Record<string, unknown> = {}) => ({
  ...base,
  screen: { ...base.screen, ...screen },
  setup: { ...base.setup, ...setup },
});

const RULE_CASES: Record<string, unknown> = {
  "window-order": withSetup({ window: { from: "11:30", to: "09:30" } }, { listAt: "04:30" }),
  "window-in-session": withSetup({ session: "extended", window: { from: "03:59", to: "09:00" } }, { listAt: "04:30" }),
  "window-in-regular": withSetup({ window: { from: "09:00", to: "10:00" } }),
  "list-time-range": withSetup({ session: "extended", window: { from: "04:00", to: "09:00" } }, { listAt: "04:29" }),
  "window-after-list": withSetup({}, { listAt: "10:00" }),
};

for (const rule of PRACTICE_BLOCK_RULES) {
  test(`rule ${rule.id} rejects its case with its message`, () => {
    const result = PracticeBlockV1Schema.safeParse(RULE_CASES[rule.id]);
    assert.ok(
      !result.success && result.error.issues.some((issue) => issue.message === rule.description),
      `expected "${rule.description}"`,
    );
  });
}
