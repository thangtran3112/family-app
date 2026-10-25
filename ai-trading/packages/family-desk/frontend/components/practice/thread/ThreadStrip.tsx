import Link from "next/link";
import { formatBalance, formatDayResult, dayResultTone, threadModeLabel } from "@/lib/replay/threadView";
import type { ThreadBrief } from "@/lib/replay/threads";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { SimulatedBadge } from "./SimulatedBadge";
import styles from "./thread.module.css";

/** "Thread balance $50,123 · today +$112  SIMULATED" with the thread's mode and a link to its journal (02r). The balance
 *  reads as text and the figure is colored only for today's result: the sign is the cue. */
export function ThreadStrip({ thread }: { thread: ThreadBrief }) {
  const today = thread.today_pnl_usd;
  return (
    <div className={styles.strip} role="group" aria-label="Practice thread">
      <span className={styles.stripMain}>
        <span>{practiceText("threadBalanceLine", { balance: formatBalance(thread.balance) })}</span>
        {today !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {PRACTICE_COPY.threadToday.toLowerCase()} <span className={styles[dayResultTone(today)]}>{formatDayResult(today)}</span>
            </span>
          </>
        )}
        <SimulatedBadge />
      </span>
      <span className={styles.stripSide}>
        <span>{threadModeLabel(thread.mode)}</span>
        <Link href={`/practice/journal?thread=${thread.id}`} className={styles.stripLink}>{PRACTICE_COPY.threadJournal}</Link>
      </span>
    </div>
  );
}
