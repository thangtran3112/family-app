// Timeframe switchers for the chart (1m..1W) and the technical summary (5m..1W). `label` is what the
// switcher shows, `api` what the endpoints take (02m §a3.3).
export type TimeframeOption = { label: string; api: string };

export const CHART_TIMEFRAMES: readonly TimeframeOption[] = [
  { label: "1m", api: "1m" },
  { label: "5m", api: "5m" },
  { label: "15m", api: "15m" },
  { label: "1h", api: "1h" },
  { label: "4h", api: "4h" },
  { label: "1D", api: "1d" },
  { label: "1W", api: "1w" },
];

export const SUMMARY_TIMEFRAMES: readonly TimeframeOption[] = [
  { label: "5m", api: "5m" },
  { label: "15m", api: "15m" },
  { label: "30m", api: "30m" },
  { label: "1h", api: "1h" },
  { label: "4h", api: "4h" },
  { label: "1D", api: "1d" },
  { label: "1W", api: "1w" },
];

/** Accepts a label or an API value in any case ("1D", "1d"); falls back to `fallback` (15m by default). */
export function timeframeFromQuery(value: string | null, options: readonly TimeframeOption[], fallback = "15m"): TimeframeOption {
  const wanted = value?.trim().toLowerCase();
  return (
    options.find((option) => option.label.toLowerCase() === wanted || option.api === wanted) ??
    options.find((option) => option.api === fallback) ??
    options[0]!
  );
}

export const timeframeLabel = (api: string): string => CHART_TIMEFRAMES.find((option) => option.api === api)?.label ?? SUMMARY_TIMEFRAMES.find((option) => option.api === api)?.label ?? api;

export const isIntraday = (api: string): boolean => api !== "1d" && api !== "1w";

// How many calendar days of bars the chart asks for at each timeframe.
const CHART_DAYS: Record<string, number> = { "1m": 2, "5m": 5, "15m": 20, "30m": 30, "1h": 60, "4h": 180, "1d": 365, "1w": 1825 };
export const chartDays = (api: string): number => CHART_DAYS[api] ?? 30;

/** Calendar days of daily bars behind the symbol header's day change: two sessions across a long weekend. */
export const HEADER_DAYS = 10;
