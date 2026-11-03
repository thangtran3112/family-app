import assert from "node:assert/strict";
import test from "node:test";
import { balanceTicks, barsLayout, curveLayout, dayTickStep, endLabelSpots, placeLabel, startNoteSpot, type Box } from "./threadChart.ts";
import type { CurvePoint, ThreadDate } from "./threads.ts";

const box: Box = { width: 700, height: 200, left: 60, right: 20, top: 10, bottom: 30 };

// A thread that traded on 8 ET dates, Mon 03-02 to Wed 03-11 (a weekend and a gap between them): losing, winning, flat and winning dates.
const PNL = [-182, 56, 140, 0, 240, -75, 31, 18];
const DAYS = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12"];
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Mon", "Tue", "Wed", "Thu"] as const;
const dates: ThreadDate[] = DAYS.map((day, index) => ({
  n: index + 1,
  day,
  weekday: WEEKDAY[index]!,
  trades: 1,
  pnl_usd: PNL[index]!,
  balance: 50000 + PNL.slice(0, index + 1).reduce((sum, value) => sum + value, 0),
}));
const curve: CurvePoint[] = [{ n: 0, day: null, balance: 50000 }, ...dates.map(({ n, day, balance }) => ({ n, day, balance }))];

test("nice ticks are round, ascending and cover the data", () => {
  assert.deepEqual(balanceTicks(49753, 50123), [49700, 49800, 49900, 50000, 50100, 50200]);
  assert.deepEqual(balanceTicks(-182, 240), [-200, 0, 200, 400]);
  assert.deepEqual(balanceTicks(50000, 50000).length > 1, true);
  const ticks = balanceTicks(0, 0);
  assert.ok(ticks[0]! < ticks[ticks.length - 1]!);
});

test("the balance curve starts on the left edge, ends on the right, and puts the start line between the ticks", () => {
  const layout = curveLayout(curve, 50000, box);
  assert.equal(layout.points.length, 9);
  assert.equal(layout.points[0]!.x, 60);
  assert.equal(layout.points[8]!.x, 680);
  assert.equal(layout.points[0]!.label, "Start");
  assert.equal(layout.points[3]!.label, "03-04", "a point is named by its ET date, not by a day number");
  const top = layout.ticks[layout.ticks.length - 1]!;
  const bottom = layout.ticks[0]!;
  assert.ok(top.y < layout.startY && layout.startY < bottom.y);
  assert.equal(bottom.value < 49818 && top.value > 50300, true);
  // Higher balance, higher on the screen (smaller y).
  assert.ok(layout.points[5]!.y < layout.points[1]!.y);
});

test("the lowest and the newest point are named, and every point is a date that traded", () => {
  const layout = curveLayout(curve, 50000, box);
  assert.equal(layout.lowest?.balance, 49818);
  assert.deepEqual([layout.now?.balance, layout.now?.day], [50228, "2026-03-12"]);
  assert.match(layout.area, /Z$/);
  assert.deepEqual(layout.points.slice(1).map((point) => point.day), DAYS);
});

test("a thread with no trade draws no line and no labels, and one that never dipped has no lowest", () => {
  const empty = curveLayout([{ n: 0, day: null, balance: 50000 }], 50000, box);
  assert.equal(empty.points.length, 1);
  assert.equal(empty.now, null);
  assert.equal(empty.lowest, null);
  const up = curveLayout([{ n: 0, day: null, balance: 50000 }, { n: 1, day: "2026-03-02", balance: 50100 }], 50000, box);
  assert.equal(up.lowest, null);
  assert.equal(up.now?.balance, 50100);
});

test("the date bars grow up from zero for a win and down for a loss, a flat date has none, and every date has a slot", () => {
  const layout = barsLayout(dates, box);
  assert.equal(layout.slots.length, 8);
  const win = layout.slots[4]!;
  const loss = layout.slots[0]!;
  assert.equal(win.barY + win.barHeight, layout.zeroY);
  assert.equal(loss.barY, layout.zeroY);
  assert.ok(win.barHeight > loss.barHeight);
  assert.equal(layout.slots[3]!.barHeight, 0, "a date that netted nothing draws no bar");
  assert.deepEqual(layout.slots.slice(0, 2).map((slot) => slot.label), ["03-02", "03-03"]);
  assert.equal(layout.ticks.some((tick) => tick.value === 0), true);
  assert.equal(barsLayout(dates.slice(0, 1), box).slots.length, 1);
  assert.equal(barsLayout([], box).slots.length, 0);
});

test("dates that all netted nothing still get a readable axis with no repeated figure", () => {
  const flat = dates.map((date) => ({ ...date, pnl_usd: 0 }));
  const layout = barsLayout(flat, box);
  const values = layout.ticks.map((tick) => tick.value);
  assert.deepEqual(values, [-50, 0, 50]);
  assert.equal(new Set(values.map((value) => Math.round(value))).size, values.length);
  assert.ok(layout.slots.every((slot) => slot.barHeight === 0));
  // A few dollars of spread never makes the step finer than a whole dollar.
  assert.ok(balanceTicks(0, 2).every((value) => Number.isInteger(value)));
});

