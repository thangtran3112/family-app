import type { CurvePoint, ThreadDay } from "./threads.ts";
import type { Week } from "./threadView.ts";

// Geometry of the thread journal's two charts (02r, board P8): the balance curve and the daily result bars. Pure numbers
// in, SVG coordinates out, so the components only draw. Every figure is SIMULATED dollars.

export type Box = { width: number; height: number; left: number; right: number; top: number; bottom: number };

/** Round tick values for a numeric axis: steps of 1, 2 or 5 times a power of ten that cover `min` to `max`. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  let low = min;
  let high = max;
  if (low === high) {
    const pad = Math.max(Math.abs(low) * 0.01, 1);
    low -= pad;
    high += pad;
  }
  const raw = (high - low) / Math.max(target - 1, 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
  const first = Math.floor(low / step + 1e-9) * step;
  const last = Math.ceil(high / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let value = first; value <= last + step / 2; value += step) ticks.push(Math.round(value / step) * step);
  return ticks;
}

export type Tick = { value: number; y: number };

export type CurveLayout = {
  ticks: Tick[];
  /** Y of the starting balance, the dashed line; the area below it is the red shading. */
  startY: number;
  /** One per curve point: `skipped` marks a day that ended with no session (an open circle). */
  points: Array<{ n: number; x: number; y: number; balance: number; skipped: boolean; label: string }>;
  line: string;
  /** The line closed down to the starting-balance line; clip it to y >= startY to shade only below the start. */
  area: string;
  plot: { x: number; y: number; width: number; height: number };
  /** The lowest practised point when it is below the start, for the "Lowest $49,753" label. */
  lowest: { x: number; y: number; balance: number } | null;
  /** The newest point, for the "Now $50,123" label. */
  now: { x: number; y: number; balance: number } | null;
};

/** The balance at the end of each day. `curve[0]` is the starting balance (n 0, no day). Days are evenly spaced. */
export function curveLayout(curve: readonly CurvePoint[], daily: readonly ThreadDay[], startingBalance: number, box: Box): CurveLayout {
  const plot = { x: box.left, y: box.top, width: box.width - box.left - box.right, height: box.height - box.top - box.bottom };
  const balances = [startingBalance, ...curve.map((point) => point.balance)];
  const ticks = niceTicks(Math.min(...balances), Math.max(...balances));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const yOf = (value: number) => plot.y + plot.height - ((value - lo) / (hi - lo || 1)) * plot.height;
  const last = Math.max(curve.length - 1, 1);
  const xOf = (index: number) => plot.x + (curve.length <= 1 ? 0 : (index / last) * plot.width);
  const kindOf = new Map(daily.map((day) => [day.n, day.kind]));
  const points = curve.map((point, index) => ({
    n: point.n,
    x: xOf(index),
    y: yOf(point.balance),
    balance: point.balance,
    skipped: kindOf.get(point.n) === "skipped",
    label: point.n === 0 ? "Start" : `D${point.n}`,
  }));
  const startY = yOf(startingBalance);
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const first = points[0];
  const end = points[points.length - 1];
  const area = first && end ? `${line} L${end.x.toFixed(1)} ${startY.toFixed(1)} L${first.x.toFixed(1)} ${startY.toFixed(1)} Z` : "";
  const practised = points.filter((point) => point.n > 0 && !point.skipped);
  const bottom = practised.reduce<(typeof practised)[number] | null>((low, point) => (low === null || point.balance < low.balance ? point : low), null);
  return {
    ticks: ticks.map((value) => ({ value, y: yOf(value) })),
    startY,
    points,
    line,
    area,
    plot,
    lowest: bottom && bottom.balance < startingBalance ? { x: bottom.x, y: bottom.y, balance: bottom.balance } : null,
    now: end && end.n > 0 ? { x: end.x, y: end.y, balance: end.balance } : null,
  };
}

export type BarsLayout = {
  ticks: Tick[];
  zeroY: number;
  plot: { x: number; y: number; width: number; height: number };
  /** One slot per ended day, left to right. A skipped day has no bar: the slot draws a dashed box. */
  slots: Array<{ n: number; x: number; center: number; width: number; kind: ThreadDay["kind"]; value: number; barY: number; barHeight: number; label: string }>;
  /** The x range of each week, for the "Week 1" labels under the bars. */
  weeks: Array<{ n: number; label: string; x1: number; x2: number }>;
};

/** The result of each day as bars from zero; the axis is symmetric enough to hold the biggest win and loss. */
export function barsLayout(daily: readonly ThreadDay[], weeks: readonly Week[], box: Box): BarsLayout {
  const plot = { x: box.left, y: box.top, width: box.width - box.left - box.right, height: box.height - box.top - box.bottom };
  const values = daily.map((day) => day.pnl_usd);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const yOf = (value: number) => plot.y + plot.height - ((value - lo) / (hi - lo || 1)) * plot.height;
  const zeroY = yOf(0);
  const slotWidth = plot.width / Math.max(daily.length, 1);
  const barWidth = Math.min(slotWidth * 0.5, 44);
  const slots = daily.map((day, index) => {
    const center = plot.x + slotWidth * (index + 0.5);
    const y = yOf(day.pnl_usd);
    return {
      n: day.n,
      x: center - barWidth / 2,
      center,
      width: barWidth,
      kind: day.kind,
      value: day.pnl_usd,
      barY: Math.min(y, zeroY),
      barHeight: Math.abs(zeroY - y),
      label: `D${day.n}`,
    };
  });
  let cursor = 0;
  const bands = weeks.map((week) => {
    const x1 = plot.x + slotWidth * cursor + 4;
    cursor += week.days.length;
    return { n: week.n, label: `Week ${week.n}`, x1, x2: plot.x + slotWidth * cursor - 4 };
  });
  return { ticks: ticks.map((value) => ({ value, y: yOf(value) })), zeroY, plot, slots, weeks: bands };
}
