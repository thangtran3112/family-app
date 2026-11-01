"use client";

import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { practiceText } from "@/lib/desk/freshness";
import type { DayList } from "@/lib/replay/daily";
import { blockLadder, blockOpenByDefault } from "@/lib/replay/dayView";
import styles from "./day.module.css";

export type DayLeftPanelProps = {
  list: DayList;
};

/** The day list's left rail (P7): the block's days. The day list is only the list of names: the portfolio is the Portfolio tab's,
 *  and the thread's balance and risk plan are the thread strip's and the right rail's Plan tab. */
export function DayLeftPanel({ list }: DayLeftPanelProps) {
  return (
    <LeftRailPortal>
      <div className={styles.side} role="region" aria-label="Block days" tabIndex={0}>
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