test("an x axis labels points at one regular step: every one up to ten, then every 5, 10, 25 or 50 (D-123)", () => {
  assert.deepEqual([1, 3, 10].map(dayTickStep), [1, 1, 1]);
  assert.deepEqual([11, 15, 20, 23, 50].map(dayTickStep), [5, 5, 5, 5, 5]);
  assert.deepEqual([51, 100].map(dayTickStep), [10, 10]);
  assert.deepEqual([101, 250, 500].map(dayTickStep), [25, 25, 50]);
  assert.equal(dayTickStep(0), 1, "a thread with no trade yet still has a step");
});

// -- where the curve's labels go ---------------------------------------------------------------------------------------------------

test("the Starting balance note moves off the end labels when the balance is still at its start", () => {
  const plot = { x: 64, y: 16, width: 672, height: 192 };
  const layout = { plot, startY: 112 };
  // Nothing near the start line: the note keeps its place, above the line at the left.
  assert.deepEqual(startNoteSpot(layout, "Starting balance", []), { x: 70, y: 106, text: "Starting balance", anchor: "start" });
  // The live thread: balance flat at the start, the equity a hair below. Both end labels sit on the note's spot.
  const labels = [
    { x: 224, y: 128, text: "Equity $24,964.00", anchor: "end" as const },
    { x: 224, y: 104, text: "Balance $25,000.00", anchor: "end" as const },
  ];
  const moved = startNoteSpot(layout, "Starting balance", labels);
  assert.notDeepEqual([moved.x, moved.y], [70, 106], "the default spot collides");
  for (const label of labels) {
    const noteRight = moved.anchor === "end" ? moved.x : moved.x + moved.text.length * 7;
    const noteLeft = moved.anchor === "end" ? moved.x - moved.text.length * 7 : moved.x;
    const clear = noteRight <= label.x - label.text.length * 7 || noteLeft >= label.x || moved.y + 3 <= label.y - 11 || moved.y - 11 >= label.y + 3;
    assert.equal(clear, true, `the note clears "${label.text}"`);
  }
  // The balance rests on the bottom tick (a flat balance at the start): the spots under the start line are the row of the day labels, so the note takes the right end, above the line (D-123).
  const floor = { plot, startY: plot.y + plot.height };
  const flat = [{ x: 224, y: floor.startY - 8, text: "Balance $50,000.00", anchor: "end" as const }];
  const onFloor = startNoteSpot(floor, "Starting balance", flat);
  assert.deepEqual([onFloor.anchor, onFloor.y], ["end", floor.startY - 6]);
  assert.ok(startNoteSpot(floor, "Starting balance", []).y <= floor.startY, "never under the plot");
  // No free spot at all: the first one stays rather than dropping the note.
  const wall = [0, 1, 2, 3].map((n) => ({ x: n % 2 === 0 ? 400 : 736, y: n < 2 ? 106 : 126, text: "x".repeat(120), anchor: "end" as const }));
  assert.equal(startNoteSpot(layout, "Starting balance", wall).y, 106);
});

// -- annotations keep off their own series and inside the plot box (D-181) ---------------------------------------------------------

const BOX_PLOT = { x: 76, y: 16, width: 660, height: 188 };
const LABEL_PX_PER_CHAR = 7;
const boxOfLabel = (label: { x: number; y: number; text: string; anchor: "start" | "end" }) => {
  const width = label.text.length * LABEL_PX_PER_CHAR;
  const left = label.anchor === "end" ? label.x - width : label.x;
  return { left, right: left + width, top: label.y - 11, bottom: label.y + 3 };
};
/** Independent of the module: walk the line one unit at a time and ask whether any step lands within `reach` of the label's box. */
const lineTouches = (label: Parameters<typeof boxOfLabel>[0], line: ReadonlyArray<{ x: number; y: number }>, reach = 3): boolean => {
  const box = boxOfLabel(label);
  return line.some((from, index) => {
    const to = line[index + 1] ?? from;
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));
    for (let step = 0; step <= steps; step++) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      if (x > box.left - reach && x < box.right + reach && y > box.top - reach && y < box.bottom + reach) return true;
    }
    return false;
  });
};
const insideBox = (label: Parameters<typeof boxOfLabel>[0], plot = BOX_PLOT) => {
  const box = boxOfLabel(label);
  return box.left >= plot.x && box.right <= plot.x + plot.width && box.top >= plot.y && box.bottom <= plot.y + plot.height;
};

