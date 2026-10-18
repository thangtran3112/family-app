import assert from "node:assert/strict";
import test from "node:test";
import { divergingBars, lineCoordinates, scalePercent } from "./chart-geometry.ts";

function assertNear(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be near ${expected}`);
}

test("divergingBars maps numeric returns proportionally around zero", () => {
  const bars = divergingBars([
    { label: "gain", value: 2 },
    { label: "loss", value: -1 },
    { label: "flat", value: 0 },
  ]);

  assert.equal(bars[0]?.topPercent, 0);
  assertNear(bars[0]?.heightPercent ?? NaN, 200 / 3);
  assertNear(bars[1]?.topPercent ?? NaN, 200 / 3);
  assertNear(bars[1]?.heightPercent ?? NaN, 100 / 3);
  assertNear(bars[2]?.topPercent ?? NaN, 200 / 3);
  assert.equal(bars[2]?.heightPercent, 0);
  assert.ok(bars.every((bar) => Math.abs(bar.baselinePercent - 200 / 3) < 1e-9));
});

test("divergingBars returns empty geometry for empty series", () => {
  assert.deepEqual(divergingBars([]), []);
});

test("lineCoordinates maps larger values upward across the supplied width", () => {
  assert.deepEqual(lineCoordinates([10, 20, 0], 100, 100), [
    { x: 0, y: 50 }, { x: 50, y: 0 }, { x: 100, y: 100 },
  ]);
});

test("lineCoordinates shares one numeric domain when comparing series", () => {
  const domain = { minimum: 100, maximum: 250 };
  const strategy = lineCoordinates([100, 180.3], 100, 100, domain);
  const benchmark = lineCoordinates([100, 250], 100, 100, domain);

  assertNear(strategy[1]?.y ?? NaN, ((250 - 180.3) / 150) * 100);
  assert.equal(benchmark[1]?.y, 0);
});

test("scalePercent places a value relative to numeric bounds", () => {
  assertNear(scalePercent(268, 236, 312), 42.10526315789473);
});
