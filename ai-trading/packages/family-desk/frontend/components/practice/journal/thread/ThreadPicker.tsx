"use client";

import Link from "next/link";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadThreads } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { formatBalance, threadModeLabel, threadName } from "@/lib/replay/threadView";
import styles from "./threadJournal.module.css";

/** `/practice/journal` with no thread (D-037): says so in plain words and lists her threads, the active one first, each a link to its journal. */
export function ThreadPicker() {
  const list = useDeskQuery("replay-threads:picker", (signal) => loadThreads({ signal }));
  if (list.data === null) {
    return (
      <div className={styles.center}>
        {list.error === null ? <LoadingBlock label={PRACTICE_COPY.threadsLoading} height={160} /> : <ErrorBlock message={PRACTICE_COPY.threadsLoadError} onRetry={list.refresh} />}
      </div>
    );
  }
  const rows = [...list.data].sort((a, b) => Number(b.thread.status === "active") - Number(a.thread.status === "active"));
  return (
    <div className={styles.center}>
      <EmptyBlock title={PRACTICE_COPY.threadPickTitle}>
        <div className={styles.stack}>
          <p className={styles.muted}>{rows.length === 0 ? PRACTICE_COPY.threadPickNone : PRACTICE_COPY.threadPickHint}</p>
          {rows.length > 0 && (
            <ul role="list" className={styles.list} aria-label="Your threads">
              {rows.map((row) => (
                <li key={row.thread.id}>
                  <Link href={`/practice/journal?thread=${row.thread.id}`} className={styles.threadRow}>
                    <span className={styles.rowMain}>
                      <span className={styles.rowTitle}>{threadName(row.thread)}</span>
                      <span className={styles.rowMeta}>{`${row.thread.status === "active" ? PRACTICE_COPY.threadActive : PRACTICE_COPY.threadClosedBadge} · ${threadModeLabel(row.thread.mode)}`}</span>
                    </span>
                    <span className={styles.rowEnd}>
                      <span>{formatBalance(row.thread.stats.balance)}</span>
                      <SimulatedBadge />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/practice" className={styles.link}>Open Practice</Link>
        </div>
      </EmptyBlock>
    </div>
  );
}
