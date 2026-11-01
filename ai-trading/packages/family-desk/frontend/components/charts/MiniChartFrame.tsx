import type { ReactNode } from "react";
import { chartPalette } from "@/lib/desk/chartPalette";
import styles from "./MiniChartFrame.module.css";

/** The SVG box: its size in viewBox units and the margins that leave room for the axes. */
export type FrameBox = { width: number; height: number; left: number; right: number; top: number; bottom: number };

/** One horizontal grid line with its label at the left edge. `y` is in viewBox units; `zero` draws the line stronger (the baseline of a bar chart). */
export type FrameTick = { key: string | number; y: number; label: string; zero?: boolean };

/** The dashed line the series starts from (a starting balance), with an optional note placed by the caller. */
export type FrameStart = { y: number; note?: { x: number; y: number; text: string; anchor: "start" | "middle" | "end" } };

/**
 * The frame every small SVG chart shares: the `<svg>` with its viewBox and accessible name, hairline grid lines with their y labels
 * (the ticks come from `niceTicks` in lib/desk/ticks.ts), an optional dashed start line and a row of x labels. Colours come from
 * `chartPalette` (SVG cannot read the CSS tokens' class names), type from `--text-micro`. The series, bars and marks are `children`.
 * `MarketChart` is not built on this: it is a charting library.
 */
export function MiniChartFrame({
  box,
  label,
  yTicks,
  xLabels = [],
  start,
  maxWidth,
  className,
  children,
}: {
  box: FrameBox;
  /** What the chart says, for assistive tech: the figures a sighted reader gets from the picture. */
  label: string;
  yTicks: ReadonlyArray<FrameTick>;
  /** A row of labels under the plot (`x` in viewBox units). */
  xLabels?: ReadonlyArray<{ x: number; label: string }>;
  start?: FrameStart;
  /** Cap the drawn width in px; the chart still scales down. */
  maxWidth?: number;
  /** Layout only. */
  className?: string;
  children?: ReactNode;
}) {
  const left = box.left;
  const right = box.width - box.right;
  const bottom = box.height - box.bottom;
  return (
    <svg viewBox={`0 0 ${box.width} ${box.height}`} role="img" aria-label={label} className={`${styles.svg} ${className ?? ""}`} style={maxWidth === undefined ? undefined : { maxWidth }}>
      {yTicks.map((tick) => (
        <g key={tick.key}>
          <line x1={left} x2={right} y1={tick.y} y2={tick.y} stroke={tick.zero ? chartPalette.muted : chartPalette.hairline} strokeWidth={1} />
          <text x={left - 8} y={tick.y} dy="0.32em" textAnchor="end" fill={chartPalette.muted} className={styles.text}>{tick.label}</text>
        </g>
      ))}
      {xLabels.map((item) => (
        <text key={item.x} x={item.x} y={bottom + 14} textAnchor="middle" fill={chartPalette.muted} className={styles.text}>{item.label}</text>
      ))}
      {start && (
        <>
          <line x1={left} x2={right} y1={start.y} y2={start.y} stroke={chartPalette.muted} strokeWidth={1} strokeDasharray="4 4" />
          {start.note && <text x={start.note.x} y={start.note.y} textAnchor={start.note.anchor} fill={chartPalette.muted} className={styles.text}>{start.note.text}</text>}
        </>
      )}
      {children}
    </svg>
  );
}
