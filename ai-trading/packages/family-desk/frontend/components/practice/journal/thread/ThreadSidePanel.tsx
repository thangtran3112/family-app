"use client";

import Link from "next/link";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadThreads } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { dayResultTone, formatDayResult, type Week } from "@/lib/replay/threadView";
import type { Thread, ThreadSummary } from "@/lib/replay/threads";
import { ThreadList } from "./ThreadList";
import styles from "./threadJournal.module.css";

/** The journal's left rail (P8, D-039): her threads (switch or start one), the weeks with their day results, and how to read the charts.
 *  A swing thread (02p) keeps only the switcher: its weeks table and the curve's key sit in the page itself. */
export function ThreadSidePanel({ thread, weeks, swing = false }: { thread: Thread; weeks: Week[]; swing?: boolean }) {
  const list = useDeskQuery("replay-threads:journal", (signal) => loadThreads({ signal }));
  const current = thread.thread.id;
  const listed = list.data ?? [];
  // The open thread's own row comes from `thread`, so its balance and status stay current; if the list is down, only this row shows.
  const rows: ThreadSummary[] = listed.some((row) => row.thread.id === current) ? listed.map((row) => (row.thread.id === current ? thread : row)) : [thread, ...listed];
  const { stats, startingBalance } = thread.thread;
  const change = stats.balance - startingBalance;

  return (
    <LeftRailPortal>
      <div className={styles.panel}>
        <section className={styles.block} aria-labelledby="thread-switcher-title">
          <div className={styles.blockHead}>
            <h2 id="thread-switcher-title" className={styles.sectionTitle}>{PRACTICE_COPY.threadSwitcher}</h2>
            <Link href="/practice#threads" className={styles.link}>{PRACTICE_COPY.threadNewTitle}</Link>
          </div>
          <ThreadList rows={rows} current={current} />
        </section>

        {!swing && (
          <>
            <section className={styles.block} aria-labelledby="thread-weeks-title">
              <div className={styles.blockHead}>
                <h2 id="thread-weeks-title" className={styles.sectionTitle}>{PRACTICE_COPY.weeksTitle}</h2>
                <SimulatedBadge />
              </div>
              <p className={styles.hint}>{PRACTICE_COPY.weeksHint}</p>
              {weeks.length === 0 ? (
                <p className={styles.muted}>{PRACTICE_COPY.weeksNone}</p>
              ) : (
                <ul role="list" className={styles.list}>
                  {weeks.map((week) => (
                    <li key={week.n} className={styles.weekRow}>
                      <span className={styles.rowMain}>
                        <span className={styles.rowTitle}>{week.label}</span>
                        <span className={styles.rowMeta}>{week.detail}</span>
                      </span>
                      <span className={`${styles.money} ${styles[dayResultTone(week.pnl)]}`}>{formatDayResult(week.pnl)}</span>
                    </li>
                  ))}
                  <li className={styles.weekRow}>
                    <span className={styles.rowTitle}>{PRACTICE_COPY.weeksAll}</span>
                    <span className={`${styles.money} ${styles[dayResultTone(change)]}`}>{formatDayResult(change)}</span>
                  </li>
                </ul>
              )}
            </section>

            <section className={styles.block} aria-labelledby="thread-legend-title">
              <h2 id="thread-legend-title" className={styles.sectionTitle}>{PRACTICE_COPY.legendTitle}</h2>
              <ul role="list" className={styles.list}>
                <li className={styles.legendRow}>
                  <span className={`${styles.swatch} ${styles.swatchWon}`} aria-hidden="true" />
                  <span>{PRACTICE_COPY.legendWon}</span>
                </li>
                <li className={styles.legendRow}>
                  <span className={`${styles.swatch} ${styles.swatchLost}`} aria-hidden="true" />
                  <span>{PRACTICE_COPY.legendLost}</span>
                </li>
                <li className={styles.legendRow}>
                  <span className={`${styles.swatch} ${styles.swatchSkipped}`} aria-hidden="true" />
                  <span>{PRACTICE_COPY.legendSkipped}</span>
                </li>
              </ul>
            </section>
          </>
        )}
      </div>
    </LeftRailPortal>
  );
}
