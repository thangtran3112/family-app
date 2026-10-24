import { z } from "zod";
import { AlertStrategySchema } from "./alert-strategy.ts";
import { CustomStrategySchema } from "./custom-strategy.ts";
import { FilterPresetSchema, FilterStrategySchema } from "./filter-strategy.ts";
import { PatternPresetSchema } from "./pattern-preset-strategy.ts";
import { StrategyDraftSchema } from "./strategy-draft.ts";

// Every persona-split config document, told apart by `kind`. The API validates a persisted
// strategy result (and a shipped preset) with this one schema. strategy-spec-v1 is separate:
// it is the alert-and-paper-order spec, versioned on its own.
export const StrategyConfigSchema = z.discriminatedUnion("kind", [
  FilterStrategySchema,
  FilterPresetSchema,
  PatternPresetSchema,
  CustomStrategySchema,
  AlertStrategySchema,
  StrategyDraftSchema,
]);

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
