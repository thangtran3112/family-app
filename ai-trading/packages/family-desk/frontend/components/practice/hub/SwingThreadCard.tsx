"use client";

import Link from "next/link";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { swingCardView } from "@/lib/replay/swing";
import type { ThreadSummary } from "@/lib/replay/threads";
import { threadModeLabel, threadName } from "@/lib/replay/threadView";
import { SwingContinue } from "./SwingContinue";
import styles from "./hub.module.css";

/**
 * The active swing thread's card (02p h): "Swing · 50 names · Week 2 of 4 · Day 7 of 20 · Balance $51,240 · Equity $52,010 ·
 * 2 holds open" with SIMULATED, then what comes next: `Continue Day 7`, the finished week's review, or nothing when the
 * thread is finished (its journal stays one link away). It sits beside the day thread's card.
 */
export function SwingThreadCard({ summary, onChanged }: { summary: ThreadSummary; onChanged: () => void }) {
  const view = swingCardView(summary);
  const { thread } = summary;
  if (view === null) return null;
  const { action } = view;
  return (
    <article className={styles.threadCard} aria-label="Active swing thread">
      <div className={styles.threadHead}>
        <span className={styles.threadName}>{threadName(thread)}</span>
        <span className={styles.chip}>{threadModeLabel(thread.mode)}</span>
        <span className={styles.threadActiveTag}>
          <span className={styles.openDot} aria-hidden="true" />
          {PRACTICE_COPY.threadActive}
        </span>
      </div>
      <p className={styles.balanceRow}>
        <span className={styles.swingLine}>{view.line}</span>
        <SimulatedBadge />
      </p>
      {view.notice && <p className={styles.swingNotice} role="status">{view.notice}</p>}
      {action.kind === "review" && action.weekNo !== null && action.label !== null ? (
        <div className={styles.inline}>
          <Link href={`/practice/week?thread=${thread.id}&week=${action.weekNo}`} className={styles.primaryLink}>{action.label}</Link>
        </div>
      ) : (
        (action.kind === "start" || action.kind === "continue") && action.label !== null && (
          <SwingContinue threadId={thread.id} label={action.label} onChanged={onChanged} />
        )
      )}
      <Link href={`/practice/journal?thread=${thread.id}`} className={styles.threadLink}>{PRACTICE_COPY.threadJournal}</Link>
    </article>
  );
}
