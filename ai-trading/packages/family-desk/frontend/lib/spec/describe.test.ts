import assert from "node:assert/strict";
import test from "node:test";
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
    "At the 08:30 premarket scan during extended hours, alert when gap % is at least 3 or gap % is at most -3, and relative volume (10 days) is at least 2; notify inbox and telegram.",
  );
});

test("describes each shipped template as readable preview text", () => {
  for (const template of STRATEGY_TEMPLATES) {
    const description = describeSpec(template.spec);
    assert.match(description, /^At .+ alert when .+; notify .+\.$/, template.slug);
    assert.ok(description.includes("20-day high") || template.slug !== "n-day-breakout", description);
  }
});
