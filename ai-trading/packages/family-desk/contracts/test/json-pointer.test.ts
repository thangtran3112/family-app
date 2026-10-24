import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, EditSchema, jsonEqual, resolvePointer } from "../src/json-pointer.ts";
import { jsonFiles } from "./fixtures.ts";

type Case = { name: string; doc: unknown; edits: unknown[]; result?: unknown; error?: boolean };
const cases = jsonFiles("fixtures/json-pointer")[0]?.[1] as Case[];

test("json-pointer cases exist", () => {
  assert.ok(cases.length >= 20);
});

for (const c of cases) {
  test(`edits: ${c.name}`, () => {
    const edits = c.edits.map((edit) => EditSchema.parse(edit));
    if (c.error) {
      assert.throws(() => applyEdits(c.doc, edits));
    } else {
      const before = structuredClone(c.doc);
      assert.ok(jsonEqual(applyEdits(c.doc, edits), c.result));
      assert.deepEqual(c.doc, before, "applyEdits must not mutate its input");
    }
  });
}

test("edit schema rejects malformed ops", () => {
  for (const bad of [
    { op: "replace", path: "/a" },
    { op: "remove", path: "/a", value: 1 },
    { op: "move", path: "/a", value: 1 },
    { op: "add", path: "a", value: 1 },
    { op: "add", path: "", value: 1 },
    { op: "add", path: "/a~2", value: 1 },
    { op: "add", path: "/a", value: null },
    { op: "add", path: "/a", value: true },
    { op: "add", path: "/a", value: { b: [1, null] } },
    { op: "add", path: "/a", value: Infinity },
    { op: "add", path: "/a", value: { b: [Number.NaN] } },
    { op: "add", path: "/a", value: 1, extra: 1 },
  ]) {
    assert.equal(EditSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("edit schema rejects a JSON number that overflows to infinity", () => {
  const edit = JSON.parse('{"op": "add", "path": "/a", "value": {"b": 1e400}}');
  assert.equal(EditSchema.safeParse(edit).success, false);
});

test("resolvePointer and jsonEqual", () => {
  assert.deepEqual(resolvePointer({ a: [{ b: 1 }] }, "/a/0/b"), { found: true, value: 1 });
  assert.equal(resolvePointer({ a: [] }, "/a/0").found, false);
  assert.ok(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }));
  assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!jsonEqual([1], { 0: 1 }));
});
