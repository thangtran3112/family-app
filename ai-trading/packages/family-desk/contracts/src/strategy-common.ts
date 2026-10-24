import { z } from "zod";
import { HhMmSchema, TickerSchema } from "./strategy-spec-v1.ts";

// Shared primitives for the persona-split strategy configs (filter, pattern, custom, alert,
// draft). Every config is a strict JSON object. The Pydantic mirror (ai_trading.contracts.*)
// rejects nulls and booleans everywhere, so these schemas have no boolean field: a flag is an
// enum instead. No `.meta({ id })` here: ids are global in Zod and only the v1 spec exports JSON Schema.
export { HhMmSchema, TickerSchema };

export const SchemaVersionSchema = z.literal(1);

// Stable ids for presets, strategies, and drafts. [a-z0-9], not \w: both validators must agree.
export const SlugSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const NameSchema = z.string().min(1).max(80);
export const DescriptionSchema = z.string().min(1).max(500);

// Bar cadence, shortest to longest. Order matters: see TIMEFRAME_ORDER.
export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d", "1w"] as const;
export const TimeframeSchema = z.enum(TIMEFRAMES);
export type Timeframe = z.infer<typeof TimeframeSchema>;

/** True when `a` is the same bar length as `b` or a longer one. */
export function timeframeAtLeast(a: Timeframe, b: Timeframe): boolean {
  return TIMEFRAMES.indexOf(a) >= TIMEFRAMES.indexOf(b);
}

export const UniverseSchema = z.union([
  z.strictObject({ watchlist: z.string().min(1).max(80) }),
  z.strictObject({ symbols: z.array(TickerSchema).min(1).max(70) }),
]);

export const SeveritySchema = z.enum(["info", "opportunity", "risk"]);

// UTC instant, whole seconds: "2026-10-23T14:30:00Z".
export const UtcTimestampSchema = z
  .string()
  .regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/);
