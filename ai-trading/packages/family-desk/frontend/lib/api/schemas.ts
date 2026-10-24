import { z } from "zod";
import type { components } from "./openapi.js";

const finiteNumber = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const utcTimestamp = timestamp.refine((value) => value.endsWith("Z") || value.endsWith("+00:00"));
const dateOrTimestamp = z.union([z.iso.date(), utcTimestamp]);
const jsonObject = z.record(z.string(), z.unknown());
const quality = z.enum(["realtime", "delayed-15m", "eod", "fallback", "unavailable"]);
const barInterval = z.enum(["1d", "1w", "1h", "5m", "15m", "30m", "4h", "1m"]);
const normalizedTimeframe = z.enum(["1D", "1W", "1h", "5m", "15m", "30m", "4h", "1m"]);
const freshness = z.enum(["live", "delayed", "closed", "paused", "unavailable"]);
const marketSession = z.enum(["pre", "regular", "after", "closed"]);
const runOn = z.enum(["bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h", "premarket_0830", "daily_close", "weekly"]);
const biasLabel = z.enum(["Strong Sell", "Sell", "Neutral", "Buy", "Strong Buy", "warming up"]);
const alertChannel = z.enum(["inbox", "telegram", "slack"]);
const deliveryStatus = z.enum(["delivered", "held_quiet_hours", "no_channel", "failed"]);
const signalKind = z.enum(["orb", "vwap_reclaim", "pattern", "rvol", "other"]);
const optionalMetric = finiteNumber.nullable().optional();

export const StampSchema = z.object({
  as_of: dateOrTimestamp.nullable(),
  source: z.string().nullable(),
  quality,
  freshness,
}) satisfies z.ZodType<components["schemas"]["Stamp"]>;

export const ProblemSchema = z.object({ path: z.string(), message: z.string() }) satisfies z.ZodType<components["schemas"]["Problem"]>;

const BarSchema = z.object({
  t: dateOrTimestamp,
  o: finiteNumber.nullable(),
  h: finiteNumber.nullable(),
  l: finiteNumber.nullable(),
  c: finiteNumber.nullable(),
  v: finiteNumber.nullable(),
  ext: z.boolean(),
}) satisfies z.ZodType<components["schemas"]["BarOut"]>;

export const BarsSchema = z.object({
  symbol: z.string(),
  interval: barInterval,
  quality,
  as_of: dateOrTimestamp.nullable(),
  bars: z.array(BarSchema),
  stamp: StampSchema,
}) satisfies z.ZodType<components["schemas"]["BarsOut"]>;

const VoteCountsSchema = z.object({
  sell: finiteNumber.int(),
  neutral: finiteNumber.int(),
  buy: finiteNumber.int(),
}) satisfies z.ZodType<components["schemas"]["VoteCountsOut"]>;

