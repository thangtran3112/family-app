"use client";

import { useMemo, useState } from "react";
import { MarketChart } from "@/components/charts/MarketChart";
import play from "@/components/practice/swing/play.module.css";
import { ChartLegend } from "@/components/workspace/ChartLegend";
import type { CrosshairPoint } from "@/lib/chart-data";
import { legendModel, type ChartSeries, type IndicatorId } from "@/lib/desk/workspace";
import { dailyBlock, type ReplayView } from "@/lib/replay/feedState";
import { chartLevels, declutterMarkers, firstDrawBars, practiceMarkers, signalMarkers, stopLevel } from "@/lib/replay/marks";
import { visibleOverlays, type ChartPrefs, type PrefId } from "@/lib/replay/chartPrefs";
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
  /** What she chose to see (design-replay-chart §b): the series type, the lines and the levels. */
  prefs: ChartPrefs;
  /** A click on an overlay in the legend hides or shows it. */
  onTogglePref: (id: PrefId) => void;
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
function DailyChart({ symbol, view, hideDates, dimmed, prefs }: ReplayChartProps) {
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
        <ChartLegend model={legend} />
        <MarketChart
          symbol={symbol}
          interval="1d"
          bars={model.bars}
          quality="eod"
          asOf={null}
          levels={model.levels}
          chartType={prefs.type}
          markers={model.markers}
          volume
          onCrosshair={setCrosshair}
          chrome="bare"
          height="fill"
          hideDates={hideDates}
          rowLabels={model.offsets ?? undefined}
          dimmed={dimmed}
        />
      </div>
      <p className={play.dailyNote}>{model.note}</p>
    </>
  );
}

function IntradayChart({ symbol, view, bars, series, marks, hideDates, focus, dimmed, prefs, onTogglePref }: ReplayChartProps) {
  const [crosshair, setCrosshair] = useState<CrosshairPoint | null>(null);
  // Marker labels that would print over each other lose their text; the shapes stay (D-099).
  const markers = useMemo(() => declutterMarkers([...practiceMarkers(marks, bars), ...signalMarkers(view.signals, bars)], bars), [marks, bars, view.signals]);
  // Her toggles filter what is drawn; the practice stop is her risk line, not a preference, so it always shows.
  const levels = useMemo(() => [...chartLevels(view.levels, prefs), ...stopLevel(view.openTrade)], [view.levels, view.openTrade, prefs]);
  // The legend names VWAP and the EMAs. The chart's own series tags ("EMA 9") would sit over the newest bars, where a practice
  // marker lands, so they are left off the chart (D-028). Every overlay is still computed (the header reads VWAP from `series`);
  // only the visible ones go to the chart, and the legend keeps the hidden ones listed so a click turns them back on.
  const untagged = useMemo(() => visibleOverlays(series.overlays, prefs).map((overlay) => ({ ...overlay, label: "" })), [series.overlays, prefs]);
  const hidden = new Set(series.overlays.filter((overlay) => prefs.on[overlay.id as PrefId] === false).map((overlay) => overlay.id));
  const legend = legendModel(symbol, view.interval, bars, series.overlays, crosshair, hidden);

  return (
    <div className={styles.chartArea}>
      <ChartLegend model={legend} onToggle={(id) => onTogglePref(id as PrefId)} />
      <MarketChart
        symbol={symbol}
        interval={view.interval}
        bars={bars}
        quality="delayed-15m"
        asOf={view.revealedThrough}
        overlays={untagged}
        panes={series.panes}
        levels={levels}
        chartType={prefs.type}
        markers={markers}
        volume={series.volume && prefs.on.volume}
        onCrosshair={setCrosshair}
        chrome="bare"
        height="fill"
        follow
        firstDraw={firstDrawBars(view.interval)}
        hideDates={hideDates}
        focus={focus}
        dimmed={dimmed}
      />
    </div>
  );
}
