import type { SettingsRecord } from "./schema.ts";

// The Fundamental lane's settings keys (02n §c3 #19). `PUT /settings` replaces the whole record, so each writer returns
// a new record that starts from the saved one. The backend (`fundamental/settings.py`) is the authority on bounds;
// `coveredCallProblems` mirrors them so a field can say what is wrong before the save, and the screen still shows the
// server's own problems when it answers 422.

/** The metric keys a holdings row, a `long_term` watchlist row and the `Columns` menu share (02n §c4). */
export const METRIC_KEYS = [
  "fwd_pe", "pe_vs_5y_median_pct", "fcf_yield_pct", "revenue_growth_yoy_pct", "debt_to_equity", "eps_rev_7d_pct",
  "eps_rev_30d_pct", "eps_rev_90d_pct", "next_earnings", "dividend_yield_pct", "ex_dividend", "ai_rating", "ai_target_base",
  "ai_upside_pct", "dist_to_252d_high_pct", "weight_pct", "gain_vs_cost_pct", "cc_coverable",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export const DEFAULT_COLUMNS: readonly MetricKey[] = ["fwd_pe", "pe_vs_5y_median_pct", "fcf_yield_pct", "eps_rev_30d_pct", "next_earnings", "cc_coverable"];
export const MAX_COLUMNS = 8;

const isMetricKey = (value: unknown): value is MetricKey => typeof value === "string" && (METRIC_KEYS as readonly string[]).includes(value);

/** The saved columns, or the defaults when the key is missing or holds anything the backend would reject. */
export function readFundamentalColumns(settings: SettingsRecord): MetricKey[] {
  const stored = settings.fundamental_columns;
  if (!Array.isArray(stored) || stored.length > MAX_COLUMNS || !stored.every(isMetricKey) || new Set(stored).size !== stored.length) return [...DEFAULT_COLUMNS];
  return [...stored];
}

export const withFundamentalColumns = (settings: SettingsRecord, columns: readonly MetricKey[]): SettingsRecord => ({ ...settings, fundamental_columns: [...columns] });

/** The cover-scan filters (02 §6.3 engine defaults, plus the 50% cover cap). */
export type CoveredCallSettings = {
  min_dte: number;
  max_dte: number;
  min_delta: number;
  max_delta: number;
  min_open_interest: number;
  max_spread_pct: number;
  min_bid: number;
  cap_pct: number;
};
export const COVERED_CALL_DEFAULTS: CoveredCallSettings = { min_dte: 21, max_dte: 45, min_delta: 0.15, max_delta: 0.3, min_open_interest: 100, max_spread_pct: 10, min_bid: 0.1, cap_pct: 50 };
export const COVERED_CALL_KEYS = Object.keys(COVERED_CALL_DEFAULTS) as Array<keyof CoveredCallSettings>;

/** [lowest, highest, whole number]: the engine's sane bounds, as the backend enforces them. */
export const COVERED_CALL_BOUNDS: Record<keyof CoveredCallSettings, readonly [number, number, boolean]> = {
  min_dte: [1, 365, true],
  max_dte: [1, 365, true],
  min_delta: [0.01, 0.99, false],
  max_delta: [0.01, 0.99, false],
  min_open_interest: [0, 1_000_000, true],
  max_spread_pct: [0, 100, false],
  min_bid: [0, 100, false],
  cap_pct: [1, 100, false],
};

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Stored values over the defaults; a stored value that is not a number is ignored. */
export function readCoveredCallSettings(settings: SettingsRecord): CoveredCallSettings {
  const stored = typeof settings.covered_calls === "object" && settings.covered_calls !== null ? (settings.covered_calls as Record<string, unknown>) : {};
  const merged = { ...COVERED_CALL_DEFAULTS };
  for (const key of COVERED_CALL_KEYS) {
    const value = stored[key];
    if (isNumber(value)) merged[key] = value;
  }
  return merged;
}

export type FieldProblems = Partial<Record<keyof CoveredCallSettings, string>>;

/** One message per field that is out of bounds, not whole where it must be, or on the wrong side of its pair. */
export function coveredCallProblems(values: Record<keyof CoveredCallSettings, number | null>): FieldProblems {
  const problems: FieldProblems = {};
  for (const key of COVERED_CALL_KEYS) {
    const value = values[key];
    const [low, high, whole] = COVERED_CALL_BOUNDS[key];
    if (value === null || !Number.isFinite(value)) problems[key] = "Enter a number";
    else if (whole && !Number.isInteger(value)) problems[key] = "Enter a whole number";
    else if (value < low || value > high) problems[key] = `Must be between ${low} and ${high}`;
  }
  const pair = (low: keyof CoveredCallSettings, high: keyof CoveredCallSettings) => {
    const a = values[low];
    const b = values[high];
    if (!problems[high] && a !== null && b !== null && a > b) problems[high] = `Must not be below ${a}`;
  };
  pair("min_dte", "max_dte");
  pair("min_delta", "max_delta");
  return problems;
}

export const withCoveredCallSettings = (settings: SettingsRecord, values: CoveredCallSettings): SettingsRecord => ({ ...settings, covered_calls: { ...values } });
