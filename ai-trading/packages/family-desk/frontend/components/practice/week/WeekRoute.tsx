"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { loadWeek } from "@/lib/replay/swingApi";
import { WEEK_TEXT, parseWeekParams, threadHref, weekLoadProblem } from "@/lib/replay/weekScreen";
import { WeekReview } from "./WeekReview";
import styles from "./week.module.css";

/** `/practice/week?thread=&week=`: reads the URL, so the page wraps it in Suspense. */
export function WeekRoute() {
  const search = useSearchParams();
  const ids = parseWeekParams(search.get("thread"), search.get("week"));
  const threadId = ids?.threadId ?? 0;
  const weekNo = ids?.weekNo ?? 0;
  const enabled = ids !== null;
  const week = useDeskQuery(`replay-week:${threadId}:${weekNo}`, (signal) => loadWeek(threadId, weekNo, { signal }), { enabled });
  const thread = useDeskQuery(`replay-thread:${threadId}`, (signal) => loadThread(threadId, { signal }), { enabled });

  if (ids === null) {
    return (
      <div className={styles.center}>
        <EmptyBlock title={WEEK_TEXT.none}>
          <p className={styles.muted}>{WEEK_TEXT.noneHint}</p>
          <Link href="/practice" className={styles.link}>{WEEK_TEXT.openPractice}</Link>
        </EmptyBlock>
      </div>
    );
  }
  if (week.data === null) {
    const problem = week.error === null ? null : weekLoadProblem(week.error);
    return (
      <div className={styles.center}>
        {problem === null ? (
          <LoadingBlock label={WEEK_TEXT.loading} height={320} />
        ) : problem.kind === "missing" ? (
          <EmptyBlock title={problem.message}>
            <Link href={threadHref(threadId)} className={styles.link}>{WEEK_TEXT.backToThread}</Link>
          </EmptyBlock>
        ) : (
          <ErrorBlock message={PRACTICE_COPY.swingWeekLoadError} onRetry={week.refresh} />
        )}
      </div>
    );
  }
  // The thread only adds the day links and the Start Week button: wait for it while it loads, go on without it if it failed.
  if (thread.data === null && thread.error === null) {
    return (
      <div className={styles.center}>
        <LoadingBlock label={WEEK_TEXT.loading} height={320} />
      </div>
    );
  }
  return <WeekReview key={`${threadId}:${weekNo}`} threadId={threadId} week={week.data} thread={thread.data} />;
}
