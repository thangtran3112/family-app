import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_VALUE } from "./format.ts";
import { cellAlign, cellTitle, columnLayout, dropEmptyColumns, fitColumns, isEmptyCell, type ColumnWidth } from "./denseTable.ts";

test("numbers and actions align right, text left, and an explicit align wins", () => {
  assert.equal(cellAlign({}), "left");
  assert.equal(cellAlign({ kind: "text" }), "left");
  assert.equal(cellAlign({ kind: "num" }), "right");
  assert.equal(cellAlign({ kind: "action" }), "right");
  assert.equal(cellAlign({ kind: "num", align: "center" }), "center");
  assert.equal(cellAlign({ align: "right" }), "right"); // the existing opt-in still works
});

test("a cell is empty when it renders nothing or the em dash", () => {
  for (const value of [null, undefined, false, "", EMPTY_VALUE]) assert.equal(isEmptyCell(value), true, String(value));
  for (const value of [0, "0", "AAPL", true, { type: "span" }]) assert.equal(isEmptyCell(value), false, String(value));
});

test("hideWhenEmpty drops a column only when every row is empty in it", () => {
  type Row = { tag: string | null; name: string };
  const columns = [
    { key: "name", label: "Name", render: (row: Row) => row.name },
    { key: "tag", label: "Tag", hideWhenEmpty: true, render: (row: Row) => row.tag },
    { key: "always", label: "Always", render: () => null }, // not flagged: stays even though it is empty
  ];
  const keys = (rows: Row[]) => dropEmptyColumns(columns, rows).map((column) => column.key);
  assert.deepEqual(keys([{ name: "A", tag: null }, { name: "B", tag: "" }]), ["name", "always"]);
  assert.deepEqual(keys([{ name: "A", tag: null }, { name: "B", tag: "swing" }]), ["name", "tag", "always"]);
  assert.deepEqual(keys([]), ["name", "tag", "always"], "no rows: the empty state decides, not the columns");
});

test("a truncating column titles its cell with the text it clips", () => {
  const row = { name: "Volume spike near support" };
  assert.equal(cellTitle({ truncate: true, render: (r: typeof row) => r.name }, row), "Volume spike near support");
  assert.equal(cellTitle({ truncate: true, render: () => 42 }, row), "42");
  assert.equal(cellTitle({ truncate: true, render: () => ({ type: "span" }) }, row), undefined, "an element has no text to title");
  assert.equal(cellTitle({ truncate: (r: typeof row) => `Full: ${r.name}`, render: () => "short" }, row), "Full: Volume spike near support");
  assert.equal(cellTitle({ render: () => "plain" }, row), undefined, "no truncate, no title");
});

test("a number is never clipped; a truncating column holds its minWidth, a fill column takes the slack", () => {
  assert.deepEqual(columnLayout({ kind: "num", fill: true, truncate: true, minWidth: 60 }), { fill: false, truncate: false, style: { minWidth: 60 } });
  assert.deepEqual(columnLayout({ kind: "text", fill: true }), { fill: true, truncate: false, style: undefined });
  assert.deepEqual(columnLayout({ truncate: true, minWidth: 140 }), { fill: false, truncate: true, style: { width: 140, minWidth: 140, maxWidth: 140 } });
  assert.deepEqual(columnLayout({ fill: true, truncate: true, minWidth: 80 }), { fill: true, truncate: true, style: { minWidth: 80 } });
  assert.deepEqual(columnLayout({}), { fill: false, truncate: false, style: undefined });
});

// -- fitColumns (D-157) ------------------------------------------------------------------------------------------------------

const col = (key: string, max: number, min: number, priority?: number): ColumnWidth => (priority === undefined ? { key, max, min } : { key, max, min, priority });

test("a table that fits its pane drops nothing and wraps nothing", () => {
  const columns = [col("symbol", 80, 60), col("last", 90, 70, 1), col("chg", 90, 70, 2)];
  assert.deepEqual(fitColumns(columns, { max: 100, min: 100 }, 360), { hidden: [], wrap: false, fits: true });
  assert.deepEqual(fitColumns(columns, { max: 100, min: 100 }, 1000), { hidden: [], wrap: false, fits: true }, "a wider pane changes nothing");
});

test("columns drop lowest priority first, only until the rest fit, the rightmost of equal priorities first", () => {
  const columns = [col("symbol", 80, 60), col("a", 100, 70, 1), col("b", 100, 70, 2), col("c", 100, 70, 2), col("d", 100, 70, 3)];
  assert.deepEqual(fitColumns(columns, { max: 0, min: 0 }, 470), { hidden: ["a"], wrap: false, fits: true });
  assert.deepEqual(fitColumns(columns, { max: 0, min: 0 }, 370), { hidden: ["a", "c"], wrap: false, fits: true });
  assert.deepEqual(fitColumns(columns, { max: 0, min: 0 }, 270), { hidden: ["a", "c", "b"], wrap: false, fits: true });
  assert.deepEqual(fitColumns(columns, { max: 0, min: 0 }, 170), { hidden: ["a", "c", "b", "d"], wrap: false, fits: true });
});

test("the actions cell is reserved: it never drops and always counts", () => {
  const columns = [col("symbol", 80, 60), col("a", 100, 70, 1)];
  assert.deepEqual(fitColumns(columns, { max: 140, min: 140 }, 300), { hidden: ["a"], wrap: false, fits: true });
  assert.deepEqual(fitColumns(columns, { max: 140, min: 140 }, 320), { hidden: [], wrap: false, fits: true });
});

test("when the columns without a priority overflow, headers wrap and the drop restarts at the wrapped widths", () => {
  // At one-line headers only the unprioritized 80 + 120 + 140 reserved = 340 would be left, still over 300: wrap, and the wrapped widths (370 in all) need only column a gone.
  const columns = [col("symbol", 80, 60), col("a", 120, 70, 1), col("b", 130, 70, 2), col("c", 120, 80)];
  assert.deepEqual(fitColumns(columns, { max: 140, min: 90 }, 300), { hidden: ["a"], wrap: true, fits: true });
  assert.deepEqual(fitColumns(columns, { max: 140, min: 90 }, 250), { hidden: ["a", "b"], wrap: true, fits: true });
});

test("when even the wrapped columns without a priority overflow, the table says it does not fit", () => {
  const columns = [col("symbol", 80, 60), col("a", 120, 70, 1), col("c", 120, 80)];
  assert.deepEqual(fitColumns(columns, { max: 100, min: 100 }, 200), { hidden: ["a"], wrap: true, fits: false });
});
