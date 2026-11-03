"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThreadPicker } from "@/components/practice/journal/thread/ThreadPicker";
import { PracticeNotice } from "@/components/practice/PracticeNotice";
import { ErrorBlock, Skeleton } from "@/components/ui/StateBlocks";
import { TabPanel } from "@/components/ui/Tabs";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { parseThreadTab, threadPageHref } from "@/lib/replay/practiceTabs";
import { routeId } from "@/lib/replay/routeId";
import { threadName } from "@/lib/replay/threadView";
import { useThreadClock } from "@/lib/replay/useThreadClock";
import { NextStep } from "./NextStep";
import { DatesSection, OverviewChips, OverviewShell, PlaceStrip, StatsPanel } from "./OverviewParts";
import { PortfolioTab } from "./PortfolioTab";
import { PracticeTabs, PRACTICE_TABS_ID } from "./PracticeTabs";
import { ThreadClockPanel } from "./ThreadClockPanel";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/** `/practice/thread?id=`: the thread's Summary, where she lands after a click on a row or New thread and where she returns to between
 *  sessions (02r2, 5R; ADR-0025). One header, the thread's tab strip, and a card of the thread: its equity at the clock, the one next step (open the
 *  Screen), the clock and its controls, and the results by ET date, with the stats at the side. `?tab=portfolio` shows the Portfolio tab;
 *  anything else is Summary. Both tabs share this component, so a switch keeps the loaded thread. Reads the URL, so the page wraps it in Suspense. */
export function ThreadOverview() {
  const params = useSearchParams();
  const { id, given } = routeId(params.get("id"));
  const tab = parseThreadTab(params.get("tab"));
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  // Arriving here (after New thread was submitted) the keyboard starts at the page heading, not at the skip link (D-093).
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const query = useDeskQuery(`practice-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null, revision });
  // The thread's clock runs on the server (ADR-0018); this page only reads it every two seconds and asks for changes. A closed thread's has stopped.
  const clock = useThreadClock(query.data?.thread.status === "active" ? id : null);
  // A fill (an order of hers crossed by the clock) or a trade moves the ledger or the open positions: read the thread again then, not on every minute.
  const book = clock.clock?.account === undefined || clock.clock.account === null ? null : `${clock.clock.account.balance}|${clock.clock.account.positions}`;
  const seenBook = useRef<string | null>(null);
  useEffect(() => {
    if (book === null) return;
    if (seenBook.current !== null && seenBook.current !== book) changed();
    seenBook.current = book;
  }, [book, changed]);

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
  const closed = thread.status === "closed";
  // One account at the clock feeds the headline, the place line and the clock card (D-169).
  const account = closed ? null : (clock.clock?.account ?? null);
  const positionsOpen = account === null ? summary.positions_open : account.positions;

  return (
    <OverviewShell
      title={threadName(thread)}
      titleRef={titleRef}
      aside={<OverviewChips thread={thread} />}
      tabs={<PracticeTabs threadId={thread.id} active={tab} back={false} panelMounted />}
    >
      <TabPanel idBase={PRACTICE_TABS_ID} id={tab}>
        {tab === "portfolio" ? (
          <PortfolioTab summary={summary} clockRevision={clock.revision} account={account} />
        ) : (
          <div className={o.grid}>
            <div className={o.main}>
              <PlaceStrip summary={summary} account={account} />
              <NextStep summary={summary} />
              {!closed && <ThreadClockPanel api={clock} />}
              <DatesSection daily={summary.daily} />
            </div>
            <div className={o.side}>
              <StatsPanel thread={thread} positionsOpen={positionsOpen} />
            </div>
          </div>
        )}
      </TabPanel>
    </OverviewShell>
  );
}

/** The overview while it loads: grey blocks where the balance, the next step, the clock and the side column will be, in the same two columns. */
function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label={PRACTICE_COPY.threadPageLoading} className={o.grid}>
      <div className={o.main}>
        <div className={styles.panel}>
          <Skeleton width={120} />
          <Skeleton width={160} height={40} />
          <Skeleton width="60%" />
        </div>
        <div className={styles.panel}>
          <Skeleton width={120} />
          <Skeleton width={96} height={14} />
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
