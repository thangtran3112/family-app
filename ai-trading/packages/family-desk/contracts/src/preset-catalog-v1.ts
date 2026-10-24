import { z } from "zod";
import { SchemaVersionSchema, SlugSchema } from "./strategy-common.ts";

// PresetCatalogV1: the index of the shipped template files (contracts/catalog.json). `file` is
// relative to contracts/templates/. `kind` says which schema the file parses with: "strategy" is
// a StrategySpecV1, "filter" a FilterStrategySpecV1. Unique ids, existing files, and the
// kind-to-schema match are checked by the catalog test, not by this schema.
const PresetEntrySchema = z.strictObject({
  id: SlugSchema,
  file: z.string().max(80).regex(/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*\.json$/),
  kind: z.enum(["strategy", "filter"]),
  lane: z.enum(["technical", "fundamental"]),
  category: z.enum(["candlestick", "breakout", "trend", "volume", "futures", "income", "long_term"]),
  bias: z.enum(["bullish", "bearish", "neutral"]),
  label: z.string().min(1).max(80),
  summary: z.string().min(1).max(160),
});

export const PresetCatalogV1Schema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    entries: z.array(PresetEntrySchema).min(1).max(200),
  })
  .meta({ id: "PresetCatalogV1" });

export type PresetCatalogV1 = z.infer<typeof PresetCatalogV1Schema>;
