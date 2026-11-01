"use client";

import { ChipToggleGroup } from "@/components/ui/ChipToggleGroup";
import { CHART_MODES, chartModeLabel, type ChartMode } from "@/lib/replay/playView";

/** Daily · 15m · 5m (02p d2). Daily needs no request (the daily block is already in the view); 15m and 5m re-read the feed. */
export function ChartIntervalToggle({ mode, onMode }: { mode: ChartMode; onMode: (mode: ChartMode) => void }) {
  const options = CHART_MODES.map((value) => ({
    id: value,
    label: chartModeLabel(value),
    title: value === "daily" ? "Daily candles through the prior close and today's forming candle" : `${value} candles`,
  }));
  return <ChipToggleGroup label="Chart interval" options={options} pressed={[mode]} onToggle={onMode} />;
}
