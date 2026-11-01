import assert from "node:assert/strict";
import test from "node:test";
import { balanceTicks, barsLayout, curveLayout, dayTickStep, type Box } from "./threadChart.ts";
import { thread, threadCurve, threadDays } from "./threadFixtures.ts";
import { weeksOf } from "./threadView.ts";

const box: Box = { width: 700, height: 200, left: 60, right: 20, top: 10, bottom: 30 };

test("nice ticks are round, ascending and cover the data", () => {
  assert.deepEqual(balanceTicks(49753, 50123), [49700, 49800, 49900, 50000, 50100, 50200]);
  assert.deepEqual(balanceTicks(-182, 240), [-200, 0, 200, 400]);
  assert.deepEqual(balanceTicks(50000, 50000).length > 1, true);
  const ticks = balanceTicks(0, 0);
  assert.ok(ticks[0]! < ticks[ticks.length - 1]!);
});

test("the balance curve starts on the left edge, ends on the right, and puts the start line between the ticks", () => {
  const layout = curveLayout(threadCurve, threadDays, 50000, box);
  assert.equal(layout.points.length, 9);
  assert.equal(layout.points[0]!.x, 60);
  assert.equal(layout.points[8]!.x, 680);
  assert.equal(layout.points[0]!.label, "Start");
  assert.equal(layout.points[3]!.label, "D3");
  const top = layout.ticks[layout.ticks.length - 1]!;
  const bottom = layout.ticks[0]!;
  assert.ok(top.y < layout.startY && layout.startY < bottom.y);
  assert.equal(bottom.value < 49753 && top.value > 50123, true);
  // Higher balance, higher on the screen (smaller y).
  assert.ok(layout.points[8]!.y < layout.points[2]!.y);
});

test("skipped days are open circles, the lowest and the newest point are named", () => {
  const layout = curveLayout(threadCurve, threadDays, 50000, box);
  assert.deepEqual(layout.points.filter((point) => point.skipped).map((point) => point.label), ["D4", "D7"]);
  assert.equal(layout.lowest?.balance, 49753);
  assert.equal(layout.now?.balance, 50123);
  assert.match(layout.area, /Z$/);
});

test("a thread with no ended day draws no line and no labels, and one that never dipped has no lowest", () => {
  const empty = curveLayout([{ n: 0, day: null, balance: 50000 }], [], 50000, box);
  assert.equal(empty.points.length, 1);
  assert.equal(empty.now, null);
  assert.equal(empty.lowest, null);
  const up = curveLayout([{ n: 0, day: null, balance: 50000 }, { n: 1, day: "2026-03-02", balance: 50100 }], [{ ...threadDays[0]!, pnl_usd: 100, balance: 50100 }], 50000, box);
  assert.equal(up.lowest, null);
});

test("the day bars grow up from zero for a win and down for a loss, a skipped day has none, weeks span their days", () => {
  const layout = barsLayout(threadDays, weeksOf(threadDays), box);
  assert.equal(layout.slots.length, 8);
  const win = layout.slots[4]!;
  const loss = layout.slots[0]!;
  assert.equal(win.barY + win.barHeight, layout.zeroY);
  assert.equal(loss.barY, layout.zeroY);
  assert.ok(win.barHeight > loss.barHeight);
  assert.equal(layout.slots[3]!.kind, "skipped");
  assert.equal(layout.slots[3]!.barHeight, 0);
  assert.deepEqual(layout.weeks.map((week) => week.label), ["Week 1", "Week 2"]);
  assert.ok(layout.weeks[0]!.x2 < layout.weeks[1]!.x1);
  assert.equal(layout.ticks.some((tick) => tick.value === 0), true);
  assert.equal(barsLayout(thread.daily.slice(0, 1), weeksOf(thread.daily.slice(0, 1)), box).slots.length, 1);
});

test("days that all ended flat still get a readable axis with no repeated figure", () => {
  const flat = threadDays.map((day) => ({ ...day, pnl_usd: 0, kind: "practiced" as const }));
  const layout = barsLayout(flat, weeksOf(flat), box);
  const values = layout.ticks.map((tick) => tick.value);
  assert.deepEqual(values, [-50, 0, 50]);
  assert.equal(new Set(values.map((value) => Math.round(value))).size, values.length);
  assert.ok(layout.slots.every((slot) => slot.barHeight === 0));
  // A few dollars of spread never makes the step finer than a whole dollar.
  assert.ok(balanceTicks(0, 2).every((value) => Number.isInteger(value)));
});

test("an x axis labels days at one regular step: every day up to ten, then every 5, 10, 25 or 50 (D-123)", () => {
  assert.deepEqual([1, 3, 10].map(dayTickStep), [1, 1, 1]);
  assert.deepEqual([11, 15, 20, 23, 50].map(dayTickStep), [5, 5, 5, 5, 5]);
  assert.deepEqual([51, 100].map(dayTickStep), [10, 10]);
  assert.deepEqual([101, 250, 500].map(dayTickStep), [25, 25, 50]);
  assert.equal(dayTickStep(0), 1, "a thread with no day yet still has a step");
});
