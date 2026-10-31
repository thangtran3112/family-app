"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EmptyBlock, ErrorBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadDaily, loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { threadName } from "@/lib/replay/threadView";
import { DayOverview } from "./DayOverview";
import { NewPlanModal } from "./NewPlanModal";
import { OverviewChips, OverviewShell } from "./OverviewParts";
import { SwingOverview } from "./SwingOverview";
import { planOpensIn } from "./ThreadAction";
import styles from "./landing.module.css";
import o from "./overview.module.css";

const POLL_MS = 4000;

/** `/practice/thread?id=`: the thread's overview, where she lands after a click on a row or New plan and where she returns to
 *  between days (02r2, 5R). A day thread and a swing thread each have their own dashboard (`DayOverview`, `SwingOverview`)
 *  under one header. Reads the URL, so the page wraps it in Suspense. */
export function ThreadOverview() {
  const raw = useSearchParams().get("id");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  const [replacing, setReplacing] = useState(false);
  const query = useDeskQuery(`practice-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null, revision });
  const daily = useDeskQuery(`replay-daily:${id}`, (signal) => loadDaily({ threadId: id ?? 0, signal }), { enabled: id !== null, revision });
  const plan = daily.data?.plan ?? null;
  const preparing = plan?.prep.state === "running" && query.data !== null && planOpensIn(plan, query.data.thread);
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(changed, POLL_MS);
    return () => clearInterval(timer);
  }, [preparing, changed]);

  if (id === null || (query.error instanceof DeskApiError && query.error.status === 404)) {
    return (
      <OverviewShell title="Practice thread">
        <EmptyBlock title={PRACTICE_COPY.threadPageNotFound} />
      </OverviewShell>
    );
  }
  if (query.data === null) {
    return (
      <OverviewShell title="Practice thread">
        {query.error === null ? <PageSkeleton /> : <ErrorBlock message={PRACTICE_COPY.threadPageLoadError} onRetry={query.refresh} />}
      </OverviewShell>
    );
  }

  const summary = query.data;
  const { thread } = summary;

  return (
    <OverviewShell title={threadName(thread)} aside={<OverviewChips thread={thread} />}>
      {thread.mode === "swing" && summary.swing ? (
        <SwingOverview summary={summary} plan={plan} onChanged={changed} />
      ) : (
        <DayOverview summary={summary} plan={plan} onChanged={changed} onNewPlan={() => setReplacing(true)} />
      )}
      {replacing && (
        <NewPlanModal
          thread={thread}
          onClose={() => {
            setReplacing(false);
            changed();
          }}
          onSaved={() => {
            setReplacing(false);
            changed();
          }}
        />
      )}
    </OverviewShell>
  );
}

/** The overview while it loads: grey blocks where the next step, the balance, the days and the side column will be, in the same two columns. */
function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label={PRACTICE_COPY.threadPageLoading} className={o.grid}>
      <div className={o.main}>
        <div className={styles.panel}>
          <span className={`${styles.skel} ${styles.skelTitle}`} />
          <span className={`${styles.skel} ${styles.skelMoney}`} />
          <span className={`${styles.skel} ${styles.skelLine}`} />
        </div>
        <div className={styles.panel}>
          <span className={`${styles.skel} ${styles.skelTitle}`} />
          <span className={`${styles.skel} ${styles.skelButton}`} />
          <span className={`${styles.skel} ${styles.skelLine}`} />
        </div>
        <div className={styles.panel}>
          <span className={`${styles.skel} ${styles.skelTitle}`} />
          <span className={`${styles.skel} ${styles.skelCurve}`} />
        </div>
      </div>
      <div className={o.side}>
        <div className={styles.panel}>
          <span className={`${styles.skel} ${styles.skelTitle}`} />
          <div className={styles.skelStats}>
            <span className={`${styles.skel} ${styles.skelStat}`} />
            <span className={`${styles.skel} ${styles.skelStat}`} />
            <span className={`${styles.skel} ${styles.skelStat}`} />
          </div>
        </div>
      </div>
    </div>
  );
}
