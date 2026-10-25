"use client";

import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import type { DayList } from "@/lib/replay/daily";
import { blockLadder, MAX_STARS, riskPlanText } from "@/lib/replay/dayView";
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
  /** The name already being practiced today: v1 practices one name a day. */
  practicing: string | null;
  ended: boolean;
};

/** The day list's left rail (P7): the block's days, the thread box with its risk plan, and the starred names. */
export function DayLeftPanel({ list, thread, selected, onPeek, onPractice, onUnstar, busy, practicing, ended }: DayLeftPanelProps) {
  const brief = list.thread;
  return (
    <LeftRailPortal>
      <div className={styles.side}>
        <section className={styles.sideSection} aria-label={practiceText("dayBlockTitle", { of: list.of })}>
          <h2 className={styles.sideTitle}>{practiceText("dayBlockTitle", { of: list.of })}</h2>
          <ul className={styles.ladder}>
            {blockLadder(list).map((row) => (
              <li key={row.n} className={styles.ladderRow} data-state={row.state}>
                <span className={styles.ladderMark} aria-hidden="true">{row.state === "ended" ? "✓" : row.state === "open" ? "●" : "○"}</span>
                <span className={styles.ladderDay}>{row.weekday ? `Day ${row.n} · ${row.weekday}` : `Day ${row.n}`}</span>
                <span className={styles.ladderDetail}>{row.detail}</span>
              </li>
            ))}
          </ul>
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

        <section className={styles.sideSection} aria-label={PRACTICE_COPY.dayWatch}>
          <div className={styles.sideHead}>
            <h2 className={styles.sideTitle}>{practiceText("dayStarred", { n: list.watch.length, max: MAX_STARS })}</h2>
            <span className={styles.sideHint}>click to peek</span>
          </div>
          {list.watch.length === 0 ? (
            <p className={styles.muted}>{PRACTICE_COPY.dayWatchEmpty}</p>
          ) : (
            <ul className={styles.watchList}>
              {list.watch.map((entry) => (
                <li key={entry.symbol} className={styles.watchRow} data-selected={entry.symbol === selected ? "true" : undefined}>
                  <button type="button" className={styles.watchName} onClick={() => onPeek(entry.symbol)} aria-label={`Peek at ${entry.symbol}`}>
                    <span aria-hidden="true" className={styles.watchStar}>★</span>
                    <span className={styles.symbol}>{entry.symbol}</span>
                    {entry.symbol === selected && <span className={styles.sideHint}>selected</span>}
                  </button>
                  {!ended && (
                    <span className={styles.actions}>
                      <button type="button" className={styles.small} disabled={busy || (practicing !== null && practicing !== entry.symbol)} aria-label={practiceText("dayPractice", { symbol: entry.symbol })} onClick={() => onPractice(entry.symbol)}>
                        {practicing === entry.symbol ? "Resume" : "Practice"}
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
      </div>
    </LeftRailPortal>
  );
}
