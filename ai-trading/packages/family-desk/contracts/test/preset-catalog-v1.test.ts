import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { FilterStrategySpecV1Schema } from "../src/filter-strategy-spec-v1.ts";
import { PresetCatalogV1Schema } from "../src/preset-catalog-v1.ts";
import { PATTERN_IDS, StrategySpecV1Schema } from "../src/strategy-spec-v1.ts";
import { jsonFiles, jsonPaths, readJson } from "./fixtures.ts";

const valid = jsonFiles("fixtures/preset-catalog-v1/valid");
const invalid = jsonFiles("fixtures/preset-catalog-v1/invalid");
const catalog = PresetCatalogV1Schema.parse(readJson("catalog.json"));
const templates = jsonPaths("templates");

test("fixture folders are not empty", () => {
  assert.ok(valid.length >= 4 && invalid.length >= 24);
});

for (const [name, doc] of valid) {
  test(`accepts ${name}`, () => {
    const result = PresetCatalogV1Schema.safeParse(doc);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
}

for (const [name, doc] of invalid) {
  test(`rejects ${name}`, () => {
    assert.equal(PresetCatalogV1Schema.safeParse(doc).success, false);
  });
}

test("catalog ids and files are unique", () => {
  const ids = catalog.entries.map((entry) => entry.id);
  const files = catalog.entries.map((entry) => entry.file);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(files).size, files.length);
});

test("every template file is cataloged, and every catalog file exists", () => {
  assert.deepEqual(catalog.entries.map((entry) => entry.file).sort(), templates);
});

test("the technical lane ships 47 presets: 10 filters, 37 strategies", () => {
  assert.equal(catalog.entries.length, 47);
  assert.equal(catalog.entries.filter((entry) => entry.kind === "filter").length, 10);
  assert.ok(catalog.entries.every((entry) => entry.lane === "technical"));
});

for (const entry of catalog.entries) {
  test(`${entry.id}: ${entry.file} parses as a ${entry.kind} and sits in the right folder`, () => {
    const schema = entry.kind === "filter" ? FilterStrategySpecV1Schema : StrategySpecV1Schema;
    const result = schema.safeParse(readJson(`templates/${entry.file}`));
    assert.ok(result.success, JSON.stringify(result.error?.issues));
    assert.equal(entry.file.startsWith("filters/"), entry.kind === "filter");
    assert.equal(entry.file.startsWith("patterns/"), entry.category === "candlestick");
    assert.equal(entry.file.split("/").pop(), `${entry.id}.json`);
  });
}

// Pattern presets: Paper-persona-split-plan section c2, "Pattern defaults".
const patternEntries = catalog.entries.filter((entry) => entry.file.startsWith("patterns/"));
type PatternWhen = { op: string; pattern: string; trend?: string; trendBars?: number; withinBars?: number };

test("one preset per candlestick pattern: 9 bullish, 9 bearish, 2 neutral", () => {
  assert.equal(patternEntries.length, PATTERN_IDS.length);
  const used = patternEntries.map((entry) => (readJson(`templates/${entry.file}`) as { when: PatternWhen }).when.pattern);
  assert.deepEqual([...used].sort(), [...PATTERN_IDS].sort());
  const bias = (name: string) => patternEntries.filter((entry) => entry.bias === name).length;
  assert.deepEqual([bias("bullish"), bias("bearish"), bias("neutral")], [9, 9, 2]);
});

for (const entry of patternEntries) {
  test(`${entry.id}: pattern defaults (withinBars 1, 5m or 15m, trend by bias)`, () => {
    const spec = readJson(`templates/${entry.file}`) as {
      watch: { runOn: string };
      when: PatternWhen;
      then: { alert: Record<string, unknown> };
    };
    assert.equal(spec.when.op, "pattern");
    assert.equal(spec.when.withinBars, 1);
    assert.ok(["bar_close_5m", "bar_close_15m"].includes(spec.watch.runOn));
    const trend = { bullish: "after_downtrend", bearish: "after_uptrend", neutral: undefined }[entry.bias];
    assert.equal(spec.when.trend, trend);
    assert.equal(spec.when.trendBars, trend ? 5 : undefined);
    assert.equal(spec.then.alert.paperOrder, undefined);
  });
}

// The five new non-candlestick presets (plan section c2, bold rows), by what their rule is.
type Node = { op?: string; left?: unknown; right?: unknown; all?: Node[]; any?: Node[]; not?: Node };

function comparisons(node: Node): Node[] {
  return [node, ...(node.all ?? []).flatMap(comparisons), ...(node.any ?? []).flatMap(comparisons), ...(node.not ? comparisons(node.not) : [])];
}

function hasComparison(file: string, op: string, left: object, right: object): boolean {
  const { when } = readJson(`templates/${file}`) as { when: Node };
  return comparisons(when).some((node) => node.op === op && isDeepStrictEqual(node.left, left) && isDeepStrictEqual(node.right, right));
}

const CLOSE = { series: "close" };
const cross = (file: string, left: object, right: object) =>
  hasComparison(file, "crosses_above", left, right) && hasComparison(file, "crosses_below", left, right);

test("high-of-day break crosses above session_high", () => {
  assert.ok(hasComparison("setups/hod-break.json", "crosses_above", CLOSE, { level: "session_high" }));
});

test("red-to-green crosses above prior_day_close", () => {
  assert.ok(hasComparison("setups/red-to-green.json", "crosses_above", CLOSE, { level: "prior_day_close" }));
});

test("EMA 9/21 cross goes both ways", () => {
  assert.ok(cross("setups/ema-9-21-cross.json", { series: "ema", length: 9 }, { series: "ema", length: 21 }));
});

test("golden/death cross is SMA 50 against SMA 200, both ways", () => {
  assert.ok(cross("setups/golden-death-cross.json", { series: "sma", length: 50 }, { series: "sma", length: 200 }));
});

test("MACD signal cross compares the MACD line with its signal, both ways", () => {
  const macd = (line: string) => ({ series: "macd", line, fast: 12, slow: 26, signal: 9 });
  assert.ok(cross("setups/macd-signal-cross.json", macd("line"), macd("signal")));
});
