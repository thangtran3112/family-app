import { practiceText, prepPercent } from "../desk/freshness.ts";
import type { SwingOpenNext, UniversePreview } from "./swingApi.ts";
import type { SwingProblems } from "./swingSetup.ts";
import { startBlocker } from "./universeView.ts";
import { niceTicks, type Box, type Tick } from "./threadChart.ts";
import type { SwingEquityPoint } from "./threads.ts";

// What the hub and the thread journal need for swing threads beyond F1's `swing*.ts`: the thread modes,
// the universe preview's timing, what "Continue" answered, and the geometry of the balance-and-equity curve. Pure, so
// the node tests cover it. Copy that only these screens use lives here (checked by the same banned-word test).

// -- thread modes ----------------------------------------------------------------------------------------------

export type ThreadMode = "day" | "swing";

export const HUB_SWING_COPY = {
  pickSwing: "Pick Swing to build a universe and start a swing thread",
  noWatchlists: "No watchlists yet · you can still add symbols by hand",
  noDailyFilters: "No daily filters yet · a swing board reads daily bars, so only daily filters are offered",
  updatingList: "Updating the list…",
  tooLong: "The data is taking longer than usual · change a setting to try again",
  buildingList: "Building the universe…",
  startsWith: "Starts with a pretend {balance} and {n} names. The list is frozen once the thread starts.",
  noRows: "No names yet · pick a watchlist, add symbols, or add by liquidity",
  removeRow: "Remove {symbol}",
  addSymbol: "Add",
  // The thread page
  weeksTitle: "Weeks",
  weeksHint: "Open a week for its review",
  weeksLoadError: "Couldn't load the weeks · Try again",
  holdsTitle: "Open holds",
  holdsHint: "Marked at the last finished close",
  holdsLoadError: "Couldn't load the holds · Try again",
  closeSwingNote: "Your open holds exit at the last finished close, and the open week is frozen with its review.",
  curveLine: "Balance counts closed holds only. Equity adds the open holds at the last close.",
  curveBalance: "Balance",
  curveEquity: "Equity",
  curveSummary: "Balance and equity at the close of each day. Starts at {start}, balance now {balance}, equity now {equity}.",
    noDaysYet: "No finished day yet · the curve starts after Day 1 ends",
  dateHidden: "dates hidden",
} as const;

type HubSwingKey = keyof typeof HUB_SWING_COPY;
export const hubSwingText = (key: HubSwingKey, values: Record<string, string | number> = {}): string =>
  HUB_SWING_COPY[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));

// -- the universe preview's timing ---------------------------------------------------------------------------

/** Wait this long after the last change before asking again. */
export const PREVIEW_DEBOUNCE_MS = 400;
/** While the pool data is still being prepared, ask again this often. */
export const PREVIEW_POLL_MS = 3000;
/** Give up asking after this long; a change to the inputs starts it again. */
export const PREVIEW_POLL_MAX_MS = 10 * 60 * 1000;

export const pollExpired = (startedAt: number, now: number): boolean => now - startedAt >= PREVIEW_POLL_MAX_MS;

/** The first thing wrong with the inputs, in the order the form shows them. */
const FIELD_ORDER = ["firstDay", "sessions", "target", "universe"] as const;
export const firstProblem = (problems: SwingProblems): string | null => {
  for (const field of FIELD_ORDER) if (problems[field]) return problems[field] ?? null;
  return null;
};

/**
 * Why `Start swing thread` is off, in plain words; null when it can start. `fresh` says the table on screen answers
 * the inputs on screen (a changed input makes the table stale until the new answer arrives).
 */
export function startBlockedBy(input: { preview: UniversePreview | null; fresh: boolean; problems: SwingProblems }): string | null {
  const problem = firstProblem(input.problems);
  if (problem) return problem;
  if (input.preview === null) return startBlocker(null);
  if (!input.fresh) return HUB_SWING_COPY.updatingList;
  return startBlocker(input.preview);
}

// -- Continue ----------------------------------------------------------------------------------------------------

export type ContinueOutcome =
  | { kind: "open"; dayListId: number }
  | { kind: "preparing"; text: string }
  | { kind: "finished" };

/** What `POST /daily/next {threadId}` answered: the day to open, the prep that is still running, or nothing left. */
export function continueOutcome(next: Pick<SwingOpenNext, "day_list_id" | "plan">): ContinueOutcome {
  if (next.day_list_id !== null) return { kind: "open", dayListId: next.day_list_id };
  if (next.plan.finished) return { kind: "finished" };
  return { kind: "preparing", text: practiceText("swingPrepWait", { done: next.plan.prep.done, total: next.plan.prep.total, pct: prepPercent(next.plan.prep.done, next.plan.prep.total) }) };
}

/** The plan rows of a swing thread: the day rule's two limits count per week there (02p). */
export const weeklyPlanRows = <T extends { id: string; label: string }>(rows: readonly T[]): T[] =>
  rows.map((row) => (row.id === "max_loss" || row.id === "max_trades" ? { ...row, label: row.label.replace(/ a day$/, " a week") } : row));

// -- the balance and equity curve ----------------------------------------------------------------------------------

