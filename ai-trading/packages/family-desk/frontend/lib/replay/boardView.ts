import { withPriorities } from "../desk/columns.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { SortValue } from "../desk/sort.ts";
import type { ListColumn } from "./daily.ts";
import { pollExpired } from "./hubSwing.ts";
import { firstSessionSymbol, sideLabel } from "./swing.ts";
import type { BoardRow, SwingDayList, SwingOpenNext, SwingPlan } from "./swingApi.ts";
import type { SwingState } from "./threads.ts";
import { etWallToUtcIso, ms } from "./time.ts";
import { SOURCE_ORDER } from "./universeView.ts";

// The swing board (02p d1), view logic beyond what swing.ts already says: the universe table's columns and sort, the
// stars (and the ones placed after the open), what the primary button does, and what an ended day offers next. Pure, so
// the node tests cover it.

// -- the universe table ---------------------------------------------------------------------------------------

export type BoardColumn = ListColumn & {
  align: "left" | "right";
  /** The direction of the first click on the header. */
  firstSort: "asc" | "desc";
  /** Present: dropped at the 1180 band (all of them at once, as `lib/desk/columns.ts` does). */
  priority?: number;
  /** The column is left out of a board where every cell of it is a dash (D-136). */
  hideWhenEmpty?: boolean;
};

/** The API's columns in its order, then the earnings chip (a row field, not a metric column). The ones that drop at 1180 are registered as `boardView` in `lib/desk/columns.ts`. */
export function boardColumns(columns: readonly ListColumn[]): BoardColumn[] {
  return withPriorities(
    [...columns, { key: "earnings", label: "Earnings", format: "text" }].map((column) => ({
      ...column,
      align: column.format === "text" ? ("left" as const) : ("right" as const),
      // Numbers and the match count read biggest first; the source order and the soonest report read first-to-last.
      firstSort: column.key === "source" || column.key === "earnings" ? ("asc" as const) : ("desc" as const),
      // The names that matched a filter and the names that report soon are often none at all: an all-dash column is only width to scroll past.
      hideWhenEmpty: column.key === "matches" || column.key === "earnings",
    })),
    "boardView",
  );
}

