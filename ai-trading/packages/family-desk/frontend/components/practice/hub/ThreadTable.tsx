"use client";

import Link from "next/link";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { threadCard } from "@/lib/replay/overviewView";
import { journalHref, threadPageHref } from "@/lib/replay/practiceTabs";
import type { ThreadSummary } from "@/lib/replay/threads";
import { formatBalance, threadName, threadStartedText } from "@/lib/replay/threadView";
import { DeleteThread } from "./DeleteThread";
import { ThreadAction, lockLink } from "./ThreadAction";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

/** The landing's table (Paper mock LEW-0): one row per thread, the active ones first and the closed ones below. Every dollar figure is
 *  SIMULATED. A row is the thread's card: its name, its realized balance, how many positions are open, the thread's time `T` with the
 *  clock's state, and when it was last used. The name is a link stretched over the whole row, so a click, Enter, a middle click and a
 *  cmd-click all open the thread's Summary; the last column holds the one action (Open Screen, or Trades for a closed thread) and a
 *  Delete button, both clear of that link. While `loading` the rows are two grey skeletons. `busy` is true while a thread is being
 *  deleted: every row waits, so a second click cannot race the first. */
export function ThreadTable({
  rows,
  loading = false,
  busy,
  onBusy,
  onChanged,
  onDeleted,
}: {
  rows: readonly ThreadSummary[];
  loading?: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onChanged: () => void;
  /** A thread was deleted: its name, for the page's status line (the row is gone by then). */
  onDeleted?: (name: string) => void;
}) {
  // The last-activity column is the first to go at the 1180 band (02l §b3 rule 4).
  const wide = useShellBand() === "1440";
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label={loading ? PRACTICE_COPY.threadsLoading : PRACTICE_COPY.landingTableLabel} aria-busy={loading || undefined}>
        {/* Fixed layout with set widths: the columns stay put when a row is deleted or a status changes (D-114). */}
        <colgroup>
          <col />
          <col className={styles.colBalance} />
          <col className={styles.colPositions} />
          <col className={styles.colClock} />
          {wide && <col className={styles.colActivity} />}
          <col className={styles.colAction} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{PRACTICE_COPY.landingColThread}</th>
            <th scope="col" className={styles.num}>{PRACTICE_COPY.landingColBalance}</th>
            <th scope="col" className={styles.num}>{PRACTICE_COPY.landingColPositions}</th>
            <th scope="col">{PRACTICE_COPY.landingColClock}</th>
            {wide && <th scope="col">{PRACTICE_COPY.landingColActivity}</th>}
            <th scope="col" className={styles.actionHead}>{PRACTICE_COPY.landingColAction}</th>
          </tr>
        </thead>
        <tbody>
          {loading
            ? [0, 1].map((n) => <SkeletonRow key={n} wide={wide} />)
            : rows.map((row) => <ThreadRow key={row.thread.id} summary={row} wide={wide} busy={busy} onBusy={onBusy} onChanged={onChanged} onDeleted={onDeleted} />)}
        </tbody>
      </table>
    </div>
  );
}

/** A row-shaped placeholder: one grey bar per column, so the table keeps its shape while the threads load. */
function SkeletonRow({ wide }: { wide: boolean }) {
  return (
    <tr className={styles.skelRow} aria-hidden="true">
      <td><Skeleton width={120} height={14} /></td>
      <td className={styles.num}><Skeleton width={96} height={14} className={styles.skelEnd} /></td>
      <td className={styles.num}><Skeleton width={72} height={14} className={styles.skelEnd} /></td>
      <td><Skeleton width={160} height={14} /></td>
      {wide && <td><Skeleton width={72} height={14} /></td>}
      <td className={styles.actionCell}><Skeleton width={84} height={32} className={styles.skelEnd} /></td>
    </tr>
  );
}

function ThreadRow({
  summary,
  wide,
  busy,
  onBusy,
  onChanged,
  onDeleted,
}: {
  summary: ThreadSummary;
  wide: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onChanged: () => void;
  onDeleted?: (name: string) => void;
}) {
  const { thread } = summary;
  const closed = thread.status === "closed";
  const card = threadCard(summary);
  return (
    <tr className={styles.row} data-status={thread.status} data-busy={busy || undefined} aria-label={threadName(thread)}>
      <th scope="row" className={styles.threadCell}>
        <span className={styles.threadHead}>
          <Link href={threadPageHref(thread.id)} className={styles.threadName} {...lockLink(busy)}>{threadName(thread)}</Link>
          {closed ? (
            <Badge tone="neutral">{PRACTICE_COPY.threadClosedBadge}</Badge>
          ) : (
            <span className={styles.activeTag}>
              <span className={hub.openDot} aria-hidden="true" />
              {PRACTICE_COPY.threadActive}
            </span>
          )}
        </span>
        <span className={styles.sub}>{threadStartedText(thread, summary.clock)}</span>
      </th>
      <td className={styles.num}>
        <span className={styles.balance}>
          <span className={styles.balanceValue}>{formatBalance(thread.stats.balance)}</span>
          <SimulatedBadge />
        </span>
      </td>
      <td className={styles.num} data-testid="thread-positions">{card.positions}</td>
      <td>
        <span className={styles.progress} data-testid="thread-time">{card.clock}</span>
        {card.state !== "" && <span className={styles.sub}>{card.state}</span>}
      </td>
      {wide && <td className={styles.lastDay}>{card.lastActivity}</td>}
      <td className={styles.actionCell}>
        <div className={styles.actions}>
          {closed ? (
            <Button client href={journalHref(thread.id)} variant="primary" {...lockLink(busy)}>{PRACTICE_COPY.landingJournal}</Button>
          ) : (
            <ThreadAction summary={summary} busy={busy} />
          )}
          <DeleteThread
            thread={thread}
            busy={busy}
            onBusy={onBusy}
            onDeleted={(name) => {
              onChanged();
              onDeleted?.(name);
            }}
          />
        </div>
      </td>
    </tr>
  );
}
