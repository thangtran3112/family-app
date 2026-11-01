import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_VALUE } from "./format.ts";
import { cellAlign, cellTitle, columnLayout, dropEmptyColumns, isEmptyCell } from "./denseTable.ts";

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