const GaugeSchema = z.object({
  label: biasLabel,
  score: finiteNumber.nullable(),
  counts: VoteCountsSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["GaugeOut"]>;

const StrategiesGaugeSchema = z.object({
  label: biasLabel,
  score: finiteNumber.nullable(),
  counts: VoteCountsSchema,
  votes: z.array(z.object({
    strategy_id: finiteNumber.int(),
    name: z.string(),
    bias: z.enum(["bullish", "bearish", "neutral"]),
    vote: z.enum(["buy", "neutral", "sell"]),
  })),
  watching: z.array(z.object({ strategy_id: finiteNumber.int(), name: z.string() })),
}) satisfies z.ZodType<components["schemas"]["StrategiesGaugeOut"]>;

const GaugesSchema = z.object({
  summary: GaugeSchema,
  oscillators: GaugeSchema,
  moving_averages: GaugeSchema,
  strategies: StrategiesGaugeSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["GaugesOut"]>;

const VoteSchema = z.object({
  values: z.record(z.string(), finiteNumber.nullable()),
  action: z.enum(["Sell", "Neutral", "Buy"]).nullable(),
}) satisfies z.ZodType<components["schemas"]["VoteOut"]>;

const MacdSchema = z.object({
  line: finiteNumber.nullable(),
  signal: finiteNumber.nullable(),
  histogram: finiteNumber.nullable(),
}) satisfies z.ZodType<components["schemas"]["MacdOut"]>;

const VolatilitySchema = z.object({
  atr14: finiteNumber.nullable(),
  atr_percent: finiteNumber.nullable(),
  label: z.enum(["low", "normal", "high"]).nullable(),
}).refine((value) => value.label === null || (value.atr14 !== null && value.atr_percent !== null));

const numericMap = z.record(z.string(), finiteNumber.nullable());

const PivotMethodsSchema = z.object({
  classic: numericMap,
  fibonacci: numericMap,
  camarilla: numericMap,
}) satisfies z.ZodType<components["schemas"]["PivotMethodsOut"]>;

const CardBackSchema = z.object({
  symbol: z.string(),
  timeframe: normalizedTimeframe,
  bias_label: z.string().nullable(),
  bias_score: finiteNumber.nullable(),
  oscillators: numericMap,
  moving_averages: numericMap,
  atr_pct_label: z.string(),
  pivots: numericMap,
}) satisfies z.ZodType<components["schemas"]["CardBackOut"]>;

const BiasHistorySchema = z.object({
  history: z.array(z.object({
    bar: utcTimestamp,
    summary: biasLabel,
    score: finiteNumber.nullable(),
    oscillators: biasLabel,
    moving_averages: biasLabel,
  })),
  last_change_in_window: z.object({ from: biasLabel, to: biasLabel, at_bar: utcTimestamp }).nullable(),
}) satisfies z.ZodType<components["schemas"]["BiasHistoryOut"]>;

const LevelsSchema = z.object({
  prior_close: finiteNumber.nullable(),
  session_high: finiteNumber.nullable(),
  session_low: finiteNumber.nullable(),
}) satisfies z.ZodType<components["schemas"]["LevelsOut"]>;

export const TechnicalsSchema = z.object({
  symbol: z.string(),
  quality,
  as_of: dateOrTimestamp.nullable(),
  timeframe: z.string(),
  bars_used: finiteNumber.int(),
  first_bar: utcTimestamp.nullable(),
  last_bar: utcTimestamp.nullable(),
  bias_ready: z.boolean(),
  indicators: z.record(z.string(), z.union([finiteNumber, z.string()]).nullable()).nullable(),
  bias_history: BiasHistorySchema.nullable(),
  levels: LevelsSchema.nullable(),
  stamp: StampSchema,
  gauges: GaugesSchema,
  moving_averages: z.record(z.string(), VoteSchema),
  oscillators: z.record(z.string(), VoteSchema),
  pivots: PivotMethodsSchema,
  rsi: finiteNumber.nullable(),
  macd: MacdSchema,
  volatility: VolatilitySchema,
  card_back: CardBackSchema,
}) satisfies z.ZodType<components["schemas"]["TechnicalsOut"]>;

const FuturesSpecSchema = z.object({
  root: z.string(),
  mini: z.string(),
  micro: z.string(),
  multiplier: finiteNumber,
  tick_size: finiteNumber,
  session: z.object({ open_time: z.string(), close_time: z.string() }),
  roll_dates: z.array(z.iso.date()),
  approx_margin: finiteNumber.nullable(),
  margin_as_of: z.iso.date().nullable(),
}) satisfies z.ZodType<components["schemas"]["FuturesSpecOut"]>;

export const FuturesSpecsSchema = z.array(FuturesSpecSchema) satisfies z.ZodType<components["schemas"]["FuturesSpecOut"][]>;

export const StatusSchema = z.object({
  gateway: z.enum(["not_configured", "connected", "reconnecting", "down"]),
  data_sources: z.enum(["unknown", "alpaca", "ibkr", "mixed"]),
  streaming_slots: z.object({ used: finiteNumber.int(), max: finiteNumber.int() }),
  backups: z.null(),
  reconciliation: z.null(),
  market: z.object({ session: marketSession, next_open: utcTimestamp, last_close: utcTimestamp }),
  quotes: StampSchema,
  scans: z.object({
    as_of: dateOrTimestamp.nullable(),
    source: z.string().nullable(),
    quality,
    freshness,
    next_run_at: utcTimestamp.nullable(),
  }),
  alerts: z.object({
    state: z.enum(["running", "paused_no_quotes", "paused_by_user", "not_started"]),
    unread: finiteNumber.int(),
  }),
}) satisfies z.ZodType<components["schemas"]["StatusOut"]>;

export const MeSchema = z.object({ email: z.string() }) satisfies z.ZodType<components["schemas"]["MeOut"]>;

const WatchlistItemReadSchema = z.object({
  symbol: z.string(),
  asset_type: z.string(),
  backfill: z.enum(["ready", "pending"]),
}) satisfies z.ZodType<components["schemas"]["WatchlistItemReadOut"]>;

export const WatchlistItemsSchema = z.array(WatchlistItemReadSchema) satisfies z.ZodType<components["schemas"]["WatchlistItemReadOut"][]>;

export const AlertOutSchema = z.object({
  id: finiteNumber,
  kind: z.string(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  payload: jsonObject,
  created_at: timestamp,
  read_at: timestamp.nullable(),
  symbol: z.string().nullable(),
  strategy_id: finiteNumber.int().nullable(),
  strategy_name: z.string().nullable(),
}) satisfies z.ZodType<components["schemas"]["AlertOut"]>;

export const SettingsBodySchema = z.object({
  settings: jsonObject,
}) satisfies z.ZodType<components["schemas"]["SettingsBody"]>;

export const SignalOutSchema = z.object({
  id: finiteNumber,
  strategy_version_id: finiteNumber,
  symbol: z.string(),
  bar_time: timestamp,
  evidence: jsonObject,
  data_quality: z.string(),
  created_at: timestamp,
  strategy_id: finiteNumber.int(),
  strategy_name: z.string(),
  kind: signalKind,
}) satisfies z.ZodType<components["schemas"]["SignalOut"]>;

export const StrategyOutSchema = z.object({
  id: finiteNumber,
  name: z.string(),
  stage: z.string(),
  current_version_id: finiteNumber.nullable(),
}) satisfies z.ZodType<components["schemas"]["StrategyOut"]>;

export const StrategyVersionOutSchema = z.object({
  id: finiteNumber,
  strategy_id: finiteNumber,
  version: finiteNumber,
  schema_version: finiteNumber,
  spec: jsonObject,
  change_note: z.string().nullable(),
}) satisfies z.ZodType<components["schemas"]["StrategyVersionOut"]>;

export const WatchlistOutSchema = z.object({
  id: finiteNumber,
  name: z.string(),
  horizon: z.string(),
}) satisfies z.ZodType<components["schemas"]["WatchlistOut"]>;

export const WatchlistItemOutSchema = z.object({
  watchlist_id: finiteNumber,
  symbol: z.string(),
  asset_type: z.string(),
}) satisfies z.ZodType<components["schemas"]["WatchlistItemOut"]>;

export const AlertsResponseSchema = z.array(AlertOutSchema);
export const SignalsResponseSchema = z.array(SignalOutSchema);
export const StrategiesResponseSchema = z.array(StrategyOutSchema);
export const StrategyVersionsResponseSchema = z.array(StrategyVersionOutSchema);
export const WatchlistsResponseSchema = z.array(WatchlistOutSchema);

// ---- Desktop MVP (02m §a3): one schema per new or extended response. ----

const MetricsSchema = z.object({
  last: optionalMetric,
  prev_close: optionalMetric,
  change_pct: optionalMetric,
  volume: optionalMetric,
  avg_volume_20d: optionalMetric,
  rvol_10d: optionalMetric,
  atr_pct_14: optionalMetric,
  rsi_14: optionalMetric,
  gap_pct_open: optionalMetric,
  high_252d: optionalMetric,
  dist_to_252d_high_pct: optionalMetric,
  vwap_close: optionalMetric,
  vs_vwap_pct: optionalMetric,
  rvol_intraday_10d_at_close: optionalMetric,
}) satisfies z.ZodType<components["schemas"]["Metrics"]>;

export const SymbolSearchResponseSchema = z.array(z.object({
  symbol: z.string(),
  name: z.string(),
  asset_type: z.enum(["stock", "etf"]),
  in_watchlist: z.boolean(),
}) satisfies z.ZodType<components["schemas"]["SymbolSearchOut"]>);

export const DashboardSchema = z.object({
  stamp: StampSchema,
  market: z.object({ session: marketSession, next_open: utcTimestamp }),
  market_strip: z.array(z.object({
    symbol: z.string(),
    last: finiteNumber.nullable(),
    change_pct: finiteNumber.nullable(),
    stamp: StampSchema,
  })),
  signals: z.array(z.object({
    id: finiteNumber.int(),
    symbol: z.string(),
    strategy_id: finiteNumber.int(),
    strategy_name: z.string(),
    kind: signalKind,
    bar_time: utcTimestamp,
    summary: z.string(),
    evidence: jsonObject,
  })),
  screener_matches: z.array(z.object({
    filter_id: finiteNumber.int(),
    name: z.string(),
    run_on: z.string(),
    scanned: finiteNumber.int(),
    matches_total: finiteNumber.int(),
    top: z.array(z.string()),
    stamp: StampSchema,
  })),
  watchlist: z.object({
    id: finiteNumber.int(),
    name: z.string(),
    rows: z.array(z.object({
      symbol: z.string(),
      last: finiteNumber.nullable(),
      change_pct: finiteNumber.nullable(),
      rvol_10d: finiteNumber.nullable(),
      vs_vwap_pct: finiteNumber.nullable(),
      bias_label: z.string(),
    })),
  }),
  events: z.array(z.object({ symbol: z.string(), kind: z.literal("earnings"), date: z.iso.date(), timing: z.string() })),
  alerts_state: z.enum(["running", "paused_no_quotes", "paused_by_user", "not_started"]),
}) satisfies z.ZodType<components["schemas"]["DashboardOut"]>;

export const MarkersSchema = z.object({
  patterns: z.array(z.object({
    pattern: z.string(),
    template: z.string(),
    bar_start: utcTimestamp,
    bar_close: utcTimestamp,
    ohlc: z.array(finiteNumber),
  })),
  fires: z.array(z.object({ signal_id: finiteNumber.int(), strategy_name: z.string(), bar_time: utcTimestamp })),
}) satisfies z.ZodType<components["schemas"]["MarkersOut"]>;

const ScreenerLiquiditySchema = z.object({
  minPrice: finiteNumber.nullable().optional(),
  minAvgVolume: finiteNumber.int().nullable().optional(),
  avgVolumeDays: finiteNumber.int().nullable().optional(),
}) satisfies z.ZodType<components["schemas"]["ScreenerLiquidityOut"]>;

export const ScreenerFiltersSchema = z.array(z.object({
  id: finiteNumber.int(),
  name: z.string(),
  origin: z.enum(["seed", "user"]),
  seed_key: z.string().nullable(),
  read_only: z.boolean(),
  run_on: runOn,
  session: z.enum(["regular", "extended"]),
  last_run: z.object({
    evaluation_point: utcTimestamp,
    matches_total: finiteNumber.int(),
    scanned: finiteNumber.int(),
    stamp: StampSchema,
  }).nullable(),
}) satisfies z.ZodType<components["schemas"]["ScreenerFilterOut"]>);

export const ScreenerFilterDetailSchema = z.object({
  id: finiteNumber.int(),
  name: z.string(),
  origin: z.enum(["seed", "user"]),
  read_only: z.boolean(),
  version: finiteNumber.int(),
  spec: jsonObject,
  default_spec: jsonObject.nullable(),
  stamp: StampSchema,
}) satisfies z.ZodType<components["schemas"]["ScreenerFilterDetailOut"]>;

export const ScreenerResultsSchema = z.object({
  filter_id: finiteNumber.int(),
  name: z.string(),
  run_on: runOn,
  session: z.enum(["regular", "extended"]),
  rank: z.object({ by: jsonObject, order: z.enum(["desc", "asc"]) }).nullable(),
  liquidity: ScreenerLiquiditySchema.nullable(),
  evaluation_point: utcTimestamp,
  scanned: finiteNumber.int(),
  no_data_on_eval_day: finiteNumber.int(),
  matches_total: finiteNumber.int(),
  matches_returned: finiteNumber.int(),
  stamp: StampSchema,
  table_columns: z.array(z.object({
    key: z.string(),
    label: z.string(),
    format: z.enum(["price", "pct", "pct_signed", "compact", "ratio", "number", "time"]),
  })),
  matches: z.array(z.object({
    symbol: z.string(),
    matched_since: utcTimestamp,
    rank_value: finiteNumber.nullable(),
    operands: z.record(z.string(), finiteNumber.nullable()),
    columns: MetricsSchema,
  })),
}) satisfies z.ZodType<components["schemas"]["ScreenerResultsOut"]>;

export const ScreenerPreviewSchema = z.object({
  problems: z.array(ProblemSchema),
  matches_total: finiteNumber.int().nullable(),
  scanned: finiteNumber.int(),
  top: z.array(z.object({ symbol: z.string(), rank_value: finiteNumber.nullable() })),
}) satisfies z.ZodType<components["schemas"]["ScreenerPreviewOut"]>;

export const ScreenerUniverseSchema = z.object({
  scan_basis: z.string(),
  candidates: finiteNumber.int(),
  scanned: finiteNumber.int(),
  dropped_non_plain_tickers: finiteNumber.int(),
  no_daily_data: finiteNumber.int(),
  liquidity_floor: ScreenerLiquiditySchema,
  stamp: StampSchema,
}) satisfies z.ZodType<components["schemas"]["ScreenerUniverseOut"]>;

export const WatchlistTableSchema = z.object({
  watchlist: z.object({ id: finiteNumber.int(), name: z.string(), horizon: z.string() }),
  stamp: StampSchema,
  rows: z.array(z.object({
    symbol: z.string(),
    name: z.string(),
    asset_type: z.enum(["stock", "etf", "future"]),
    last: finiteNumber.nullable(),
    change_pct: finiteNumber.nullable(),
    rvol_10d: finiteNumber.nullable(),
    vs_vwap_pct: finiteNumber.nullable(),
    bias_label: z.string(),
    freshness,
    tags: z.array(z.object({ kind: z.enum(["pattern", "armed"]), label: z.string(), at: utcTimestamp.nullable() })),
  })),
}) satisfies z.ZodType<components["schemas"]["WatchlistTable"]>;

const presetCategory = z.enum(["candlestick", "breakout", "trend", "volume", "futures", "income", "long_term"]);
const libraryBase = {
  id: z.string(),
  file: z.string(),
  kind: z.enum(["strategy", "filter"]),
  lane: z.enum(["technical", "fundamental"]),
  category: presetCategory,
  bias: z.enum(["bullish", "bearish", "neutral"]),
  label: z.string(),
  summary: z.string(),
  attachable: z.boolean(),
  attach_blocked_reason: z.string().nullable(),
};

export const LibraryItemSchema = z.object(libraryBase) satisfies z.ZodType<components["schemas"]["LibraryItemOut"]>;
export const LibraryListSchema = z.array(LibraryItemSchema);
export const LibraryEntrySchema = z.object({
  ...libraryBase,
  spec: jsonObject,
  defaults: jsonObject,
  example: z.object({ symbol: z.string(), timeframe: z.string(), bar_time: utcTimestamp, ohlc: z.array(finiteNumber) }).nullable(),
}) satisfies z.ZodType<components["schemas"]["LibraryEntryOut"]>;

const alertStrategyFields = {
  id: finiteNumber.int(),
  name: z.string(),
  origin: z.enum(["seed", "library", "user"]),
  stage: z.enum(["draft", "alert_only"]),
  status: z.enum(["active", "paused", "expired", "draft"]),
  paused_reason: z.string().nullable(),
  version: finiteNumber.int(),
  source: z.object({ kind: z.enum(["symbol", "watchlist", "filter"]), id: finiteNumber.int().nullable(), label: z.string() }),
  category: z.enum(["pattern", "indicator", "level", "screener"]),
  run_on: runOn,
  frequency: z.enum(["once", "once_per_bar", "every_time"]),
  cooldown_minutes: finiteNumber.int().nullable(),
  expires_on: z.iso.date().nullable(),
  channels: z.array(alertChannel),
  severity: z.enum(["info", "opportunity", "risk"]),
  last_fired_at: utcTimestamp.nullable(),
  fires_7d: finiteNumber.int(),
  spec: jsonObject,
};

export const AlertStrategySchema = z.object(alertStrategyFields) satisfies z.ZodType<components["schemas"]["AlertStrategyOut"]>;
export const AlertStrategiesSchema = z.array(AlertStrategySchema);
export const AlertStrategyDetailSchema = z.object({
  ...alertStrategyFields,
  versions: z.array(z.object({ version: finiteNumber.int(), change_note: z.string().nullable(), created_at: utcTimestamp })),
}) satisfies z.ZodType<components["schemas"]["AlertStrategyDetailOut"]>;

export const AlertStrategyValidateSchema = z.object({
  problems: z.array(ProblemSchema),
  resolved_symbols: z.array(z.string()),
  run_on: runOn.nullable(),
}) satisfies z.ZodType<components["schemas"]["AlertStrategyValidateOut"]>;

export const AlertStrategyFiresSchema = z.array(z.object({
  signal_id: finiteNumber.int(),
  symbol: z.string(),
  bar_time: utcTimestamp,
  evidence: jsonObject,
  deliveries: z.array(z.object({ channel: alertChannel, status: deliveryStatus })),
  thumb: z.object({
    interval: z.literal("15m"),
    bars: z.array(z.object({ t: utcTimestamp, o: finiteNumber.nullable(), h: finiteNumber.nullable(), l: finiteNumber.nullable(), c: finiteNumber.nullable(), v: finiteNumber.nullable() })),
  }),
}) satisfies z.ZodType<components["schemas"]["AlertStrategyFireOut"]>);

export const AlertLogSchema = z.array(z.object({
  delivery_id: finiteNumber.int(),
  alert_id: finiteNumber.int(),
  created_at: utcTimestamp,
  symbol: z.string().nullable(),
  strategy_id: finiteNumber.int().nullable(),
  strategy_name: z.string().nullable(),
  channel: z.string(),
  status: deliveryStatus,
  detail: z.string(),
}) satisfies z.ZodType<components["schemas"]["AlertLogOut"]>);

export const AlertReadAllSchema = z.object({ marked: finiteNumber.int() }) satisfies z.ZodType<components["schemas"]["AlertReadAllOut"]>;

export const SettingsChannelsSchema = z.array(z.object({
  channel: alertChannel,
  connected: z.boolean(),
  configured: z.boolean().default(false),
  locked: z.boolean().default(false),
}) satisfies z.ZodType<components["schemas"]["SettingsChannelStateOut"]>);

export const SettingsChannelSchema = SettingsChannelsSchema.element;
export const SettingsChannelTestSchema = z.object({ status: z.enum(["sent", "not_connected", "failed"]) }) satisfies z.ZodType<components["schemas"]["SettingsChannelTestOut"]>;

export const EmptySchema = z.undefined();

export type Stamp = z.infer<typeof StampSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type Bars = z.infer<typeof BarsSchema>;
export type Technicals = z.infer<typeof TechnicalsSchema>;
export type DeskStatus = z.infer<typeof StatusSchema>;
export type Dashboard = z.infer<typeof DashboardSchema>;
export type Markers = z.infer<typeof MarkersSchema>;
export type ScreenerFilter = z.infer<typeof ScreenerFiltersSchema>[number];
export type ScreenerFilterDetail = z.infer<typeof ScreenerFilterDetailSchema>;
export type ScreenerResults = z.infer<typeof ScreenerResultsSchema>;
export type ScreenerPreview = z.infer<typeof ScreenerPreviewSchema>;
export type ScreenerUniverse = z.infer<typeof ScreenerUniverseSchema>;
export type WatchlistTable = z.infer<typeof WatchlistTableSchema>;
export type WatchlistTableRow = WatchlistTable["rows"][number];
export type LibraryItem = z.infer<typeof LibraryItemSchema>;
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;
export type AlertStrategy = z.infer<typeof AlertStrategySchema>;
export type AlertStrategyDetail = z.infer<typeof AlertStrategyDetailSchema>;
export type AlertStrategyFire = z.infer<typeof AlertStrategyFiresSchema>[number];
export type AlertLogRow = z.infer<typeof AlertLogSchema>[number];
export type SettingsChannel = z.infer<typeof SettingsChannelSchema>;
export type Signal = z.infer<typeof SignalOutSchema>;
export type DeskAlert = z.infer<typeof AlertOutSchema>;
export type BiasLabel = z.infer<typeof GaugeSchema>["label"];
