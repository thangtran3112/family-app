import type { Technicals } from "@/lib/api/schemas";
import { formatPrice } from "@/lib/desk/format";
import { keyLevelRows } from "@/lib/desk/workspace";
import styles from "./workspacePanels.module.css";

export function KeyLevels({ technicals }: { technicals: Technicals }) {
  const rows = keyLevelRows(technicals);
  return (
    <section className={styles.section} aria-label="Key levels">
      <h3 className={styles.heading}>Key levels</h3>
      {rows.length === 0 ? (
        <p className={styles.muted}>Levels are not available yet</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li key={row.label} className={styles.listRow}>
              <span>{row.label}</span>
              <span className={styles.price}>{formatPrice(row.price)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
