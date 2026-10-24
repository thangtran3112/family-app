"use client";

import type { LegendModel } from "@/lib/desk/workspace";
import styles from "./workspaceHeader.module.css";

type LegendEntry = { label: string; color: string; value: string };

function LegendItem({ label, color, value }: LegendEntry) {
  return (
    <span className={styles.legendItem}>
      <span className={styles.swatch} style={{ backgroundColor: color }} aria-hidden="true" />
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}

/** Top-left overlay: the OHLC title and one line per overlay (02l §b5). The parent positions it. */
export function ChartLegend({ model }: { model: LegendModel }) {
  return (
    <div className={styles.legend}>
      <div className={styles.legendTitle}>{model.title}</div>
      {model.items.map((item) => (
        <LegendItem key={item.id} label={item.label} color={item.color} value={item.value} />
      ))}
    </div>
  );
}

/** One-line chip for an indicator pane (RSI, MACD) with a close button. The parent positions it. */
export function PaneLegend({
  label,
  items,
  onClose,
}: {
  label: string;
  items: Array<{ label: string; color: string; value: string }>;
  onClose: () => void;
}) {
  return (
    <div className={styles.paneLegend}>
      <span className={styles.paneLabel}>{label}</span>
      {items.map((item) => (
        <LegendItem key={item.label} label={item.label} color={item.color} value={item.value} />
      ))}
      <button type="button" className={styles.paneClose} aria-label={`Close ${label}`} onClick={onClose}>
        ×
      </button>
    </div>
  );
}
