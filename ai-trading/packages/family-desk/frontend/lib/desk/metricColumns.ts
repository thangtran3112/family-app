import type { HoldingRow, Rating } from "../api/fundamentalSchemas.ts";
import { METRIC_KEYS, type MetricKey } from "../settings/fundamental.ts";
import { changeTone, EMPTY_VALUE, formatEtDay, formatNumber, formatPct, formatSignedPct, type Tone } from "./format.ts";
import { formatUsdPrice, maskedQuantity } from "./mask.ts";

// The Columns menu and the Fundamentals table (02n §c4): one label and one display kind per metric key, numbers or null.
type Fundamentals = HoldingRow["fundamentals"];
export type MetricKind = "number" | "pct" | "pct_signed" | "price" | "date" | "rating" | "count";
export const METRIC_META: Record<MetricKey, { label: string; kind: MetricKind }> = {
  fwd_pe: { label: "Fwd P/E", kind: "number" },
  pe_vs_5y_median_pct: { label: "P/E vs 5y", kind: "pct_signed" },
  fcf_yield_pct: { label: "FCF yield", kind: "pct" },
  revenue_growth_yoy_pct: { label: "Rev growth", kind: "pct_signed" },
  debt_to_equity: { label: "Debt/equity", kind: "number" },
  eps_rev_7d_pct: { label: "EPS rev 7d", kind: "pct_signed" },
  eps_rev_30d_pct: { label: "EPS rev 30d", kind: "pct_signed" },
  eps_rev_90d_pct: { label: "EPS rev 90d", kind: "pct_signed" },
  next_earnings: { label: "Earnings", kind: "date" },
  dividend_yield_pct: { label: "Div yield", kind: "pct" },
  ex_dividend: { label: "Ex-dividend", kind: "date" },
  ai_rating: { label: "AI rating", kind: "rating" },
  ai_target_base: { label: "AI target", kind: "price" },
  ai_upside_pct: { label: "AI upside", kind: "pct_signed" },
  dist_to_252d_high_pct: { label: "vs 52w high", kind: "pct_signed" },
  weight_pct: { label: "Weight", kind: "pct" },
  gain_vs_cost_pct: { label: "Gain vs cost", kind: "pct_signed" },
  cc_coverable: { label: "Coverable", kind: "count" },
};

export const metricLabel = (key: MetricKey): string => METRIC_META[key].label;
export const ALL_METRICS: readonly MetricKey[] = METRIC_KEYS;

export type MetricCell = { text: string; tone: Tone | null; rating: Rating | null };

/** One cell of the Fundamentals table. A missing value is a dash; a contract count hides while values are hidden. */
export function metricCell(key: MetricKey, fundamentals: Fundamentals, masked: boolean): MetricCell {
  const value = fundamentals[key];
  const plain = (text: string): MetricCell => ({ text, tone: null, rating: null });
  if (value === null || value === undefined) return plain(EMPTY_VALUE);
  switch (METRIC_META[key].kind) {
    case "rating":
      return { text: String(value), tone: null, rating: value as Rating };
    case "date":
      return plain(typeof value === "string" ? formatEtDay(value) : EMPTY_VALUE);
    case "number":
      return plain(typeof value === "number" ? formatNumber(value, 1) : EMPTY_VALUE);
    case "pct":
      return plain(typeof value === "number" ? formatPct(value, 1) : EMPTY_VALUE);
    case "pct_signed":
      return typeof value === "number" ? { text: formatSignedPct(value, 1), tone: changeTone(value), rating: null } : plain(EMPTY_VALUE);
    case "price":
      return plain(typeof value === "number" ? formatUsdPrice(value) : EMPTY_VALUE);
    case "count":
      return plain(typeof value === "number" ? maskedQuantity(masked, value) : EMPTY_VALUE);
  }
}
