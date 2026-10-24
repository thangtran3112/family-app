import type { BiasLabel, Technicals } from "../api/schemas.ts";
import { formatEtTime } from "./format.ts";
import { notEnoughHistoryText } from "./freshness.ts";

// Pure logic behind the technical summary (D4): gauge text and geometry, "What changed", pivots.

export const STRATEGY_GAUGE_EMPTY = "Attach a strategy to see its vote";

type Counts = { buy: number; neutral: number; sell: number };

/** "Buy 9 · Neutral 3 · Sell 2" (02l §d1 D4). */
export function countsLine(counts: Counts | null | undefined): string {
  return counts ? `Buy ${counts.buy} · Neutral ${counts.neutral} · Sell ${counts.sell}` : "Vote counts unavailable";
}

/** Half-dial needle: score -1..+1 maps to 180°..0° across the top; null score has no needle. */
export function needleGeometry(score: number | null, radius: number, cx: number, cy: number): { x2: number; y2: number; degrees: number } | null {
  if (score === null || !Number.isFinite(score)) return null;
  const clamped = Math.max(-1, Math.min(1, score));
  const degrees = 180 - ((clamped + 1) / 2) * 180;
  const radians = (degrees * Math.PI) / 180;
  return { x2: cx + radius * Math.cos(radians), y2: cy - radius * Math.sin(radians), degrees };
}

export function formatScore(score: number | null): string {
  return score === null || !Number.isFinite(score) ? "—" : `${score > 0 ? "+" : score < 0 ? "−" : ""}${Math.abs(score).toFixed(2)}`;
}

/** The accessible name of a gauge: label and counts, never colour alone (02m §c3). */
export function gaugeAriaLabel(title: string, label: BiasLabel | "Unavailable", score: number | null, counts: Counts | null | undefined): string {
  return `${title}: ${label}, score ${formatScore(score)}. ${countsLine(counts)}`;
}

/** The one-line verdict under the Summary gauge in the rail: "Sell on 15m". */
export function verdictText(label: BiasLabel, timeframe: string): string {
  return label === "warming up" ? `Warming up on ${timeframe}` : `${label} on ${timeframe}`;
}

/** "Moved from Neutral to Buy at 1:45 PM"; no change in the last 20 bars says so. */
export function whatChangedText(technicals: Pick<Technicals, "bias_history" | "bias_ready">): string {
  const change = technicals.bias_history?.last_change_in_window;
  if (!technicals.bias_ready) return "Bias is still warming up";
  if (!change) return "No change in the last 20 bars";
  return `Moved from ${change.from} to ${change.to} at ${formatEtTime(change.at_bar)}`;
}

export function historyBanner(technicals: Pick<Technicals, "bias_ready">, timeframe: string): string | null {
  return technicals.bias_ready ? null : notEnoughHistoryText(timeframe);
}

export const PIVOT_METHODS = ["classic", "fibonacci", "camarilla"] as const;
export type PivotMethod = (typeof PIVOT_METHODS)[number];
const PIVOT_POINTS = ["S3", "S2", "S1", "P", "R1", "R2", "R3"] as const;

export type PivotRow = { point: (typeof PIVOT_POINTS)[number]; classic: number | null; fibonacci: number | null; camarilla: number | null };

/** Rows S3..R3 with one column per method; a missing point reads as null. */
export function pivotRows(pivots: Technicals["pivots"]): PivotRow[] {
  return PIVOT_POINTS.map((point) => ({
    point,
    classic: pivots.classic[point] ?? null,
    fibonacci: pivots.fibonacci[point] ?? null,
    camarilla: pivots.camarilla[point] ?? null,
  }));
}
