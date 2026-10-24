import assert from "node:assert/strict";
import test from "node:test";
import { ariaSort, nextSort, sortRows } from "./sort.ts";

const rows = [
  { s: "A", v: 2 },
  { s: "B", v: null },
  { s: "C", v: 10 },
  { s: "D", v: Number.NaN },
  { s: "E", v: 2 },
];

test("numbers sort both ways, ties keep their order, empty values go last", () => {
  assert.deepEqual(sortRows(rows, (r) => r.v, "asc").map((r) => r.s), ["A", "E", "C", "B", "D"]);
  assert.deepEqual(sortRows(rows, (r) => r.v, "desc").map((r) => r.s), ["C", "A", "E", "B", "D"]);
});

test("strings sort with natural numeric order", () => {
  const names = [{ n: "item10" }, { n: "item2" }, { n: "Item1" }];
  assert.deepEqual(sortRows(names, (r) => r.n, "asc").map((r) => r.n), ["Item1", "item2", "item10"]);
});

test("header clicks cycle desc, asc, off and aria-sort follows", () => {
  let state = nextSort(null, "rvol");
  assert.deepEqual(state, { key: "rvol", direction: "desc" });
  assert.equal(ariaSort(state, "rvol"), "descending");
  assert.equal(ariaSort(state, "last"), "none");
  state = nextSort(state, "rvol");
  assert.deepEqual(state, { key: "rvol", direction: "asc" });
  assert.equal(ariaSort(state, "rvol"), "ascending");
  assert.equal(nextSort(state, "rvol"), null);
  assert.deepEqual(nextSort(state, "last"), { key: "last", direction: "desc" });
  assert.deepEqual(nextSort(null, "symbol", "asc"), { key: "symbol", direction: "asc" });
});