test("Starting balance keeps off a series that leaves the start point, above or below (journal)", () => {
  const startY = 110;
  const layout = { plot: BOX_PLOT, startY };
  const rising = [{ x: 76, y: startY }, { x: 110, y: 96 }, { x: 144, y: 84 }, { x: 178, y: 70 }, { x: 212, y: 60 }];
  const falling = rising.map((point) => ({ x: point.x, y: 2 * startY - point.y }));
  // The default spot (above the start line at the left) is on the rising series; the note moves and touches neither series.
  for (const lines of [[rising], [falling], [rising, falling]]) {
    const note = startNoteSpot(layout, "Starting balance", [], lines);
    assert.equal(insideBox(note), true, "inside the plot box");
    for (const line of lines) assert.equal(lineTouches(note, line), false, `clear of the series (${JSON.stringify(note)})`);
  }
  // Rising and falling together take both left spots: the note goes along the line to the first free run.
  const both = startNoteSpot(layout, "Starting balance", [], [rising, falling]);
  assert.notEqual(both.x, 82, "not at the left end");
  // No series: unchanged.
  assert.deepEqual(startNoteSpot(layout, "Starting balance", [], []), startNoteSpot(layout, "Starting balance", []));
});

test("the end label sits on the side of its point the line does not come from, inside the plot box (day journal)", () => {
  const text = "After day 1 $49,246.00";
  // One ended day: the balance fell from the start (left, high) to the newest point (right edge, low). Above-left is the line itself.
  const now = { x: 736, y: 150 };
  const line = [{ x: 76, y: 100 }, now];
  const label = placeLabel(endLabelSpots(now, text), { plot: BOX_PLOT, lines: [line] });
  assert.equal(label.y > now.y, true, "below the point: the line comes in from above");
  assert.equal(lineTouches(label, line), false);
  assert.equal(insideBox(label), true);
  // A line that rose into the point keeps the label above, the way it was.
  const rose = [{ x: 76, y: 190 }, now];
  const above = placeLabel(endLabelSpots(now, text), { plot: BOX_PLOT, lines: [rose] });
  assert.deepEqual([above.x, above.y, above.anchor], [now.x - 8, now.y - 8, "end"]);
});

test("the end label of a newest point on the right edge clears the line that falls to it, even when the plot has no room below (D-188)", () => {
  const text = "After day 1 $49,246.00";
  // The day journal after one lost day ($50,000 to $49,246): the point is at the right edge and 11 units above the bottom tick, so the two
  // right-hand spots and the spots below leave the plot, and the one left in it (above-left) has the line through its right half.
  const now = { x: 736, y: 193.19 };
  const line = [{ x: 76, y: 16 }, now];
  const label = placeLabel(endLabelSpots(now, text), { plot: BOX_PLOT, lines: [line] });
  assert.equal(insideBox(label), true, "inside the plot box");
  assert.equal(lineTouches(label, line), false, `clear of the line (${JSON.stringify(label)})`);
  assert.equal(label.anchor, "end", "right-aligned on its point");
  assert.equal(label.x, now.x - 8);
  // The nearest of the further spots wins: not higher than it has to be.
  assert.equal(label.y < now.y - 8 && label.y > now.y - 8 - 16 * 5, true);
});

test("a label never leaves the plot box when a spot inside it exists: day 1 goes right of its point, a low point stays above the day labels", () => {
  const text = "After day 1 $49,246.00";
  const early = { x: 100, y: 120 }; // 24 units in: no room to the left for 154 units of text
  const right = placeLabel(endLabelSpots(early, text), { plot: BOX_PLOT, lines: [[{ x: 76, y: 110 }, early]] });
  assert.equal(right.anchor, "start");
  assert.equal(insideBox(right), true);
  const floor = { x: 400, y: BOX_PLOT.y + BOX_PLOT.height };
  const kept = placeLabel(endLabelSpots(floor, text), { plot: BOX_PLOT });
  assert.equal(insideBox(kept), true, "a point on the bottom tick never sends its label under the plot (D-123)");
  const top = { x: 400, y: BOX_PLOT.y };
  assert.equal(insideBox(placeLabel(endLabelSpots(top, text), { plot: BOX_PLOT })), true, "nor above it");
  // Whole sweep: every spot of a 5 x 5 grid of points lands inside.
  for (const x of [76, 200, 400, 600, 736]) for (const y of [16, 60, 110, 160, 204]) {
    assert.equal(insideBox(placeLabel(endLabelSpots({ x, y }, text), { plot: BOX_PLOT })), true, `(${x}, ${y})`);
  }
});

test("a label clear of the lines but on another label is worse than one on a line: the labels stay readable", () => {
  const text = "Balance $50,000.00";
  const point = { x: 400, y: 110 };
  const spots = endLabelSpots(point, text);
  const other = { ...spots[0]!, text: "Equity $50,100.00" }; // sits on the first spot
  const picked = placeLabel(spots, { plot: BOX_PLOT, others: [other], lines: [[{ x: 76, y: 130 }, { x: 736, y: 130 }]] });
  assert.notDeepEqual([picked.x, picked.y], [spots[0]!.x, spots[0]!.y], "not on the other label");
});
