import assert from "node:assert/strict";
import test from "node:test";
import { delayUntilNextTick, jumpMinutes, nextTo, reachedEnd, speedForDigit, SPEEDS, threadClock, TICK_MS } from "./clock.ts";

const END = "2026-04-07T20:00:00Z";

test("each tick asks for speed market seconds ahead and never past the window end", () => {
  assert.equal(nextTo("2026-04-07T14:07:00Z", 1, END), "2026-04-07T14:07:01.000Z");
  assert.equal(nextTo("2026-04-07T14:07:00Z", 10, END), "2026-04-07T14:07:10.000Z");
  assert.equal(nextTo("2026-04-07T19:59:55Z", 10, END), "2026-04-07T20:00:00.000Z");
  assert.equal(nextTo(END, 5, END), "2026-04-07T20:00:00.000Z");
});

test("jumps are whole minutes, clamped to the window end", () => {
  assert.equal(jumpMinutes("2026-04-07T14:07:00Z", 5, END), "2026-04-07T14:12:00.000Z");
  assert.equal(jumpMinutes("2026-04-07T19:50:00Z", 15, END), "2026-04-07T20:00:00.000Z");
});

test("the thread's time is the shared day clock, never a name's older playhead", () => {
  const behind = "2026-04-07T14:00:00Z";
  const clock = "2026-04-07T14:30:00Z";
  assert.equal(threadClock(behind, clock), clock); // a name left behind shows the thread's time
  assert.equal(threadClock(clock, clock), clock);
  assert.equal(threadClock(clock, behind), clock); // the playhead is never pulled back by a stale clock
  assert.equal(threadClock(behind, null), behind); // a standalone session has only its own playhead
  // ...and Play and Jump start from it, so a name behind the clock does not spend its first tick catching up.
  assert.equal(nextTo(threadClock(behind, clock), 5, END), "2026-04-07T14:30:05.000Z");
  assert.equal(jumpMinutes(threadClock(behind, clock), 5, END), "2026-04-07T14:35:00.000Z");
});

test("digits 1 to 4 pick 1x 2x 5x 10x", () => {
  assert.deepEqual([...SPEEDS], [1, 2, 5, 10]);
  assert.deepEqual(["1", "2", "3", "4"].map(speedForDigit), [1, 2, 5, 10]);
  assert.equal(speedForDigit("0"), null);
  assert.equal(speedForDigit("5"), null);
  assert.equal(speedForDigit("x"), null);
});

test("a slow answer shortens the pause but never below zero, so requests cannot stack", () => {
  assert.equal(delayUntilNextTick(1000, 1200), TICK_MS - 200);
  assert.equal(delayUntilNextTick(1000, 2500), 0);
  assert.equal(reachedEnd(END, END), true);
  assert.equal(reachedEnd("2026-04-07T19:59:59Z", END), false);
});
