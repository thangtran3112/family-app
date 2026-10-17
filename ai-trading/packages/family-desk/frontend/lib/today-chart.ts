import type { z } from "zod";
import type { ChartBar } from "./chart-data.ts";
import { calcEMAWithGaps } from "./indicators-with-gaps.ts";
import { calcMA } from "./indicators.ts";
import { BarsSchema } from "./api/schemas.ts";
import { marketDataPath, marketSymbol, type AssetType } from "./today.ts";

export const TODAY_CHART_INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
export type TodayChartInterval = (typeof TODAY_CHART_INTERVALS)[number];
export type TodayChartSelection = { symbol: string; asset_type: AssetType; interval: TodayChartInterval };
export type TodayChartOverlay = { id: string; label: string; color: string; values: Array<number | null> };

type SourceChartBar = { t: string; o: number | null; h: number | null; l: number | null; c: number | null };
type BarsResponse = z.infer<typeof BarsSchema>;

export function firstChartSelection(items: readonly { symbol: string; asset_type: string }[]): Omit<TodayChartSelection, "interval"> | null {
  const item = items.find(({ asset_type }) => asset_type === "stock" || asset_type === "future");
  return item && (item.asset_type === "stock" || item.asset_type === "future")
    ? { symbol: item.symbol, asset_type: item.asset_type }
    : null;
}

export function chartContextKey(selection: TodayChartSelection): string {
  return `${marketSymbol(selection.symbol, selection.asset_type)}\u001f${selection.interval}`;
}

export function chartSnapshotFor<T>(
  snapshot: { context: string; value: T } | null,
  selection: TodayChartSelection,
): T | null {
  return snapshot?.context === chartContextKey(selection) ? snapshot.value : null;
}

export function chartBarsPath(selection: TodayChartSelection): string {
  return `${marketDataPath("/api/desk/bars", selection.symbol, selection.asset_type)}?interval=${selection.interval}&days=90`;
}

export function chartResponseMatchesSelection(response: BarsResponse, selection: TodayChartSelection): boolean {
  return response.symbol === marketSymbol(selection.symbol, selection.asset_type) && response.interval === selection.interval;
}

export function chartBarsFromResponse(bars: readonly SourceChartBar[]): ChartBar[] {
  return bars.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
}

export function chartOverlays(bars: readonly ChartBar[]): TodayChartOverlay[] {
  const closes = bars.map(({ c }) => c);
  const sma = calcMA(closes.map((value) => value ?? Number.NaN), 20)
    .map((value) => value !== null && Number.isFinite(value) ? value : null);
  return [
    { id: "sma20", label: "SMA 20", color: "#FFB020", values: sma },
    { id: "ema20", label: "EMA 20", color: "#A78BFA", values: calcEMAWithGaps(closes, 20) },
  ];
}

export function chartPresentation(response: BarsResponse) {
  const bars = chartBarsFromResponse(response.bars);
  return {
    bars,
    quality: response.quality,
    asOf: response.as_of,
    overlays: chartOverlays(bars).filter((overlay) => overlay.values.some((value) => value !== null)),
  };
}
