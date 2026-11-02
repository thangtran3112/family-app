"use client";

import { useSyncExternalStore } from "react";

// "Show date" on a hidden day (D-023) is the viewer's own choice for that day. The replay band sets it; the Summary's clock, its "Next session
// starts" line and its End day question read it, so they show what the "Replay · hidden day" chip shows (D-174). It is keyed by the day list, so
// the next day of the thread is hidden again, and it lives in memory only: a reload hides the date again, never the other way round.

const shown = new Set<number>();
const listeners = new Set<() => void>();

/** The viewer chose to see the date of this day. */
export function showDayDate(dayListId: number): void {
  if (shown.has(dayListId)) return;
  shown.add(dayListId);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** True once the viewer showed the date of this day list (null: no day, so nothing to show). */
export const dayDateShown = (dayListId: number | null): boolean => dayListId !== null && shown.has(dayListId);

export function useDayDateShown(dayListId: number | null): boolean {
  return useSyncExternalStore(subscribe, () => dayDateShown(dayListId), () => false);
}
