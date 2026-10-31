import { EMPTY_VALUE, type Tone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { swingCardView } from "./swing.ts";
import type { WeekRow } from "./swingApi.ts";
import type { PracticeThread, SwingState, ThreadDay, ThreadSummary } from "./threads.ts";
import { dayResultTone, formatBalance, formatDayResult, winRateText } from "./threadView.ts";
import { dayBoardHref } from "./weekScreen.ts";
import { weekReviewable, weekRowView } from "./weekView.ts";

// View logic of the thread overview (`/practice/thread?id=`, 5R) and of the landing's Progress column: the progress
// text, the days table rows, the week list and the adherence stat. Pure, so the node tests cover it. Every dollar figure
// is SIMULATED. A day is named by number and weekday only: the replayed calendar date is never shown.

// -- progress (the landing's one Progress column) ------------------------------------------------------------------------

export type ThreadProgress = {
  /** "Day 6 of 20" (swing), "Day 6" (day thread), "Finished", or "5 days" for a closed thread. */
  main: string;
  /** "4 practiced · 1 skipped", or "No days yet" before the first day ends. */
  sub: string;
  /** "Week 1 review due" while a swing thread waits for its review; null otherwise. */
  gate: string | null;
};

const daysEnded = (summary: Pick<ThreadSummary, "thread">): number => summary.thread.stats.daysPracticed + summary.thread.stats.daysSkipped;

/** Where a thread is, in one place: the number of the day it is on, and what the days so far add up to. */
export function threadProgress(summary: Pick<ThreadSummary, "thread" | "swing" | "today" | "last_day">, planFinished = false): ThreadProgress {
  const { thread, swing, today, last_day: lastDay } = summary;
  const { stats } = thread;
  const ended = daysEnded(summary);
  const sub = ended === 0 ? PRACTICE_COPY.landingProgressNoDays : practiceText("landingProgressCounts", { practiced: stats.daysPracticed, skipped: stats.daysSkipped });
  const card = swingCardView({ thread, swing, today });
  const review = card?.action.kind === "review" && card.action.weekNo !== null ? practiceText("landingReviewDue", { n: card.action.weekNo }) : null;
  if (swing && thread.mode === "swing") {
    const main = swing.next === "finished" ? PRACTICE_COPY.landingProgressFinished : practiceText("planDay", { day: swing.day_no, of: swing.days });
    return { main, sub, gate: review };
  }
  if (thread.status === "closed") return { main: ended === 0 ? PRACTICE_COPY.landingProgressNone : practiceText("landingProgressClosed", { n: ended }), sub, gate: null };
  if (today !== null) return { main: practiceText("landingProgressDay", { n: today.day_no }), sub, gate: null };
  // The plan's last day has ended: "Day 5 done" would sit beside "New plan needed" (D-096).
  if (planFinished) return { main: PRACTICE_COPY.landingProgressFinished, sub, gate: null };
  if (lastDay !== null) return { main: practiceText("landingProgressDone", { n: lastDay.n }), sub, gate: null };
  return { main: PRACTICE_COPY.landingProgressNone, sub, gate: null };
}

/** "Plan finished · 5 days · +$123.00 · win rate 64%": the summary a finished day plan ends on (days, P/L and win rate, from the thread's own stats). */
export function planFinishedLine(thread: Pick<PracticeThread, "startingBalance" | "stats">): string {
  const days = thread.stats.daysPracticed + thread.stats.daysSkipped;
  return practiceText("planFinishedSummary", {
    days: `${days} ${days === 1 ? "day" : "days"}`,
    change: formatDayResult(thread.stats.balance - thread.startingBalance),
    rate: winRateText(thread.stats.winRate),
  });
}

// -- adherence -----------------------------------------------------------------------------------------------------------

/** The Adherence stat: "0%" with "last scored day", or "71% → 83%" with "first to last scored day". Never a bare number. */
export function adherenceStat(stats: Pick<PracticeThread["stats"], "adherenceFirstPct" | "adherenceLastPct">): { value: string; hint: string } {
  const { adherenceFirstPct: first, adherenceLastPct: last } = stats;
  if (first === undefined && last === undefined) return { value: EMPTY_VALUE, hint: PRACTICE_COPY.threadAdherenceNone };
  if (first === undefined || last === undefined || first === last) return { value: `${last ?? first}%`, hint: PRACTICE_COPY.threadAdherenceLast };
  return { value: `${first}% → ${last}%`, hint: PRACTICE_COPY.threadAdherenceRange };
}

// -- the days table --------------------------------------------------------------------------------------------------------

export type OverviewDayRow = {
  key: string;
  n: number;
  /** "Day 3 · Wed". */
  title: string;
  /** The day's board in its ended state. */
  href: string;
  practiced: boolean;
  status: string;
  trades: string;
  result: string;
  resultTone: Tone;
  adherence: string;
  balance: string;
};

/** A swing thread's equity at each ended day's close, so a day she passed can say what its open holds did (D-082). */
export type EquityDays = { startingBalance: number; series: ReadonlyArray<Pick<SwingState["equity_series"][number], "day_no" | "equity_usd">> };

/** "Passed", or "Passed · holds rode, equity +$601.00" when the open holds moved a swing thread's equity that day. */
function passedText(dayNo: number, equity: EquityDays | undefined): string {
  const at = equity?.series.find((point) => point.day_no === dayNo);
  if (!equity || !at) return PRACTICE_COPY.overviewDaySkipped;
  const before = dayNo === 1 ? equity.startingBalance : (equity.series.find((point) => point.day_no === dayNo - 1)?.equity_usd ?? at.equity_usd);
  const change = at.equity_usd - before;
  return Math.abs(change) < 0.005 ? PRACTICE_COPY.overviewDaySkipped : practiceText("overviewDayPassedHolds", { change: formatDayResult(change) });
}

/** One row per ended day, the newest first. A passed day has no trades or result of its own; on a swing thread its open holds can still move equity. */
export const overviewDayRows = (daily: readonly ThreadDay[], equity?: EquityDays): OverviewDayRow[] =>
  daily
    .map((day): OverviewDayRow => {
      const practiced = day.kind === "practiced";
      return {
        key: String(day.n),
        n: day.n,
        title: practiceText("swingDayShort", { day: day.n, weekday: day.weekday }),
        href: dayBoardHref(day.day_list_id),
        practiced,
        status: practiced ? PRACTICE_COPY.overviewDayPracticed : passedText(day.n, equity),
        trades: practiced ? String(day.trades) : EMPTY_VALUE,
        result: practiced ? formatDayResult(day.pnl_usd) : EMPTY_VALUE,
        resultTone: practiced ? dayResultTone(day.pnl_usd) : "flat",
        adherence: day.adherence_pct === null ? EMPTY_VALUE : `${day.adherence_pct}%`,
        balance: formatBalance(day.balance),
      };
    })
    .sort((a, b) => b.n - a.n);

// -- the week list ---------------------------------------------------------------------------------------------------------

export type OverviewWeekStatus = "done" | "review" | "current" | "upcoming";

export type OverviewWeekRow = {
  weekNo: number;
  label: string;
  status: OverviewWeekStatus;
  statusText: string;
  days: string;
  realized: string;
  realizedTone: Tone;
  /** Realized plus the open holds' change: the figure a week with holds still open needs beside "realized" (D-081). */
  equityChange: string;
  equityChangeTone: Tone;
  /** The week's review; null for a week with no ended day. */
  href: string | null;
};

const STATUS_TEXT: Record<OverviewWeekStatus, string> = {
  done: PRACTICE_COPY.overviewWeekDone,
  review: PRACTICE_COPY.overviewWeekReview,
  current: PRACTICE_COPY.overviewWeekCurrent,
  upcoming: PRACTICE_COPY.overviewWeekUpcoming,
};

/**
 * Every week of the thread, not only the ones opened: a done week, the week whose review is owed (the gate: its last day
 * ended and the next one has not opened), the week under way, and the weeks still to come. `rows` is the weeks answer
 * (`null` while it loads or failed: every week then reads from the thread's own state).
 */
export function overviewWeekRows(threadId: number, state: Pick<SwingState, "weeks" | "week_no" | "next" | "days_ended">, rows: readonly WeekRow[] | null): OverviewWeekRow[] {
  const gated = state.next === "week_review";
  return Array.from({ length: state.weeks }, (_, index): OverviewWeekRow => {
    const weekNo = index + 1;
    const row = rows?.find((item) => item.week_no === weekNo);
    const started = row !== undefined && weekReviewable(row, state.days_ended);
    const status: OverviewWeekStatus =
      state.next === "finished"
        ? "done"
        : gated && weekNo === state.week_no - 1
          ? "review"
          : weekNo < state.week_no
            ? "done"
            : weekNo === state.week_no && !gated
              ? "current"
              : "upcoming";
    const view = row === undefined ? null : weekRowView(row);
    return {
      weekNo,
      label: practiceText("swingWeek", { n: weekNo }),
      status,
      statusText: STATUS_TEXT[status],
      days: view && started ? view.days : EMPTY_VALUE,
      realized: view && started ? view.realized : EMPTY_VALUE,
      realizedTone: view && started ? view.realizedTone : "flat",
      equityChange: view && started ? view.equityChange : EMPTY_VALUE,
      equityChangeTone: view && started ? view.equityChangeTone : "flat",
      href: started ? `/practice/week?thread=${threadId}&week=${weekNo}` : null,
    };
  });
}

// -- the next step ---------------------------------------------------------------------------------------------------------

export type SwingGate = { weekNo: number; step: string; locked: string };

/** The gated state of a swing thread: "Week 1 review" first, and "Day 6 unlocks after the Week 1 review" until it is done. Null when no review is owed. */
export function swingGate(summary: Pick<ThreadSummary, "thread" | "swing" | "today">): SwingGate | null {
  const card = swingCardView(summary);
  const weekNo = card?.action.kind === "review" ? card.action.weekNo : null;
  if (weekNo === null || !summary.swing) return null;
  return {
    weekNo,
    step: practiceText("overviewReviewStep", { n: weekNo }),
    locked: practiceText("overviewDayLocked", { day: summary.swing.day_no, n: weekNo }),
  };
}
