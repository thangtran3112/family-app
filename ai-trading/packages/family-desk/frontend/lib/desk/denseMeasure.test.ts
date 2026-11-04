import assert from "node:assert/strict";
import test from "node:test";
import { fitsAsRendered, measureKey, measuredWidthsStale } from "./denseMeasure.ts";

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
  for (const change of [{ label: "Held" }, { kind: "text" }, { align: "right" }, { priority: 1 }, { fill: true }, { truncate: true }, { minWidth: 120 }, { maxWidth: 120 }]) {
    const changed = columns().map((column) => (column.key === "held" ? { ...column, ...change } : column));
    assert.notEqual(measureKey(changed, 5, false, false), base, JSON.stringify(change));
  }
});

test("a table that fits as rendered is not measured; one that does not, or that cannot be judged by its width, is", () => {
  const plain = [{ kind: "text" as const }, { kind: "num" as const }];
  const none = { hidden: [], wrap: false };
  assert.equal(fitsAsRendered(plain, none, 480, 480), true, "as wide as the pane");
  assert.equal(fitsAsRendered(plain, none, 300, 480), true, "narrower");
  assert.equal(fitsAsRendered(plain, none, 480.5, 480), false, "wider by half a pixel: the columns sum to more than the pane");
  assert.equal(fitsAsRendered(plain, { hidden: ["held"], wrap: false }, 300, 480), false, "columns already hidden: the rendered width is not the natural width");
  assert.equal(fitsAsRendered(plain, { hidden: [], wrap: true }, 300, 480), false, "headers already wrapped");
  assert.equal(fitsAsRendered([...plain, { kind: "text", fill: true }], none, 300, 480), false, "a fill column ellipsizes: a narrow table can hold wide text");
  assert.equal(fitsAsRendered([...plain, { kind: "text", truncate: true }], none, 300, 480), false, "a truncating column is clipped to its width");
  assert.equal(fitsAsRendered([...plain, { kind: "num", fill: true, truncate: true }], none, 300, 480), true, "a num column is never clipped, so fill and truncate do not apply to it");
});

test("a table wider than its pane though its fit says it fits was measured with other widths: measure again (D-243)", () => {
  const fits = { hidden: ["a"], wrap: false, fits: true };
  assert.equal(measuredWidthsStale(fits, 1088, 1088), false, "as wide as the pane");
  assert.equal(measuredWidthsStale(fits, 1088.4, 1088), false, "under half a pixel: no scrollbar to show");
  assert.equal(measuredWidthsStale(fits, 1089, 1088), true, "a pixel wider: a placeholder was measured, its value landed wider, a late font");
  assert.equal(measuredWidthsStale(fits, 1092, 1088), true);
  const stuck = { hidden: ["a"], wrap: true, fits: false };
  assert.equal(measuredWidthsStale(stuck, 1200, 1088), false, "the columns that never drop overflow by themselves: nothing more to drop, so nothing to measure for");
  assert.equal(measuredWidthsStale(fits, 600, 1088), false, "narrower");
});
