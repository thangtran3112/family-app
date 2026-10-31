import type { Tone } from "../../components/ui/tone.ts";
import type { MarketChartLevel, MarketChartOverlay, MarketChartPane } from "../../components/charts/MarketChart.tsx";
import { AlertStrategySpecV1Schema } from "@ai-trading/contracts/alert-strategy";
import type { Condition, Operand } from "@ai-trading/contracts";
import type { AlertStrategy, Bars, BiasLabel, Technicals } from "../api/schemas.ts";
import { currentValue, type CrosshairPoint } from "../chart-data.ts";
import { calcEMAWithGaps, calcMACDWithGaps, calcMAWithGaps, calcRSIWithGaps, calcVWAPWithGaps } from "../indicators-with-gaps.ts";
import { formatPrice, formatSignedPct } from "./format.ts";
import { isIntraday } from "./timeframes.ts";

// Pure logic behind the chart workspace (D3): which series the Indicators menu shows, their colours and
// styles (02l §b5, no new colours), key levels, alert levels, and the legend text.

const TEXT = "#F2F2F4";
const MUTED = "#9B9BA1";
const AMBER = "#FFB020";
const UP = "#30D158";
const DOWN = "#FF453A";

/** How the three replay overlays look (the chart and the settings swatches both read it): colour, and EMA 21 dashed. */
export const OVERLAY_LOOK = {
  vwap: { color: AMBER },
  ema9: { color: TEXT },
  ema21: { color: MUTED, style: "dashed" as const },
};

export type IndicatorId = "vwap" | "ema9" | "ema21" | "sma50" | "sma200" | "volume" | "rsi" | "macd";
export type IndicatorOption = { id: IndicatorId; label: string; group: "Overlays" | "Panes"; defaultOn: boolean };

export const INDICATOR_OPTIONS: readonly IndicatorOption[] = [
  { id: "vwap", label: "VWAP", group: "Overlays", defaultOn: true },
  { id: "ema9", label: "EMA 9", group: "Overlays", defaultOn: true },
  { id: "ema21", label: "EMA 21", group: "Overlays", defaultOn: true },
  { id: "sma50", label: "SMA 50", group: "Overlays", defaultOn: false },
  { id: "sma200", label: "SMA 200", group: "Overlays", defaultOn: false },
  { id: "volume", label: "Volume", group: "Panes", defaultOn: true },
  { id: "rsi", label: "RSI (14)", group: "Panes", defaultOn: true },
  { id: "macd", label: "MACD (12, 26, 9)", group: "Panes", defaultOn: true },
];

export const defaultIndicators = (): ReadonlySet<IndicatorId> =>
  new Set(INDICATOR_OPTIONS.filter((option) => option.defaultOn).map((option) => option.id));

export function toggleIndicator(current: ReadonlySet<IndicatorId>, id: IndicatorId): ReadonlySet<IndicatorId> {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
}

export type ChartSeries = { overlays: MarketChartOverlay[]; panes: MarketChartPane[]; volume: boolean };

/** Series computed in the browser from the bars (02m §f decision 5). VWAP is intraday only. */
export function buildChartSeries(bars: Bars["bars"], indicators: ReadonlySet<IndicatorId>, apiInterval: string): ChartSeries {
  const closes = bars.map((bar) => bar.c);
  const overlays: MarketChartOverlay[] = [];
  if (indicators.has("vwap") && isIntraday(apiInterval)) {
    overlays.push({ id: "vwap", label: "VWAP", ...OVERLAY_LOOK.vwap, values: calcVWAPWithGaps(bars) });
  }
  if (indicators.has("ema9")) overlays.push({ id: "ema9", label: "EMA 9", ...OVERLAY_LOOK.ema9, values: calcEMAWithGaps(closes, 9) });
  if (indicators.has("ema21")) overlays.push({ id: "ema21", label: "EMA 21", ...OVERLAY_LOOK.ema21, values: calcEMAWithGaps(closes, 21) });
  if (indicators.has("sma50")) overlays.push({ id: "sma50", label: "SMA 50", color: TEXT, style: "dashed", values: calcMAWithGaps(closes, 50) });
  if (indicators.has("sma200")) overlays.push({ id: "sma200", label: "SMA 200", color: MUTED, values: calcMAWithGaps(closes, 200) });

  const panes: MarketChartPane[] = [];
  if (indicators.has("rsi")) {
    panes.push({
      id: "rsi",
      label: "RSI (14)",
      height: 120,
      references: [{ value: 70, label: "70" }, { value: 30, label: "30" }],
      series: [{ id: "rsi-line", label: "RSI (14)", color: TEXT, kind: "line", values: calcRSIWithGaps(closes, 14) }],
    });
  }
  if (indicators.has("macd")) {
    const macd = calcMACDWithGaps(closes);
    panes.push({
      id: "macd",
      label: "MACD (12, 26, 9)",
      height: 120,
      references: [{ value: 0, label: "0" }],
      series: [
        { id: "macd-histogram", label: "Histogram", color: UP, negativeColor: DOWN, kind: "histogram", values: macd.histogram },
        { id: "macd-line", label: "MACD", color: TEXT, kind: "line", values: macd.dif },
        { id: "macd-signal", label: "Signal", color: MUTED, kind: "line", values: macd.signal },
      ],
    });
  }
  return { overlays, panes, volume: indicators.has("volume") };
}

