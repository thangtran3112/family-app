"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadDaily, loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { swingCardView } from "@/lib/replay/swing";
import { adherenceTrendText, formatBalance, startedWithText, threadModeLabel, threadName, todayView, winRateText } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import { NewPlanModal } from "./NewPlanModal";
import { ThreadAction, planOpensIn } from "./ThreadAction";
import { ResultLine } from "./ThreadTable";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

const POLL_MS = 4000;

/** `/practice/thread?id=`: one thread between days (02r2). Where she lands after New plan and where she returns to: her balance
 *  with SIMULATED, the stats, today's day (Continue) or the last ended day with Next day, or a note that a new plan is needed.
 *  Reads the URL, so the page wraps it in Suspense. */
export function ThreadOverview() {
  const raw = useSearchParams().get("id");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  const [replacing, setReplacing] = useState(false);
  const query = useDeskQuery(`practice-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null, revision });
  const daily = useDeskQuery("replay-daily", (signal) => loadDaily({ signal }), { enabled: id !== null, revision });
  const plan = daily.data?.plan ?? null;
  const preparing = plan?.prep.state === "running" && query.data !== null && planOpensIn(plan, query.data.thread);
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(changed, POLL_MS);
    return () => clearInterval(timer);
  }, [preparing, changed]);

  if (id === null || (query.error instanceof DeskApiError && query.error.status === 404)) {
    return (
      <Shell title="Practice thread">
        <EmptyBlock title={PRACTICE_COPY.threadPageNotFound} />
      </Shell>
    );
  }
  if (query.data === null) {
    return (
      <Shell title="Practice thread">
        {query.error === null ? <LoadingBlock label={PRACTICE_COPY.threadPageLoading} height={240} /> : <ErrorBlock message={PRACTICE_COPY.threadPageLoadError} onRetry={query.refresh} />}
      </Shell>
    );
  }

  const summary: Thread = query.data;
  const { thread, today, last_day: lastDay } = summary;
  const { stats } = thread;
  const closed = thread.status === "closed";
  const swing = swingCardView(summary);
  const view = todayView(today, lastDay);
  const canReplace = !closed && thread.mode === "day" && planOpensIn(plan, thread);
  const fresh = !closed && thread.mode === "day" && today !== null && lastDay === null && stats.daysPracticed === 0;

  return (
    <Shell
      title={threadName(thread)}
      aside={
        <>
          <span className={hub.chip}>{threadModeLabel(thread.mode)}</span>
          <span className={hub.chip}>{closed ? PRACTICE_COPY.threadClosedBadge : PRACTICE_COPY.threadActive}</span>
        </>
      }
    >
      <section className={styles.panel} aria-label="Thread balance">
        <span className={hub.cap}>{PRACTICE_COPY.threadBalance}</span>
        <p className={hub.balanceRow}>
          <span className={hub.balanceValue}>{formatBalance(stats.balance)}</span>
          <SimulatedBadge />
        </p>
        <p className={hub.muted}>{startedWithText(thread)}</p>
        {swing && <p className={hub.swingLine}>{swing.line}</p>}
        <hr className={hub.threadRule} />
        <dl className={hub.statGrid}>
          <div className={hub.statCell}>
            <dt className={hub.cap}>{PRACTICE_COPY.threadDaysPracticed}</dt>
            <dd>{stats.daysPracticed}</dd>
          </div>
          <div className={hub.statCell}>
            <dt className={hub.cap}>{PRACTICE_COPY.threadSkipped}</dt>
            <dd>{stats.daysSkipped}</dd>
          </div>
          <div className={hub.statCell}>
            <dt className={hub.cap}>{PRACTICE_COPY.threadWinRate}</dt>
            <dd>{winRateText(stats.winRate)}</dd>
          </div>
        </dl>
        <dl className={hub.threadRows}>
          <div className={hub.threadRow}>
            <dt className={hub.cap}>{PRACTICE_COPY.threadAdherence}</dt>
            <dd>
              {adherenceTrendText(stats)} <span className={hub.hint}>{PRACTICE_COPY.threadAdherenceBy}</span>
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.panel} aria-label="Practice day">
        <h2 className={styles.panelTitle}>{closed ? PRACTICE_COPY.threadClosedTitle : view.label}</h2>
        {closed ? (
          <p className={hub.muted}>{PRACTICE_COPY.threadPageClosed}</p>
        ) : (
          <>
            <p className={styles.dayLine}>
              <ResultLine pnl={view.pnl} line={view.line} />
            </p>
            {fresh && <p className={hub.muted}>{PRACTICE_COPY.threadPageFresh}</p>}
            {swing?.notice && <p className={hub.swingNotice} role="status">{swing.notice}</p>}
            <div className={styles.dayActions}>
              <ThreadAction summary={summary} plan={plan} nextLabel={PRACTICE_COPY.threadPageNextDay} onChanged={changed} onNewPlan={() => setReplacing(true)} />
              {canReplace && <button type="button" className={hub.button} onClick={() => setReplacing(true)}>{PRACTICE_COPY.threadPageReplace}</button>}
            </div>
          </>
        )}
        <Link href={`/practice/journal?thread=${thread.id}`} className={hub.threadLink}>{PRACTICE_COPY.threadJournal}</Link>
      </section>

      {replacing && (
        <NewPlanModal
          open={{ day: false, swing: false }}
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
    </Shell>
  );
}

function Shell({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={`${hub.header} ${styles.headerSplit}`}>
        <div className={styles.titleBlock}>
          <Link href="/practice" className={styles.back}>{`← ${PRACTICE_COPY.threadPageBack}`}</Link>
          <h1 className={hub.title}>{title}</h1>
        </div>
        {aside && <div className={hub.inline}>{aside}</div>}
      </header>
      <div className={styles.pageBody}>{children}</div>
    </div>
  );
}
