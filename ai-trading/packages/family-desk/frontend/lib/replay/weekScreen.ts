import { DeskApiError } from "../api/client.ts";
import { fillCopy, practiceText, prepPercent } from "../desk/freshness.ts";
import type { SwingOpenNext, WeekOut } from "./swingApi.ts";
import type { SwingState, ThreadDay, ThreadToday } from "./threads.ts";
import { formatBalance } from "./threadView.ts";
import { startWeekAction, type EquitySeries, type WeekDayRowView } from "./weekView.ts";

// The weekly review screen (`/practice/week?thread=&week=`, 02p e1): what the route reads from its URL, the header
// lines, the one primary button, how a day row finds its board, and the plain-words load problems. The tables, tiles and
// heat strip are `weekView.ts`. Pure, so the node tests cover it. Dates never appear: a week names days by number.

/** Screen copy that has no `PRACTICE_COPY` row. The tests hold every line to the Practice banned-word list. */
export const WEEK_TEXT = {
  none: "No week selected",
  noneHint: "Open a week from your thread.",
  openPractice: "Open Practice",
  loading: "Loading the week…",
  notStarted: "This week has not started yet",
  threadJournal: "Thread journal",
  summaryTitle: "Week summary",
  backToThread: "Back to your thread",
  back: "← Thread",
  weeklyReviewTitle: "Weekly review",
  dayThreadNoWeeks: "Weekly reviews are for swing threads. This is a day thread, so it has no weeks.",
  legendClose: "Close of each day",
  backToDay: "Back to Day {n}",
  saveError: "Couldn't save your week notes",
  daysCaption: "Days this week",
  holdsCaption: "Holds this week",
  byDayTitle: "Balance and equity by day",
  notesTitle: "Notes and rating",
  heatLabel: "Universe names by week return, best first",
  legendBalance: "Balance",
  legendEquity: "Equity",
  legendWeek: "This week is shaded",
  sourceLead: "Median week return by source",
  throughDay: "Through Day {n}",
  daysRange: "Days {first} to {last}",
  daysSoFar: "{played} of {planned} days so far",
} as const;

// -- the URL ---------------------------------------------------------------------------------------------------

