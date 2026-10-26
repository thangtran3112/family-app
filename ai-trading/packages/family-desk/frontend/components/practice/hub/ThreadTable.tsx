"use client";

import Link from "next/link";
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
import { ThreadAction } from "./ThreadAction";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

/** The landing's table (Paper mock LEW-0): one row per thread, the active ones first and the closed ones below. Every
 *  dollar figure is SIMULATED. The last column's content is the same Continue logic the thread page uses. */
export function ThreadTable({
  rows,
  plan,
  onChanged,
  onNewPlan,
}: {
  rows: readonly ThreadSummary[];
  plan: PracticePlan | null;
  onChanged: () => void;
  onNewPlan: (thread: PracticeThread) => void;
}) {
  // The last-day column is the first to go at the 1180 band (02l §b3 rule 4).
  const wide = useShellBand() === "1440";
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label={PRACTICE_COPY.landingTableLabel}>
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
          {rows.map((row) => (
            <ThreadRow key={row.thread.id} summary={row} plan={plan} wide={wide} onChanged={onChanged} onNewPlan={onNewPlan} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ThreadRow({
  summary,
  plan,
  wide,
  onChanged,
  onNewPlan,
}: {
  summary: ThreadSummary;
  plan: PracticePlan | null;
  wide: boolean;
  onChanged: () => void;
  onNewPlan: (thread: PracticeThread) => void;
}) {
  const { thread, last_day: lastDay, today } = summary;
  const { stats } = thread;
  const closed = thread.status === "closed";
  const swing = swingCardView(summary);
  const view = todayView(today, lastDay);
  return (
    <tr className={styles.row} data-status={thread.status} aria-label={`${threadName(thread)} · ${threadModeLabel(thread.mode)}`}>
      <th scope="row" className={styles.threadCell}>
        <span className={styles.threadHead}>
          <span className={styles.threadName}>{threadName(thread)}</span>
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
          {!closed && <ThreadAction summary={summary} plan={plan} onChanged={onChanged} onNewPlan={() => onNewPlan(thread)} />}
          <Link href={`/practice/journal?thread=${thread.id}`} className={styles.journalLink} aria-label={`${PRACTICE_COPY.threadJournal}: ${threadName(thread)}`}>
            {PRACTICE_COPY.threadJournal}
          </Link>
          <Link href={`/practice/thread?id=${thread.id}`} className={styles.journalLink} aria-label={`Overview: ${threadName(thread)}`}>Overview</Link>
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