export type AlertLevel = { price: number; name: string; strategyId: number };

const PRICE_SERIES = new Set(["open", "high", "low", "close"]);
const isPriceSeries = (operand: Operand) => "series" in operand && PRICE_SERIES.has(operand.series);

function collectValueLevels(condition: Condition, found: number[]): void {
  if ("all" in condition) condition.all.forEach((item) => collectValueLevels(item, found));
  else if ("any" in condition) condition.any.forEach((item) => collectValueLevels(item, found));
  else if ("not" in condition) collectValueLevels(condition.not, found);
  else if (condition.op !== "time_between" && condition.op !== "pattern") {
    if (isPriceSeries(condition.left) && "value" in condition.right) found.push(condition.right.value);
    else if (isPriceSeries(condition.right) && "value" in condition.left) found.push(condition.left.value);
  }
}

/** Horizontal price lines for strategies that compare a price series with a fixed number (amber, dashed). */
export function alertLevels(strategies: readonly AlertStrategy[]): AlertLevel[] {
  const seen = new Set<string>();
  const levels: AlertLevel[] = [];
  for (const strategy of strategies) {
    if (strategy.status === "paused" || strategy.status === "expired") continue;
    const parsed = AlertStrategySpecV1Schema.safeParse(strategy.spec);
    if (!parsed.success) continue;
    const prices: number[] = [];
    collectValueLevels(parsed.data.when, prices);
    for (const price of prices) {
      const key = `${strategy.id}:${price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      levels.push({ price, name: strategy.name, strategyId: strategy.id });
    }
  }
  return levels;
}

const PIVOT_ORDER = ["S3", "S2", "S1", "P", "R1", "R2", "R3"] as const;
export const pivotOrder = PIVOT_ORDER;

/** Classic pivots, prior close and session high/low as dotted muted lines; alert levels amber dashed with a bell. */
export function buildLevels(technicals: Technicals | null, alerts: readonly AlertLevel[]): MarketChartLevel[] {
  const levels: MarketChartLevel[] = [];
  if (technicals) {
    for (const point of PIVOT_ORDER) {
      const price = technicals.pivots.classic[point];
      if (price !== undefined && price !== null) levels.push({ label: point, price, color: MUTED, style: "dotted" });
    }
    const { levels: key } = technicals;
    if (key) {
      levels.push({ label: "Prior close", price: key.prior_close, color: MUTED, style: "dotted" });
      levels.push({ label: "Session high", price: key.session_high, color: MUTED, style: "dotted" });
      levels.push({ label: "Session low", price: key.session_low, color: MUTED, style: "dotted" });
    }
  }
  for (const alert of alerts) levels.push({ label: `🔔 ${alert.name}`, price: alert.price, color: AMBER, style: "dashed" });
  return levels;
}

export type KeyLevel = { label: string; price: number };

/** The key-levels block in the rail and the bottom panel: highest first. */
export function keyLevelRows(technicals: Technicals | null): KeyLevel[] {
  if (!technicals) return [];
  const rows: KeyLevel[] = [];
  const add = (label: string, price: number | null | undefined) => {
    if (price !== null && price !== undefined && Number.isFinite(price)) rows.push({ label, price });
  };
  for (const point of PIVOT_ORDER) add(point === "P" ? "Pivot" : point, technicals.pivots.classic[point]);
  add("Prior close", technicals.levels?.prior_close);
  add("Session high", technicals.levels?.session_high);
  add("Session low", technicals.levels?.session_low);
  return rows.sort((a, b) => b.price - a.price);
}

export type LegendModel = {
  title: string;
  items: Array<{ id: string; label: string; color: string; value: string; style: "solid" | "dashed"; hidden: boolean }>;
};

/** `NVDA · 15m · O … H … L … C …` plus one line per overlay, at the crosshair or at the last bar (02l §b5). An overlay in `hidden` stays listed with the value "hidden" (the replay legend turns it back on). */
export function legendModel(
  symbol: string,
  timeframe: string,
  bars: Bars["bars"],
  overlays: readonly MarketChartOverlay[],
  point: CrosshairPoint | null,
  hidden: ReadonlySet<string> = new Set(),
): LegendModel {
  const last = bars.at(-1);
  const o = point ? point.open : (last?.o ?? null);
  const h = point ? point.high : (last?.h ?? null);
  const l = point ? point.low : (last?.l ?? null);
  const c = point ? point.close : (last?.c ?? null);
  return {
    title: `${symbol} · ${timeframe} · O ${formatPrice(o)} H ${formatPrice(h)} L ${formatPrice(l)} C ${formatPrice(c)}`,
    items: overlays.map((overlay) => ({
      id: overlay.id,
      label: overlay.label,
      color: overlay.color,
      value: hidden.has(overlay.id) ? "hidden" : formatPrice(point ? (point.values[overlay.id] ?? null) : currentValue(overlay.values)),
      style: overlay.style ?? "solid",
      hidden: hidden.has(overlay.id),
    })),
  };
}

export type PriceSummary = { last: number | null; change: number | null; changePct: number | null };

/** Header numbers: the live quote when there is one, else the last bar; change against the prior close. */
export function priceSummary(liveClose: number | null, bars: Bars["bars"], priorClose: number | null | undefined): PriceSummary {
  const last = liveClose ?? bars.at(-1)?.c ?? null;
  if (last === null || priorClose === null || priorClose === undefined || priorClose === 0) return { last, change: null, changePct: null };
  return { last, change: last - priorClose, changePct: ((last - priorClose) / priorClose) * 100 };
}

type QuotePrice = { close: number; as_of: string };
const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * Header numbers: always the day's move, whatever timeframe the chart shows (V-Technicals-01: a 1W chart's prior bar
 * is last week, so its "prior close" read as a week's drop). The live quote against the last daily close before the
 * quote's New York day; without a quote, the last daily close against the one before it. The chart's own bars only
 * stand in for the price while the daily bars load, never for the change.
 */
export function headerSummary(quote: QuotePrice | null, daily: Bars["bars"], chart: Bars["bars"]): PriceSummary {
  if (quote) {
    const day = etDate.format(new Date(quote.as_of));
    const prior = daily.findLast((bar) => bar.c !== null && bar.t.slice(0, 10) < day)?.c;
    return priceSummary(quote.close, [], prior);
  }
  if (daily.length > 0) return priceSummary(null, daily, daily.at(-2)?.c);
  return priceSummary(null, chart, null);
}

/** Nothing to chart or quote at all: no live quote, no daily bars, no bars for this timeframe (V-Technicals-03). */
export const noMarketData = (quote: QuotePrice | null, daily: Bars["bars"], chart: Bars["bars"]): boolean =>
  quote === null && daily.length === 0 && chart.length === 0;

export const changeText = (summary: PriceSummary): string =>
  summary.change === null ? "—" : `${summary.change > 0 ? "+" : summary.change < 0 ? "−" : ""}${formatPrice(Math.abs(summary.change))} (${formatSignedPct(summary.changePct)})`;

const SIGNAL_KIND_LABEL: Record<string, string> = {
  orb: "Opening range",
  vwap_reclaim: "VWAP reclaim",
  pattern: "Pattern",
  rvol: "Volume",
  other: "Signal",
};
export const signalKindLabel = (kind: string): string => SIGNAL_KIND_LABEL[kind] ?? "Signal";

/** Row tone for a bias label, in the components/ui/tone vocabulary. */
export const biasUiTone = (label: BiasLabel | string): Tone =>
  label === "Buy" || label === "Strong Buy" ? "up" : label === "Sell" || label === "Strong Sell" ? "down" : "neutral";

/** The legacy spelling ("flat") for modules still styling by class; each migration wave moves its callers to `biasUiTone`. */
export const biasTone = (label: BiasLabel | string): "up" | "down" | "flat" => {
  const tone = biasUiTone(label);
  return tone === "up" || tone === "down" ? tone : "flat";
};
