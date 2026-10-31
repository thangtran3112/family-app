"use client";

import { Portfolio } from "@/components/practice/replay/Portfolio";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { useShellBand } from "@/lib/desk/useViewportBand";
import type { DayList } from "@/lib/replay/daily";
import { blockLadder, blockOpenByDefault, riskPlanText } from "@/lib/replay/dayView";
import { dayResultTone, formatBalance, formatDayResult, threadName } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import styles from "./day.module.css";

export type DayLeftPanelProps = {
  list: DayList;
  /** The thread's full payload (its risk plan); null while it loads or when the day has no thread. */
  thread: Thread | null;
  /** Bump to re-read the portfolio (the day page changed). */
  revision: number;
};

/** The day list's left rail (P7): the day's portfolio, the thread box with its risk plan, and the block's days. At 1180 the
 *  portfolio is the right rail's tab instead. */
export function DayLeftPanel({ list, thread, revision }: DayLeftPanelProps) {
  const brief = list.thread;
  const band = useShellBand();
  return (
    <LeftRailPortal>
      <div className={styles.side} role="region" aria-label="Day portfolio and lists" tabIndex={0}>
        {band === "1440" && (
          <section className={styles.sideSection} aria-label={PRACTICE_COPY.dayPortfolio}>
            <h2 className={styles.sideTitle}>{PRACTICE_COPY.dayPortfolio}</h2>
            <Portfolio dayListId={list.id} revision={revision} />
          </section>
        )}

        {brief && (
          <section className={styles.sideSection} aria-label="Practice thread">
            <div className={styles.sideHead}>
              <h2 className={styles.sideTitle}>{thread ? threadName(thread.thread) : "Practice thread"}</h2>
              <SimulatedBadge />
            </div>
            <dl className={styles.sideFacts}>
              <div><dt>{PRACTICE_COPY.threadBalance}</dt><dd>{formatBalance(brief.balance)}</dd></div>
              {brief.today_pnl_usd !== null && (
                <div><dt>{PRACTICE_COPY.threadToday}</dt><dd className={styles[dayResultTone(brief.today_pnl_usd)]}>{formatDayResult(brief.today_pnl_usd)}</dd></div>
              )}
            </dl>
            {thread && <p className={styles.muted}>{riskPlanText(thread.thread.plan)}</p>}
          </section>
        )}

        <details className={styles.sideSection} open={blockOpenByDefault(list.of) ? true : undefined}>
          <summary className={styles.sideSummary}><h2 className={styles.sideTitle}>{practiceText("dayBlockTitle", { of: list.of })}</h2></summary>
          <ul className={styles.ladder}>
            {blockLadder(list, list.plan.day_offset).map((row) => (
              <li key={row.n} className={styles.ladderRow} data-state={row.state}>
                <span className={styles.ladderMark} aria-hidden="true">{row.state === "ended" ? "✓" : row.state === "open" ? "●" : "○"}</span>
                <span className={styles.ladderDay}>{row.weekday ? `Day ${row.n + list.plan.day_offset} · ${row.weekday}` : `Day ${row.n + list.plan.day_offset}`}</span>
                <span className={styles.ladderDetail}>{row.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </LeftRailPortal>
  );
}
