"use client";

import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { improvementOf, type Week } from "@/lib/replay/threadView";
import styles from "./threadJournal.module.css";

/** Week against week (02r). Too few days for a trend shows the honest caveat instead of a verdict. */
export function ImprovementPanel({ weeks }: { weeks: Week[] }) {
  const { compared, caveat, verdict } = improvementOf(weeks);
  return (
    <div className={styles.stack}>
      <div className={styles.headRow}>
        <p className={styles.muted}>{compared?.intro}</p>
        <SimulatedBadge />
      </div>
      {compared && (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Measure</span></th>
                <th scope="col" className={styles.num}>{`Week ${compared.first.n}`}</th>
                <th scope="col" className={styles.num}>Latest</th>
              </tr>
            </thead>
            <tbody>
              {compared.rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.label}</th>
                  <td className={`${styles.num} ${toneClass(row.first)}`}>{row.first}</td>
                  <td className={`${styles.num} ${toneClass(row.latest)}`}>{row.latest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {caveat && (
        <div className={styles.caveat}>
          <p className={styles.caveatTitle}>{caveat.title}</p>
          <p className={styles.muted}>{caveat.reason}</p>
        </div>
      )}
      {verdict && <p className={styles.muted}>{verdict}</p>}
    </div>
  );
}

/** Signed money only: a "+" reads green, a "−" red; anything else keeps the plain text colour. */
function toneClass(text: string): string {
  if (text.startsWith("+")) return styles.up;
  if (text.startsWith("−")) return styles.down;
  return "";
}