/** What a header click sorts by. A gap in the data is empty and always goes last. */
export function boardSortValue(key: string, row: BoardRow): SortValue {
  if (key === "symbol") return row.symbol;
  if (key === "source") {
    const index = SOURCE_ORDER.indexOf(row.source);
    return index === -1 ? SOURCE_ORDER.length : index;
  }
  if (key === "matches") return row.matches.length;
  if (key === "earnings") return row.earnings?.in_sessions ?? null;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

/** Open holds by symbol, as the tag next to a name on the board ("Long", "Short"). */
export function heldSides(holds: SwingDayList["holds"]): Record<string, string> {
  return Object.fromEntries(holds.filter((hold) => hold.status === "open").map((hold) => [hold.symbol, sideLabel(hold.side)]));
}

// -- stars ----------------------------------------------------------------------------------------------------

/** 09:30 ET of the day as an instant: a star placed after it is a late star (allowed, and scored). */
export const dayOpenClock = (day: string): string => etWallToUtcIso(day, "09:30") ?? `${day}T13:30:00.000Z`;

/** The star a click adds before the server has answered: stamped with the day clock, else the open. */
export const starEntry = (list: Pick<SwingDayList, "clock" | "day">, symbol: string): { symbol: string; starred_clock: string } => ({
  symbol,
  starred_clock: list.clock ?? dayOpenClock(list.day),
});

/** The names starred after the open. */
export function lateStars(list: Pick<SwingDayList, "watch" | "day">): string[] {
  const open = ms(dayOpenClock(list.day));
  return list.watch.filter((star) => ms(star.starred_clock) > open).map((star) => star.symbol);
}

/** "Starred after the open: COIN", or null with none. */
export const lateStarsText = (names: readonly string[]): string | null =>
  names.length === 0 ? null : practiceText("swingLateStars", { names: names.join(", ") });

// -- the primary button and Pass ----------------------------------------------------------------------------------

export const resumeDayLabel = (dayNo: number): string => `Resume Day ${dayNo}`;

export type BoardStart =
  /**
   * The day is under way: reopen the name's session at the day clock (the first focus name's, else a hold's, else any open
   * one). Asked of the server like a start, never opened by session id: that session may be behind the day clock.
   */
  | { kind: "resume"; symbol: string }
  /** Start the workspace on the first focus name, or on a hold when nothing is starred. */
  | { kind: "start"; symbol: string }
  /** Nothing starred and no hold to open on. */
  | { kind: "none" };

export function boardStart(list: Pick<SwingDayList, "status" | "watch" | "holds" | "sessions">): BoardStart {
  const symbol = firstSessionSymbol(list);
  if (list.status === "practicing") {
    const open = list.sessions.filter((session) => session.status === "active");
    const session = open.find((item) => item.symbol === symbol) ?? open[0];
    if (session) return { kind: "resume", symbol: session.symbol };
  }
  return symbol === null ? { kind: "none" } : { kind: "start", symbol };
}

/** Pass is for a day she has not opened: with a session under way the day ends from the workspace. */
export const canPass = (list: Pick<SwingDayList, "status" | "sessions">): boolean => list.status === "listed" && list.sessions.length === 0;

// -- after the day --------------------------------------------------------------------------------------------

export type EndedDayView = {
  /** "Week 2 is done. Review it to unlock Day 11." once that week's last day has ended and the review is the next step (D-085). */
  notice: string | null;
  /** The link to this day's week: "Open Week 2 review". */
  reviewLabel: string;
  reviewWeekNo: number;
  /** An older day while the thread waits on a LATER week's review: that review's link, beside this day's own. */
  waiting: { weekNo: number; label: string } | null;
  /**
   * `continue`: the next day opens from here. `review`: the finished week's review comes first (the review page offers
   * the next week). `finished`: the thread is over. Null while the thread state has not loaded.
   */
  next: { kind: "continue"; label: string } | { kind: "review" } | { kind: "finished"; text: string } | null;
};

/**
 * What an ended day offers. `swing` is the thread's state: undefined while it loads, null when it could not be read
 * (the server then decides what Continue opens).
 */
export function endedDayView(list: Pick<SwingDayList, "day_no" | "of" | "week_no">, swing: SwingState | null | undefined): EndedDayView {
  const reviewLabel = practiceText("swingOpenReview", { n: list.week_no });
  const base = { notice: null, reviewLabel, reviewWeekNo: list.week_no, waiting: null };
  const finished = { kind: "finished", text: PRACTICE_COPY.swingThreadFinished } as const;
  if (swing === undefined) return { ...base, next: null };
  if (swing === null) {
    return { ...base, next: list.day_no >= list.of ? finished : { kind: "continue", label: practiceText("swingContinueDay", { n: list.day_no + 1 }) } };
  }
  if (swing.next === "finished") return { ...base, next: finished };
  if (swing.next === "week_review") {
    // The state's week is the week of the next day to open, so the review waiting is the one before it. Any ended day says so.
    const weekNo = swing.week_no - 1;
    const waiting = weekNo === list.week_no ? null : { weekNo, label: practiceText("swingOpenReview", { n: weekNo }) };
    return { ...base, notice: practiceText("overviewDayLocked", { n: weekNo, day: swing.day_no }), waiting, next: { kind: "review" } };
  }
  return { ...base, next: { kind: "continue", label: practiceText("swingContinueDay", { n: swing.day_no }) } };
}

/**
 * The thread state the board may act on. `updating`: the thread is being read again (right after Pass), and the answer on
 * hand predates the pass, so it offers nothing yet. A failed refresh leaves that old answer too: null, as for a thread
 * that cannot be read (the server decides what Continue opens).
 */
export function trustedSwingState(thread: { data: { swing?: SwingState | null } | null; error: unknown; updating: boolean }): SwingState | null | undefined {
  if (thread.updating) return undefined;
  if (thread.data !== null) return thread.error === null ? (thread.data.swing ?? null) : null;
  return thread.error === null ? undefined : null;
}

// -- waiting for the next day's data --------------------------------------------------------------------------------

export type PrepStep =
  | { kind: "open"; href: string }
  /** Nothing to wait for: back to the hub. */
  | { kind: "hub" }
  | { kind: "wait"; prep: SwingPlan["prep"] }
  /** The data is taking too long: stop asking (the same ten minutes as the setup's preview). */
  | { kind: "expired" };

/** What `POST /daily/next` means for a board waiting since `startedAt`: the day that opened, the hub, keep asking, or give up. */
export function prepStep(result: SwingOpenNext, startedAt: number, now: number): PrepStep {
  if (result.day_list_id !== null) return { kind: "open", href: `/practice/day?id=${result.day_list_id}` };
  if (result.plan.finished || result.plan.prep.state !== "running") return { kind: "hub" };
  return pollExpired(startedAt, now) ? { kind: "expired" } : { kind: "wait", prep: result.plan.prep };
}
