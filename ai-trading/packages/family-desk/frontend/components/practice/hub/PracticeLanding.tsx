"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyBlock, ErrorBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadThreadCapacity, loadThreads } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { threadPageHref } from "@/lib/replay/practiceTabs";
import { NewPlanModal } from "./NewPlanModal";
import { ThreadTable } from "./ThreadTable";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

/** Practice landing (02r2, Paper mock LEW-0): the header with New thread (up to the shared thread slots), and one table of her
 *  practice threads, each a card of its clock, balance, open positions and last activity. The thread's setup lives in the New thread modal;
 *  nothing else is on this page. */
export function PracticeLanding() {
  // Bumped when a thread changes (one was deleted), so the table refetches.
  const router = useRouter();
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  // The New thread modal: a thread's setup is never edited, a new setup is a new thread.
  const [modal, setModal] = useState(false);
  // True while a thread is being deleted: every row waits, so a second click cannot race the first.
  const [busy, setBusy] = useState(false);
  // "Deleted Freestyle · Oct 15": the row is gone by then, so the page says it (D-079). The region exists from the start so it is announced.
  const [deleted, setDeleted] = useState<string | null>(null);
  const threads = useDeskQuery("replay-threads", (signal) => loadThreads({ signal }), { revision });
  // The server lists every active thread first (newest first), then the closed ones.
  const rows = threads.data ?? [];
  // The thread slots are shared by every user (ADR-0025): at most day_max active threads at once (the key names stay until the contract migration). Read again whenever a thread changed.
  const capacity = useDeskQuery("thread-capacity", (signal) => loadThreadCapacity({ signal }), { revision });

  return (
    <div className={hub.root}>
      <header className={`${hub.header} ${styles.headerSplit}`}>
        <div className={styles.titleBlock}>
          <h1 className={hub.title}>Practice</h1>
          <p className={hub.hint}>{PRACTICE_COPY.threadsHintFreestyle}</p>
        </div>
        <div className={styles.headerActions}>
          {capacity.data !== null && (
            <span className={hub.hint} role="status" data-testid="day-slots" data-full={capacity.data.day_active >= capacity.data.day_max ? "true" : undefined}>
              {practiceText("threadSlots", { active: capacity.data.day_active, max: capacity.data.day_max })}
            </span>
          )}
          {/* The button stays when every slot is taken: the form opens and its footer gives the reason Start is off. */}
          <Button variant="primary" disabled={threads.loading} onClick={() => {
              setDeleted(null);
              setModal(true);
            }}
          >
            {PRACTICE_COPY.newThreadTitle}
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
          <ThreadTable rows={rows} loading={threads.loading} busy={busy} onBusy={setBusy} onChanged={changed} onDeleted={setDeleted} />
        )}
      </div>
      {modal && (
        <NewPlanModal
          onClose={() => {
            setModal(false);
            changed();
          }}
          onSaved={(id) => router.push(threadPageHref(id))}
        />
      )}
    </div>
  );
}
