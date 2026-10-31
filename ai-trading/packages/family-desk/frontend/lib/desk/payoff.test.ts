import assert from "node:assert/strict";
import test from "node:test";
import { coveredCallPayoff, payoffAt, scaleLinear } from "./payoff.ts";

test("the payoff is the stock move plus the premium, capped at the strike", () => {
  // Bought at 231.40, sold the 245 call for 2.85: the most it makes is 245 - 231.40 + 2.85 = 16.45.
  const payoff = coveredCallPayoff(231.4, 245, 2.85)!;
  assert.ok(Math.abs(payoff.maxProfit - 16.45) < 1e-9);
  assert.ok(Math.abs(payoff.breakeven - 228.55) < 1e-9);
  assert.ok(Math.abs(payoffAt(300, 231.4, 245, 2.85) - 16.45) < 1e-9, "capped above the strike");
  assert.ok(Math.abs(payoffAt(231.4, 231.4, 245, 2.85) - 2.85) < 1e-9, "flat stock keeps the premium");
  assert.ok(Math.abs(payoffAt(228.55, 231.4, 245, 2.85)) < 1e-9, "zero at the breakeven");
  assert.deepEqual(payoff.points.map((point) => point.price), [231.4 * 0.8, 245, 231.4 * 1.2]);
  assert.ok(Math.abs(payoff.points[1]!.pl - 16.45) < 1e-9);
  assert.deepEqual(payoff.xDomain, [231.4 * 0.8, 231.4 * 1.2]);
  assert.ok(payoff.yDomain[0] < payoff.points[0]!.pl && payoff.yDomain[1] > 16.45);
});

test("a strike beyond the range draws two straight points, and bad inputs draw nothing", () => {
  const far = coveredCallPayoff(100, 150, 1)!;
  assert.equal(far.points.length, 2);
  assert.equal(coveredCallPayoff(null, 245, 2.85), null);
  assert.equal(coveredCallPayoff(0, 245, 2.85), null);
  assert.equal(coveredCallPayoff(231.4, 245, Number.NaN), null);
  assert.equal(coveredCallPayoff(231.4, -1, 1), null);
});

test("axis ticks are round numbers inside the range", () => {
  const payoff = coveredCallPayoff(231.4, 245, 2.85)!;
  for (const tick of payoff.xTicks) assert.ok(tick >= payoff.xDomain[0] && tick <= payoff.xDomain[1]);
  for (const tick of payoff.yTicks) assert.ok(tick >= payoff.yDomain[0] && tick <= payoff.yDomain[1]);
  assert.ok(payoff.yTicks.includes(0));
});

test("scaleLinear maps a domain onto a pixel range, reversed for the y axis", () => {
  assert.equal(scaleLinear(5, [0, 10], [0, 200]), 100);
  assert.equal(scaleLinear(0, [0, 10], [100, 0]), 100);
  assert.equal(scaleLinear(10, [0, 10], [100, 0]), 0);
  assert.equal(scaleLinear(3, [4, 4], [7, 9]), 7);
});
