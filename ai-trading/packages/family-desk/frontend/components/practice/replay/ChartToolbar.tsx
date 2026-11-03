import type { ReactNode } from "react";
import { ChipToggleGroup } from "@/components/ui/ChipToggleGroup";
import type { ReplayInterval } from "@/lib/replay/schemas";
import { INTERVALS } from "@/lib/replay/setup";
import styles from "./replay.module.css";

const INTERVAL_CHIPS = INTERVALS.map((value) => ({ id: value, label: value, title: `${value} candles` }));

export type ChartToolbarProps = {
  symbol: string;
  interval: ReplayInterval;
  onInterval: (interval: ReplayInterval) => void;
  /** At the 1180 band the practice buttons live here so they work with the drawer closed. */
  quick?: ReactNode;
  /** The view controls after the interval chips: Chart settings and Full screen (same slot inline and full screen, so focus stays put). */
  view?: ReactNode;
};

/**
 * What belongs to ONE name's chart, under that chart: the candle interval, Buy and Sell, Chart settings and Full screen. It
 * holds nothing of the thread's time (Play, speed, Jump, Next open, the clock): those are on the thread's Summary, and time moves only there.
 */
export function ChartToolbar({ symbol, interval, onInterval, quick, view }: ChartToolbarProps) {
  return (
    <div className={styles.chartToolbar} role="group" aria-label={`${symbol} chart`} data-testid="chart-toolbar">
      <div className={styles.toolbarRow}>
        <span className={styles.chartLabel} aria-hidden="true">{symbol} chart</span>
        <ChipToggleGroup label="Chart interval" size="md" options={INTERVAL_CHIPS} pressed={[interval]} onToggle={onInterval} />
        {quick}
        {view}
      </div>
    </div>
  );
}
