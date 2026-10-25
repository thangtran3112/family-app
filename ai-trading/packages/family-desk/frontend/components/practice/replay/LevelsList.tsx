import { formatPrice } from "@/lib/desk/format";
import type { LevelRow } from "@/lib/replay/marks";
import styles from "./panels.module.css";

// The Levels tab (02o §a3): key levels, highest first as given.

export function LevelsList({ rows }: { rows: LevelRow[] }) {
  if (rows.length === 0) return <p className={styles.muted}>Levels appear as the day unfolds</p>;
  return (
    <ul className={styles.list}>
      {rows.map((row) => (
        <li key={row.label} className={styles.row}>
          <span className={styles.label}>{row.label}</span>
          <span className={styles.detail}>{formatPrice(row.price)}</span>
        </li>
      ))}
    </ul>
  );
}
