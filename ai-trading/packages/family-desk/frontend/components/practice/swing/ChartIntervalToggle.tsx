"use client";

import { CHART_MODES, chartModeLabel, type ChartMode } from "@/lib/replay/playView";
import styles from "./play.module.css";

/** Daily · 15m · 5m (02p d2). Daily needs no request (the daily block is already in the view); 15m and 5m re-read the feed. */
export function ChartIntervalToggle({ mode, onMode }: { mode: ChartMode; onMode: (mode: ChartMode) => void }) {
  return (
    <div className={styles.toggle} role="group" aria-label="Chart interval">
      {CHART_MODES.map((value) => (
        <button
          key={value}
          type="button"
          className={styles.toggleButton}
          aria-pressed={mode === value}
          title={value === "daily" ? "Daily candles through the prior close and today's forming candle" : `${value} candles`}
          onClick={() => onMode(value)}
        >
          {chartModeLabel(value)}
        </button>
      ))}
    </div>
  );
}
