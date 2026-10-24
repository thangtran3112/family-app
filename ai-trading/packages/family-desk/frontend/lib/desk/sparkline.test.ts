import assert from "node:assert/strict";
import test from "node:test";
import { sparkline } from "./sparkline.ts";

test("a rising series draws bottom-left to top-right and closes the area", () => {
  const s = sparkline([1, 2, 3], 102, 52, 2);
  assert.equal(s.line, "M2.0 50.0 L51.0 26.0 L100.0 2.0");
  assert.ok(s.area.endsWith("L100.0 50.0 L2.0 50.0 Z"));
  assert.deepEqual(s.last, { x: 100, y: 2 });
  assert.equal(s.up, true);
});

test("gaps are skipped, a flat series stays on screen and fewer than two points draw nothing", () => {
  assert.equal(sparkline([1, null, 3], 102, 52, 2).line, "M2.0 50.0 L100.0 2.0");
  assert.match(sparkline([5, 5, 5], 100, 40).line, /^M[\d.]+ [\d.]+ L/);
  assert.deepEqual(sparkline([1], 100, 40), { line: "", area: "", last: null, up: true });
  assert.equal(sparkline([null, Number.NaN], 100, 40).line, "");
  assert.equal(sparkline([3, 1], 100, 40).up, false);
});
