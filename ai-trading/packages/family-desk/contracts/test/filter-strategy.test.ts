import assert from "node:assert/strict";
import { test } from "node:test";
import { FilterPresetSchema, FilterStrategySchema, filterGroupStats } from "../src/filter-strategy.ts";
import { applyEdits, jsonEqual } from "../src/json-pointer.ts";
import { jsonFiles } from "./fixtures.ts";

const validStrategies = jsonFiles("fixtures/filter-strategy/valid");
const invalidStrategies = jsonFiles("fixtures/filter-strategy/invalid");
const shippedPresets = jsonFiles("presets/filters");
const validPresets = jsonFiles("fixtures/filter-strategy/valid-preset");
const invalidPresets = jsonFiles("fixtures/filter-strategy/invalid-preset");

test("fixture folders are not empty", () => {
  assert.ok(validStrategies.length >= 5 && invalidStrategies.length >= 14);
  assert.equal(shippedPresets.length, 7);
  assert.ok(validPresets.length >= 1 && invalidPresets.length >= 1);
});

for (const [name, strategy] of validStrategies) {
  test(`accepts ${name}`, () => {
    const result = FilterStrategySchema.safeParse(strategy);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
    assert.ok(jsonEqual(result.data, strategy));
  });
}

for (const [name, strategy] of invalidStrategies) {
  test(`rejects ${name}`, () => {
    assert.equal(FilterStrategySchema.safeParse(strategy).success, false);
  });
}

for (const [name, preset] of [...shippedPresets, ...validPresets]) {
  test(`accepts preset ${name}`, () => {
    const result = FilterPresetSchema.safeParse(preset);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
    assert.ok(jsonEqual(result.data, preset));
  });
}

for (const [name, preset] of invalidPresets) {
  test(`rejects preset ${name}`, () => {
    assert.equal(FilterPresetSchema.safeParse(preset).success, false);
  });
}

for (const [name, preset] of shippedPresets) {
  test(`${name}: every param at its min, then at its max, still parses as a FilterStrategy`, () => {
    const entry = FilterPresetSchema.parse(preset);
    for (const bound of ["min", "max"] as const) {
      const edits = entry.params.map((param) => ({ op: "replace" as const, path: param.path, value: param[bound] }));
      const strategy = applyEdits(entry.strategy, edits);
      const result = FilterStrategySchema.safeParse(strategy);
      assert.ok(result.success, `${bound}: ${JSON.stringify(result.error?.issues)}`);
    }
  });
}

test("filterGroupStats counts depth (top group = 1) and condition leaves", () => {
  const nested = FilterStrategySchema.parse(validStrategies.find(([name]) => name === "nested-all-any.json")?.[1]);
  assert.deepEqual(filterGroupStats(nested.match), { depth: 3, leaves: 5 });
});
