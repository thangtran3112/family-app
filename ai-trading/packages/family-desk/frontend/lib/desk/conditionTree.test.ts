import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { ConditionSchema, StrategySpecV1Schema, type Condition } from "@ai-trading/contracts";
import { groupSpecErrors } from "../spec/form.ts";
import {
  MAX_CHILDREN,
  MAX_NESTING,
  addChild,
  canAddChild,
  canRemoveChild,
  changeKind,
  conditionKind,
  newCondition,
  nestingLeft,
  nodePath,
  removeChild,
  replaceChild,
  withOperator,
  type ConditionKind,
} from "./conditionTree.ts";

const compare: Condition = { op: "gt", left: { series: "close" }, right: { series: "vwap" } };
const within: Condition = { op: "within_pct", left: { series: "close" }, right: { series: "vwap" }, pct: 2 };
const time: Condition = { op: "time_between", start: "09:45", end: "11:00" };
const pattern: Condition = { op: "pattern", pattern: "doji", trend: "after_uptrend" };
const KINDS: ConditionKind[] = ["compare", "time_between", "pattern", "all", "any", "not"];

test("kind: a pattern leaf is \"pattern\" (the builder read it as a comparison and crashed), a within_pct leaf is \"compare\"", () => {
  assert.equal(conditionKind(pattern), "pattern");
  assert.equal(conditionKind(within), "compare");
  assert.equal(conditionKind(compare), "compare");
  assert.equal(conditionKind(time), "time_between");
  assert.equal(conditionKind({ all: [compare] }), "all");
  assert.equal(conditionKind({ any: [compare] }), "any");
  assert.equal(conditionKind({ not: compare }), "not");
});

test("newCondition: every kind is a valid condition of that kind", () => {
  for (const kind of KINDS) {
    const made = newCondition(kind);
    assert.equal(conditionKind(made), kind);
    assert.equal(ConditionSchema.safeParse(made).success, true, kind);
  }
  assert.deepEqual(newCondition("compare"), { op: "gte", left: { series: "close" }, right: { value: 0 } });
  assert.deepEqual(newCondition("time_between"), { op: "time_between", start: "09:30", end: "16:00" });
  assert.deepEqual(newCondition("pattern"), { op: "pattern", pattern: "hammer" });
});

test("changeKind table", () => {
  for (const c of [compare, within, time, pattern, { all: [compare] }, { any: [compare] }, { not: compare }] as Condition[]) {
    assert.equal(changeKind(c, conditionKind(c)), c, "same kind returns the same reference");
  }
  assert.deepEqual(changeKind(compare, "not"), { not: compare });
  assert.deepEqual(changeKind(compare, "all"), { all: [compare] });
  assert.deepEqual(changeKind(time, "any"), { any: [time] });
  assert.deepEqual(changeKind({ all: [compare, time] }, "any"), { any: [compare, time] }, "all to any keeps the children");
  assert.deepEqual(changeKind({ any: [compare, time] }, "all"), { all: [compare, time] });
  assert.deepEqual(changeKind({ all: [pattern, time] }, "pattern"), pattern, "group to leaf picks the first child");
  assert.deepEqual(changeKind({ any: [within, time] }, "compare"), within, "a within_pct first child is already a comparison");
  assert.deepEqual(changeKind({ all: [compare, time] }, "time_between"), newCondition("time_between"), "no child of that kind: the default");
  assert.deepEqual(changeKind({ not: pattern }, "compare"), newCondition("compare"), "not to a leaf unwraps first");
  assert.deepEqual(changeKind({ not: time }, "time_between"), time);
  assert.deepEqual(changeKind(compare, "time_between"), { op: "time_between", start: "09:30", end: "16:00" });
  assert.deepEqual(changeKind(compare, "pattern"), { op: "pattern", pattern: "hammer" });
  assert.deepEqual(changeKind({ not: compare }, "all"), { all: [{ not: compare }] }, "as the builder does today, a not under a new group stays a child");
});

test("changeKind never mutates its input", () => {
  const input: Condition = { all: [compare, { not: time }] };
  const before = structuredClone(input);
  for (const kind of KINDS) changeKind(input, kind);
  assert.deepEqual(input, before);
});

test("withOperator: keeps operands; within_pct sets pct to 1 or keeps it; to pattern and back", () => {
  const lt = withOperator(compare, "lt");
  assert.deepEqual(lt, { op: "lt", left: compare.left, right: compare.right });
  assert.deepEqual(withOperator(lt, "within_pct"), { op: "within_pct", left: { series: "close" }, right: { series: "vwap" }, pct: 1 });
  assert.deepEqual(withOperator(within, "within_pct"), within, "an existing pct is kept");
  assert.deepEqual(withOperator(within, "crosses_above"), { op: "crosses_above", left: within.left, right: within.right }, "pct is dropped");
  assert.deepEqual(withOperator(compare, "pattern"), { op: "pattern", pattern: "hammer" });
  assert.deepEqual(withOperator(pattern, "gt"), { op: "gt", left: { series: "close" }, right: { value: 0 } });
});

