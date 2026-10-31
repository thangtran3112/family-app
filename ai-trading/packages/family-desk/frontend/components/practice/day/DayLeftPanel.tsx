"use client";

import Link from "next/link";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import type { DayList } from "@/lib/replay/daily";
import { blockLadder, blockOpenByDefault, nameCap, riskPlanText, stripRows, watchEmptyText } from "@/lib/replay/dayView";
import { dayResultTone, formatBalance, formatDayResult, threadName } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import styles from "./day.module.css";

export type DayLeftPanelProps = {
  list: DayList;
  /** The thread's full payload (its risk plan); null while it loads or when the day has no thread. */
  thread: Thread | null;
  selected: string | null;
  onPeek: (symbol: string) => void;
  onPractice: (symbol: string) => void;
  onUnstar: (symbol: string) => void;
  busy: boolean;
  /** The names she has opened today: each shows Resume (the day switches names on one clock, 02o-b2). */
  opened: ReadonlySet<string>;
  ended: boolean;
};

/** The day list's left rail (P7): the block's days, the thread box with its risk plan, and the starred names. */
export function DayLeftPanel({ list, thread, selected, onPeek, onPractice, onUnstar, busy, opened, ended }: DayLeftPanelProps) {
  const brief = list.thread;
  return (
    <LeftRailPortal>
      <div className={styles.side} role="region" aria-label="Day lists and names" tabIndex={0}>
        <section className={styles.sideSection} aria-label={PRACTICE_COPY.dayWatch}>
          <div className={styles.sideHead}>
            <h2 className={styles.sideTitle}>{practiceText("dayStarred", { n: list.watch.length, max: nameCap(list.plan) })}</h2>
            {!ended && <span className={styles.sideHint}>click to peek</span>}
          </div>
          {list.watch.length === 0 ? (
            <p className={styles.muted}>{watchEmptyText(nameCap(list.plan))}</p>
          ) : (
            <ul className={styles.watchList}>
              {list.watch.map((entry) => (
                <li key={entry.symbol} className={styles.watchRow} data-selected={entry.symbol === selected ? "true" : undefined}>
                  {ended ? (
                    <span className={styles.watchName} data-inert="true">
                      <span aria-hidden="true" className={styles.watchStar}>★</span>
                      <span className={styles.symbol}>{entry.symbol}</span>
                    </span>
                  ) : (
                    <button type="button" className={styles.watchName} onClick={() => onPeek(entry.symbol)} aria-label={`Peek at ${entry.symbol}`}>
                      <span aria-hidden="true" className={styles.watchStar}>★</span>
                      <span className={styles.symbol}>{entry.symbol}</span>
                      {entry.symbol === selected && <span className={styles.sideHint}>selected</span>}
                    </button>
                  )}
                  {!ended && (
                    <span className={styles.actions}>
                      <button type="button" className={styles.small} disabled={busy} aria-label={practiceText("dayPractice", { symbol: entry.symbol })} onClick={() => onPractice(entry.symbol)}>
                        {opened.has(entry.symbol) ? "Resume" : "Practice"}
                      </button>
                      <button type="button" className={styles.small} disabled={busy} aria-label={practiceText("dayRemove", { symbol: entry.symbol })} onClick={() => onUnstar(entry.symbol)}>Unstar</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!ended && <p className={styles.muted}>{PRACTICE_COPY.dayPracticeHint}</p>}
        </section>

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

        {list.sessions.length > 0 && (
          <section className={styles.sideSection} aria-label={PRACTICE_COPY.dayNamesTitle}>
            <h2 className={styles.sideTitle}>{PRACTICE_COPY.dayNamesTitle}</h2>
            <ul className={styles.watchList} aria-label={PRACTICE_COPY.dayNamesTitle}>
              {stripRows(list).map((row) => (
                <li key={row.symbol} className={styles.watchRow} data-symbol={row.symbol}>
                  <span className={styles.symbol}>{row.symbol}</span>
                  <span className={styles.actions}>
                    {row.holding && <span className={`${styles.chip} ${styles.chipAmber}`}>{PRACTICE_COPY.dayHolding}</span>}
                    {row.behind && <span className={styles.chip}>{PRACTICE_COPY.dayBehind}</span>}
                    {row.sessionId !== null && !ended && (
                      <Link href={`/practice/replay?id=${row.sessionId}`} className={styles.small} aria-label={practiceText("daySwitch", { symbol: row.symbol })}>Open</Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </LeftRailPortal>
  );
}
