import assert from "node:assert/strict";
import test from "node:test";
import { ConditionSchema, type Condition } from "@ai-trading/contracts";
import { FilterStrategySpecV1Schema } from "@ai-trading/contracts/filter-strategy-spec-v1";
import { boxField, boxId, boxLineId, problemsByPath, rowPath } from "../../components/conditions/conditionBoxes.ts";
import type { Problem } from "../api/schemas.ts";
import { formToSpec, problemsFor, type FilterForm } from "./filterForm.ts";
import { OPERAND_CATALOG, STRATEGY_OPERAND_CATALOG, operandFor, type OperandDef } from "./operands.ts";
import { fieldError } from "./problems.ts";
import { fieldWiring } from "./primitivesView.ts";

// D-242: a condition's number box is invalid and described by its own error line. The wiring is `Field`'s (`fieldWiring`); the box's id, the
// problem's path and the line's id are the kit's (`conditionBoxes.ts`). Problem paths here come from the real contract schemas, not typed by hand.

type Side = "left" | "right";
const SIDES: readonly Side[] = ["left", "right"];
const KIT = OPERAND_CATALOG.filter((def) => def.params.length > 0);

const issues = (error: { issues: readonly { path: PropertyKey[]; message: string }[] }): Problem[] => error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
const operandOf = (def: OperandDef, values: Record<string, number>) => operandFor({ id: def.id, params: values }, STRATEGY_OPERAND_CATALOG);
const defaults = (def: OperandDef) => Object.fromEntries(def.params.map((param) => [param.key, param.defaultValue]));

/** The row at `index` of `count` rows holds `def` on `side` (other side: the number 1), with `values` in its boxes. The problems are the screener contract's. */
function filterProblems(def: OperandDef, side: Side, values: Record<string, number>, { count = 1, rank = false }: { count?: number; rank?: boolean } = {}): { problems: Problem[]; path: string } {
  const own = operandOf(def, values);
  const row: Condition = { op: "gte", left: side === "left" ? own : { value: 1 }, right: side === "right" ? own : { value: 1 } };
  const rows: Condition[] = Array.from({ length: count }, (_, index) => (index === count - 1 ? row : { op: "gte", left: { series: "close" }, right: { value: 1 } }));
  const form: FilterForm = {
    name: "x", universe: "market", watchlist: "", symbols: "", assetTypes: null, minPrice: "", minAvgVolume: "", avgVolumeDays: "", session: "regular", runOn: "bar_close_5m",
    mode: "all", rows, rankEnabled: rank, rankBy: rank ? own : operandFor({ id: "close", params: {} }), rankOrder: "desc", maxResults: "20",
  };
  const parsed = FilterStrategySpecV1Schema.safeParse(formToSpec(form));
  return { problems: parsed.success ? [] : issues(parsed.error), path: rank ? "rank.by" : `${rowPath(form, count - 1)}.${side}` };
}

/** A box's wiring as the control gets it: the `Field` wiring for the sentence `boxField` hands it. */
const wiringOf = (problems: readonly Problem[], path: string, key: string) => {
  const { id, error } = boxField(problems, path, key);
  return { id, ...fieldWiring({ id, error }) };
};

test("D-242: the kit has the 11 number boxes the walk measured", () => {
  assert.equal(KIT.flatMap((def) => def.params).length, 11);
});

test("D-242: every kit box, on both sides, in a single row and in a group, is invalid and described by its own line when its value is over the top", () => {
  for (const def of KIT) {
    for (const side of SIDES) {
      for (const count of [1, 2]) {
        for (const param of def.params) {
          const where = `${def.id} ${side} ${param.key} (${count} row${count === 1 ? "" : "s"})`;
          const { problems, path } = filterProblems(def, side, { ...defaults(def), [param.key]: param.max + 1 }, { count });
          const wired = wiringOf(problems, path, param.key);
          assert.equal(wired.invalid, true, `${where}: aria-invalid`);
          assert.equal(wired.describedBy, boxLineId(`${path}.${param.key}`), `${where}: aria-describedby`);
          assert.equal(wired.id, boxId(`${path}.${param.key}`), `${where}: the box's id`);
          // The row prints that line once, under that id, holding the sentence.
          const lines = problemsByPath(problemsFor(problems, rowPath({ mode: "all", rows: Array(count) }, count - 1))).filter((line) => line.path === `${path}.${param.key}`);
          assert.equal(lines.length, 1, `${where}: one line for the box`);
          assert.equal(fieldError(lines[0]!.problems), `Must be ${param.max} or less.`, `${where}: the line's sentence`);
          assert.equal(boxField(problems, path, param.key).error, fieldError(lines[0]!.problems), `${where}: the box and its line share one sentence`);
        }
      }
    }
  }
});

