import type { Dashboard } from "@/lib/api/schemas";
import { eventRows } from "@/lib/desk/dashboardView";
import { symbolHref } from "@/lib/desk/listNav";
import styles from "./dashboard.module.css";

export function EventsPanel({ events }: { events: Dashboard["events"] }) {
  const rows = eventRows(events);
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>Upcoming events</h2>
      {rows.length === 0 ? (
        <p className={styles.muted}>No earnings dates for your symbols soon</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li key={`${row.symbol}-${row.day}`} className={styles.event}>
              <a className={styles.link} href={symbolHref(row.symbol)}>{row.symbol}</a>
              <span>{row.day}</span>
              <span className={styles.muted}>{row.timing}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
