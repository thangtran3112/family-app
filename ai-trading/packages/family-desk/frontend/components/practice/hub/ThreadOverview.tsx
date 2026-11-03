"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThreadPicker } from "@/components/practice/journal/thread/ThreadPicker";
import { PracticeNotice } from "@/components/practice/PracticeNotice";
import { ErrorBlock } from "@/components/ui/StateBlocks";
import { TabPanel } from "@/components/ui/Tabs";
import { DeskApiError } from "@/lib/api/client";
import { backoffMs } from "@/lib/desk/backoff";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadDaily, loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { parseThreadTab, threadPageHref } from "@/lib/replay/practiceTabs";
import { routeId } from "@/lib/replay/routeId";
import { threadName } from "@/lib/replay/threadView";
import { useThreadClock } from "@/lib/replay/useThreadClock";
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

/** `/practice/thread?id=`: the thread's overview, where she lands after a click on a row or New plan and where she returns to
 *  between days (02r2, 5R). A day thread and a swing thread each have their own dashboard (`DayOverview`, `SwingOverview`)
 *  under one header and the thread's tab strip. `?tab=portfolio` shows the Portfolio tab; anything else is Summary. Both tabs share
 *  this component, so a switch keeps the loaded thread. Reads the URL, so the page wraps it in Suspense. */
export function ThreadOverview() {
  const router = useRouter();
  const params = useSearchParams();
  const { id, given } = routeId(params.get("id"));
  const tab = parseThreadTab(params.get("tab"));
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  // New plan from this page starts a new thread (a plan is never replaced); `onSaved` takes her to it.
  const [starting, setStarting] = useState(false);
  // Arriving here (after a day ended, a day opened or New plan was submitted) the keyboard starts at the page heading, not at the skip link (D-093).
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const query = useDeskQuery(`practice-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null, revision });
  const daily = useDeskQuery(`replay-daily:${id}`, (signal) => loadDaily({ threadId: id ?? 0, signal }), { enabled: id !== null, revision });
  const plan = daily.data?.plan ?? null;
  // The day thread's clock runs on the server (ADR-0018); this page only reads it every two seconds and asks for changes.
  const clock = useThreadClock(query.data?.thread.mode === "day" && query.data.thread.status === "active" ? id : null);
  // A day that ended, or the next one that opened (Skip day, or End day from the chart), moves the Summary on.
  const clockDay = clock.clock === null ? undefined : clock.clock.day_list_id;
  const seenDay = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (clockDay === undefined) return;
    if (seenDay.current !== undefined && seenDay.current !== clockDay) changed();
    seenDay.current = clockDay;
  }, [clockDay, changed]);
  const preparing = plan?.prep.state === "running" && query.data !== null && planOpensIn(plan, query.data.thread);
  // While the plan's data is prepared the page asks again every POLL_MS; each read that failed in a row doubles the wait (up to a minute).
  const failures = query.failures + daily.failures;
  useEffect(() => {
    if (!preparing) return;
    const timer = setTimeout(changed, backoffMs(POLL_MS, failures));
    return () => clearTimeout(timer);
  }, [preparing, changed, failures, revision]);

  if (id === null && !given) {
    return (
      <OverviewShell title="Practice thread" titleRef={titleRef}>
        <ThreadPicker hint={PRACTICE_COPY.threadPickHintThread} href={threadPageHref} />
      </OverviewShell>
    );
  }
  if (id === null || (query.error instanceof DeskApiError && query.error.status === 404)) {
    return (
      <OverviewShell title="Practice thread" titleRef={titleRef}>
        <PracticeNotice title={PRACTICE_COPY.threadPageNotFound} />
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
      tabs={<PracticeTabs threadId={thread.id} active={tab} mode={thread.mode} back={false} panelMounted dayOpen={summary.today !== null} />}
    >
      <TabPanel idBase={PRACTICE_TABS_ID} id={tab}>
        {tab === "portfolio" ? (
          <PortfolioTab summary={summary} clockRevision={clock.revision} account={clock.clock?.account ?? null} />
        ) : thread.mode === "swing" && summary.swing ? (
          <SwingOverview summary={summary} plan={plan} onChanged={changed} />
        ) : (
          <DayOverview summary={summary} plan={plan} onChanged={changed} onNewPlan={() => setStarting(true)} clock={clock} />
        )}
      </TabPanel>
      {starting && (
        <NewPlanModal
          onClose={() => {
            setStarting(false);
            changed();
          }}
          onSaved={(newId) => router.push(threadPageHref(newId))}
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
