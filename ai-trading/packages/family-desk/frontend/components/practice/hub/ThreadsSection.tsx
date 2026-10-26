"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadDaily, loadThreads } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { activeThreads, HUB_SWING_COPY, openModes } from "@/lib/replay/hubSwing";
import type { ThreadSummary } from "@/lib/replay/threads";
import { threadModeLabel, threadName } from "@/lib/replay/threadView";
import { ClosedThreadCard, ThreadCard } from "./ThreadCard";
import { NewThreadForm } from "./NewThreadForm";
import { SwingThreadCard } from "./SwingThreadCard";
import styles from "./hub.module.css";

/** "Your practice threads" (02r, 02p): her pretend accounts. The server allows one active thread per mode, so a day
 *  thread's card and a swing thread's card sit side by side; the New thread form follows while a mode is free. A closed
 *  thread is picked from the switcher and shown beside them (or alone when none is active). */
export function ThreadsSection({ revision, onChanged }: { revision?: number; onChanged: () => void }) {
  const threads = useDeskQuery("replay-threads", (signal) => loadThreads({ signal }), { revision });
  const daily = useDeskQuery("replay-daily-for-threads", (signal) => loadDaily({ signal }), { revision });
  const [pickedId, setPickedId] = useState<number | null>(null);

  const list: ThreadSummary[] = threads.data ?? [];
  const active = activeThreads(list);
  const open = openModes(active);
  const actives = [active.day, active.swing].filter((row): row is ThreadSummary => row !== null);
  const closed = list.filter((row) => row.thread.status === "closed");
  const picked = closed.find((row) => row.thread.id === pickedId) ?? null;
  const cards = actives.length > 0 ? (picked ? [...actives, picked] : actives) : [picked ?? list[0]].filter((row): row is ThreadSummary => row !== undefined);
  // A plan opens days in its own thread only: a plan bound to a closed thread (or to the swing thread) is not offered here.
  const plan = daily.data?.plan ?? null;
  const planOpen = plan !== null && !plan.finished && active.day !== null && plan.thread_id === active.day.thread.id;

  function focusNewThread() {
    document.getElementById("thread-balance")?.focus();
  }

  return (
    <section id="threads" aria-labelledby="threads-title" className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 id="threads-title" className={styles.sectionTitle}>{PRACTICE_COPY.threadsTitle}</h2>
        <p className={styles.hint}>{PRACTICE_COPY.threadsHint}</p>
      </div>
      {threads.loading ? (
        <LoadingBlock label={PRACTICE_COPY.threadsLoading} height={180} />
      ) : threads.data === null ? (
        <ErrorBlock message={PRACTICE_COPY.threadsLoadError} onRetry={threads.refresh} />
      ) : (
        <>
          {closed.length > 0 && list.length > 1 && (
            <div role="group" aria-label={PRACTICE_COPY.threadSwitcher} className={`${styles.segmented} ${styles.threadSwitch}`}>
              {closed.map((row) => (
                <button
                  key={row.thread.id}
                  type="button"
                  className={styles.segment}
                  aria-pressed={cards.some((card) => card.thread.id === row.thread.id)}
                  onClick={() => setPickedId(pickedId === row.thread.id && actives.length > 0 ? null : row.thread.id)}
                >
                  {`${threadName(row.thread)} · ${threadModeLabel(row.thread.mode)} · ${PRACTICE_COPY.threadClosedBadge}`}
                </button>
              ))}
            </div>
          )}
          <div className={styles.threadGrid}>
            {cards.length === 0 && <p className={styles.threadEmpty}>{PRACTICE_COPY.threadNone}</p>}
            {cards.map((row) =>
              row.thread.status === "closed" ? (
                <ClosedThreadCard key={row.thread.id} thread={row.thread} canStartNew={open.day || open.swing} onStartNew={focusNewThread} />
              ) : row.thread.mode === "swing" ? (
                <SwingThreadCard key={row.thread.id} summary={row} onChanged={onChanged} />
              ) : (
                <ThreadCard key={row.thread.id} summary={row} planOpen={planOpen} onChanged={onChanged} />
              ),
            )}
            {open.day || open.swing ? (
              <NewThreadForm key={`${open.day}-${open.swing}`} open={open} wide={cards.length >= 2} onCreated={onChanged} />
            ) : (
              <div className={styles.threadPanel}>
                <h3 className={styles.threadTitle}>{PRACTICE_COPY.threadNewTitle}</h3>
                <p className={styles.muted}>{HUB_SWING_COPY.bothActive}</p>
                <div className={styles.inline}>
                  {actives.map((row) => (
                    <Link key={row.thread.id} href={`/practice/journal?thread=${row.thread.id}`} className={styles.threadLink}>
                      {`${threadModeLabel(row.thread.mode)} · ${PRACTICE_COPY.threadJournal}`}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
