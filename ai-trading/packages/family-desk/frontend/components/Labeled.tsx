import type { Quality } from "../lib/labels.ts";
import { qualityLabel } from "../lib/labels.ts";
import styles from "./today/today.module.css";

export function Labeled({
  label,
  value,
  quality,
}: Readonly<{ label: string; value: string | number | null | undefined; quality?: Quality }>) {
  return (
    <div className={styles.labeled}>
      <span className={styles.labeledLabel}>{label}</span>
      <strong className={styles.labeledValue}>{value === null || value === undefined ? "not available" : value}</strong>
      {quality && <span className={styles.quality}>{qualityLabel(quality)}</span>}
    </div>
  );
}
