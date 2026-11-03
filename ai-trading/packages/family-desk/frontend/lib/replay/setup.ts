import { DeskApiError } from "../api/client.ts";
import { formatEtDay } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { ReplayInterval } from "./schemas.ts";
import { etDayOf, etHhMm } from "./time.ts";

// What the Practice screens share about picking a day and reading a failed request. The thread's start instant is the New thread form's
// (`planSetup.ts`); a standalone one-day replay no longer exists (ADR-0025), so there is no session draft here.

export const EARLIEST_DAY = "2016-01-04";
export const INTERVALS: readonly ReplayInterval[] = ["1m", "5m", "15m"];

const DAY_PLEASE = "Pick a day";

export const isWeekend = (day: string) => {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
};

const previousWeekday = (day: string): string => {
  const date = new Date(`${day}T12:00:00Z`);
  do date.setUTCDate(date.getUTCDate() - 1); while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
};

/** The latest day a thread can start on: today after the regular close plus the 15 minute data delay (4:15 PM ET), else the previous weekday.
 *  The server's `horizon` (the extended close of the newest session the embargo has released) has the last word. */
export function latestReplayDay(now: Date): string {
  const iso = now.toISOString();
  const today = etDayOf(iso);
  return !isWeekend(today) && etHhMm(iso) >= "16:15" ? today : previousWeekday(today);
}

/** A quick local read of a typed start date. Holidays and missing data are the server's call (its `422` shows inline). */
export function dayProblem(day: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) return DAY_PLEASE;
  if (day < EARLIEST_DAY) return PRACTICE_COPY.beforeFloor;
  if (isWeekend(day)) return practiceText("noTrading", { day: formatEtDay(day) });
  // Only today can be unfinished (its replay opens at 4:15 PM ET); a later date is not traded yet and gets the last finished day.
  if (day > latestReplayDay(now)) {
    return day > etDayOf(now.toISOString()) ? practiceText("futureDay", { day: formatEtDay(latestReplayDay(now)) }) : PRACTICE_COPY.notFinished;
  }
  return null;
}

// ---- errors -------------------------------------------------------------------------------------------------

/** The plain message of a failed Practice request: the server's first problem or detail, else the fallback. */
export function problemMessage(error: unknown, fallback: string): string {
  if (error instanceof DeskApiError) {
    return error.problems[0]?.message || error.detail || fallback;
  }
  return fallback;
}
