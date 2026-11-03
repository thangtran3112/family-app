import { labelSpan, niceTicks, textWidth } from "../desk/ticks.ts";
import type { CurvePoint, ThreadDate } from "./threads.ts";

// Geometry of the thread journal's two charts (02r, board P8; ADR-0025): the balance curve and the result-by-ET-date bars. Pure numbers
// in, SVG coordinates out, so the components only draw. One point or bar per ET date that realized a trade (the ledger grouped by date, so
// the figures add up to the balance); a date is a label and a key, never a boundary. Every figure is SIMULATED dollars.

export type Box = { width: number; height: number; left: number; right: number; top: number; bottom: number };

/** Round tick values for a dollar axis that cover `min` to `max`, whole dollars at least; a flat series still gets an axis (a little above and below it). */
export function balanceTicks(min: number, max: number): number[] {
  const pad = min === max ? Math.max(Math.abs(min) * 0.01, 1) : 0;
  return niceTicks(min - pad, max + pad, { minStep: 1 });
}

export type Tick = { value: number; y: number };

/** The step of an x axis that counts points: every one up to ten, then 5, 10, 25 or 50, so the labels sit at one regular
 *  interval and never crowd the "Start" label (D-123). */
export function dayTickStep(days: number): number {
  return [1, 5, 10, 25, 50].find((step) => days / step <= 10) ?? 50;
}

/** "03-11" from an ET date: the axis label of a point or a bar; the starting point (no date) is "Start". */
const axisLabel = (day: string | null): string => (day === null ? "Start" : day.slice(5));

export type CurveLayout = {
  ticks: Tick[];
  /** Y of the starting balance, the dashed line; the area below it is the red shading. */
  startY: number;
  /** One per curve point: the starting balance (n 0), then the balance after each ET date that realized a trade. `day` is that date, null for the start. */
  points: Array<{ n: number; x: number; y: number; balance: number; day: string | null; label: string }>;
  line: string;
  /** The line closed down to the starting-balance line; clip it to y >= startY to shade only below the start. */
  area: string;
  plot: { x: number; y: number; width: number; height: number };
  /** The lowest point after the start when it is below the start, for the "Lowest $49,753" label. */
  lowest: { x: number; y: number; balance: number } | null;
  /** The newest point, for the "After 03-11 $50,123" label; null with no trade yet. */
  now: { x: number; y: number; balance: number; day: string } | null;
};

/** The balance after each ET date. `curve[0]` is the starting balance (n 0, no date). Points are evenly spaced. */
export function curveLayout(curve: readonly CurvePoint[], startingBalance: number, box: Box): CurveLayout {
  const plot = { x: box.left, y: box.top, width: box.width - box.left - box.right, height: box.height - box.top - box.bottom };
  const balances = [startingBalance, ...curve.map((point) => point.balance)];
  const ticks = balanceTicks(Math.min(...balances), Math.max(...balances));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const yOf = (value: number) => plot.y + plot.height - ((value - lo) / (hi - lo || 1)) * plot.height;
  const last = Math.max(curve.length - 1, 1);
  const xOf = (index: number) => plot.x + (curve.length <= 1 ? 0 : (index / last) * plot.width);
  const points = curve.map((point, index) => ({
    n: point.n,
    x: xOf(index),
    y: yOf(point.balance),
    balance: point.balance,
    day: point.day,
    label: axisLabel(point.day),
  }));
  const startY = yOf(startingBalance);
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const first = points[0];
  const end = points[points.length - 1];
  const area = first && end ? `${line} L${end.x.toFixed(1)} ${startY.toFixed(1)} L${first.x.toFixed(1)} ${startY.toFixed(1)} Z` : "";
  const traded = points.filter((point) => point.n > 0);
  const bottom = traded.reduce<(typeof traded)[number] | null>((low, point) => (low === null || point.balance < low.balance ? point : low), null);
  return {
    ticks: ticks.map((value) => ({ value, y: yOf(value) })),
    startY,
    points,
    line,
    area,
    plot,
    lowest: bottom && bottom.balance < startingBalance ? { x: bottom.x, y: bottom.y, balance: bottom.balance } : null,
    now: end && end.n > 0 && end.day !== null ? { x: end.x, y: end.y, balance: end.balance, day: end.day } : null,
  };
}