test("D-242: Rank by wires the same boxes (rank.by)", () => {
  for (const def of KIT.filter((item) => item.group !== "Levels")) {
    for (const param of def.params) {
      const { problems, path } = filterProblems(def, "left", { ...defaults(def), [param.key]: param.max + 1 }, { rank: true });
      assert.equal(path, "rank.by");
      const wired = wiringOf(problems, path, param.key);
      assert.equal(wired.invalid, true, `${def.id} ${param.key}`);
      assert.equal(wired.describedBy, boxLineId(`rank.by.${param.key}`), `${def.id} ${param.key}`);
    }
  }
});

test("D-242: a good value leaves neither attribute, and a bad box does not mark its neighbours", () => {
  for (const def of KIT) {
    for (const side of SIDES) {
      const good = filterProblems(def, side, defaults(def));
      assert.deepEqual(good.problems, [], `${def.id}: defaults are valid`);
      for (const param of def.params) {
        const wired = wiringOf(good.problems, good.path, param.key);
        assert.deepEqual([wired.invalid, wired.describedBy, wired.messageId], [undefined, undefined, null], `${def.id} ${side} ${param.key}: unmarked`);
        // Over the top in this box only: the other boxes of the same metric stay unmarked.
        const bad = filterProblems(def, side, { ...defaults(def), [param.key]: param.max + 1 });
        for (const other of def.params.filter((item) => item.key !== param.key)) {
          const wiredOther = wiringOf(bad.problems, bad.path, other.key);
          assert.deepEqual([wiredOther.invalid, wiredOther.describedBy], [undefined, undefined], `${def.id} ${side}: ${other.key} is not ${param.key}`);
        }
      }
    }
  }
});

test("D-242: the other side's box of the same key is its own box", () => {
  const rsi = KIT.find((def) => def.id === "rsi")!;
  const both: Condition = { op: "gt", left: operandOf(rsi, { length: 501 }), right: operandOf(rsi, { length: 501 }) };
  const parsed = ConditionSchema.safeParse(both);
  assert.equal(parsed.success, false);
  const problems = issues((parsed as { error: { issues: { path: PropertyKey[]; message: string }[] } }).error).map((problem) => ({ ...problem, path: `when.${problem.path}` }));
  const left = wiringOf(problems, "when.left", "length");
  const right = wiringOf(problems, "when.right", "length");
  assert.notEqual(left.id, right.id);
  assert.notEqual(left.describedBy, right.describedBy);
  assert.deepEqual([left.invalid, right.invalid], [true, true]);
});

test("D-242: every number box of every operand the strategy catalog offers (43) reads its contract problem", () => {
  let boxes = 0;
  for (const def of STRATEGY_OPERAND_CATALOG.filter((item) => item.params.length > 0)) {
    for (const param of def.params) {
      for (const side of SIDES) {
        const own = operandOf(def, { ...defaults(def), [param.key]: param.max + 1 });
        const when: Condition = { op: "gte", left: side === "left" ? own : { value: 1 }, right: side === "right" ? own : { value: 1 } };
        const parsed = ConditionSchema.safeParse(when);
        assert.equal(parsed.success, false, `${def.id} ${param.key}`);
        const problems = issues((parsed as { error: { issues: { path: PropertyKey[]; message: string }[] } }).error).map((problem) => ({ ...problem, path: `when.${problem.path}` }));
        const wired = wiringOf(problems, `when.${side}`, param.key);
        assert.equal(wired.invalid, true, `${def.id} ${side} ${param.key}: aria-invalid`);
        assert.equal(wired.describedBy, boxLineId(`when.${side}.${param.key}`), `${def.id} ${side} ${param.key}: aria-describedby`);
        boxes += 1;
      }
    }
  }
  assert.ok(boxes > 0);
});

test("D-242: a plain number's Value box is wired the same way", () => {
  const problems: Problem[] = [{ path: "when.right.value", message: "Invalid input: expected number, received NaN" }];
  const wired = wiringOf(problems, "when.right", "value");
  assert.deepEqual([wired.invalid, wired.describedBy, wired.id], [true, boxLineId("when.right.value"), boxId("when.right.value")]);
  assert.equal(boxField(problems, "when.right", "value").error, "Enter a number.");
});

test("D-242: the line's id is Field's own scheme for the box's id; two sentences for one path share one line", () => {
  const path = "when.all.1.left.lookbackDays";
  assert.equal(boxLineId(path), fieldWiring({ id: boxId(path), error: "Must be 60 or less." }).messageId);
  const problems: Problem[] = [{ path, message: "Too big: expected number to be <=60" }, { path: "when.all.1.op", message: "Invalid input" }, { path, message: "Input should be a valid integer" }];
  const lines = problemsByPath(problems);
  assert.deepEqual(lines.map((line) => line.path), [path, "when.all.1.op"]);
  assert.equal(fieldError(lines[0]!.problems), "Must be 60 or less. Use a whole number.");
  assert.equal(boxField(problems, "when.all.1.left", "lookbackDays").error, "Must be 60 or less. Use a whole number.");
  assert.equal(boxField(problems, "when.all.1.left", "length").error, null, "a box with no problem of its own has no sentence");
});
