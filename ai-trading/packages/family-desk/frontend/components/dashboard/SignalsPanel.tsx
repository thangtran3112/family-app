import type { Dashboard } from "@/lib/api/schemas";
import { formatEtTime } from "@/lib/desk/format";
import { SIGNAL_LIMIT } from "@/lib/desk/dashboardView";
import { symbolHref } from "@/lib/desk/listNav";
import { EmptyDay } from "./EmptyDay";
import styles from "./dashboard.module.css";

export function SignalsPanel({ signals }: { signals: Dashboard["signals"] }) {
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>Today&apos;s signals</h2>
      {signals.length === 0 ? (
        <EmptyDay />
      ) : (
        <ul className={styles.list}>
          {signals.slice(0, SIGNAL_LIMIT).map((signal) => (
            <li key={signal.id} className={styles.signal}>
              <span className={styles.muted}>{formatEtTime(signal.bar_time)}</span>
              <a className={styles.link} href={symbolHref(signal.symbol)}>{signal.symbol}</a>
              <span className={styles.muted}>{signal.strategy_name}</span>
              <span className={styles.ellipsis}>{signal.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
