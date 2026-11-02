import type { Tone } from "../../components/ui/tone.ts";
import { currentValue, type ChartBar } from "../chart-data.ts";
import { formatNumber, formatPrice } from "../desk/format.ts";
import { PRACTICE_COPY } from "../desk/freshness.ts";
import { buildChartSeries, type IndicatorId } from "../desk/workspace.ts";
import type { SessionVwap } from "./sessionVwap.ts";

// The Practice replay's left rail (owner, 2026-11-01): the popular indicators, read off the bars the server has revealed so far.
// They come from `buildChartSeries`, the same functions that draw the live workspace's lines and panes, so a value here is the
// number on a live chart. Nothing is read from the live Technicals endpoint: that describes today's market, not the replayed day.

const SET: ReadonlySet<IndicatorId> = new Set<IndicatorId>(["vwap", "ema9", "ema21", "rsi", "macd"]);

export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;

export type IndicatorRow = {
  id: string;
  name: string;
  value: string;
  /** One word that says what the value means ("Above", "Bullish", "Overbought"); empty when the value alone is the answer. */
  state: string;
  tone: Tone;
};
export type IndicatorGroup = { id: "momentum" | "trend"; title: string; rows: IndicatorRow[] };

const WARMING = "Warming up";
const MINUS = "−";

const signed = (value: number | null, digits = 2): string => {
  if (value === null) return "—";
  const fixed = Math.abs(value).toFixed(digits);
  return Number(fixed) === 0 ? fixed : `${value > 0 ? "+" : MINUS}${fixed}`;
};
const signTone = (value: number | null): Tone => (value === null || value === 0 ? "neutral" : value > 0 ? "up" : "down");

/** RSI reads as a state at the usual 70 / 30 lines; between them it names no side. */
export function rsiState(value: number | null): Pick<IndicatorRow, "state" | "tone"> {
  if (value === null) return { state: WARMING, tone: "neutral" };
  if (value >= RSI_OVERBOUGHT) return { state: "Overbought", tone: "warn" };
  if (value <= RSI_OVERSOLD) return { state: "Oversold", tone: "warn" };
  return { state: "Neutral", tone: "neutral" };
}

/** A line the price can sit above or below (VWAP, an EMA). */
function lineState(line: number | null, price: number | null): Pick<IndicatorRow, "state" | "tone"> {
  if (line === null || price === null) return { state: WARMING, tone: "neutral" };
  if (price > line) return { state: "Price above", tone: "up" };
  if (price < line) return { state: "Price below", tone: "down" };
  return { state: "Price at", tone: "neutral" };
}

/** VWAP's row: its value and state, or the words for why there is no value when the one-minute bars are not there (D-168). */
function vwapRow(row: IndicatorRow, vwap: SessionVwap | undefined): IndicatorRow {
  if (vwap === undefined || vwap.status === "ready") return row;
  return { ...row, state: vwap.status === "loading" ? PRACTICE_COPY.vwapLoading : PRACTICE_COPY.vwapNoMinutes, tone: "neutral" };
}

/**
 * RSI (14) and MACD (12, 26, 9) first, then VWAP and the two EMAs against the last price. VWAP is intraday only, so the daily view
 * (`interval` "1d") leaves it out. A value that has not warmed up yet reads "—" and says so; nothing is filled in. `vwap` is the session VWAP
 * built from one-minute bars (`sessionVwap`, D-168): VWAP then never depends on the chart's interval, and when no one-minute bars could be read the
 * row says that in words instead of "Warming up".
 */
export function indicatorGroups(bars: readonly ChartBar[], interval: string, vwap?: SessionVwap): IndicatorGroup[] {
  const series = buildChartSeries(bars.map((bar) => ({ ...bar, v: bar.v ?? null, ext: bar.ext ?? false })), SET, interval, "stock", vwap?.values);
  const price = bars.at(-1)?.c ?? null;
  const overlay = (id: string) => currentValue(series.overlays.find((item) => item.id === id)?.values ?? []);
  const pane = (paneId: string, seriesId: string) => currentValue(series.panes.find((item) => item.id === paneId)?.series.find((item) => item.id === seriesId)?.values ?? []);

  const rsi = pane("rsi", "rsi-line");
  const macd = pane("macd", "macd-line");
  const signal = pane("macd", "macd-signal");
  const histogram = pane("macd", "macd-histogram");
  const macdState: Pick<IndicatorRow, "state" | "tone"> =
    macd === null || signal === null ? { state: WARMING, tone: "neutral" } : macd > signal ? { state: "Bullish", tone: "up" } : macd < signal ? { state: "Bearish", tone: "down" } : { state: "Flat", tone: "neutral" };

  const line = (id: string, name: string, value: number | null): IndicatorRow => ({ id, name, value: formatPrice(value), ...lineState(value, price) });

  const trend: IndicatorRow[] = [
    ...(series.overlays.some((item) => item.id === "vwap") ? [vwapRow(line("vwap", "VWAP", overlay("vwap")), vwap)] : []),
    line("ema9", "EMA 9", overlay("ema9")),
    line("ema21", "EMA 21", overlay("ema21")),
  ];
  return [
    {
      id: "momentum",
      title: "Momentum",
      rows: [
        { id: "rsi", name: "RSI (14)", value: formatNumber(rsi, 1), ...rsiState(rsi) },
        { id: "macd", name: "MACD (12, 26, 9)", value: signed(macd), ...macdState },
        { id: "macd-signal", name: "Signal", value: signed(signal), state: "", tone: "neutral" },
        { id: "macd-histogram", name: "Histogram", value: signed(histogram), state: "", tone: signTone(histogram) },
      ],
    },
    { id: "trend", title: "Trend", rows: trend },
  ];
}
