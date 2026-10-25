"use client";

import { useMemo } from "react";
import { MarketChart, type MarketChartPane } from "@/components/charts/MarketChart";
import { buildChartSeries, type IndicatorId } from "@/lib/desk/workspace";
import { levelLines, pnlValues, practiceMarkers, signalMarkers, windowIndex } from "@/lib/replay/marks";
import type { ReplayFeed, ReplaySession } from "@/lib/replay/schemas";
import { chartBars, viewFromFeed } from "@/lib/replay/feedState";

const INDICATORS: ReadonlySet<IndicatorId> = new Set<IndicatorId>(["vwap", "ema9", "ema21", "volume"]);
const AMBER = "#FFB020";

/**
 * The session's whole window with her marks, the would-fire bells and a `Practice P/L` pane. Indicators are computed over
 * the lookback plus the window, then the chart starts at the window start. After `end` the feed covers the whole day;
 * while a session is still open it holds only what is revealed, so nothing is unsealed early.
 */
export function JournalChart({ session, feed, hideDates }: { session: ReplaySession; feed: ReplayFeed; hideDates: boolean }) {
  const model = useMemo(() => {
    const view = viewFromFeed(feed, session.spec.interval);
    const all = chartBars(view);
    const from = windowIndex(all, feed.window_start ?? session.window_start);
    const series = buildChartSeries(all, INDICATORS, view.interval);
    const bars = all.slice(from);
    const pnl: MarketChartPane = {
      id: "pnl",
      label: "Practice P/L",
      height: 120,
      references: [{ value: 0, label: "0" }],
      series: [{ id: "pnl-line", label: "Practice P/L", color: AMBER, kind: "line", values: pnlValues(bars, session.journal.pnl_series) }],
    };
    return {
      view,
      bars,
      overlays: series.overlays.map((overlay) => ({ ...overlay, values: overlay.values.slice(from) })),
      markers: [...practiceMarkers(session.marks, bars), ...signalMarkers(view.signals, bars)],
      // No closed trade, no line: an empty pane would only take height from the chart.
      panes: session.journal.pnl_series.length > 0 ? [pnl] : [],
      levels: levelLines(view.levels),
    };
  }, [feed, session]);

  return (
    <MarketChart
      symbol={session.spec.symbol}
      interval={model.view.interval}
      bars={model.bars}
      quality="delayed-15m"
      asOf={session.window_end}
      overlays={model.overlays}
      panes={model.panes}
      clockTicks
      levels={model.levels}
      markers={model.markers}
      volume
      hideDates={hideDates}
      chrome="bare"
      height={440}
    />
  );
}