const whole = (raw: string | null): number | null => {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

/** `?thread=7&week=2` as numbers; null when either is missing, not a whole number, or zero. */
export function parseWeekParams(thread: string | null, week: string | null): { threadId: number; weekNo: number } | null {
  const threadId = whole(thread);
  const weekNo = whole(week);
  return threadId === null || weekNo === null ? null : { threadId, weekNo };
}

export const threadHref = (threadId: number): string => `/practice/journal?thread=${threadId}`;
/** The thread's page: where "Back to your thread" goes (the journal is `threadHref`). */
export const threadOverviewHref = (threadId: number): string => `/practice/thread?id=${threadId}`;
export const dayBoardHref = (dayListId: number): string => `/practice/day?id=${dayListId}`;

// -- header ----------------------------------------------------------------------------------------------------

/** "Week 2 · 5 days"; "Week 1 · 3 days" for a short week; "Week 2 to date" while the week is open. */
export function weekTitle(week: Pick<WeekOut, "label" | "to_date" | "week_no" | "review">): string {
  if (week.to_date === "yes") return `${practiceText("swingWeek", { n: week.week_no })} to date`;
  if (week.label.includes("·")) return week.label;
  const { first_day_no: first, last_day_no: last } = week.review.week;
  const days = last - first + 1;
  return `${week.label} · ${days} ${days === 1 ? "day" : "days"}`;
}

/** "Days 6 to 10", or while the week is open "Through Day 7 · 2 of 5 days so far". */
export function weekSubtitle(week: Pick<WeekOut, "label" | "to_date" | "review">): string {
  const { first_day_no: first, last_day_no: last } = week.review.week;
  if (week.to_date !== "yes") return first === last ? `Day ${first}` : fillCopy(WEEK_TEXT.daysRange, { first: String(first), last: String(last) });
  const through = fillCopy(WEEK_TEXT.throughDay, { n: String(last) });
  // The open week's label already reads "Week 2 · 2 of 5 days": the played and planned counts are in it.
  const counted = /(\d+) of (\d+) days/.exec(week.label);
  return counted ? `${through} · ${fillCopy(WEEK_TEXT.daysSoFar, { played: counted[1]!, planned: counted[2]! })}` : through;
}

// -- the primary button ----------------------------------------------------------------------------------------

export type WeekAction =
  /** `Start Week 3`: calls `POST /daily/next` and opens the new week's first day. */
  | { kind: "start"; label: string; weekNo: number }
  /** A plain link: that day's board when `href` is set, else the thread. */
  | { kind: "link"; label: string; href: string | null };

/**
 * One button closes the review. `Start Week 3` when this week just ended and the thread waits for the next one; for the
 * open week "Back to Day 7" (the day she is on, linking to its board; with no board to go to, "Back to your thread");
 * otherwise (the final week, or a week she has already moved past) "Back to your thread". `state` is null until the thread
 * loads, or when it failed to load; `daily` and `today` are the thread's ended days and its open day.
 */
export function weekAction(args: {
  weekNo: number;
  toDate: boolean;
  lastDayNo: number;
  state: SwingState | null | undefined;
  daily?: ReadonlyArray<Pick<ThreadDay, "n" | "day_list_id">> | null;
  today?: Pick<ThreadToday, "day_no" | "day_list_id"> | null;
}): WeekAction {
  const { weekNo, toDate, lastDayNo, state, daily, today } = args;
  if (toDate) {
    const dayNo = state?.day_no ?? lastDayNo;
    const dayListId = today?.day_no === dayNo ? today.day_list_id : dayListIdOf(daily, dayNo);
    return dayListId === null
      ? { kind: "link", label: WEEK_TEXT.backToThread, href: null }
      : { kind: "link", label: fillCopy(WEEK_TEXT.backToDay, { n: String(dayNo) }), href: dayBoardHref(dayListId) };
  }
  const start = startWeekAction(state, weekNo);
  return start ? { kind: "start", label: start.label, weekNo: start.weekNo } : { kind: "link", label: WEEK_TEXT.backToThread, href: null };
}

export type StartOutcome = { kind: "open"; href: string } | { kind: "wait"; text: string };

/** What `POST /daily/next` means for the button: open the day's board, or say why nothing opened. */
export function startOutcome(next: SwingOpenNext): StartOutcome {
  if (next.day_list_id !== null) return { kind: "open", href: dayBoardHref(next.day_list_id) };
  if (next.plan.finished) return { kind: "wait", text: practiceText("swingThreadFinished") };
  const { done, total } = next.plan.prep;
  return { kind: "wait", text: `${practiceText("swingPrepWait", { done, total, pct: prepPercent(done, total) })} · ${practiceText("swingPrepWaitHint")}` };
}

// -- day rows --------------------------------------------------------------------------------------------------

export type LinkedDayRow = WeekDayRowView & { href: string | null };

/** The thread's ended days list `n` = the day number and the day list that is its board (null while the thread loads). */
export const dayListIdOf = (daily: ReadonlyArray<Pick<ThreadDay, "n" | "day_list_id">> | null | undefined, dayNo: number): number | null =>
  daily?.find((day) => day.n === dayNo)?.day_list_id ?? null;

/** Each day row opens that day's board in its ended state; no link without a known board. */
export const linkDayRows = (rows: readonly WeekDayRowView[], daily: ReadonlyArray<Pick<ThreadDay, "n" | "day_list_id">> | null | undefined): LinkedDayRow[] =>
  rows.map((row) => {
    const id = dayListIdOf(daily, row.dayNo);
    return { ...row, href: id === null ? null : dayBoardHref(id) };
  });

// -- equity chart ------------------------------------------------------------------------------------------------

export type EquityDayRow = { dayNo: number; day: string; balance: string; equity: string; inWeek: boolean };

/** The chart as a table for a screen reader (the chart axis names no day): "Day 6", balance and equity per close. */
export const equityRows = (series: Pick<EquitySeries, "points">): EquityDayRow[] =>
  series.points.map((point) => ({
    dayNo: point.dayNo,
    day: `Day ${point.dayNo}`,
    balance: formatBalance(point.balance),
    equity: formatBalance(point.equity),
    inWeek: point.inWeek,
  }));

/** "Day 1 to Day 10 · this week is Days 6 to 10, shaded". */
export function equityCaption(series: Pick<EquitySeries, "points" | "weekFirstDay" | "weekLastDay">): string {
  const last = series.points.at(-1)?.dayNo ?? series.weekLastDay;
  const week = series.weekFirstDay === series.weekLastDay ? `Day ${series.weekFirstDay}` : `Days ${series.weekFirstDay} to ${series.weekLastDay}`;
  return `Day 1 to Day ${last} · this week is ${week}, shaded`;
}

// -- load problems ---------------------------------------------------------------------------------------------

/** A heading and one full sentence for a week that cannot open. The server's reason is a fragment ("swing threads only"), so a day thread gets its own sentence and any other reason is capitalised and ended. */
export function weekMissingText(message: string, mode: "day" | "swing" | null): { title: string; text: string } {
  if (mode === "day") return { title: WEEK_TEXT.weeklyReviewTitle, text: WEEK_TEXT.dayThreadNoWeeks };
  const text = message.trim();
  return { title: WEEK_TEXT.weeklyReviewTitle, text: `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}` };
}

export type WeekProblem = { kind: "missing"; message: string } | { kind: "failed" };

/** A 404 is a week that has not started (or is not hers): the server's own plain sentence. Anything else is a failed load. */
export function weekLoadProblem(error: unknown): WeekProblem {
  if (error instanceof DeskApiError && error.status === 404) {
    return { kind: "missing", message: error.problems[0]?.message || error.detail || WEEK_TEXT.notStarted };
  }
  return { kind: "failed" };
}
