"use client";

import { useMemo, useState } from "react";
import { MarketChart } from "@/components/charts/MarketChart";
import { ChartLegend } from "@/components/workspace/ChartLegend";
import type { ChartMarkerInput, CrosshairPoint } from "@/lib/chart-data";
import { legendModel, type ChartSeries, type IndicatorId } from "@/lib/desk/workspace";
import type { ReplayView } from "@/lib/replay/feedState";
import { chartLevels, declutterMarkers, firstDrawBars, positionLevel, signalMarkers, stopLevel } from "@/lib/replay/marks";
import { visibleOverlays, type ChartPrefs, type PrefId } from "@/lib/replay/chartPrefs";
import type { ReplayBar } from "@/lib/replay/schemas";
import type { TicketSide, TimeInForce } from "@/lib/replay/ticket";
import { firstBarFrom, ms } from "@/lib/replay/time";
import { ChartOrder } from "./ChartOrder";
import styles from "./replay.module.css";

// Practice charts show the thread's price, VWAP and the two EMAs with volume. RSI and MACD stay on the live workspace.
export const REPLAY_INDICATORS: ReadonlySet<IndicatorId> = new Set<IndicatorId>(["vwap", "ema9", "ema21", "volume"]);

/** One empty list for every bar: a chart with no markers is handed the same array, so a new bar does not look like a change of markers (D-217). */
const NO_MARKERS: ChartMarkerInput[] = [];

export type ReplayChartProps = {
  symbol: string;
  view: ReplayView;
  /** The displayed bars and the series computed from them (the header reads VWAP from the same series). */
  bars: ReplayBar[];
  series: ChartSeries;
  focus: { time: string; at: number } | null;
  dimmed?: boolean;
  /** What she chose to see (design-replay-chart §b): the series type, the lines and the levels. */
  prefs: ChartPrefs;
  /** A click on an overlay in the legend hides or shows it. */
  onTogglePref: (id: PrefId) => void;
  /** Click-to-order: the ticket's quantity and time in force, and the way an order goes in. Absent while she cannot order (the thread is closed, or the name is behind the thread clock). */
  order?: { shares: string; tif: TimeInForce; place: (side: TicketSide, price: number) => Promise<boolean>; error: string | null };
};

/**
 * The replay chart: `MarketChart` fed only with what the server revealed (closed bars plus the forming one), the would-fire
 * bells of released signals, key levels, and her position and stop as price lines. It draws no entry or exit arrows and no
 * "Practice" wording: it reads as a broker's chart (the Marks list and the journal keep the labelled marks). A level is only its
 * number on the axis, with its name on hover. A click on a price offers Buy and Sell there. No bar is ever sliced here: the bars of every
 * session the thread's time has crossed are drawn in one series, and the library's own tick marks name the date where a day changes.
 */
export function ReplayChart(props: ReplayChartProps) {
  return <IntradayChart {...props} />;
}

function IntradayChart({ symbol, view, bars, series, focus, dimmed, prefs, onTogglePref, order }: ReplayChartProps) {
  const [crosshair, setCrosshair] = useState<CrosshairPoint | null>(null);
  // Only the replayed signals are marked: her entries and exits are not drawn on the chart. Their labels that would print over each other lose their text; the shapes stay (D-099).
  const markers = useMemo(() => {
    const placed = signalMarkers(view.signals, bars);
    return placed.length === 0 ? NO_MARKERS : declutterMarkers(placed, bars);
  }, [bars, view.signals]);
  // Her toggles filter the key levels; her position and stop are her own lines, not a preference, so they always show.
  const levels = useMemo(() => [...chartLevels(view.levels, prefs), ...positionLevel(view.openTrade), ...stopLevel(view.openTrade)], [view.levels, view.openTrade, prefs]);
  const last = view.last?.price ?? null;
  // The legend names VWAP and the EMAs. The chart's own series tags ("EMA 9") would sit over the newest bars, where a practice
  // marker lands, so they are left off the chart (D-028). Every overlay is still computed (the header reads VWAP from `series`);
  // only the visible ones go to the chart, and the legend keeps the hidden ones listed so a click turns them back on.
  const untagged = useMemo(() => visibleOverlays(series.overlays, prefs).map((overlay) => ({ ...overlay, label: "" })), [series.overlays, prefs]);
  const hidden = new Set(series.overlays.filter((overlay) => prefs.on[overlay.id as PrefId] === false).map((overlay) => overlay.id));
  const legend = legendModel(symbol, view.interval, bars, series.overlays, crosshair, hidden);
  // The bars before the replay window are lookback for the lines. The first view opens on the window's first bar, so a 15m axis reads 9:30 to 4:00, not 5:00 AM (D-099).
  const sessionStart = useMemo(() => {
    if (view.windowStart === null) return undefined;
    return firstBarFrom(bars, ms(view.windowStart));
  }, [bars, view.windowStart]);

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
        levelTips
        renderPick={order && last !== null ? (price, close) => <ChartOrder symbol={symbol} price={price} last={last} shares={order.shares} tif={order.tif} onPlace={order.place} error={order.error} onClose={close} /> : undefined}
        chartType={prefs.type}
        markers={markers}
        volume={series.volume && prefs.on.volume}
        sessionShading={bars.some((bar) => bar.ext)}
        onCrosshair={setCrosshair}
        chrome="bare"
        height="fill"
        follow
        firstDraw={firstDrawBars(view.interval)}
        sessionStart={sessionStart}
        focus={focus}
        dimmed={dimmed}
      />
    </div>
  );
}
