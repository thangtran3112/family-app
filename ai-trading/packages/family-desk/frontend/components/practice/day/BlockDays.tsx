"use client";

import { practiceText } from "@/lib/desk/freshness";
import type { DayList } from "@/lib/replay/daily";
import { blockLadder, blockOpenByDefault } from "@/lib/replay/dayView";
import styles from "./day.module.css";

/** The block's days (P7), stacked in the day list's right rail under the thread plan: the Day list itself is only the list of names.
 *  The portfolio is the Portfolio tab's, and the thread's balance and risk plan are the plan section above. A long block starts collapsed (D-097). */
export function BlockDays({ list }: { list: DayList }) {
  return (
    <details open={blockOpenByDefault(list.of) ? true : undefined}>
      <summary className={styles.sideSummary}>{practiceText("dayBlockTitle", { of: list.of })}</summary>
      <ul className={styles.ladder}>
        {blockLadder(list, list.plan.day_offset, list.plan.weekdays).map((row) => (
          <li key={row.n} className={styles.ladderRow} data-state={row.state}>
            <span className={styles.ladderMark} aria-hidden="true">{row.state === "ended" ? "✓" : row.state === "open" ? "●" : "○"}</span>
            <span className={styles.ladderDay}>{row.weekday ? `Day ${row.n + list.plan.day_offset} · ${row.weekday}` : `Day ${row.n + list.plan.day_offset}`}</span>
            <span className={styles.ladderDetail}>{row.detail}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
