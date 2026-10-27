"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import type { PracticePlan } from "@/lib/replay/daily";
import { swingCardView } from "@/lib/replay/swing";
import type { PracticeThread, ThreadSummary } from "@/lib/replay/threads";
import {
  dayResultTone,
  formatBalance,
  formatDayResult,
  threadModeLabel,
  threadName,
  todayView,
  winRateText,
} from "@/lib/replay/threadView";
import { ThreadAction, lockLink } from "./ThreadAction";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

/** The landing's table (Paper mock LEW-0): one row per thread, the active ones first and the closed ones below. Every
 *  dollar figure is SIMULATED. A click anywhere on a row opens the thread page; the last column holds the one action
 *  (Resume, or the swing thread's own, or Journal for a closed thread). While `loading` the rows are two grey skeletons.
 *  `busy` is true while any row's action is opening a day: every row waits, so a second click cannot race the first. */
export function ThreadTable({
  rows,
  plan,
  loading = false,
  busy,
  onBusy,
  onChanged,
  onNewPlan,
}: {
  rows: readonly ThreadSummary[];
  plan: PracticePlan | null;
  loading?: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onChanged: () => void;
  onNewPlan: (thread: PracticeThread) => void;
}) {
  // The last-day column is the first to go at the 1180 band (02l §b3 rule 4).
  const wide = useShellBand() === "1440";
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label={loading ? PRACTICE_COPY.threadsLoading : PRACTICE_COPY.landingTableLabel} aria-busy={loading || undefined}>
        <thead>
          <tr>
            <th scope="col">{PRACTICE_COPY.landingColThread}</th>
            <th scope="col">{PRACTICE_COPY.threadBalance}</th>
            <th scope="col" className={styles.num}>{PRACTICE_COPY.landingColDays}</th>
            <th scope="col" className={styles.num}>{PRACTICE_COPY.threadSkipped}</th>
            <th scope="col" className={styles.num}>{PRACTICE_COPY.threadWinRate}</th>
            {wide && <th scope="col">{PRACTICE_COPY.landingColLastDay}</th>}
            <th scope="col" className={styles.actionHead}>{PRACTICE_COPY.landingColAction}</th>
          </tr>
        </thead>
        <tbody>
          {loading
            ? [0, 1].map((n) => <SkeletonRow key={n} wide={wide} />)
            : rows.map((row) => (
                <ThreadRow key={row.thread.id} summary={row} plan={plan} wide={wide} busy={busy} onBusy={onBusy} onChanged={onChanged} onNewPlan={onNewPlan} />
              ))}
        </tbody>
      </table>
    </div>
  );
}

/** A row-shaped placeholder: one grey bar per column, so the table keeps its shape while the threads load. */
function SkeletonRow({ wide }: { wide: boolean }) {
  return (
    <tr className={styles.skelRow} aria-hidden="true">
      <td><span className={`${styles.skel} ${styles.skelName}`} /></td>
      <td><span className={`${styles.skel} ${styles.skelMoney}`} /></td>
      <td className={styles.num}><span className={`${styles.skel} ${styles.skelNum}`} /></td>
      <td className={styles.num}><span className={`${styles.skel} ${styles.skelNum}`} /></td>
      <td className={styles.num}><span className={`${styles.skel} ${styles.skelNum}`} /></td>
      {wide && <td><span className={`${styles.skel} ${styles.skelName}`} /></td>}
      <td className={styles.actionCell}><span className={`${styles.skel} ${styles.skelAction}`} /></td>
    </tr>
  );
}

function ThreadRow({
  summary,
  plan,
  wide,
  busy,
  onBusy,
  onChanged,
  onNewPlan,
}: {
  summary: ThreadSummary;
  plan: PracticePlan | null;
  wide: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onChanged: () => void;
  onNewPlan: (thread: PracticeThread) => void;
}) {
  const router = useRouter();
  const { thread, last_day: lastDay, today } = summary;
  const href = `/practice/thread?id=${thread.id}`;
  // The whole row opens the thread page. The name link does the same for the keyboard; a click on the action does its own thing.
  const openThread = (event: MouseEvent<HTMLTableRowElement>) => {
    if (!busy && !(event.target as HTMLElement).closest("a, button")) router.push(href);
  };
  const { stats } = thread;
  const closed = thread.status === "closed";
  const swing = swingCardView(summary);
  const view = todayView(today, lastDay);
  return (
    <tr className={styles.row} data-status={thread.status} data-busy={busy || undefined} aria-label={`${threadName(thread)} · ${threadModeLabel(thread.mode)}`} onClick={openThread}>
      <th scope="row" className={styles.threadCell}>
        <span className={styles.threadHead}>
          <Link href={href} className={styles.threadName} {...lockLink(busy)}>{threadName(thread)}</Link>
          <span className={hub.chip}>{threadModeLabel(thread.mode)}</span>
          {closed ? (
            <span className={hub.chip}>{PRACTICE_COPY.threadClosedBadge}</span>
          ) : (
            <span className={styles.activeTag}>
              <span className={hub.openDot} aria-hidden="true" />
              {PRACTICE_COPY.threadActive}
            </span>
          )}
        </span>
        {swing && <span className={styles.sub}>{swing.line}</span>}
      </th>
      <td>
        <span className={styles.balance}>
          <span className={styles.balanceValue}>{formatBalance(stats.balance)}</span>
          <SimulatedBadge />
        </span>
        {summary.swing && <span className={styles.sub}>{practiceText("landingEquity", { amount: formatBalance(summary.swing.equity_usd) })}</span>}
      </td>
      <td className={styles.num}>{stats.daysPracticed}</td>
      <td className={styles.num}>{stats.daysSkipped}</td>
      <td className={styles.num}>{winRateText(stats.winRate)}</td>
      {wide && (
        <td>
          <span className={styles.sub}>{view.label}</span>
          <ResultLine pnl={view.pnl} line={view.line} />
        </td>
      )}
      <td className={styles.actionCell}>
        <div className={styles.actions}>
          {closed ? (
            <Link href={`/practice/journal?thread=${thread.id}`} className={hub.primaryLink} {...lockLink(busy)}>{PRACTICE_COPY.landingJournal}</Link>
          ) : (
            <ThreadAction summary={summary} plan={plan} busy={busy} onBusy={onBusy} onChanged={onChanged} onNewPlan={() => onNewPlan(thread)} />
          )}
        </div>
      </td>
    </tr>
  );
}

/** A thread's today or last-day line, the signed result colored; the rest of the line stays muted text. */
export function ResultLine({ pnl, line }: { pnl: number | null; line: string }) {
  if (pnl === null) return <span>{line}</span>;
  const amount = formatDayResult(pnl);
  const at = line.indexOf(amount);
  if (at < 0) return <span>{line}</span>;
  return (
    <span>
      {line.slice(0, at)}
      <span className={hub[dayResultTone(pnl)]}>{amount}</span>
      {line.slice(at + amount.length)}
    </span>
  );
}