export type BarsLayout = {
  ticks: Tick[];
  zeroY: number;
  plot: { x: number; y: number; width: number; height: number };
  /** One slot per ET date with a trade, left to right. */
  slots: Array<{ n: number; x: number; center: number; width: number; day: string; value: number; barY: number; barHeight: number; label: string }>;
};

/** The result of each ET date as bars from zero; the axis is symmetric enough to hold the biggest win and loss. */
export function barsLayout(daily: readonly ThreadDate[], box: Box): BarsLayout {
  const plot = { x: box.left, y: box.top, width: box.width - box.left - box.right, height: box.height - box.top - box.bottom };
  const values = daily.map((date) => date.pnl_usd);
  // A thread whose dates all ended flat still gets a readable axis: at least 50 dollars each way.
  const ticks = niceTicks(Math.min(-50, ...values), Math.max(50, ...values));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const yOf = (value: number) => plot.y + plot.height - ((value - lo) / (hi - lo || 1)) * plot.height;
  const zeroY = yOf(0);
  const slotWidth = plot.width / Math.max(daily.length, 1);
  const barWidth = Math.min(slotWidth * 0.5, 44);
  const slots = daily.map((date, index) => {
    const center = plot.x + slotWidth * (index + 0.5);
    const y = yOf(date.pnl_usd);
    return {
      n: date.n,
      x: center - barWidth / 2,
      center,
      width: barWidth,
      day: date.day,
      value: date.pnl_usd,
      barY: Math.min(y, zeroY),
      barHeight: Math.abs(zeroY - y),
      label: axisLabel(date.day),
    };
  });
  return { ticks: ticks.map((value) => ({ value, y: yOf(value) })), zeroY, plot, slots };
}

// -- where the curve's labels go ---------------------------------------------------------------------------------

/** A label's anchor point in the curve's own SVG units: `end` anchored labels grow to the left of `x`, `start` ones to the right. */
export type CurveLabel = { x: number; y: number; text: string; anchor: "start" | "end" };

/** A point on a drawn line, in the curve's SVG units. */
export type Dot = { x: number; y: number };

type Plot = CurveLayout["plot"];

const LABEL_PX = 11; // the curve prints --text-micro labels
const LABEL_ABOVE = 11;
const LABEL_BELOW = 3;
/** How far a line reaches around its points: half the stroke and the biggest dot (r 4.5). */
const LINE_REACH = 5;

const boxOf = (label: CurveLabel) => {
  const [left, right] = labelSpan(label.x, label.text, LABEL_PX, label.anchor);
  return { left, right, top: label.y - LABEL_ABOVE, bottom: label.y + LABEL_BELOW };
};

const overlaps = (a: CurveLabel, b: CurveLabel): boolean => {
  const [p, q] = [boxOf(a), boxOf(b)];
  return p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom;
};

/** True when the label sits whole inside the plot box: it never leaves the frame, so it never lands on a tick label or an axis. */
const insidePlot = (label: CurveLabel, plot: Plot): boolean => {
  const box = boxOf(label);
  return box.left >= plot.x && box.right <= plot.x + plot.width && box.top >= plot.y && box.bottom <= plot.y + plot.height;
};

/** True when a line (or one of its dots) passes through the label. The line is walked every 2 units: the label is 14 high and the reach 5, so no crossing slips between two steps. */
function crossesLine(label: CurveLabel, line: readonly Dot[]): boolean {
  const box = boxOf(label);
  const hit = (x: number, y: number) => x > box.left - LINE_REACH && x < box.right + LINE_REACH && y > box.top - LINE_REACH && y < box.bottom + LINE_REACH;
  return line.some((from, index) => {
    const to = line[index + 1] ?? from;
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
    for (let step = 0; step <= steps; step++) if (hit(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps)) return true;
    return false;
  });
}

