import { z } from "zod";
import type { components } from "./openapi.js";

const finiteNumber = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const jsonObject = z.record(z.string(), z.unknown());

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
