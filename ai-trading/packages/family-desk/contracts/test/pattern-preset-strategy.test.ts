import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonEqual } from "../src/json-pointer.ts";
import {
  PATTERN_RULES,
  PatternDirectionSchema,
  PatternKindSchema,
  PatternPresetSchema,
  PatternSpecSchema,
  PatternToleranceSchema,
  type PatternKind,
} from "../src/pattern-preset-strategy.ts";
import { jsonFiles } from "./fixtures.ts";

const valid = jsonFiles("fixtures/pattern-preset-strategy/valid");
const invalid = jsonFiles("fixtures/pattern-preset-strategy/invalid");
const shipped = jsonFiles("presets/patterns");

const SHIPPED_IDS = [
  "bearish-engulfing",
  "bearish-reversal",
  "breakout-down",
  "breakout-up",
  "bullish-engulfing",
  "bullish-reversal",
  "doji",
  "evening-star",
  "hammer",
  "inverted-hammer",
  "morning-star",
  "three-black-crows",
  "three-white-soldiers",
];

test("fixture folders are not empty and the shipped catalog is complete", () => {
  assert.ok(valid.length >= 6 && invalid.length >= 16);
  assert.deepEqual(shipped.map(([name]) => name.replace(/\.json$/, "")).sort(), SHIPPED_IDS);
});

for (const [name, preset] of [...valid, ...shipped]) {
  test(`accepts ${name}`, () => {
    const result = PatternPresetSchema.safeParse(preset);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  test(`parse output round-trips ${name}`, () => {
    assert.ok(jsonEqual(PatternPresetSchema.parse(preset), preset));
  });
}

for (const [name, preset] of invalid) {
  test(`rejects ${name}`, () => {
    assert.equal(PatternPresetSchema.safeParse(preset).success, false);
  });
}

test("every PATTERN_RULES kind has at least one shipped preset", () => {
  const shippedKinds = new Set(shipped.map(([, preset]) => PatternPresetSchema.parse(preset).spec.pattern));
  assert.deepEqual([...shippedKinds].sort(), [...PatternKindSchema.options].sort());
  assert.deepEqual(Object.keys(PATTERN_RULES).sort(), [...PatternKindSchema.options].sort());
});

test("the tolerance schema has exactly the keys the table uses", () => {
  const tableKeys = new Set(Object.values(PATTERN_RULES).flatMap((rule) => rule.tolerance));
  assert.deepEqual(Object.keys(PatternToleranceSchema.shape).sort(), [...tableKeys].sort());
});

// Sample values inside every tolerance range, so a rule table entry is checked on its own.
const SAMPLE_TOLERANCE: Record<string, number> = {
  bodyMaxPct: 50,
  bodyMinPct: 50,
  starBodyMaxPct: 50,
  shadowMinRatio: 2,
  engulfMinRatio: 2,
  bufferPct: 1,
  retracePct: 50,
};

function sampleSpec(kind: PatternKind, direction: string) {
  const rule = PATTERN_RULES[kind];
  return {
    pattern: kind,
    direction,
    timeframe: "1d",
    ...(rule.lookbackRequired ? { lookback: 20 } : {}),
    confirmation: { type: "none" },
    tolerance: Object.fromEntries(rule.tolerance.map((key) => [key, SAMPLE_TOLERANCE[key]])),
  };
}

for (const kind of PatternKindSchema.options) {
  test(`PATTERN_RULES ${kind} is self-consistent`, () => {
    const rule = PATTERN_RULES[kind];
    assert.equal(rule.category === "technical", rule.lookbackRequired);
    if (rule.category === "candlestick") assert.ok(rule.bars === 1 || rule.bars === 2 || rule.bars === 3);
    else assert.equal(rule.bars, null);
    assert.ok(rule.directions.length >= 1 && rule.tolerance.length >= 1);
    for (const direction of PatternDirectionSchema.options) {
      const accepted = PatternSpecSchema.safeParse(sampleSpec(kind, direction)).success;
      assert.equal(accepted, (rule.directions as readonly string[]).includes(direction), `${kind} ${direction}`);
    }
  });
}
