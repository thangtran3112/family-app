import assert from "node:assert/strict";
import test from "node:test";
import { fitsWhole, labelSpan, niceTicks, textWidth } from "./ticks.ts";

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

test("a label is kept whole or left out: the edge of the axis never cuts one (D-180)", () => {
  assert.equal(textWidth("04:00 AM", 11), 56, "7 units a character at 11 px");
  assert.deepEqual(labelSpan(100, "abcd", 11, "middle"), [86, 114]);
  assert.deepEqual(labelSpan(100, "abcd", 11, "start"), [100, 128]);
  assert.deepEqual(labelSpan(100, "abcd", 11, "end"), [72, 100]);
  // "04:00 AM" centred on the first bar (x 0) loses its left half; centred 28 units in it just fits.
  assert.equal(fitsWhole(0, "04:00 AM", 11, "middle", 0, 520), false);
  assert.equal(fitsWhole(27, "04:00 AM", 11, "middle", 0, 520), false);
  assert.equal(fitsWhole(28, "04:00 AM", 11, "middle", 0, 520), true);
  assert.equal(fitsWhole(492, "04:00 AM", 11, "middle", 0, 520), true);
  assert.equal(fitsWhole(493, "04:00 AM", 11, "middle", 0, 520), false, "the right edge cuts too");
  // A y label ends at the gutter's right edge: too long for the gutter, it is left out.
  assert.equal(fitsWhole(68, "$51,500", 11, "end", 0, 760), true);
  assert.equal(fitsWhole(68, "$1,000,000.00", 11, "end", 0, 760), false);
});
