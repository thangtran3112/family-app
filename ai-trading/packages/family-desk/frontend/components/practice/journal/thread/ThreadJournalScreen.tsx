"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { journalStatusLine } from "@/lib/replay/statusLine";
import { formatBalance, hasNoDays, startedWithText, threadModeLabel, threadName, threadTiles, weeksInText, weeksOf } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import { BalanceCurve } from "./BalanceCurve";
import { DayBars } from "./DayBars";
import { ImprovementPanel } from "./ImprovementPanel";
import { SwingThreadJournal } from "./SwingThreadJournal";
import { CloseThreadPanel, ThreadPlanPanel } from "./ThreadPlanPanel";
import { ThreadPicker } from "./ThreadPicker";
import { ThreadSidePanel } from "./ThreadSidePanel";
import { ThreadTiles } from "./ThreadTiles";
import styles from "./threadJournal.module.css";

/** `/practice/journal?thread=`: one practice thread's journal (02r). Every dollar on it is SIMULATED. Reads the URL, so the page wraps it in Suspense. */
export function ThreadJournalScreen() {
  const raw = useSearchParams().get("thread");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const query = useDeskQuery(`replay-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null });

  if (id === null) return <ThreadPicker />;
  if (query.data === null) {
    return (
      <div className={styles.center}>
        {query.error === null ? <LoadingBlock label={PRACTICE_COPY.journalThreadLoading} height={320} /> : <ErrorBlock message={PRACTICE_COPY.journalThreadLoadError} onRetry={query.refresh} />}
      </div>
    );
  }
  // A swing thread (02p) has its own journal: balance and equity, weeks, open holds. The day thread's is unchanged.
  if (query.data.thread.mode === "swing" && query.data.swing) return <SwingThreadJournal key={query.data.thread.id} thread={query.data} onChanged={query.refresh} />;
  return <ThreadJournal key={query.data.thread.id} thread={query.data} onChanged={query.refresh} />;
}

function ThreadJournal({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const { stats, status, mode } = thread.thread;
  const weeks = weeksOf(thread.daily);
  const empty = hasNoDays(thread);
  const closed = status === "closed";
  const balance = formatBalance(stats.balance);
  const name = threadName(thread.thread).replace(" thread", "");
  // At the 1180 band the right rail is a tab strip: each tab opens its own drawer, and the screen leaves room for them (D-038, D-040).
  const band = useShellBand();
  const [railOpen, setRailOpen] = useState<string[]>([]);
  useReportPracticeChrome({ day: null, hidden: false, playhead: null, scope: "days", status: journalStatusLine(thread.daily) });

  return (
    <div className={styles.screen} data-drawer={band === "1180" && railOpen.length > 0 ? "open" : undefined}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{`Thread · ${name} · ${weeksInText(weeks.length)}`}</h1>
            <span className={styles.chip}>{threadModeLabel(mode)}</span>
          </div>
          <p className={styles.sub}>
            {`${startedWithText(thread.thread)} · start date hidden · ${stats.daysPracticed} ${stats.daysPracticed === 1 ? "day" : "days"} practiced, ${stats.daysSkipped} skipped `}
            <SimulatedBadge />
          </p>
        </div>
        <div className={styles.balance}>
          <span className={styles.balanceLabel}>{PRACTICE_COPY.balanceNow}</span>
          <span className={styles.balanceValue}>{balance}</span>
          <SimulatedBadge />
        </div>
      </header>
      <ThreadSidePanel thread={thread} weeks={weeks} />
      <div className={styles.body}>
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
        multi
        openIds={railOpen}
        onOpenIdsChange={setRailOpen}
        sections={[
          { id: "improvement", label: PRACTICE_COPY.improvementTitle, node: <ImprovementPanel weeks={weeks} /> },
          { id: "plan", label: PRACTICE_COPY.threadPlanTitle, node: <ThreadPlanPanel thread={thread} onChanged={onChanged} /> },
          { id: "close", label: PRACTICE_COPY.threadClose, node: <CloseThreadPanel thread={thread} onChanged={onChanged} /> },
        ]}
      />
    </div>
  );
}
