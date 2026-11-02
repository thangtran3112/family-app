"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ThreadPicker } from "@/components/practice/journal/thread/ThreadPicker";
import { PracticeNotice } from "@/components/practice/PracticeNotice";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, fillCopy } from "@/lib/desk/freshness";
import { loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { threadPageHref } from "@/lib/replay/practiceTabs";
import { loadWeek } from "@/lib/replay/swingApi";
import type { SwingState } from "@/lib/replay/threads";
import { WEEK_TEXT, parseWeekParams, threadOverviewHref, weekHref, weekLoadProblem, weekMissingText } from "@/lib/replay/weekScreen";
import { WeekReview } from "./WeekReview";
import styles from "./week.module.css";

/**
 * `/practice/week?thread=&week=`: reads the URL, so the page wraps it in Suspense. The thread is answered first, in the D-164 shape,
 * and the week only after it (D-183): no thread is "not selected", a thread the server does not know (or an id that is no number) is
 * "not found", a failed load is the retry block. A day thread has no weeks whatever the week says; a swing thread with no week asks for one.
 */
export function WeekRoute() {
  const search = useSearchParams();
  const given = search.get("thread") !== null;
  const { threadId: id, weekNo: no } = parseWeekParams(search.get("thread"), search.get("week"));
  const threadId = id ?? 0;
  const weekNo = no ?? 0;
  const week = useDeskQuery(`replay-week:${threadId}:${weekNo}`, (signal) => loadWeek(threadId, weekNo, { signal }), { enabled: id !== null && no !== null });
  const thread = useDeskQuery(`replay-thread:${threadId}`, (signal) => loadThread(threadId, { signal }), { enabled: id !== null });

  if (!given) {
    return (
      <div className={styles.center}>
        <ThreadPicker hint={PRACTICE_COPY.threadPickHintWeek} href={threadPageHref} />
      </div>
    );
  }
  if (id === null || (thread.error instanceof DeskApiError && thread.error.status === 404)) {
    return (
      <div className={styles.center}>
        <PracticeNotice title={PRACTICE_COPY.threadPageNotFound} />
      </div>
    );
  }
  if (thread.data?.thread.mode === "day") {
    return (
      <div className={styles.center}>
        <MissingWeek message="" mode="day" threadId={threadId} />
      </div>
    );
  }
  if (no === null) {
    return (
      <div className={styles.center}>
        {thread.data !== null ? <NoWeek threadId={threadId} swing={thread.data.swing ?? null} /> : thread.error === null ? <LoadingBlock label={WEEK_TEXT.loading} height={320} /> : <ErrorBlock message={PRACTICE_COPY.threadPageLoadError} onRetry={thread.refresh} />}
      </div>
    );
  }
  if (week.data === null) {
    const problem = week.error === null ? null : weekLoadProblem(week.error);
    return (
      <div className={styles.center}>
        {problem === null ? (
          <LoadingBlock label={WEEK_TEXT.loading} height={320} />
        ) : problem.kind === "missing" && thread.data === null && thread.error === null ? (
          <LoadingBlock label={WEEK_TEXT.loading} height={320} />
        ) : problem.kind === "missing" ? (
          <MissingWeek message={problem.message} mode={thread.data?.thread.mode ?? null} threadId={threadId} />
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

/** A swing thread opened with no week (or week 0): says so, and offers the week she is on once it has begun (D-183). */
function NoWeek({ threadId, swing }: { threadId: number; swing: SwingState | null }) {
  const current = swing !== null && swing.days_ended > 0 ? swing.week_no : null;
  return (
    <div className={styles.missing}>
      <h1 className={styles.title}>{WEEK_TEXT.none}</h1>
      <p className={styles.muted}>{WEEK_TEXT.noneHint}</p>
      {current !== null && <Link href={weekHref(threadId, current)} className={styles.link}>{fillCopy(WEEK_TEXT.openWeek, { n: String(current) })}</Link>}
      <Link href={threadOverviewHref(threadId)} className={styles.link}>{WEEK_TEXT.backToThread}</Link>
    </div>
  );
}

/** A week that cannot open: a heading, one full sentence, and the way back to the thread's page (D-089). */
function MissingWeek({ message, mode, threadId }: { message: string; mode: "day" | "swing" | null; threadId: number }) {
  const { title, text } = weekMissingText(message, mode);
  return (
    <div className={styles.missing}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.muted}>{text}</p>
      <Link href={threadOverviewHref(threadId)} className={styles.link}>{WEEK_TEXT.backToThread}</Link>
    </div>
  );
}
