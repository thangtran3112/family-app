import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { FilterStrategySpecV1Schema } from "@ai-trading/contracts/filter-strategy-spec-v1";
import {
  addRow,
  formToSpec,
  isDirty,
  newRow,
  problemsFor,
  problemsForRow,
  removeRow,
  rowKind,
  specToForm,
  symbolsFromText,
  unplacedProblems,
  updateRow,
} from "./filterForm.ts";
import { choiceOf, OPERAND_CATALOG, operandFor } from "./operands.ts";

const dir = new URL("../../../contracts/templates/filters/", import.meta.url);
const templates = readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => ({
  file,
  spec: FilterStrategySpecV1Schema.parse(JSON.parse(readFileSync(new URL(file, dir), "utf8"))),
}));

test("every shipped filter survives form and back unchanged and still validates", () => {
  assert.equal(templates.length, 10);
  for (const { file, spec } of templates) {
    const back = formToSpec(specToForm(spec));
    assert.deepEqual(back, JSON.parse(JSON.stringify(spec)), file);
    assert.equal(FilterStrategySpecV1Schema.safeParse(back).success, true, file);
  }
});

test("a fresh form is not dirty; editing any field, row or the rank is", () => {
  const original = specToForm(templates[0]!.spec);
  assert.equal(isDirty(original, specToForm(templates[0]!.spec)), false);
  assert.equal(isDirty(original, { ...original, name: "Other" }), true);
  assert.equal(isDirty(original, { ...original, maxResults: "10" }), true);
  assert.equal(isDirty(original, addRow(original)), true);
  assert.equal(isDirty(original, { ...original, rankEnabled: !original.rankEnabled }), true);
  assert.equal(isDirty(original, { ...original, session: original.session === "regular" ? "extended" : "regular" }), true);
});

test("rows: add, edit, remove; one row is the condition itself, several wrap in all or any", () => {
  let form = specToForm(templates.find((t) => t.file === "abnormal-volume.json")!.spec);
  assert.equal(form.rows.length, 1);
  assert.equal("op" in (formToSpec(form).when as object), true);
  form = addRow(form);
  assert.deepEqual(Object.keys(formToSpec(form).when as object), ["all"]);
  form = { ...form, mode: "any" };
  assert.deepEqual(Object.keys(formToSpec(form).when as object), ["any"]);
  form = updateRow(form, 1, { op: "lt", left: operandFor({ id: "rsi", params: { length: 7 } }), right: { value: 30 } });
  assert.deepEqual((formToSpec(form).when as { any: unknown[] }).any[1], { op: "lt", left: { series: "rsi", length: 7 }, right: { value: 30 } });
  assert.equal(removeRow(form, 1).rows.length, 1);
  assert.equal(rowKind(newRow()), "compare");
  assert.equal(rowKind({ op: "within_pct", left: { series: "close" }, right: { series: "vwap" }, pct: 1 }), "within_pct");
  assert.equal(rowKind({ not: newRow() }), "static");
  assert.equal(rowKind({ op: "pattern", pattern: "hammer" }), "static");
});

test("bad input never throws: the spec carries it and the server explains", () => {
  const form = { ...specToForm(templates[0]!.spec), maxResults: "abc", minPrice: "x" };
  const spec = formToSpec(form);
  assert.equal(Number.isNaN(spec.maxResults), true);
  assert.equal(FilterStrategySpecV1Schema.safeParse(spec).success, false);
  assert.deepEqual(symbolsFromText(" nvda, amd  tsla,,"), ["NVDA", "AMD", "TSLA"]);
});

test("universe kinds map both ways", () => {
  const base = specToForm(templates[0]!.spec);
  assert.deepEqual((formToSpec({ ...base, universe: "watchlist", watchlist: "Day movers" }).watch as { universe: unknown }).universe, { watchlist: "Day movers" });
  assert.deepEqual((formToSpec({ ...base, universe: "symbols", symbols: "nvda amd" }).watch as { universe: unknown }).universe, { symbols: ["NVDA", "AMD"] });
  assert.deepEqual((formToSpec({ ...base, universe: "market" }).watch as { universe: unknown }).universe, { market: "us_equities" });
});

test("server problems land on the right field and row", () => {
  const problems = [
    { path: "watch.runOn", message: "pick a run time" },
    { path: "when.all.1.right.value", message: "must be a number" },
    { path: "maxResults", message: "use 1 to 100" },
    { path: "something.else", message: "other" },
  ];
  const form = { mode: "all" as const, rows: [newRow(), newRow()] };
  assert.deepEqual(problemsFor(problems, "watch"), [problems[0]]);
  assert.deepEqual(problemsForRow(problems, form, 1), [problems[1]]);
  assert.deepEqual(problemsForRow(problems, form, 0), []);
  assert.deepEqual(problemsForRow([{ path: "when.right.value", message: "x" }], { mode: "all", rows: [newRow()] }, 0).length, 1);
  assert.deepEqual(unplacedProblems(problems, form), [problems[3]]);
});

test("operand picker: every catalog entry round-trips and numbers are values", () => {
  for (const def of OPERAND_CATALOG) {
    const params = Object.fromEntries(def.params.map((p) => [p.key, p.defaultValue]));
    const operand = operandFor({ id: def.id, params });
    assert.deepEqual(choiceOf(operand), { id: def.id, params }, def.id);
  }
  assert.deepEqual(choiceOf({ value: 2.5 }), { id: "value", value: 2.5 });
  assert.equal(choiceOf({ series: "macd", line: "line", fast: 12, slow: 26, signal: 9 }), null);
  assert.deepEqual(operandFor({ id: "sma", params: {} }), { series: "sma", length: 20 });
  assert.deepEqual(operandFor({ id: "value", value: 7 }), { value: 7 });
  assert.throws(() => operandFor({ id: "nope", params: {} }));
});

test("every operand in the shipped filters is either in the picker or kept read-only", () => {
  let unknown = 0;
  const walk = (condition: unknown) => {
    const c = condition as Record<string, unknown>;
    if ("all" in c) (c.all as unknown[]).forEach(walk);
    else if ("any" in c) (c.any as unknown[]).forEach(walk);
    else if ("left" in c) for (const side of [c.left, c.right]) if (choiceOf(side as never) === null) unknown += 1;
  };
  for (const { spec } of templates) walk(spec.when);
  assert.equal(unknown, 0, "all shipped filter operands are editable in the picker");
});