const group = (count: number): Extract<Condition, { all: Condition[] }> => ({ all: Array.from({ length: count }, () => compare) });

test("add/remove/replace never mutate the input and honour 1 and 20", () => {
  const one = group(1);
  const full = group(MAX_CHILDREN);
  const frozen = structuredClone(full);
  assert.equal(canAddChild(one), true);
  assert.equal(canAddChild(full), false);
  assert.equal(canRemoveChild(one), false);
  assert.equal(canRemoveChild(full), true);
  assert.equal(canAddChild(compare), false);
  assert.equal(canRemoveChild(compare), false);

  assert.equal(addChild(full), full, "a full group is returned as is");
  assert.equal(removeChild(one, 0), one, "the last child cannot go");
  const grown = addChild(one, time);
  assert.deepEqual(grown, { all: [compare, time] });
  assert.notEqual(grown.all, one.all);
  assert.deepEqual(one, { all: [compare] }, "input untouched");
  assert.deepEqual(addChild(one), { all: [compare, newCondition("compare")] }, "the default child is a comparison");

  const shrunk = removeChild({ any: [compare, time, pattern] }, 1);
  assert.deepEqual(shrunk, { any: [compare, pattern] });
  const swapped = replaceChild({ any: [compare, time] }, 0, pattern);
  assert.deepEqual(swapped, { any: [pattern, time] });
  assert.equal((removeChild(full, 3) as typeof full).all.length, MAX_CHILDREN - 1);
  assert.deepEqual(full, frozen, "no operation touched the 20-child input");
  assert.equal(ConditionSchema.safeParse(addChild(group(MAX_CHILDREN - 1))).success, true);
});

test("nestingLeft blocks new nesting at MAX_NESTING but a deeper stored tree is untouched by every non-adding operation", () => {
  assert.equal(MAX_NESTING, 4);
  assert.equal(nestingLeft(0), MAX_NESTING);
  assert.equal(nestingLeft(MAX_NESTING - 1), 1);
  assert.equal(nestingLeft(MAX_NESTING), 0);
  assert.equal(nestingLeft(MAX_NESTING + 3), 0, "a deeper stored tree never goes negative");

  // Seven levels (all, not, all, not, ...) with a group at the root: three deeper than the UI would let a user build.
  let deep: Condition = compare;
  for (let level = 0; level < MAX_NESTING + 3; level += 1) deep = level % 2 === 0 ? { all: [deep, time] } : { not: deep };
  const before = structuredClone(deep);
  assert.deepEqual(replaceChild(deep as { all: Condition[] }, 0, (deep as { all: Condition[] }).all[0]!), before);
  assert.deepEqual(removeChild(deep as { all: Condition[] }, 1), { all: [(before as { all: Condition[] }).all[0]] });
  assert.deepEqual(deep, before, "the stored tree is untouched");
});

const templates = new URL("../../../contracts/templates/", import.meta.url);
const specFiles = ["", "filters/", "patterns/", "setups/"].flatMap((dir) =>
  readdirSync(new URL(dir, templates)).filter((file) => file.endsWith(".json")).map((file) => dir + file),
);

test("every shipped template when is a no-op through replaceChild with itself; every node has a kind", () => {
  assert.equal(specFiles.length, 11 + 10 + 20 + 6);
  const walk = (node: Condition, file: string): Condition => {
    assert.ok(KINDS.includes(conditionKind(node)), file);
    if ("not" in node) return { not: walk(node.not, file) };
    if (!("all" in node) && !("any" in node)) return node;
    const children = "all" in node ? node.all : node.any;
    let next = node;
    children.forEach((child, index) => {
      next = replaceChild(next as { all: Condition[] }, index, walk(child, file));
    });
    assert.deepEqual(next, node, file);
    return next;
  };
  for (const file of specFiles) {
    const when = ConditionSchema.parse(JSON.parse(readFileSync(new URL(file, templates), "utf8")).when);
    assert.deepEqual(walk(when, file), when, file);
  }
});

test("nodePath builds the strings the contract's issues use (round trip against a real nested failure)", () => {
  assert.equal(nodePath("when"), "when");
  assert.equal(nodePath("when", "all", 1), "when.all.1");
  assert.equal(nodePath("when.all.1", "not"), "when.all.1.not");
  const nested: Condition = { all: [compare, { any: [time, { not: { op: "gt", left: { series: "sma", length: 1 }, right: { value: 1 } } }] }] };
  const spec = { ...JSON.parse(readFileSync(new URL("patterns/hammer.json", templates), "utf8")), when: nested };
  const failure = StrategySpecV1Schema.safeParse(spec);
  if (failure.success) assert.fail("the nested spec should not validate");
  const paths = (groupSpecErrors(failure.error).When ?? []).map((problem) => problem.path);
  const node = nodePath(nodePath(nodePath(nodePath("when", "all", 1), "any", 1), "not"));
  assert.deepEqual(paths, [`${node}.left.length`]);
});
