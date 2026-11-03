import assert from "node:assert/strict";
import test from "node:test";
import type { Condition } from "@ai-trading/contracts";
import { operandBoxLabels, rowsBoxLabels } from "./conditionLabels.ts";
import { OPERAND_CATALOG, operandDef } from "./operands.ts";
import { formProblems } from "./problems.ts";

const fieldOf = (when: Condition, path: string) => formProblems([{ path, message: "Input should be less than or equal to 60" }], "error", operandBoxLabels(when, OPERAND_CATALOG))[0]!.field;

// D-205 tail: the box says "Days", so the summary says "Days" (it said "Lookback (days)").
test("D-205: an out-of-range rel-volatility lookback is summarised under the word its box carries", () => {
  const when: Condition = { op: "gte", left: { series: "rvol", lookbackDays: 99 }, right: { value: 2 } };
  const box = operandDef("rvol")!.params[0]!.label;
  assert.equal(box, "Days");
  assert.equal(fieldOf(when, "when.left.lookbackDays"), `Condition · Metric · ${box}`);
});

test("D-205: the same word on either side, inside a group, and for ATR % length", () => {
  const when: Condition = { all: [
    { op: "gte", left: { series: "close" }, right: { value: 1 } },
    { op: "gt", left: { series: "atr_pct", length: 14, medianLength: 50 }, right: { series: "rvol", lookbackDays: 70 } },
  ] };
  assert.equal(fieldOf(when, "when.all.1.right.lookbackDays"), "Condition 2 · Compared with · Days");
  assert.equal(fieldOf(when, "when.all.1.left.length"), "Condition 2 · Metric · ATR length");
  assert.equal(fieldOf(when, "when.all.1.left.medianLength"), "Condition 2 · Metric · Median length");
});

test("D-205: every parameter box of every kit metric is summarised under its own label", () => {
  for (const def of OPERAND_CATALOG) {
    const when = { op: "gt", left: def.make(Object.fromEntries(def.params.map((p) => [p.key, p.defaultValue]))), right: { value: 1 } } as Condition;
    for (const param of def.params) assert.equal(fieldOf(when, `when.left.${param.key}`), `Condition · Metric · ${param.label}`, `${def.id}.${param.key}`);
  }
});

test("rowsBoxLabels paths a single row as `when` and several rows as the group; a path it does not list keeps fieldLabel's wording", () => {
  const row: Condition = { op: "gte", left: { series: "rvol", lookbackDays: 10 }, right: { value: 2 } };
  assert.deepEqual(Object.keys(rowsBoxLabels({ mode: "all", rows: [row] }, OPERAND_CATALOG)), ["when.left.lookbackDays"]);
  assert.deepEqual(Object.keys(rowsBoxLabels({ mode: "any", rows: [row, row] }, OPERAND_CATALOG)), ["when.any.0.left.lookbackDays", "when.any.1.left.lookbackDays"]);
  assert.equal(formProblems([{ path: "when.pct", message: "Field required" }])[0]!.field, "Condition · Within %");
  assert.equal(formProblems([{ path: "when.op", message: "Field required" }])[0]!.field, "Condition · Operator");
});
