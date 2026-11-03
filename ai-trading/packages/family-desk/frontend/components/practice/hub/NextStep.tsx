"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { journalHref } from "@/lib/replay/practiceTabs";
import type { ThreadSummary } from "@/lib/replay/threads";
import { DeleteThread } from "./DeleteThread";
import { ThreadAction } from "./ThreadAction";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

/**
 * The Summary's one primary step (ADR-0025): an active thread opens its Screen, with Delete thread beside it. The clock below it runs with or
 * without a name open, so the card never says "Resume" or names a day. A thread with no setup says it has no clock yet. A closed
 * thread has no step: its positions stay open at the time it stopped, and its journal and final balance stay here.
 */
export function NextStep({ summary }: { summary: ThreadSummary }) {
  const { thread, clock } = summary;
  const closed = thread.status === "closed";
  const router = useRouter();

  return (
    <section className={`${styles.panel} ${styles.nextStep}`} aria-label={PRACTICE_COPY.overviewStepTitle}>
      <h2 className={styles.panelTitle}>{closed ? PRACTICE_COPY.threadClosedTitle : PRACTICE_COPY.overviewStepTitle}</h2>
      {closed ? (
        <>
          <p className={hub.muted}>{PRACTICE_COPY.overviewStepClosed}</p>
          <div className={styles.dayActions}>
            <Button client href={journalHref(thread.id)} variant="primary">{PRACTICE_COPY.threadOpenJournal}</Button>
            <Link href="/practice" className={styles.secondaryLink}>{PRACTICE_COPY.threadStartNew}</Link>
          </div>
        </>
      ) : (
        <>
          <div className={styles.dayActions}>
            <div className={styles.resumeAction}>
              <ThreadAction summary={summary} />
            </div>
            <DeleteThread thread={thread} onSummary onDeleted={() => router.push("/practice")} />
          </div>
          <p className={styles.dayLine}>{clock === null ? PRACTICE_COPY.overviewStepNoClock : PRACTICE_COPY.overviewStepLine}</p>
        </>
      )}
    </section>
  );
}
