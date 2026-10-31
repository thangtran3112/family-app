"use client";

import type { CSSProperties } from "react";
import type { LegendModel } from "@/lib/desk/workspace";
import styles from "./workspaceHeader.module.css";

type LegendEntry = { label: string; color: string; value: string; dashed?: boolean };

/** The line's colour and its dash pattern, so a dashed line reads as dashed and not only as "the grey one" (colour is never the only cue). */
export function Swatch({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return dashed ? (
    <span className={`${styles.swatch} ${styles.swatchDashed}`} style={{ "--swatch": color } as CSSProperties} aria-hidden="true" />
  ) : (
    <span className={styles.swatch} style={{ backgroundColor: color }} aria-hidden="true" />
  );
}

function LegendItem({ label, color, value, dashed }: LegendEntry) {
  return (
    <span className={styles.legendItem}>
      <Swatch color={color} dashed={dashed} />
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}

/**
 * Top-left overlay: the OHLC title and one line per overlay (02l §b5). The parent positions it. With `onToggle` each
 * overlay is a button that hides or shows its line (the replay chart); a hidden one stays listed, dimmed.
 */
export function ChartLegend({ model, onToggle }: { model: LegendModel; onToggle?: (id: string) => void }) {
  return (
    <div className={styles.legend}>
      <div className={styles.legendTitle}>{model.title}</div>
      {model.items.map((item) =>
        onToggle ? (
          <button
            key={item.id}
            type="button"
            className={`${styles.legendItem} ${styles.legendButton}`}
            aria-pressed={!item.hidden}
            data-hidden={item.hidden ? "true" : undefined}
            title={`${item.hidden ? "Show" : "Hide"} ${item.label}`}
            onClick={() => onToggle(item.id)}
          >
            <Swatch color={item.color} dashed={item.style === "dashed"} />
            <span>{item.label}</span>
            <span>{item.value}</span>
          </button>
        ) : (
          <LegendItem key={item.id} label={item.label} color={item.color} value={item.value} dashed={item.style === "dashed"} />
        ),
      )}
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
