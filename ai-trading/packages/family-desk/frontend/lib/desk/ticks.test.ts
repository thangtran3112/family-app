import assert from "node:assert/strict";
import test from "node:test";
import { niceTicks } from "./ticks.ts";

test("ticks are round (1, 2, 5 times a power of ten), ascending, and cover the data", () => {
  assert.deepEqual(niceTicks(49753, 50123, { minStep: 1 }), [49700, 49800, 49900, 50000, 50100, 50200]);
  assert.deepEqual(niceTicks(-182, 240, { minStep: 1 }), [-200, 0, 200, 400]);
  assert.deepEqual(niceTicks(0, 2, { minStep: 1 }).every(Number.isInteger), true, "whole dollars at least: a finer step would print the same figure twice");
});

test("a mirrored axis around zero keeps its decimals clean", () => {
  assert.deepEqual(niceTicks(-0.4, 0.4), [-0.4, -0.2, 0, 0.2, 0.4]);
  assert.deepEqual(niceTicks(-6.1, 6.1), [-10, -5, 0, 5, 10]);
  assert.deepEqual(niceTicks(-18, 18), [-20, -10, 0, 10, 20]);
});

test("inside keeps every tick within [min, max] (a chart that cannot draw past its domain)", () => {
  assert.deepEqual(niceTicks(0, 790, { inside: true }), [0, 200, 400, 600]);
  assert.deepEqual(niceTicks(-20, 20, { inside: true }), [-20, -10, 0, 10, 20]);
  assert.deepEqual(niceTicks(0, 100, { inside: true }), [0, 50, 100]);
  assert.deepEqual(niceTicks(185, 278, { inside: true }), [200, 250]);
  for (const [min, max] of [[185, 278], [0.37, 4.91], [-3.2, 7.7]] as const) {
    for (const tick of niceTicks(min, max, { inside: true })) assert.ok(tick >= min && tick <= max, `${tick} in ${min}..${max}`);
  }
});

test("a flat or unreadable range has no ticks", () => {
  assert.deepEqual(niceTicks(5, 5), []);
  assert.deepEqual(niceTicks(Number.NaN, 5), []);
  assert.deepEqual(niceTicks(0, Number.POSITIVE_INFINITY), []);
  assert.deepEqual(niceTicks(9, 3), []);
});
