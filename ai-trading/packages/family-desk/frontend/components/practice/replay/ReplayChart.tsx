"use client";

import { useMemo, useState } from "react";
import { MarketChart } from "@/components/charts/MarketChart";
import play from "@/components/practice/swing/play.module.css";
import { ChartLegend } from "@/components/workspace/ChartLegend";
import type { CrosshairPoint } from "@/lib/chart-data";
import { legendModel, type ChartSeries, type IndicatorId } from "@/lib/desk/workspace";
import { dailyBlock, type ReplayView } from "@/lib/replay/feedState";
import { chartLevels, declutterMarkers, firstDrawBars, positionLevel, signalMarkers, stopLevel } from "@/lib/replay/marks";
import { visibleOverlays, type ChartPrefs, type PrefId } from "@/lib/replay/chartPrefs";
import { dailyChartModel, dailyLegend, type ChartMode } from "@/lib/replay/playView";
import type { ReplayBar } from "@/lib/replay/schemas";
import type { TicketSide } from "@/lib/replay/ticket";
import { ms } from "@/lib/replay/time";
import { ChartOrder } from "./ChartOrder";
import styles from "./replay.module.css";

// Practice charts show a day's price, VWAP and the two EMAs with volume. RSI and MACD stay on the live workspace.
export const REPLAY_INDICATORS: ReadonlySet<IndicatorId> = new Set<IndicatorId>(["vwap", "ema9", "ema21", "volume"]);

export type ReplayChartProps = {
  symbol: string;
  view: ReplayView;
  /** The displayed bars and the series computed from them (the header reads VWAP from the same series). */
  bars: ReplayBar[];
  series: ChartSeries;
  hideDates: boolean;
  focus: { time: string; at: number } | null;
  dimmed?: boolean;
  /** What she chose to see (design-replay-chart §b): the series type, the lines and the levels. */
  prefs: ChartPrefs;
  /** A click on an overlay in the legend hides or shows it. */
  onTogglePref: (id: PrefId) => void;
  /** Swing session only (02p d2): `daily` plots the rebased daily bars and today's forming candle in place of the intraday bars. */
  swing?: { mode: ChartMode };
  /** Click-to-order on the intraday chart: the ticket's quantity and the way an order goes in. Absent while she cannot order (the session ended, or the name is behind the day clock). */
  order?: { shares: string; place: (side: TicketSide, price: number) => Promise<boolean> };
};

/**
 * The replay chart: `MarketChart` fed only with what the server revealed (closed bars plus the forming one), the would-fire
 * bells of released signals, key levels, and her position and stop as price lines. It draws no entry or exit arrows and no
 * "Practice" wording: it reads as a broker's chart (the Marks list and the journal keep the labelled marks). A level is only its
 * number on the axis, with its name on hover. A click on a price offers Buy and Sell there. No bar is ever sliced here.
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
          levelTips
          chartType={prefs.type}
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

function IntradayChart({ symbol, view, bars, series, hideDates, focus, dimmed, prefs, onTogglePref, order }: ReplayChartProps) {
  const [crosshair, setCrosshair] = useState<CrosshairPoint | null>(null);
  // Only the replayed signals are marked: her entries and exits are not drawn on the chart. Their labels that would print over each other lose their text; the shapes stay (D-099).
  const markers = useMemo(() => declutterMarkers(signalMarkers(view.signals, bars), bars), [bars, view.signals]);
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
    const open = ms(view.windowStart);
    const first = bars.findIndex((bar) => ms(bar.t) >= open);
    return first < 0 ? bars.length : first;
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
        renderPick={order && last !== null ? (price, close) => <ChartOrder symbol={symbol} price={price} last={last} shares={order.shares} onPlace={order.place} onClose={close} /> : undefined}
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
        hideDates={hideDates}
        focus={focus}
        dimmed={dimmed}
      />
    </div>
  );
}
