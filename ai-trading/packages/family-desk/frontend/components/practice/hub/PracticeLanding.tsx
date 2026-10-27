"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EmptyBlock, ErrorBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadDaily, loadThreads } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { activeThreads, openModes } from "@/lib/replay/hubSwing";
import type { PracticeThread, ThreadSummary } from "@/lib/replay/threads";
import { NewPlanModal } from "./NewPlanModal";
import { ThreadTable } from "./ThreadTable";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

const POLL_MS = 4000;

/** Practice landing (02r2, Paper mock LEW-0): the header with New plan, and one table of her practice threads. The
 *  thread, plan and swing setup all live in the New plan modal; nothing else is on this page. */
export function PracticeLanding() {
  // Bumped when a thread or the plan changes (a day opened, the data prepared), so the table refetches.
  const router = useRouter();
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  // `thread` set: the modal replaces that day thread's plan instead of starting a thread.
  const [modal, setModal] = useState<{ thread: PracticeThread | null } | null>(null);
  // True while any row's action is opening a day: every row's action waits, so a second click cannot race the first.
  const [busy, setBusy] = useState(false);
  const threads = useDeskQuery("replay-threads", (signal) => loadThreads({ signal }), { revision });
  const daily = useDeskQuery("replay-daily", (signal) => loadDaily({ signal }), { revision });

  const list: ThreadSummary[] = threads.data ?? [];
  const active = activeThreads(list);
  const rows = [...[active.day, active.swing].filter((row): row is ThreadSummary => row !== null), ...list.filter((row) => row.thread.status === "closed")];
  const plan = daily.data?.plan ?? null;
  const preparing = plan?.prep.state === "running";
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(changed, POLL_MS);
    return () => clearInterval(timer);
  }, [preparing, changed]);

  return (
    <div className={hub.root}>
      <header className={`${hub.header} ${styles.headerSplit}`}>
        <div className={styles.titleBlock}>
          <h1 className={hub.title}>Practice</h1>
          <p className={hub.hint}>{PRACTICE_COPY.threadsHint}</p>
        </div>
        <button type="button" className={hub.primary} disabled={threads.loading} onClick={() => setModal({ thread: null })}>{PRACTICE_COPY.planNew}</button>
      </header>
      <div className={hub.body}>
        {!threads.loading && threads.data === null ? (
          <ErrorBlock message={PRACTICE_COPY.threadsLoadError} onRetry={threads.refresh} />
        ) : !threads.loading && rows.length === 0 ? (
          <EmptyBlock title={PRACTICE_COPY.threadNone}>{PRACTICE_COPY.landingNoneHint}</EmptyBlock>
        ) : (
          <ThreadTable rows={rows} plan={plan} loading={threads.loading} busy={busy} onBusy={setBusy} onChanged={changed} onNewPlan={(thread) => setModal({ thread })} />
        )}
      </div>
      {modal && (
        <NewPlanModal
          open={openModes(active)}
          thread={modal.thread}
          onClose={() => {
            setModal(null);
            changed();
          }}
          onSaved={(id) => router.push(`/practice/thread?id=${id}`)}
        />
      )}
    </div>
  );
}
