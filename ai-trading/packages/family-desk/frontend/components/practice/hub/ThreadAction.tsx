"use client";

import type { MouseEvent } from "react";
import { Button } from "@/components/ui/Button";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { screenHref } from "@/lib/replay/practiceTabs";
import type { ThreadSummary } from "@/lib/replay/threads";
import styles from "./hub.module.css";

/** Props that switch a link off while a delete runs: a link has no `disabled`, so it is greyed, skipped by Tab and not followed. */
export const lockLink = (locked: boolean) =>
  locked ? { "aria-disabled": true as const, tabIndex: -1, onClick: (event: MouseEvent) => event.preventDefault() } : {};

/**
 * What a thread can do next, for the landing's rows and the Summary (ADR-0025): an active thread opens its Screen, where she picks a name
 * to trade. The clock is on the Summary and runs with or without a name open, so there is no "Resume" and no day to start. A thread
 * with no setup has no clock and says so; a closed thread has no action (its journal is the Trades link). `busy` is true while any
 * thread is being deleted, so no link is followed meanwhile.
 */
export function ThreadAction({ summary, busy = false }: { summary: Pick<ThreadSummary, "thread" | "clock">; busy?: boolean }) {
  const { thread, clock } = summary;
  if (thread.status === "closed") return null;
  if (clock === null) return <p className={styles.muted}>{PRACTICE_COPY.landingNoClock}</p>;
  return <Button client href={screenHref(thread.id)} variant="primary" {...lockLink(busy)}>{PRACTICE_COPY.landingOpenScreen}</Button>;
}
