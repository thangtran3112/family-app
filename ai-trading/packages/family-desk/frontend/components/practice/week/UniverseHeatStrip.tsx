"use client";

import type { HeatItem, HeatKind } from "@/lib/replay/weekView";
import styles from "./week.module.css";

const TAG: Record<HeatKind, string | null> = { both: "Held · Focus", held: "Held", focus: "Focus", none: null };
const FRAME: Record<HeatKind, string> = { both: styles.heatHeld, held: styles.heatHeld, focus: styles.heatFocus, none: "" };

/** The universe, best to worst by week return, as an ordered list. Her holds and focus names are marked with a word, not a colour alone. */
export function UniverseHeatStrip({ items, label }: { items: HeatItem[]; label: string }) {
  return (
    <ol className={styles.heat} aria-label={label}>
      {items.map((item) => {
        const tag = TAG[item.kind];
        return (
          <li key={item.symbol} className={`${styles.heatItem} ${FRAME[item.kind]}`} title={`${item.label} · ${item.sourceLabel}`}>
            <span className={styles.heatSymbol}>{item.symbol}</span>
            <span className={styles[item.tone]}>{item.returnText}</span>
            {tag !== null && <span className={styles.heatTag}>{tag}</span>}
          </li>
        );
      })}
    </ol>
  );
}
