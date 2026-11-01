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
