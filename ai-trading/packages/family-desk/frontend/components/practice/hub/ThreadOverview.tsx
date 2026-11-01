"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyBlock, ErrorBlock } from "@/components/ui/StateBlocks";
import { TabPanel } from "@/components/ui/Tabs";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadDaily, loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { parseThreadTab } from "@/lib/replay/practiceTabs";
import { threadName } from "@/lib/replay/threadView";
import { DayOverview } from "./DayOverview";
import { NewPlanModal } from "./NewPlanModal";
import { OverviewChips, OverviewShell } from "./OverviewParts";
import { PortfolioTab } from "./PortfolioTab";
import { PracticeTabs, PRACTICE_TABS_ID } from "./PracticeTabs";
import { SwingOverview } from "./SwingOverview";
import { planOpensIn } from "./ThreadAction";
import styles from "./landing.module.css";
import o from "./overview.module.css";
import { Skeleton } from "@/components/ui/StateBlocks";

const POLL_MS = 4000;
/** The Desk picks a stalled preparation up again on its next open once it has not moved for this long (backend `_prep_stale`); the page stops polling then and offers the retry (F-01). */
export const PREP_STALL_MS = 5 * 60_000;

/** `/practice/thread?id=`: the thread's overview, where she lands after a click on a row or New plan and where she returns to
 *  between days (02r2, 5R). A day thread and a swing thread each have their own dashboard (`DayOverview`, `SwingOverview`)
 *  under one header and the thread's tab strip. `?tab=portfolio` shows the Portfolio tab; anything else is Summary. Both tabs share
 *  this component, so a switch keeps the loaded thread. Reads the URL, so the page wraps it in Suspense. */
export function ThreadOverview() {
  const params = useSearchParams();
  const raw = params.get("id");
  const tab = parseThreadTab(params.get("tab"));
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  const [replacing, setReplacing] = useState(false);
  // Arriving here (after a day ended, a day opened or New plan was submitted) the keyboard starts at the page heading, not at the skip link (D-093).
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const query = useDeskQuery(`practice-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null, revision });
  const daily = useDeskQuery(`replay-daily:${id}`, (signal) => loadDaily({ threadId: id ?? 0, signal }), { enabled: id !== null, revision });
  const plan = daily.data?.plan ?? null;
  const preparing = plan?.prep.state === "running" && query.data !== null && planOpensIn(plan, query.data.thread);
  // Preparing that has not moved for PREP_STALL_MS is stalled: `stalledAt` holds the count it stopped at, so any progress clears it.
  const prepDone = plan?.prep.done ?? 0;
  const [stalledAt, setStalledAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const stalled = preparing === true && stalledAt === prepDone;
  useEffect(() => {
    if (!preparing) return;
    const poll = setInterval(changed, POLL_MS);
    const stall = setTimeout(() => {
      clearInterval(poll);
      setStalledAt(prepDone);
    }, PREP_STALL_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(stall);
    };
  }, [preparing, prepDone, attempt, changed]);
  // Anything that asks the Desk again (the retry, an open) starts the stall clock and the polling over.
  const asked = useCallback(() => {
    setStalledAt(null);
    setAttempt((n) => n + 1);
    changed();
  }, [changed]);

  if (id === null || (query.error instanceof DeskApiError && query.error.status === 404)) {
    return (
      <OverviewShell title="Practice thread" titleRef={titleRef}>
        <EmptyBlock title={PRACTICE_COPY.threadPageNotFound} />
      </OverviewShell>
    );
  }
  if (query.data === null) {
    return (
      <OverviewShell title="Practice thread" titleRef={titleRef}>
        {query.error === null ? <PageSkeleton /> : <ErrorBlock message={PRACTICE_COPY.threadPageLoadError} onRetry={query.refresh} />}
      </OverviewShell>
    );
  }

  const summary = query.data;
  const { thread } = summary;

  return (
    <OverviewShell
      title={threadName(thread)}
      titleRef={titleRef}
      aside={<OverviewChips thread={thread} />}
      tabs={<PracticeTabs threadId={thread.id} active={tab} mode={thread.mode} back={false} panelMounted />}
    >
      <TabPanel idBase={PRACTICE_TABS_ID} id={tab}>
        {tab === "portfolio" ? (
          <PortfolioTab summary={summary} />
        ) : thread.mode === "swing" && summary.swing ? (
          <SwingOverview summary={summary} plan={plan} onChanged={asked} />
        ) : (
          <DayOverview summary={summary} plan={plan} stalled={stalled} onChanged={asked} onNewPlan={() => setReplacing(true)} />
        )}
      </TabPanel>
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
          <Skeleton width={120} />
          <Skeleton width={96} height={14} />
          <Skeleton width="60%" />
        </div>
        <div className={styles.panel}>
          <Skeleton width={120} />
          <Skeleton width={160} height={40} />
          <Skeleton width="60%" />
        </div>
        <div className={styles.panel}>
          <Skeleton width={120} />
          <Skeleton height={200} />
        </div>
      </div>
      <div className={o.side}>
        <div className={styles.panel}>
          <Skeleton width={120} />
          <div className={styles.skelStats}>
            <Skeleton height={32} />
            <Skeleton height={32} />
            <Skeleton height={32} />
          </div>
        </div>
      </div>
    </div>
  );
}
