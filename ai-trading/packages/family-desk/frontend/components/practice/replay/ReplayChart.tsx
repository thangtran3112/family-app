"use client";

import { useMemo, useState } from "react";
import { MarketChart } from "@/components/charts/MarketChart";
import play from "@/components/practice/swing/play.module.css";
import { ChartLegend } from "@/components/workspace/ChartLegend";
import type { CrosshairPoint } from "@/lib/chart-data";
import { legendModel, type ChartSeries, type IndicatorId } from "@/lib/desk/workspace";
import { dailyBlock, type ReplayView } from "@/lib/replay/feedState";
import { levelLines, practiceMarkers, signalMarkers, stopLevel } from "@/lib/replay/marks";
import { dailyChartModel, dailyLegend, type ChartMode } from "@/lib/replay/playView";
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
  /** Swing session only (02p d2): `daily` plots the rebased daily bars and today's forming candle in place of the intraday bars. */
  swing?: { mode: ChartMode };
};

/**
 * The replay chart: `MarketChart` fed only with what the server revealed (closed bars plus the forming one), her Practice
 * marks, the would-fire bells of released signals, key levels and the practice stop. No bar is ever sliced here.
 */
export function ReplayChart(props: ReplayChartProps) {
  return props.swing?.mode === "daily" && props.view.daily !== null ? <DailyChart {...props} /> : <IntradayChart {...props} />;
}

/**
 * Swing Daily view (02p a3 rule 4): the API's rebased daily bars through the prior close plus the forming candle, her hold's
 * entry marker and stop line across the days. With dates hidden the axis prints no date and the legend names a bar "D-3"
 * or "Today" (the chart component draws no tick text for a stand-in timeline).
 */
function DailyChart({ symbol, view, hideDates, dimmed }: ReplayChartProps) {
  const [crosshair, setCrosshair] = useState<CrosshairPoint | null>(null);
  const { daily, dailyForming } = view;
  const model = useMemo(() => {
    const block = dailyBlock({ daily, dailyForming });
    return block === null ? null : dailyChartModel(block, hideDates);
  }, [daily, dailyForming, hideDates]);
  if (model === null) return null;
  const legend = dailyLegend(symbol, model, crosshair);
  return (
    <>
      <div className={styles.chartArea}>
        <MarketChart
          symbol={symbol}
          interval="1d"
          bars={model.bars}
          quality="eod"
          asOf={null}
          levels={model.levels}
          markers={model.markers}
          volume
          onCrosshair={setCrosshair}
          chrome="bare"
          height="fill"
          hideDates={hideDates}
          rowLabels={model.offsets ?? undefined}
          dimmed={dimmed}
        />
        <div className={styles.legend}><ChartLegend model={legend} /></div>
      </div>
      <p className={play.dailyNote}>{model.note}</p>
    </>
  );
}

function IntradayChart({ symbol, view, bars, series, marks, hideDates, focus, dimmed }: ReplayChartProps) {
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
