"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyBlock, ErrorBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadThreadCapacity, loadThreads } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { NewPlanModal } from "./NewPlanModal";
import { ThreadTable } from "./ThreadTable";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

/** Practice landing (02r2, Paper mock LEW-0): the header with New plan (always available: any number of threads
 *  can run), and one table of her practice threads. The thread and plan setup live in the New plan modal;
 *  nothing else is on this page. */
export function PracticeLanding() {
  // Bumped when a thread or the plan changes (a day opened, the data prepared), so the table refetches.
  const router = useRouter();
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  // The New plan modal: a plan is never edited, a new plan is a new thread.
  const [modal, setModal] = useState(false);
  // True while any row's action is opening a day: every row's action waits, so a second click cannot race the first.
  const [busy, setBusy] = useState(false);
  // "Deleted Day thread · Oct 15": the row is gone by then, so the page says it (D-079). The region exists from the start so it is announced.
  const [deleted, setDeleted] = useState<string | null>(null);
  const threads = useDeskQuery("replay-threads", (signal) => loadThreads({ signal }), { revision });
  // The server lists every active thread first (newest first), then the closed ones.
  const rows = threads.data ?? [];
  // The day-trade slots are shared by every user (ADR-0022): at most day_max active day threads at once. Read again whenever a thread changed.
  const capacity = useDeskQuery("thread-capacity", (signal) => loadThreadCapacity({ signal }), { revision });

  return (
    <div className={hub.root}>
      <header className={`${hub.header} ${styles.headerSplit}`}>
        <div className={styles.titleBlock}>
          <h1 className={hub.title}>Practice</h1>
          <p className={hub.hint}>{PRACTICE_COPY.threadsHint}</p>
        </div>
        <div className={styles.headerActions}>
          {capacity.data !== null && (
            <span className={hub.hint} role="status" data-testid="day-slots" data-full={capacity.data.day_active >= capacity.data.day_max ? "true" : undefined}>
              {practiceText("daySlots", { active: capacity.data.day_active, max: capacity.data.day_max })}
            </span>
          )}
          {/* The button stays when every slot is taken: the form opens and its footer gives the reason Start is off. */}
          <Button variant="primary" disabled={threads.loading} onClick={() => {
              setDeleted(null);
              setModal(true);
            }}
          >
            {PRACTICE_COPY.planNew}
          </Button>
        </div>
      </header>
      <div className={hub.body}>
        <p role="status" className={styles.notice}>{deleted === null ? "" : practiceText("threadDeleted", { name: deleted })}</p>
        {!threads.loading && threads.data === null ? (
          <ErrorBlock message={PRACTICE_COPY.threadsLoadError} onRetry={threads.refresh} />
        ) : !threads.loading && rows.length === 0 ? (
          <EmptyBlock
            framed
            title={PRACTICE_COPY.threadNone}
            action={{
              label: PRACTICE_COPY.landingStartFirst,
              primary: true,
              onClick: () => {
                setDeleted(null);
                setModal(true);
              },
            }}
          />
        ) : (
          <ThreadTable rows={rows} revision={revision} loading={threads.loading} busy={busy} onBusy={setBusy} onChanged={changed} onDeleted={setDeleted} onNewPlan={() => setModal(true)} />
        )}
      </div>
      {modal && (
        <NewPlanModal
          onClose={() => {
            setModal(false);
            changed();
          }}
          onSaved={(id) => router.push(`/practice/thread?id=${id}`)}
        />
      )}
    </div>
  );
}
