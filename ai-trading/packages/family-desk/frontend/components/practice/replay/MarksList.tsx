import { Badge } from "@/components/ui/Badge";
import type { MarkRow } from "@/lib/replay/marks";
import styles from "./panels.module.css";

// The Marks tab (02o §a3): newest first, as the rows arrive. Every label says Practice; these are journal notes.

export function MarksList({ rows }: { rows: MarkRow[] }) {
  if (rows.length === 0) return <p className={styles.muted}>No practice marks yet · press B or S</p>;
  return (
    <ul className={styles.list}>
      {rows.map((row) => (
        <li key={row.id} className={`${styles.row} ${styles.wrap}`}>
          <span className={styles.markTime}>{row.time}</span>
          <span className={styles.markLabel}>{row.label}</span>
          {row.price !== "" && <span>{row.price}</span>}
          {row.note && <span className={styles.markNote}>{row.note}</span>}
          {row.auto && <Badge tone="neutral">auto</Badge>}
        </li>
      ))}
    </ul>
  );
}
