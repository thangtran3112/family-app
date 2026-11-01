/** Plain-English labels for the strategy builder's engine identifiers (V-Strategies-03). Unknown ids fall back to spaced words. */

const PARAMS: Record<string, string> = {
  name: "Name", symbols: "Symbols", watchlist: "Watchlist", filter: "Screener filter", universe: "Universe",
  session: "Session", runOn: "Run on", channels: "Alert channels", severity: "Alert severity",
  frequency: "Frequency", expiresOn: "Expires on", side: "Side", size: "Size", stop: "Stop", target: "Target",
  left: "Metric", right: "Compared with", value: "Value", pct: "Percent", start: "Start time", end: "End time",
  length: "Length", fast: "Fast length", slow: "Slow length", mid: "Mid length", signal: "Signal length",
  smoothK: "%K smoothing", smoothD: "%D smoothing", rsiLength: "RSI length", stochLength: "Stochastic length",
  lookbackDays: "Lookback (days)", conversionLength: "Conversion line length", baseLength: "Base line length",
  spanBLength: "Span B length", medianLength: "Median length", minutes: "Minutes", days: "Days",
  method: "Method", period: "Period", point: "Point", line: "Line", part: "Part",
  riskUsd: "Risk per trade ($)", shares: "Shares", pctOfBook: "% of book", contracts: "Contracts",
  atrMultiple: "ATR multiple", r: "R multiple",
  maxTradesPerDay: "Max trades per day", maxOpenPositions: "Max open positions", maxPositionUsd: "Max position size ($)",
  pauseAfterDailyLossUsd: "Pause after daily loss ($)", cooldownMinutes: "Cooldown (minutes)", flatBy: "Flat by (ET)",
};

/** When a strategy checks, in menu order: the one list every form and view reads (a screen never spells these ids itself). */
export const RUN_ONS = ["bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h", "premarket_0830", "daily_close", "weekly"] as const;
export type RunOn = (typeof RUN_ONS)[number];

const RUN_ON_LABEL: Record<RunOn, string> = {
  bar_close_1m: "Each 1m close",
  bar_close_5m: "Each 5m close",
  bar_close_15m: "Each 15m close",
  bar_close_1h: "Each 1h close",
  premarket_0830: "Premarket 8:30",
  daily_close: "Each daily close",
  weekly: "Each weekly close",
};
export const runOnLabel = (runOn: string): string => RUN_ON_LABEL[runOn as RunOn] ?? runOn;

/** The comparison operators in the order a form lists them, each worded once: the screener editor, the alert setup, the builder and the plain sentence all read this. */
export const COMPARE_OPERATORS = [
  { op: "gt", label: "is greater than" },
  { op: "gte", label: "is at least" },
  { op: "lt", label: "is less than" },
  { op: "lte", label: "is at most" },
  { op: "crosses_above", label: "crosses above" },
  { op: "crosses_below", label: "crosses below" },
  { op: "within_pct", label: "is within % of" },
] as const;
export type CompareOperator = (typeof COMPARE_OPERATORS)[number]["op"];
export const operatorLabel = (op: CompareOperator): string => COMPARE_OPERATORS.find((item) => item.op === op)!.label;

const OPTIONS: Record<string, string> = {
  ...Object.fromEntries(COMPARE_OPERATORS.map(({ op, label }) => [op, label])),
  ...RUN_ON_LABEL,
  // condition kinds
  compare: "Compare two things", time_between: "Time window", all: "All of these", any: "Any of these", not: "Not this",
  // operand kinds and universe
  series: "Indicator", level: "Price level", value: "Number", watchlist: "A watchlist", symbols: "Specific symbols",
  // series
  open: "Open", high: "High", low: "Low", close: "Close", volume: "Volume", vwap: "VWAP", gap_pct: "Gap %",
  sma: "SMA", ema: "EMA", rsi: "RSI", atr: "ATR", cci: "CCI", momentum: "Momentum", williams_r: "Williams %R",
  vwma: "VWMA", hull_ma: "Hull MA", rvol: "Relative volume", macd: "MACD", stochastic: "Stochastic",
  stoch_rsi: "Stochastic RSI", adx: "ADX", awesome_oscillator: "Awesome Oscillator", bull_bear_power: "Bull/Bear Power",
  ultimate_oscillator: "Ultimate Oscillator", ichimoku: "Ichimoku", atr_pct: "ATR %", bias: "Technical bias",
  // levels
  prior_day_high: "Prior day high", prior_day_low: "Prior day low", prior_day_close: "Prior day close",
  premarket_high: "Premarket high", premarket_low: "Premarket low", overnight_high: "Overnight high",
  overnight_low: "Overnight low", opening_range_high: "Opening range high", opening_range_low: "Opening range low",
  n_day_high: "N-day high", n_day_low: "N-day low", support: "Support", resistance: "Resistance", pivot: "Pivot point",
  // sessions, sides, severities, channels
  regular: "Regular hours", extended: "Extended hours", buy: "Buy", sell: "Sell",
  default: "Default", info: "Info", opportunity: "Opportunity", risk: "Risk",
  inbox: "Inbox", telegram: "Telegram", slack: "Slack",
  // order size, stop and target types
  riskUsd: "Risk per trade ($)", shares: "Shares", pctOfBook: "% of book", contracts: "Contracts", atrMultiple: "ATR multiple", r: "R multiple",
  // indicator lines and parts, pivot choices
  k: "%K", d: "%D", signal: "Signal", histogram: "Histogram", plus_di: "+DI", minus_di: "-DI", bull: "Bull", bear: "Bear",
  conversion: "Conversion line", base: "Base line", span_a: "Span A", span_b: "Span B",
  oscillators: "Oscillators", moving_averages: "Moving averages", summary: "Summary",
  classic: "Classic", fibonacci: "Fibonacci", camarilla: "Camarilla", session: "Session", week: "Week", month: "Month",
};

const sentence = (id: string) => id.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Label for a spec field name such as `riskUsd` or `smoothK`. */
export const paramLabel = (key: string): string => PARAMS[key] ?? sentence(key);

/** Label for a choice in a builder dropdown, such as `crosses_above` or `williams_r`. */
export const optionLabel = (id: string): string => OPTIONS[id] ?? id.replaceAll("_", " ");

const lowerFirst = (label: string) => (/^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label);

/** `subLabel("Left side", "lookbackDays")` is "Left side lookback (days)". */
export const subLabel = (parent: string, key: string): string => `${parent} ${lowerFirst(paramLabel(key))}`;

/** Version notes written by the system, shown to a trader as words. */
export const versionNote = (note: string | null | undefined): string => (note === "seeded" ? "Starter version" : (note ?? "Saved version"));
