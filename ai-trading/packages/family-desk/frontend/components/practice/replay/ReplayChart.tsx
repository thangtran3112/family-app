"use client";

import { useMemo, useState } from "react";
import { MarketChart } from "@/components/charts/MarketChart";
import { ChartLegend } from "@/components/workspace/ChartLegend";
import type { CrosshairPoint } from "@/lib/chart-data";
import { legendModel, type ChartSeries, type IndicatorId } from "@/lib/desk/workspace";
import type { ReplayView } from "@/lib/replay/feedState";
import { levelLines, practiceMarkers, signalMarkers, stopLevel } from "@/lib/replay/marks";
import type { ReplayBar, ReplayMark } from "@/lib/replay/schemas";
import styles from "./replay.module.css";

// Practice charts show a day's price, VWAP and the two EMAs with volume. RSI and MACD stay on the live workspace.
export const REPLAY_INDICATORS: ReadonlySet<IndicatorId> = new Set<IndicatorId>(["vwap", "ema9", "ema21", "volume"]);

export type ReplayChartProps = {
  symbol: string;
  view: ReplayView;
  /** The displayed bars and the series computed from them (the header reads VWAP from the same series). */
  bars: ReplayBar[];
  series: ChartSeries;
  marks: readonly ReplayMark[];
  hideDates: boolean;
  focus: { time: string; at: number } | null;
  dimmed?: boolean;
};

/**
 * The replay chart: `MarketChart` fed only with what the server revealed (closed bars plus the forming one), her Practice
 * marks, the would-fire bells of released signals, key levels and the practice stop. No bar is ever sliced here.
 */
export function ReplayChart({ symbol, view, bars, series, marks, hideDates, focus, dimmed }: ReplayChartProps) {
  const [crosshair, setCrosshair] = useState<CrosshairPoint | null>(null);
  const markers = useMemo(() => [...practiceMarkers(marks, bars), ...signalMarkers(view.signals, bars)], [marks, bars, view.signals]);
  const levels = useMemo(() => [...levelLines(view.levels), ...stopLevel(view.openTrade)], [view.levels, view.openTrade]);
  // The legend names VWAP and the EMAs. The chart's own series tags ("EMA 9") would sit over the newest bars, where a practice
  // marker lands, so they are left off the chart (D-028).
  const untagged = useMemo(() => series.overlays.map((overlay) => ({ ...overlay, label: "" })), [series.overlays]);
  const legend = legendModel(symbol, view.interval, bars, series.overlays, crosshair);

  return (
    <div className={styles.chartArea}>
      <MarketChart
        symbol={symbol}
        interval={view.interval}
        bars={bars}
        quality="delayed-15m"
        asOf={view.revealedThrough}
        overlays={untagged}
        panes={series.panes}
        levels={levels}
        markers={markers}
        volume={series.volume}
        onCrosshair={setCrosshair}
        chrome="bare"
        height="fill"
        follow
        hideDates={hideDates}
        focus={focus}
        dimmed={dimmed}
      />
      <div className={styles.legend}><ChartLegend model={legend} /></div>
    </div>
  );
}
