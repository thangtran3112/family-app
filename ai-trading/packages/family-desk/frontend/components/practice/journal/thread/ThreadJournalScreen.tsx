"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { formatBalance, hasNoDays, startedWithText, threadModeLabel, threadName, threadTiles, weeksInText, weeksOf } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import { BalanceCurve } from "./BalanceCurve";
import { DayBars } from "./DayBars";
import { ImprovementPanel } from "./ImprovementPanel";
import { ThreadPlanPanel } from "./ThreadPlanPanel";
import { ThreadSidePanel } from "./ThreadSidePanel";
import { ThreadTiles } from "./ThreadTiles";
import styles from "./threadJournal.module.css";

/** `/practice/journal?thread=`: one practice thread's journal (02r). Every dollar on it is SIMULATED. Reads the URL, so the page wraps it in Suspense. */
export function ThreadJournalScreen() {
  const raw = useSearchParams().get("thread");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const query = useDeskQuery(`replay-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null });

  if (id === null) {
    return (
      <div className={styles.center}>
        <EmptyBlock title={PRACTICE_COPY.journalThreadNone}>
          <Link href="/practice" className={styles.link}>Open Practice</Link>
        </EmptyBlock>
      </div>
    );
  }
  if (query.data === null) {
    return (
      <div className={styles.center}>
        {query.error === null ? <LoadingBlock label={PRACTICE_COPY.journalThreadLoading} height={320} /> : <ErrorBlock message={PRACTICE_COPY.journalThreadLoadError} onRetry={query.refresh} />}
      </div>
    );
  }
  return <ThreadJournal key={query.data.thread.id} thread={query.data} onChanged={query.refresh} />;
}

function ThreadJournal({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const { stats, status, mode } = thread.thread;
  const weeks = weeksOf(thread.daily);
  const empty = hasNoDays(thread);
  const closed = status === "closed";
  const balance = formatBalance(stats.balance);
  const name = threadName(thread.thread).replace(" thread", "");

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{`Thread · ${name} · ${weeksInText(weeks.length)}`}</h1>
            <span className={styles.chip}>{threadModeLabel(mode)}</span>
          </div>
          <p className={styles.sub}>{`${startedWithText(thread.thread)} · start date hidden · ${stats.daysPracticed} ${stats.daysPracticed === 1 ? "day" : "days"} practiced, ${stats.daysSkipped} skipped`}</p>
        </div>
        <div className={styles.balance}>
          <span className={styles.balanceLabel}>{PRACTICE_COPY.balanceNow}</span>
          <span className={styles.balanceValue}>{balance}</span>
          <SimulatedBadge />
        </div>
      </header>
      <div className={styles.body}>
        <ThreadSidePanel thread={thread} weeks={weeks} />
        <div className={styles.center}>
          {closed && (
            <p className={styles.banner} role="status">
              {practiceText("journalThreadClosed", { balance })} <Link href="/practice#threads" className={styles.link}>{PRACTICE_COPY.threadStartNew}</Link>
            </p>
          )}
          {empty ? (
            <div className={styles.emptyNote}>
              <p className={styles.emptyLine}><strong>{practiceText("journalThreadEmptyLine", { balance })}</strong></p>
              <p className={styles.muted}>{PRACTICE_COPY.journalThreadEmpty}</p>
              {thread.today !== null && (
                <Link href={`/practice/day?id=${thread.today.day_list_id}`} className={styles.link}>{"Open today's list"}</Link>
              )}
            </div>
          ) : (
            <>
              <section className={styles.section} aria-labelledby="thread-curve-title">
                <div className={styles.sectionHead}>
                  <h2 id="thread-curve-title" className={styles.sectionTitle}>{PRACTICE_COPY.curveTitle}</h2>
                  <SimulatedBadge />
                </div>
                <p className={styles.hint}>{PRACTICE_COPY.curveHint}</p>
                <BalanceCurve thread={thread} />
              </section>
              <section className={styles.section} aria-labelledby="thread-bars-title">
                <div className={styles.sectionHead}>
                  <h2 id="thread-bars-title" className={styles.sectionTitle}>{PRACTICE_COPY.barsTitle}</h2>
                  <SimulatedBadge />
                </div>
                <p className={styles.hint}>{PRACTICE_COPY.barsHint}</p>
                <DayBars thread={thread} />
              </section>
              <section className={styles.section} aria-labelledby="thread-summary-title">
                <div className={styles.sectionHead}>
                  <h2 id="thread-summary-title" className={styles.sectionTitle}>{PRACTICE_COPY.summaryTitle}</h2>
                  <SimulatedBadge />
                </div>
                <p className={styles.hint}>{PRACTICE_COPY.summaryHint}</p>
                <ThreadTiles tiles={threadTiles(thread)} />
              </section>
            </>
          )}
        </div>
      </div>
      <RightRail
        label="Thread details"
        sections={[
          { id: "improvement", label: PRACTICE_COPY.improvementTitle, node: <ImprovementPanel weeks={weeks} /> },
          { id: "plan", label: PRACTICE_COPY.threadPlanTitle, node: <ThreadPlanPanel thread={thread} onChanged={onChanged} /> },
        ]}
      />
    </div>
  );
}