/**
 * The first of `spots` (best first) where the label sits inside the plot box and prints on no `others` label and on no `lines` series
 * (D-181: the end label and "Starting balance" printed on their own lines). With no such spot it takes the first inside the plot that
 * clears the labels (a line through a readable label beats two labels on each other), then the first inside the plot, then the first.
 */
export function placeLabel(spots: readonly CurveLabel[], { plot, others = [], lines = [] }: { plot: Plot; others?: readonly CurveLabel[]; lines?: ReadonlyArray<readonly Dot[]> }): CurveLabel {
  const inside = spots.filter((spot) => insidePlot(spot, plot));
  const pool = inside.length > 0 ? inside : spots;
  const clearOfLabels = (spot: CurveLabel) => others.every((other) => !overlaps(spot, other));
  return pool.find((spot) => clearOfLabels(spot) && lines.every((line) => !crossesLine(spot, line))) ?? pool.find(clearOfLabels) ?? pool[0]!;
}

/** How far (SVG units) each further tier of end-label spots sits from the one before it: the label is 14 high, so a tier clears the last. */
const END_TIER = 16;
/** How many further tiers `endLabelSpots` offers, above and below the first two. */
const END_TIERS = 5;

/**
 * Where a series' end label ("Balance $49,246.00") goes: left of its newest point and above it (below when `above` is false), then the
 * other side, then right of the point when the left has no room (the first days of a thread put the point at the plot's left edge).
 * When every one of those is crossed by a line or leaves the plot (a newest point at the right edge, near the bottom tick, with the line
 * falling to it from the upper left: the day journal after one lost day, D-188), the same four spots follow one tier further out, then
 * two, so `placeLabel` can pick the nearest one clear of the line instead of keeping a crossed one.
 */
export function endLabelSpots(point: Dot, text: string, above = true): CurveLabel[] {
  const [first, second] = above ? [point.y - 8, point.y + 16] : [point.y + 16, point.y - 8];
  const sign = above ? -1 : 1;
  const spots: CurveLabel[] = [];
  for (let tier = 0; tier <= END_TIERS; tier++) {
    const [near, far] = [first + sign * tier * END_TIER, second - sign * tier * END_TIER];
    spots.push({ x: point.x - 8, y: near, text, anchor: "end" }, { x: point.x - 8, y: far, text, anchor: "end" });
    spots.push({ x: point.x + 8, y: near, text, anchor: "start" }, { x: point.x + 8, y: far, text, anchor: "start" });
  }
  return spots;
}

/**
 * Where the "Starting balance" note sits on the curve. The note belongs on the start line, but the end labels ("Balance $25,000.00",
 * "Equity ...") land on that line too whenever the balance is still near its start, and the series themselves cross its left end (the
 * first segment leaves the start point there). So the note tries the left end above the line, the left end below it, the right end,
 * then steps along the line, and takes the first spot inside the plot box that prints on none of `others` and none of `lines`. With no
 * free spot it keeps the first. A spot under the plot is the row of the day labels, so a start line that rests on the bottom tick has
 * no "below" spots (D-123).
 */
export function startNoteSpot(layout: Pick<CurveLayout, "plot" | "startY">, text: string, others: readonly CurveLabel[], lines: ReadonlyArray<readonly Dot[]> = []): CurveLabel {
  const { plot, startY } = layout;
  const left = plot.x + 6;
  const right = plot.x + plot.width - 6;
  const spots: CurveLabel[] = [
    { x: left, y: startY - 6, text, anchor: "start" },
    { x: left, y: startY + 14, text, anchor: "start" },
    { x: right, y: startY - 6, text, anchor: "end" },
    { x: right, y: startY + 14, text, anchor: "end" },
  ];
  const width = textWidth(text, LABEL_PX);
  for (let x = left + 48; x + width <= right; x += 48) spots.push({ x, y: startY - 6, text, anchor: "start" }, { x, y: startY + 14, text, anchor: "start" });
  return placeLabel(spots, { plot, others, lines });
}
