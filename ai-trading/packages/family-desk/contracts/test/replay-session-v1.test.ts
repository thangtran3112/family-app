import assert from "node:assert/strict";
import { test } from "node:test";
import { PracticeMarkV1Schema, REPLAY_WINDOW_RULES, ReplaySessionV1Schema } from "../src/replay-session-v1.ts";
import { jsonFiles } from "./fixtures.ts";

const sessions = { valid: jsonFiles("fixtures/replay-session-v1/valid"), invalid: jsonFiles("fixtures/replay-session-v1/invalid") };
const marks = { valid: jsonFiles("fixtures/practice-mark-v1/valid"), invalid: jsonFiles("fixtures/practice-mark-v1/invalid") };

test("fixture folders are not empty", () => {
  assert.ok(sessions.valid.length >= 8 && sessions.invalid.length >= 30);
  assert.ok(marks.valid.length >= 10 && marks.invalid.length >= 20);
});

for (const [name, spec] of sessions.valid) {
  test(`session accepts ${name}`, () => {
    const result = ReplaySessionV1Schema.safeParse(spec);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
}

for (const [name, spec] of sessions.invalid) {
  test(`session rejects ${name}`, () => {
    assert.equal(ReplaySessionV1Schema.safeParse(spec).success, false);
  });
}

for (const [name, spec] of marks.valid) {
  test(`mark accepts ${name}`, () => {
    const result = PracticeMarkV1Schema.safeParse(spec);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
}

for (const [name, spec] of marks.invalid) {
  test(`mark rejects ${name}`, () => {
    assert.equal(PracticeMarkV1Schema.safeParse(spec).success, false);
  });
}

const base = sessions.valid.find(([name]) => name === "boundary-min.json")![1] as Record<string, unknown>;
const withWindow = (session: string, from: string, to: string) => ({ ...base, session, window: { from, to } });

const WINDOW_CASES: Record<string, ReturnType<typeof withWindow>> = {
  "window-order": withWindow("regular", "10:00", "09:45"),
  "window-in-session": withWindow("extended", "03:59", "09:00"),
  "window-in-regular": withWindow("regular", "09:00", "10:00"),
};

for (const rule of REPLAY_WINDOW_RULES) {
  test(`rule ${rule.id} rejects its case with its message`, () => {
    const result = ReplaySessionV1Schema.safeParse(WINDOW_CASES[rule.id]);
    assert.ok(
      !result.success && result.error.issues.some((issue) => issue.message === rule.description),
      `expected "${rule.description}"`,
    );
  });
}
