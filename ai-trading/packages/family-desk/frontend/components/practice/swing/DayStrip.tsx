"use client";

import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { StripRow } from "@/lib/replay/schemas";
import { stripRowView } from "@/lib/replay/swing";
import styles from "./play.module.css";

export type DayStripProps = {
  /** The latest strip the server sent (an advance or the feed): every open hold first, then the focus names. */
  rows: readonly StripRow[] | null;
  /** The name on the chart. */
  current: string;
  /** The name whose session is being opened; the other rows wait. */
  opening: string | null;
  /** The day is over: nothing to switch to. */
  disabled?: boolean;
  onSwitch: (symbol: string) => void;
};

/**
 * The swing workspace's left rail (02p d2): every open hold and every focus name with the last price at the day clock, the
 * change from the prior close and, for a hold, its unrealized P/L and how far the price is from its stop. A row whose stop
 * paused the clock is amber. A click opens or resumes that name's session at the day clock.
 */
export function DayStrip({ rows, current, opening, disabled = false, onSwitch }: DayStripProps) {
  const list = rows ?? [];
  return (
    <section className={styles.strip} aria-label={PRACTICE_COPY.swingStripTitle}>
      <h2 className={styles.stripTitle}>{PRACTICE_COPY.swingStripTitle}</h2>
      {list.length === 0 ? (
        <p className={styles.muted}>{PRACTICE_COPY.swingStripEmpty}</p>
      ) : (
        <ul className={styles.stripList}>
          {list.map((row) => {
            const view = stripRowView(row);
            const here = row.symbol === current;
            return (
              <li key={row.symbol}>
                {/* aria-disabled keeps the row focusable while another name opens, so focus is not lost on the update */}
                <button
                  type="button"
                  className={styles.stripRow}
                  aria-label={view.label}
                  aria-current={here ? "true" : undefined}
                  aria-busy={opening === row.symbol ? "true" : undefined}
                  aria-disabled={disabled || opening !== null ? "true" : undefined}
                  data-current={here ? "true" : undefined}
                  data-amber={view.amber ? "true" : undefined}
                  onClick={() => {
                    if (!here && !disabled && opening === null) onSwitch(row.symbol);
                  }}
                >
                  <span className={styles.stripSymbol}>{view.symbol}</span>
                  <span className={styles.stripLast}>{view.last}</span>
                  <span className={styles.stripChange} data-tone={view.changeTone}>{view.change}</span>
                  {view.sub && <span className={styles.stripSub}>{view.sub}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
