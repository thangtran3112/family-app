import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { COMPARE_OPERATORS, RUN_ONS, operatorLabel, optionLabel, runOnLabel } from "../spec/labels.ts";
import { describeCondition } from "../spec/describe.ts";
import { ALERT_OPERATORS } from "./alertForm.ts";
import { OPERATORS } from "./filterForm.ts";
import { runOnLabel as deskRunOnLabel } from "./labels.ts";

// DS-4: one run-on list and one operator wording (design-component-system §3.9). The screens read them from lib/spec/labels.ts; a
// copy in a form or a view model is the bug this test keeps out.

const components = new URL("../../components/", import.meta.url);
const sources = (dir: URL = components): string[] =>
  readdirSync(dir).flatMap((name) => {
    const child = new URL(name + (statSync(new URL(name, dir)).isDirectory() ? "/" : ""), dir);
    if (child.pathname.endsWith("/")) return sources(child);
    return /\.tsx?$/.test(name) ? [child.pathname] : [];
  });

test("the run-on list is spelled once: no component carries its own copy of the ids", () => {
  assert.equal(new Set(RUN_ONS).size, 7);
  const copies = sources().filter((file) => readFileSync(file, "utf8").includes("bar_close_1m"));
  assert.deepEqual(copies, [], "import RUN_ONS from lib/spec/labels.ts");
});

test("every run-on has one label, and the desk and spec modules agree on it", () => {
  for (const id of RUN_ONS) {
    assert.notEqual(runOnLabel(id), id, id);
    assert.equal(deskRunOnLabel(id), runOnLabel(id), id);
    assert.equal(optionLabel(id), runOnLabel(id), id);
  }
  assert.equal(runOnLabel("not_a_run_on"), "not_a_run_on");
});

test("every operator reads one way in the screener, the alert setup, the builder and the sentence", () => {
  for (const { op, label } of COMPARE_OPERATORS) {
    assert.equal(operatorLabel(op), label);
    assert.equal(OPERATORS.find((item) => item.op === op)?.label, label, `screener ${op}`);
    assert.equal(ALERT_OPERATORS.find((item) => item.id === op)?.label, label, `alert ${op}`);
    assert.equal(optionLabel(op), label, `builder ${op}`);
  }
  const sentence = describeCondition({ op: "crosses_above", left: { series: "close" }, right: { series: "vwap" } });
  assert.equal(sentence, `close ${operatorLabel("crosses_above")} VWAP`);
  assert.equal(describeCondition({ op: "lte", left: { series: "close" }, right: { value: 5 } }), `close ${operatorLabel("lte")} 5`);
});
