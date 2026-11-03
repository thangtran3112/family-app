import assert from "node:assert/strict";
import test from "node:test";
import { measureKey } from "./denseMeasure.ts";

const columns = () => [
  { key: "symbol", label: "Ticker", render: () => "a" },
  { key: "shares", label: "Shares", kind: "num", render: () => "1" },
  { key: "held", label: "Held for", kind: "num", priority: 2, render: () => "3d" },
];

test("the same columns in a new array, with new render functions, are not measured again (D-241)", () => {
  // PositionTable builds `columns()` in its render; a hideWhenEmpty column that drops makes `dropEmptyColumns` return a new array at every poll.
  assert.equal(measureKey(columns(), 5, false, false), measureKey(columns(), 5, false, false));
});

test("everything that can change a width measures again", () => {
  const base = measureKey(columns(), 5, false, false);
  assert.notEqual(measureKey(columns(), 6, false, false), base, "a row count");
  assert.notEqual(measureKey(columns(), 5, true, false), base, "an actions cell");
  assert.notEqual(measureKey(columns(), 5, false, true), base, "the empty state shown or not");
  assert.notEqual(measureKey(columns().slice(0, 2), 5, false, false), base, "a column dropped");
  assert.notEqual(measureKey([...columns()].reverse(), 5, false, false), base, "the order of the columns");
  for (const change of [{ label: "Held" }, { kind: "text" }, { align: "right" }, { priority: 1 }, { fill: true }, { truncate: true }, { minWidth: 120 }]) {
    const changed = columns().map((column) => (column.key === "held" ? { ...column, ...change } : column));
    assert.notEqual(measureKey(changed, 5, false, false), base, JSON.stringify(change));
  }
});