export type SwingCurveDay = {
  dayNo: number;
  x: number;
  balance: number;
  equity: number;
  balanceY: number;
  equityY: number;
  /** "Start", "D1", "D5": only some days carry a label so the axis stays readable. */
  label: string | null;
};

export type SwingCurve = {
  ticks: Tick[];
  /** Y of the starting balance (the dashed line). */
  startY: number;
  plot: { x: number; y: number; width: number; height: number };
  days: SwingCurveDay[];
  balanceLine: string;
  equityLine: string;
  /** The newest day: where the "Balance" and "Equity" labels sit. */
  now: SwingCurveDay | null;
};

/**
 * Two lines over the calendar: the balance (closed holds only) and the equity (the open holds marked at each close).
 * `series` is the thread's `swing.equity_series`: one point per finished day, with day numbers only, no dates. The x axis
 * spans all `days` of the thread so the lines grow to the right as days end. Point 0 is the starting balance.
 */
export function swingCurveLayout(series: readonly SwingEquityPoint[], startingBalance: number, days: number, box: Box): SwingCurve {
  const plot = { x: box.left, y: box.top, width: box.width - box.left - box.right, height: box.height - box.top - box.bottom };
  const values = [startingBalance, ...series.flatMap((point) => [point.balance_usd, point.equity_usd])];
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const yOf = (value: number) => plot.y + plot.height - ((value - lo) / (hi - lo || 1)) * plot.height;
  const span = Math.max(days, series.length, 1);
  const xOf = (dayNo: number) => plot.x + (dayNo / span) * plot.width;
  const pointOf = (dayNo: number, balance: number, equity: number, label: string | null): SwingCurveDay => ({
    dayNo,
    x: xOf(dayNo),
    balance,
    equity,
    balanceY: yOf(balance),
    equityY: yOf(equity),
    label,
  });
  const labelled = (dayNo: number) => (dayNo === 1 || dayNo % 5 === 0 ? `D${dayNo}` : null);
  const points = [
    pointOf(0, startingBalance, startingBalance, "Start"),
    ...series.map((point) => pointOf(point.day_no, point.balance_usd, point.equity_usd, labelled(point.day_no))),
  ];
  const path = (pick: (point: SwingCurveDay) => number) => points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${pick(point).toFixed(1)}`).join(" ");
  return {
    ticks: ticks.map((value) => ({ value, y: yOf(value) })),
    startY: yOf(startingBalance),
    plot,
    days: points,
    balanceLine: path((point) => point.balanceY),
    equityLine: path((point) => point.equityY),
    now: series.length > 0 ? points[points.length - 1]! : null,
  };
}

/** A label's anchor point in the curve's own SVG units: `end` anchored labels grow to the left of `x`, `start` ones to the right. */
export type CurveLabel = { x: number; y: number; text: string; anchor: "start" | "end" };

// ponytail: text width is estimated at 7 units a character (the curve prints 11 px labels); measure with getBBox if a font change ever shifts it.
const CHAR_WIDTH = 7;
const LABEL_ABOVE = 11;
const LABEL_BELOW = 3;

const overlaps = (a: CurveLabel, b: CurveLabel): boolean => {
  const span = (label: CurveLabel) => {
    const width = label.text.length * CHAR_WIDTH;
    return label.anchor === "end" ? [label.x - width, label.x] : [label.x, label.x + width];
  };
  const [aLeft, aRight] = span(a) as [number, number];
  const [bLeft, bRight] = span(b) as [number, number];
  return aLeft < bRight && bLeft < aRight && a.y - LABEL_ABOVE < b.y + LABEL_BELOW && b.y - LABEL_ABOVE < a.y + LABEL_BELOW;
};

/**
 * Where the "Starting balance" note sits on the curve. The note belongs on the start line, but the end labels ("Balance $25,000.00",
 * "Equity ...") land on that line too whenever the balance is still near its start, so the note tries the left end above the line,
 * the left end below it, then the right end, and takes the first spot that prints on none of `others`. With no free spot it keeps the first.
 */
export function startNoteSpot(layout: Pick<SwingCurve, "plot" | "startY">, text: string, others: readonly CurveLabel[]): CurveLabel {
  const { plot, startY } = layout;
  const left = plot.x + 6;
  const right = plot.x + plot.width - 6;
  const spots: CurveLabel[] = [
    { x: left, y: startY - 6, text, anchor: "start" },
    { x: left, y: startY + 14, text, anchor: "start" },
    { x: right, y: startY - 6, text, anchor: "end" },
    { x: right, y: startY + 14, text, anchor: "end" },
  ];
  return spots.find((spot) => others.every((other) => !overlaps(spot, other))) ?? spots[0]!;
}

/** The alt text of the curve for a screen reader. */
export function swingCurveSummary(series: readonly SwingEquityPoint[], startingBalance: number, formatMoney: (value: number) => string): string {
  const last = series[series.length - 1];
  return hubSwingText("curveSummary", {
    start: formatMoney(startingBalance),
    balance: formatMoney(last?.balance_usd ?? startingBalance),
    equity: formatMoney(last?.equity_usd ?? startingBalance),
  });
}
