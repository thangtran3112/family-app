"use client";

import Link from "next/link";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadThreads } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { dateLabel } from "@/lib/replay/journalView";
import { dayResultTone, formatDayResult } from "@/lib/replay/threadView";
import type { Thread, ThreadSummary } from "@/lib/replay/threads";
import { ThreadList } from "./ThreadList";
import styles from "./threadJournal.module.css";

/** The journal's left rail (P8, D-039): her threads (switch or start one), the ET dates she traded with their results, and how to read the charts. */
export function ThreadSidePanel({ thread }: { thread: Thread }) {
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

        <section className={styles.block} aria-labelledby="thread-dates-title">
          <div className={styles.blockHead}>
            <h2 id="thread-dates-title" className={styles.sectionTitle}>{PRACTICE_COPY.journalDatesTitle}</h2>
            <SimulatedBadge />
          </div>
          <p className={styles.hint}>{PRACTICE_COPY.journalDatesHint}</p>
          {thread.daily.length === 0 ? (
            <p className={styles.muted}>{PRACTICE_COPY.journalDatesNone}</p>
          ) : (
            <ul role="list" className={styles.list}>
              {thread.daily.map((date) => (
                <li key={date.day} className={styles.dateRow}>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{dateLabel(date.day)}</span>
                    <span className={styles.rowMeta}>{`${date.trades} ${date.trades === 1 ? "trade" : "trades"}`}</span>
                  </span>
                  <span className={`${styles.money} ${styles[dayResultTone(date.pnl_usd)]}`}>{formatDayResult(date.pnl_usd)}</span>
                </li>
              ))}
              <li className={styles.dateRow}>
                <span className={styles.rowTitle}>{PRACTICE_COPY.journalDatesAll}</span>
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
              <span>{PRACTICE_COPY.journalLegendWon}</span>
            </li>
            <li className={styles.legendRow}>
              <span className={`${styles.swatch} ${styles.swatchLost}`} aria-hidden="true" />
              <span>{PRACTICE_COPY.journalLegendLost}</span>
            </li>
          </ul>
        </section>
      </div>
    </LeftRailPortal>
  );
}
