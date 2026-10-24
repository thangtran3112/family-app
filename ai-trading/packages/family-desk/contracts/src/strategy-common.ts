import { z } from "zod";

// Shared primitives for the strategy-draft exchange model and the preset catalog. The specs
// themselves (strategy-spec-v1.ts, filter-strategy-spec-v1.ts) own their field schemas. The
// Pydantic mirror (ai_trading.contracts.*) rejects nulls and booleans everywhere, so nothing here
// is a boolean: a flag is an enum instead. No `.meta({ id })`: ids are global in Zod, and the
// JSON Schema bundle (scripts/generate-json-schema.ts) names only the spec and catalog schemas.

export const SchemaVersionSchema = z.literal(1);

// Stable ids for presets and drafts. [a-z0-9], not \w: both validators must agree.
export const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

// UTC instant, whole seconds: "2026-10-23T14:30:00Z".
export const UtcTimestampSchema = z
  .string()
  .regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/);
