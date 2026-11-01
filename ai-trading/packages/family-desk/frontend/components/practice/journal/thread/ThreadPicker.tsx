"use client";

import { EmptyBlock, QueryBoundary } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadThreads } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { ThreadList } from "./ThreadList";
import styles from "./threadJournal.module.css";

/** `/practice/journal` with no thread (D-037): says so in plain words and lists her threads, the active one first, each a link to its journal. */
export function ThreadPicker() {
  const list = useDeskQuery("replay-threads:picker", (signal) => loadThreads({ signal }));
  return (
    <div className={styles.center}>
      <QueryBoundary query={list} loading={PRACTICE_COPY.threadsLoading} height={160} message={PRACTICE_COPY.threadsLoadError}>
        {(threads) => {
          const rows = [...threads].sort((a, b) => Number(b.thread.status === "active") - Number(a.thread.status === "active"));
          return (
            // With no thread there is one statement, not "no thread selected" over "no thread yet" (D-117).
            <EmptyBlock framed={rows.length === 0} title={rows.length === 0 ? PRACTICE_COPY.threadPickNone : PRACTICE_COPY.threadPickTitle} action={{ label: PRACTICE_COPY.openPractice, href: "/practice", primary: rows.length === 0 }}>
              {rows.length > 0 && (
                <div className={styles.stack}>
                  <p className={styles.muted}>{PRACTICE_COPY.threadPickHint}</p>
                  <ThreadList rows={rows} label="Your threads" />
                </div>
              )}
            </EmptyBlock>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
