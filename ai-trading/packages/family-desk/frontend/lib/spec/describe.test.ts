import assert from "node:assert/strict";
import test from "node:test";
import { StrategySpecV1Schema, type StrategySpecV1 } from "@ai-trading/contracts";
import hammer from "../../../contracts/templates/patterns/hammer.json" with { type: "json" };
import { STRATEGY_TEMPLATES } from "../templates.ts";
import { describeSpec } from "./describe.ts";

test("describes VWAP reclaim as a human-readable preview", () => {
  const template = STRATEGY_TEMPLATES.find(({ slug }) => slug === "vwap-reclaim");
  assert.ok(template);
  assert.equal(
    describeSpec(template.spec),
    "At each 1-minute close during regular hours, alert when close crosses above VWAP and time is between 09:45 and 15:30; notify inbox and telegram; paper buy with $200 risk, stop 2× ATR, target 2R.",
  );
});

test("describes gap and go as a human-readable preview", () => {
  const template = STRATEGY_TEMPLATES.find(({ slug }) => slug === "gap-and-go");
  assert.ok(template);
  assert.equal(
    describeSpec(template.spec),
    "At the 08:30 premarket scan during extended hours, alert when (either gap % is at least 3 or gap % is at most -3) and relative volume (10 days) is at least 2; notify inbox and telegram.",
  );
});

test("keeps Pullback to average's trend requirement grouped with either pullback", () => {
  const template = STRATEGY_TEMPLATES.find(({ slug }) => slug === "pullback-to-average");
  assert.ok(template);
  assert.equal(
    describeSpec(template.spec),
    "At each daily close during regular hours, alert when SMA (20) is greater than SMA (50) and (either close is within 1% of SMA (20) or close is within 1% of SMA (50)); notify inbox and telegram; paper buy with $300 risk, stop 2× ATR, target 2R.",
  );
});

test("describes each shipped template as readable preview text", () => {
  for (const template of STRATEGY_TEMPLATES) {
    const description = describeSpec(template.spec);
    assert.match(description, /^At .+ alert when .+; notify .+\.$/, template.slug);
    assert.ok(description.includes("20-day high") || template.slug !== "n-day-breakout", description);
  }
});

test("describes a pattern preset with its trend requirement", () => {
  assert.equal(
    describeSpec(StrategySpecV1Schema.parse(hammer)),
    "At each 15-minute close during regular hours, alert when a hammer pattern appears after a downtrend over 5 bars; notify inbox.",
  );
});

test("describes pattern conditions across trend, window, and nesting variants", () => {
  const spec = StrategySpecV1Schema.parse(hammer);
  const describe = (when: unknown) => describeSpec({ ...spec, when } as StrategySpecV1).replace(/^.*alert when (.+); notify .*$/, "$1");
  assert.equal(describe({ op: "pattern", pattern: "doji" }), "a doji pattern appears");
  assert.equal(describe({ op: "pattern", pattern: "inverted_hammer", trend: "any", trendBars: 9, withinBars: 1 }), "an inverted hammer pattern appears");
  assert.equal(describe({ op: "pattern", pattern: "evening_star", trend: "after_uptrend" }), "an evening star pattern appears after an uptrend");
  assert.equal(
    describe({ op: "pattern", pattern: "three_black_crows", trend: "after_uptrend", trendBars: 8, withinBars: 3 }),
    "a three black crows pattern appears after an uptrend over 8 bars within the last 3 bars",
  );
  assert.equal(
    describe({ all: [{ op: "pattern", pattern: "inside_bar" }, { not: { op: "time_between", start: "09:30", end: "10:00" } }] }),
    "an inside bar pattern appears and not (time is between 09:30 and 10:00)",
  );
});
