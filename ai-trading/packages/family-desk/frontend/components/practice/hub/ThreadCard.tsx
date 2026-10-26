"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { ErrorBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { openNextDay } from "@/lib/desk/replay";
import { problemMessage } from "@/lib/replay/setup";
import type { PracticeThread, ThreadSummary, ThreadToday } from "@/lib/replay/threads";
import {
  adherenceTrendText,
  dayResultTone,
  formatBalance,
  formatDayResult,
  startedWithText,
  threadModeLabel,
  threadName,
  todayView,
  winRateText,
} from "@/lib/replay/threadView";
import styles from "./hub.module.css";

/** The active thread's card (02r): balance with SIMULATED, the stats, today's open day (or the last ended day) and the resume control.
 *  The row below the stats reads the thread's own answer (`today`, else `last_day`), so it is there with no day open (D-048). */
export function ThreadCard({ summary, planOpen, onChanged }: { summary: ThreadSummary; planOpen: boolean; onChanged: () => void }) {
  const { thread, today, last_day: lastDay } = summary;
  const { stats } = thread;
  const view = todayView(today, lastDay);
  return (
    <article className={styles.threadCard} aria-label="Active practice thread">
      <div className={styles.threadHead}>
        <span className={styles.threadName}>{threadName(thread)}</span>
        <span className={styles.chip}>{threadModeLabel(thread.mode)}</span>
        <span className={styles.threadActiveTag}>
          <span className={styles.openDot} aria-hidden="true" />
          {PRACTICE_COPY.threadActive}
        </span>
      </div>
      <div className={styles.field}>
        <span className={styles.cap}>{PRACTICE_COPY.threadBalance}</span>
        <p className={styles.balanceRow}>
          <span className={styles.balanceValue}>{formatBalance(stats.balance)}</span>
          <SimulatedBadge />
        </p>
        <p className={styles.muted}>{startedWithText(thread)}</p>
      </div>
      <hr className={styles.threadRule} />
      <dl className={styles.statGrid}>
        <div className={styles.statCell}>
          <dt className={styles.cap}>{PRACTICE_COPY.threadDaysPracticed}</dt>
          <dd>{stats.daysPracticed}</dd>
        </div>
        <div className={styles.statCell}>
          <dt className={styles.cap}>{PRACTICE_COPY.threadSkipped}</dt>
          <dd>{stats.daysSkipped}</dd>
        </div>
        <div className={styles.statCell}>
          <dt className={styles.cap}>{PRACTICE_COPY.threadWinRate}</dt>
          <dd>{winRateText(stats.winRate)}</dd>
        </div>
      </dl>
      <dl className={styles.threadRows}>
        <div className={styles.threadRow}>
          <dt className={styles.cap}>{PRACTICE_COPY.threadAdherence}</dt>
          <dd>
            {adherenceTrendText(stats)} <span className={styles.hint}>{PRACTICE_COPY.threadAdherenceBy}</span>
          </dd>
        </div>
        <div className={styles.threadRow}>
          <dt className={styles.cap}>{view.label}</dt>
          <dd>
            <TodayLine view={view} />
          </dd>
        </div>
      </dl>
      <ThreadResume today={today} planOpen={planOpen} onChanged={onChanged} />
      <Link href={`/practice/journal?thread=${thread.id}`} className={styles.threadLink}>{PRACTICE_COPY.threadJournal}</Link>
    </article>
  );
}

/** The closed thread: its journal and final balance stay, and a new thread can start when none is active. */
export function ClosedThreadCard({ thread, canStartNew, onStartNew }: { thread: PracticeThread; canStartNew: boolean; onStartNew: () => void }) {
  return (
    <article className={styles.threadCard} aria-label="Closed practice thread">
      <div className={styles.threadHead}>
        <span className={styles.threadName}>{threadName(thread)}</span>
        <span className={styles.chip}>{threadModeLabel(thread.mode)}</span>
        <span className={styles.chip}>{PRACTICE_COPY.threadClosedBadge}</span>
      </div>
      <h3 className={styles.threadTitle}>{PRACTICE_COPY.threadClosedTitle}</h3>
      <p className={styles.muted}>{PRACTICE_COPY.threadClosedBody}</p>
      <div className={styles.field}>
        <span className={styles.cap}>{PRACTICE_COPY.threadBalance}</span>
        <p className={styles.balanceRow}>
          <span className={styles.balanceValue}>{formatBalance(thread.stats.balance)}</span>
          <SimulatedBadge />
        </p>
        <p className={styles.muted}>{startedWithText(thread)}</p>
      </div>
      <div className={styles.inline}>
        <Link href={`/practice/journal?thread=${thread.id}`} className={styles.threadLink}>{PRACTICE_COPY.threadJournal}</Link>
        {canStartNew && (
          <button type="button" className={styles.button} onClick={onStartNew}>{PRACTICE_COPY.threadStartNew}</button>
        )}
      </div>
    </article>
  );
}

/** The realized result, its signed amount colored; the rest of the line stays muted text. */
function TodayLine({ view }: { view: ReturnType<typeof todayView> }) {
  if (view.pnl === null) return <>{view.line}</>;
  const amount = formatDayResult(view.pnl);
  const at = view.line.indexOf(amount);
  if (at < 0) return <>{view.line}</>;
  return (
    <>
      {view.line.slice(0, at)}
      <span className={styles[dayResultTone(view.pnl)]}>{amount}</span>
      {view.line.slice(at + amount.length)}
    </>
  );
}

/** Resume: today's open day links straight to it; otherwise the plan opens the next day of this thread. */
function ThreadResume({ today, planOpen, onChanged }: { today: ThreadToday | null; planOpen: boolean; onChanged: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [still, setStill] = useState(false);

  async function open() {
    setBusy(true);
    setStill(false);
    setMessage(null);
    try {
      const result = await whenReady(() => openNextDay(), { onWaiting: () => setStill(true) });
      if (result.day_list_id !== null) {
        router.push(`/practice/day?id=${result.day_list_id}`);
        return;
      }
      setBusy(false);
      setStill(false);
      onChanged();
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.threadResumeError));
      setStill(false);
      setBusy(false);
    }
  }

  if (today === null && !planOpen) return <p className={styles.muted}>{PRACTICE_COPY.threadResumeNeedsPlan}</p>;

  return (
    <>
      <div className={styles.inline}>
        {today !== null ? (
          <Link href={`/practice/day?id=${today.day_list_id}`} className={styles.primaryLink}>{PRACTICE_COPY.threadResume}</Link>
        ) : (
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void open()}>{busy ? PRACTICE_COPY.planOpening : PRACTICE_COPY.threadResume}</button>
        )}
        <p className={styles.hint}>{PRACTICE_COPY.threadResumeHint}</p>
      </div>
      {still && <p role="status" className={styles.hint}>{PRACTICE_COPY.planStillWorking}</p>}
      {message && <ErrorBlock message={message} onRetry={() => void open()} />}
    </>
  );
}
