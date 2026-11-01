import type { ReactNode } from "react";
import { ChipToggleGroup } from "@/components/ui/ChipToggleGroup";
import { KEY_LEGEND } from "@/lib/replay/keys";
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
  /** A swing session (02p) swaps the 1m 5m 15m chips for its Daily and intraday toggle. */
  chartToggle?: ReactNode;
  /** The view controls after the interval chips: Chart settings and Full screen (same slot inline and full screen, so focus stays put). */
  view?: ReactNode;
};

/**
 * What belongs to ONE name's chart, under that chart: the candle interval, Buy and Sell, Chart settings and Full screen. It
 * holds nothing of the thread's time (Play, Step, speed, Jump, the clock): those are `ThreadClockBar`, above every name.
 */
export function ChartToolbar({ symbol, interval, onInterval, quick, chartToggle, view }: ChartToolbarProps) {
  return (
    <div className={styles.chartToolbar} role="group" aria-label={`${symbol} chart`} data-testid="chart-toolbar">
      <div className={styles.toolbarRow}>
        <span className={styles.chartLabel} aria-hidden="true">{symbol} chart</span>
        {chartToggle ?? <ChipToggleGroup label="Chart interval" size="md" options={INTERVAL_CHIPS} pressed={[interval]} onToggle={onInterval} />}
        {quick}
        {view}
      </div>
      <div className={styles.keyLegend} role="group" aria-label="Keyboard legend">
        {KEY_LEGEND.map((item) => (
          <span key={item.keys}><kbd>{item.keys}</kbd>{item.label}</span>
        ))}
      </div>
    </div>
  );
}
