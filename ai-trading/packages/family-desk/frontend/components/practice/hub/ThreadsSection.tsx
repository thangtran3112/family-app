"use client";

import { useState } from "react";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadDaily, loadThread, loadThreads } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import type { ThreadSummary } from "@/lib/replay/threads";
import { threadName } from "@/lib/replay/threadView";
import { ClosedThreadCard, ThreadCard } from "./ThreadCard";
import { NewThreadForm } from "./NewThreadForm";
import styles from "./hub.module.css";

/** "Your practice threads" (02r): her pretend accounts. The selected thread's card on the left; on the right the New
 *  thread form: live with no active thread, disabled with a note while one is (the server allows one active day thread at a time). */
export function ThreadsSection({ revision, onChanged }: { revision?: number; onChanged: () => void }) {
  const threads = useDeskQuery("replay-threads", (signal) => loadThreads({ signal }), { revision });
  const daily = useDeskQuery("replay-daily-for-threads", (signal) => loadDaily({ signal }), { revision });
  const [pickedId, setPickedId] = useState<number | null>(null);

  const list: ThreadSummary[] = threads.data ?? [];
  const active = list.find((row) => row.thread.status === "active") ?? null;
  // The card's TODAY row falls back to the last ended day (D-030), which only the thread's day series holds.
  const activeId = active?.thread.id ?? null;
  const detail = useDeskQuery(`replay-thread-days:${activeId}`, (signal) => loadThread(activeId ?? 0, { signal }), { enabled: activeId !== null, revision });
  const lastDay = detail.data?.daily.at(-1) ?? null;
  const selected = list.find((row) => row.thread.id === pickedId) ?? active ?? list[0] ?? null;
  // A plan opens days in its own thread only: a plan bound to a closed thread is not offered here.
  const plan = daily.data?.plan ?? null;
  const planOpen = plan !== null && !plan.finished && active !== null && plan.thread_id === active.thread.id;

  function focusNewThread() {
    document.getElementById("thread-balance")?.focus();
  }

  return (
    <section id="threads" aria-labelledby="threads-title" className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 id="threads-title" className={styles.sectionTitle}>{PRACTICE_COPY.threadsTitle}</h2>
        <p className={styles.hint}>{PRACTICE_COPY.threadsHint}</p>
      </div>
      {threads.loading || detail.loading ? (
        <LoadingBlock label={PRACTICE_COPY.threadsLoading} height={180} />
      ) : threads.data === null ? (
        <ErrorBlock message={PRACTICE_COPY.threadsLoadError} onRetry={threads.refresh} />
      ) : (
        <>
          {list.length > 1 && (
            <div role="group" aria-label={PRACTICE_COPY.threadSwitcher} className={`${styles.segmented} ${styles.threadSwitch}`}>
              {list.map((row) => (
                <button
                  key={row.thread.id}
                  type="button"
                  className={styles.segment}
                  aria-pressed={row.thread.id === selected?.thread.id}
                  onClick={() => setPickedId(row.thread.id)}
                >
                  {`${threadName(row.thread)} · ${row.thread.status === "active" ? PRACTICE_COPY.threadActive : PRACTICE_COPY.threadClosedBadge}`}
                </button>
              ))}
            </div>
          )}
          <div className={styles.threadGrid}>
            {selected === null ? (
              <p className={styles.threadEmpty}>{PRACTICE_COPY.threadNone}</p>
            ) : selected.thread.status === "active" ? (
              <ThreadCard summary={selected} lastDay={lastDay} planOpen={planOpen} onChanged={onChanged} />
            ) : (
              <ClosedThreadCard thread={selected.thread} canStartNew={active === null} onStartNew={focusNewThread} />
            )}
            <NewThreadForm active={active?.thread ?? null} onCreated={onChanged} />
          </div>
        </>
      )}
    </section>
  );
}
