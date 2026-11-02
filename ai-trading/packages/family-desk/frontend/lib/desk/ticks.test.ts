import assert from "node:assert/strict";
import test from "node:test";
import { MIN_CHART_WIDTH, fitBox, fitsWhole, labelSpan, niceTicks, textWidth } from "./ticks.ts";

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

test("a chart is drawn at its column's width, so its type keeps its size when the column narrows (D-202)", () => {
  // The journal's balance curve: a 760-unit box, 11 px labels. The SVG fills its column, so a label's size on screen is its size times column / box width.
  const BOX = { width: 760, height: 240, left: 76, right: 24, top: 16, bottom: 36 };
  const onScreen = (box: { width: number }, column: number) => (11 * column) / box.width;
  // 1180 with a drawer open: a 580 px centre column leaves the chart 548 px. The fixed box shrank every label to 7.9 px, under the 11 px floor.
  assert.equal(onScreen(BOX, 548).toFixed(1), "7.9");
  assert.equal(fitBox(BOX, 548).width, 548);
  assert.ok(onScreen(fitBox(BOX, 548), 548) >= 11, "drawn at 548 units, 548 px wide: 11 px");
  // A column that is not a whole number of pixels never rounds the box up past it (that would scale the type under 11 px again).
  assert.ok(onScreen(fitBox(BOX, 548.6), 548.6) >= 11);
  // A wide column keeps the box and its look: the type grows with the screen, as before (11.7 px at 1440).
  assert.deepEqual(fitBox(BOX, 806), BOX);
  assert.equal(onScreen(fitBox(BOX, 806), 806).toFixed(1), "11.7");
  // Only the width changes, and never below what the plot needs; a column nobody has measured yet draws the box as it was.
  assert.deepEqual({ ...fitBox(BOX, 548), width: 760 }, BOX);
  assert.equal(fitBox(BOX, 200).width, MIN_CHART_WIDTH);
  assert.deepEqual(fitBox(BOX, null), BOX);
});
