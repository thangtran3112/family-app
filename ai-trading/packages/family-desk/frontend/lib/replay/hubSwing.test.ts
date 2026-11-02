import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import {
  continueOutcome,
  firstProblem,
  HUB_SWING_COPY,
  hubSwingText,
  PREVIEW_POLL_MAX_MS,
  pollExpired,
  startBlockedBy,
  endLabelSpots,
  placeLabel,
  startNoteSpot,
  swingCurveLayout,
  swingCurveSummary,
} from "./hubSwing.ts";
import { swingOpenNext, swingOpenNextWaiting, swingState, universePreview, universePreviewPreparing } from "./swingFixtures.ts";
import { formatBalance, planRows } from "./threadView.ts";

test("the preview stops asking after ten minutes", () => {
  assert.equal(pollExpired(1000, 1000 + PREVIEW_POLL_MAX_MS - 1), false);
  assert.equal(pollExpired(1000, 1000 + PREVIEW_POLL_MAX_MS), true);
});

test("Start swing thread says why it is off, field problems first", () => {
  assert.equal(firstProblem({ sessions: "S", firstDay: "F" }), "F", "the first day is read before the sessions");
  assert.equal(firstProblem({}), null);
  assert.equal(startBlockedBy({ preview: universePreview, fresh: true, problems: {} }), null);
  assert.equal(startBlockedBy({ preview: null, fresh: false, problems: {} }), "Build the universe first");
  assert.equal(startBlockedBy({ preview: universePreview, fresh: false, problems: {} }), HUB_SWING_COPY.updatingList);
  assert.equal(startBlockedBy({ preview: universePreview, fresh: true, problems: { sessions: "Sessions: a whole number from 15 to 23" } }), "Sessions: a whole number from 15 to 23");
  const preparing = startBlockedBy({ preview: universePreviewPreparing, fresh: true, problems: {} });
  assert.match(preparing ?? "", /^Wait for the data to finish · \d+ of \d+ \(\d+%\)$/);
  const few = startBlockedBy({ preview: { ...universePreview, rows: universePreview.rows.slice(0, 4) }, fresh: true, problems: {} });
  assert.equal(few, "Pick at least 10 symbols · you have 4");
});

test("Continue: a day opens, a running prep waits with its counts, a finished thread has nothing left", () => {
  assert.deepEqual(continueOutcome(swingOpenNext), { kind: "open", dayListId: 71 });
  assert.deepEqual(continueOutcome(swingOpenNextWaiting), { kind: "preparing", text: "Preparing the swing data · 12 of 51 (23%)" });
  const finished = { ...swingOpenNextWaiting, plan: { ...swingOpenNextWaiting.plan, finished: true } };
  assert.deepEqual(continueOutcome(finished), { kind: "finished" });
});

const BOX = { width: 760, height: 240, left: 64, right: 24, top: 16, bottom: 32 };

test("the curve draws balance and equity from the starting balance, with room for the days to come", () => {
  const series = swingState.equity_series;
  const layout = swingCurveLayout(series, 50000, swingState.days, BOX);
  assert.equal(layout.days.length, series.length + 1);
  assert.equal(layout.days[0]!.x, layout.plot.x);
  assert.equal(layout.days[0]!.balanceY, layout.startY);
  const last = layout.days[layout.days.length - 1]!;
  assert.equal(last.dayNo, 6);
  assert.equal(last.balance, 51240);
  assert.equal(last.equity, 51895);
  assert.ok(last.equityY < last.balanceY, "a higher equity sits higher on the page");
  assert.ok(last.x < layout.plot.x + layout.plot.width, "6 of 20 days leaves the right side open");
  assert.equal(last.x, layout.plot.x + (6 / 20) * layout.plot.width);
  assert.equal(layout.now, last);
  assert.ok(layout.balanceLine.startsWith("M64.0 "));
  assert.equal(layout.balanceLine.split("L").length, series.length + 1);
  assert.equal(layout.equityLine.split("L").length, series.length + 1);
  // D-123: the axis is labelled at a regular step over the whole span, so D10, D15 and D20 show before those days are played.
  assert.deepEqual(layout.xTicks.map((tick) => tick.label), ["Start", "D5", "D10", "D15", "D20"]);
  assert.equal(layout.xTicks[0]!.x, layout.plot.x);
  assert.equal(layout.xTicks[4]!.x, layout.plot.x + layout.plot.width, "the last tick is the right edge");
  assert.equal(layout.xTicks[1]!.x, layout.days[5]!.x, "D5 sits where the fifth day's point sits");
  const top = layout.ticks[layout.ticks.length - 1]!;
  assert.ok(top.value >= 51895 && layout.ticks[0]!.value <= 50000, "the axis covers every figure");
});

test("a thread with no finished day has a start point and no newest point", () => {
  const layout = swingCurveLayout([], 50000, 20, BOX);
  assert.equal(layout.days.length, 1);
  assert.equal(layout.now, null);
  assert.ok(layout.ticks.length >= 2);
  assert.deepEqual(layout.xTicks.map((tick) => tick.label), ["Start", "D5", "D10", "D15", "D20"], "the axis is there before a day ends");
});

test("the curve reads out in words for a screen reader, and every new copy row is plain", () => {
  assert.equal(
    swingCurveSummary(swingState.equity_series, 50000, formatBalance),
    "Balance and equity at the close of each day. Starts at $50,000.00, balance now $51,240.00, equity now $51,895.00.",
  );
  assert.equal(swingCurveSummary([], 50000, formatBalance), "Balance and equity at the close of each day. Starts at $50,000.00, balance now $50,000.00, equity now $50,000.00.");
  assert.equal(hubSwingText("startsWith", { balance: "$50,000", n: 50 }), "Starts with a pretend $50,000 and 50 names. The list is frozen once the thread starts.");
  for (const [key, line] of Object.entries(HUB_SWING_COPY)) {
    assert.equal(containsPracticeBannedTerm(line), false, `${key}: ${line}`);
    assert.equal(line, line.trim(), key);
  }
});

test("a swing thread's plan rows say a week where the day rule says a day", () => {
  const rows = planRows({ stopNoteOnEntry: "yes", tradeOnlyOnSignal: "no", maxLossUsd: 600, maxTrades: 6 }, "swing");
  assert.deepEqual(rows.map((row) => row.label), ["Shares per trade", "Stop on every entry", "Trade only on a signal", "Max loss, pretend dollars a week", "Max trades a week"]);
  assert.deepEqual(rows.map((row) => row.value), ["You set it on each entry", "Yes", "No", "$600", "6"]);
});

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

test("Starting balance keeps off a series that leaves the start point, above or below (swing journal)", () => {
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
