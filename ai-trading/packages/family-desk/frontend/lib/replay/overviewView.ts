import { formatEtDateClock, type Tone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { positionsCountText } from "./positionTable.ts";
import { clockStateText } from "./threadClock.ts";
import type { PracticeThread, ThreadClockBrief, ThreadDate, ThreadSummary } from "./threads.ts";
import { dayResultTone, formatBalance, formatDayResult, winRateText } from "./threadView.ts";

// View logic of the thread card (the landing's row) and of the Summary (`/practice/thread?id=`, ADR-0025). Pure, so the node tests cover
// it. Every dollar figure is SIMULATED. A freestyle thread has a clock `T` and a balance, not a day number: nothing here counts days,
// names a "Day 3", or says a thread is finished. A date is an ET calendar date, a label only.

const monthDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

// -- the card ----------------------------------------------------------------------------------------------------------------

export type ThreadCard = {
  /** The thread's time `T`: "Tue 2026-03-10 · 9:41 AM ET", or "No start time yet". */
  clock: string;
  /** "Running at 5x", "Paused", "Paused at the latest available data"; "" with no clock. */
  state: string;
  running: boolean;
  /** "2 open positions". */
  positions: string;
  /** "Oct 25", or "No activity yet". The wall-clock day of the last trade or clock move, never a replayed date. */
  lastActivity: string;
};

/** The thread's time as the card reads it: a started clock gives its time, a thread without a setup says so. */
export const clockLine = (clock: Pick<ThreadClockBrief, "clock"> | null): string =>
  clock === null ? PRACTICE_COPY.landingNoClock : formatEtDateClock(clock.clock, { seconds: false });

/** The pill beside the time: the brief carries no `state`, so it is derived (`running` runs, anything else is paused). */
export const clockPill = (clock: Pick<ThreadClockBrief, "running" | "speed" | "pause"> | null): string =>
  clock === null ? "" : clockStateText({ state: clock.running ? "running" : "paused", speed: clock.speed, pause: clock.pause });

export const lastActivityText = (iso: string | null): string => (iso === null ? PRACTICE_COPY.landingNoActivity : monthDay.format(new Date(iso)));

export function threadCard(summary: Pick<ThreadSummary, "clock" | "positions_open" | "last_activity_at">): ThreadCard {
  return {
    clock: clockLine(summary.clock),
    state: clockPill(summary.clock),
    running: summary.clock?.running === true,
    positions: positionsCountText(summary.positions_open),
    lastActivity: lastActivityText(summary.last_activity_at),
  };
}

/**
 * The time the Summary's place line reads: the time its figure is priced at, the clock poll's account (`as_of`), so the equity and its "At"
 * agree after a Jump or a Next open (D-218). Without a live account (a closed thread, no poll yet) it is the clock the Summary loaded.
 */
export const placeAt = (loaded: Pick<ThreadClockBrief, "clock"> | null, account: { as_of: string } | null): string | null => account?.as_of ?? loaded?.clock ?? null;

// -- the stats -------------------------------------------------------------------------------------------------------------

export type OverviewStat = { id: string; label: string; value: string };

/** Closed trades, wins, losses and the win rate, from the thread's own stats (the ledger). Open positions are counted from the card, not here. */
export function overviewStats(stats: Pick<PracticeThread["stats"], "wins" | "losses" | "winRate">, positionsOpen: number): OverviewStat[] {
  return [
    { id: "closed", label: PRACTICE_COPY.overviewStatClosed, value: String(stats.wins + stats.losses) },
    { id: "win_rate", label: PRACTICE_COPY.threadWinRate, value: winRateText(stats.winRate) },
    { id: "wins", label: PRACTICE_COPY.overviewStatWins, value: String(stats.wins) },
    { id: "losses", label: PRACTICE_COPY.overviewStatLosses, value: String(stats.losses) },
    { id: "open", label: PRACTICE_COPY.overviewStatOpen, value: String(positionsOpen) },
  ];
}

/** "Since start +$123.00": equity less the starting balance, from the clock account. */
export const sinceStartText = (sinceStartUsd: number): string => practiceText("overviewSinceStart", { amount: formatDayResult(sinceStartUsd) });

// -- the results by ET date ------------------------------------------------------------------------------------------------

export type OverviewDateRow = {
  key: string;
  /** "Fri 2026-10-23". */
  date: string;
  trades: string;
  result: string;
  resultTone: Tone;
  balance: string;
};

/** One row per ET date with a realized trade, the newest first. The date is a label and a grouping key: nothing ends at it. */
export const overviewDateRows = (daily: readonly ThreadDate[]): OverviewDateRow[] =>
  daily
    .map((day): OverviewDateRow => ({
      key: day.day,
      date: `${day.weekday} ${day.day}`,
      trades: String(day.trades),
      result: formatDayResult(day.pnl_usd),
      resultTone: dayResultTone(day.pnl_usd),
      balance: formatBalance(day.balance),
    }))
    .reverse();
