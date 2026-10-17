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

const BarSchema = z.object({
  t: dateOrTimestamp,
  o: finiteNumber.nullable(),
  h: finiteNumber.nullable(),
  l: finiteNumber.nullable(),
  c: finiteNumber.nullable(),
  v: finiteNumber.nullable(),
}) satisfies z.ZodType<components["schemas"]["BarOut"]>;

export const BarsSchema = z.object({
  symbol: z.string(),
  interval: barInterval,
  quality,
  as_of: dateOrTimestamp.nullable(),
  bars: z.array(BarSchema),
}) satisfies z.ZodType<components["schemas"]["BarsOut"]>;

const VoteCountsSchema = z.object({
  sell: finiteNumber.int(),
  neutral: finiteNumber.int(),
  buy: finiteNumber.int(),
}) satisfies z.ZodType<components["schemas"]["VoteCountsOut"]>;

const GaugeSchema = z.object({
  label: z.enum(["Strong Sell", "Sell", "Neutral", "Buy", "Strong Buy", "warming up"]),
  score: finiteNumber.nullable(),
  counts: VoteCountsSchema.nullable(),
}) satisfies z.ZodType<components["schemas"]["GaugeOut"]>;

const GaugesSchema = z.object({
  summary: GaugeSchema,
  oscillators: GaugeSchema,
  moving_averages: GaugeSchema,
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

export const TechnicalsSchema = z.object({
  symbol: z.string(),
  quality,
  as_of: dateOrTimestamp.nullable(),
  gauges: GaugesSchema,
  moving_averages: z.record(z.string(), VoteSchema),
  oscillators: z.record(z.string(), VoteSchema),
  pivots: PivotMethodsSchema,
  rsi: finiteNumber.nullable(),
  macd: MacdSchema,
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
  gateway: z.literal("not_configured"),
  data_sources: z.literal("unknown"),
  streaming_slots: z.object({ used: finiteNumber.int(), max: finiteNumber.int() }),
  backups: z.null(),
  reconciliation: z.null(),
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
