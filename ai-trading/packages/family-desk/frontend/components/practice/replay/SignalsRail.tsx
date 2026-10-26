"use client";

import { formatEtTime, formatPrice } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { ReplaySignal } from "@/lib/replay/schemas";
import styles from "./panels.module.css";

// Released would-fire signals, as they came (02o §a3). Selecting one moves the chart crosshair to its bar;
// it never moves the playhead, so the replay stays where the trader left it.

export const signalKey = (signal: ReplaySignal): string => `${signal.source}:${signal.id}:${signal.bar_time}`;

export type SignalsRailProps = {
  signals: ReplaySignal[];
  selectedKey?: string | null;
  onSelect?: (signal: ReplaySignal) => void;
};

export function SignalsRail({ signals, selectedKey = null, onSelect }: SignalsRailProps) {
  if (signals.length === 0) return <p className={styles.muted}>{PRACTICE_COPY.noSignalsYet}</p>;
  return (
    <ul className={styles.signalList}>
      {signals.map((signal) => {
        const key = signalKey(signal);
        return (
          <li key={key}>
            <button
              type="button"
              className={styles.signal}
              aria-current={key === selectedKey ? "true" : undefined}
              title="Moves the chart crosshair to this bar · the playhead stays where it is"
              onClick={() => onSelect?.(signal)}
            >
              <span className={signal.seen ? styles.signalText : `${styles.signalText} ${styles.unseen}`}>
                {`${formatEtTime(signal.bar_close)} · ${signal.name} · would fire at ${formatPrice(signal.close)}`}
                {!signal.seen && <span className={styles.unseenNote}>{` · ${PRACTICE_COPY.signalUnseen}`}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
