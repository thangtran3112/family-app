import assert from "node:assert/strict";
import test from "node:test";
import { routeId, wholeParam } from "./routeId.ts";

// D-117, D-164, D-193: one answer for an id on every Practice route.
test("no parameter is not selected: no id, and nothing was given", () => {
  assert.deepEqual(routeId(null), { id: null, given: false });
});

test("a whole number above zero is the id", () => {
  assert.deepEqual(routeId("12"), { id: 12, given: true });
  assert.equal(wholeParam("007"), 7);
});

test("an id that cannot name a thread is given and has no number, so every route answers not found", () => {
  for (const bad of ["abc", "0", "-1", "1.5", "2x", "", " 3", "99999999999999999999"]) {
    assert.deepEqual(routeId(bad), { id: null, given: true }, `id ${JSON.stringify(bad)}`);
  }
});
