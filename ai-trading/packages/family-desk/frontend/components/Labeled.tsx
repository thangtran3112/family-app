import type { Quality } from "../lib/labels.ts";
import { qualityLabel } from "../lib/labels.ts";
import { labeledValueText } from "../lib/today.ts";
import styles from "./today/today.module.css";

export function Labeled({
  label,
  value,
  quality,
  baselineQuality,
}: Readonly<{
  label: string;
  value: string | number | null | undefined;
  quality?: Quality;
  baselineQuality?: Quality;
}>) {
  return (
    <div className={styles.labeled}>
      <span className={styles.labeledLabel}>{label}</span>
      <strong className={styles.labeledValue}>{labeledValueText(value)}</strong>
      {quality && <span className={styles.quality}>{qualityLabel(quality)}</span>}
      {baselineQuality && <span className={styles.quality}>baseline {qualityLabel(baselineQuality)}</span>}
    </div>
  );
}
