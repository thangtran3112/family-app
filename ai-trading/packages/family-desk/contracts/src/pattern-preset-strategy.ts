import { z } from "zod";
import { DescriptionSchema, NameSchema, SchemaVersionSchema, SlugSchema, TimeframeSchema } from "./strategy-common.ts";

// Pattern preset (spec 02k section 4): one candlestick or technical pattern detector, plus the
// tolerances that define it. Mirror: ai_trading.contracts.pattern_preset_strategy (same fields,
// same ranges, same PATTERN_RULES table, same rule names).

export const PatternKindSchema = z.enum([
  "hammer",
  "inverted_hammer",
  "bullish_engulfing",
  "bearish_engulfing",
  "doji",
  "morning_star",
  "evening_star",
  "three_white_soldiers",
  "three_black_crows",
  "breakout",
  "bullish_reversal",
  "bearish_reversal",
]);
export type PatternKind = z.infer<typeof PatternKindSchema>;

export const PatternDirectionSchema = z.enum(["bullish", "bearish", "neutral"]);
export type PatternDirection = z.infer<typeof PatternDirectionSchema>;

// Every key is optional here; the PatternSpec rule `toleranceKeysMatchKind` requires exactly the
// keys that the kind uses. Ranges: "(0, x]" is gt(0), "[1, 5]" is min(1).max(5).
export const PatternToleranceSchema = z.strictObject({
  bodyMaxPct: z.number().gt(0).max(100).optional(),
  bodyMinPct: z.number().gt(0).max(100).optional(),
  starBodyMaxPct: z.number().gt(0).max(100).optional(),
  shadowMinRatio: z.number().gt(0).max(20).optional(),
  engulfMinRatio: z.number().min(1).max(5).optional(),
  bufferPct: z.number().min(0).max(10).optional(),
  retracePct: z.number().gt(0).max(100).optional(),
});

type ToleranceKey = keyof z.infer<typeof PatternToleranceSchema>;

export interface PatternRule {
  category: "candlestick" | "technical";
  /** Candles in the pattern. Informational only: no rule reads it. null for technical kinds. */
  bars: 1 | 2 | 3 | null;
  /** True exactly for the technical kinds: their spec must carry `lookback`, candlestick specs must not. */
  lookbackRequired: boolean;
  directions: readonly PatternDirection[];
  /** The exact tolerance keys of the kind. */
  tolerance: readonly ToleranceKey[];
}

// The single table behind the validity rules. Python mirrors it as PATTERN_RULES.
export const PATTERN_RULES: Record<PatternKind, PatternRule> = {
  hammer: {
    category: "candlestick",
    bars: 1,
    lookbackRequired: false,
    directions: ["bullish"],
    tolerance: ["shadowMinRatio", "bodyMaxPct"],
  },
  inverted_hammer: {
    category: "candlestick",
    bars: 1,
    lookbackRequired: false,
    directions: ["bullish"],
    tolerance: ["shadowMinRatio", "bodyMaxPct"],
  },
  bullish_engulfing: {
    category: "candlestick",
    bars: 2,
    lookbackRequired: false,
    directions: ["bullish"],
    tolerance: ["engulfMinRatio"],
  },
  bearish_engulfing: {
    category: "candlestick",
    bars: 2,
    lookbackRequired: false,
    directions: ["bearish"],
    tolerance: ["engulfMinRatio"],
  },
  doji: {
    category: "candlestick",
    bars: 1,
    lookbackRequired: false,
    directions: ["neutral"],
    tolerance: ["bodyMaxPct"],
  },
  morning_star: {
    category: "candlestick",
    bars: 3,
    lookbackRequired: false,
    directions: ["bullish"],
    tolerance: ["starBodyMaxPct"],
  },
  evening_star: {
    category: "candlestick",
    bars: 3,
    lookbackRequired: false,
    directions: ["bearish"],
    tolerance: ["starBodyMaxPct"],
  },
  three_white_soldiers: {
    category: "candlestick",
    bars: 3,
    lookbackRequired: false,
    directions: ["bullish"],
    tolerance: ["bodyMinPct"],
  },
  three_black_crows: {
    category: "candlestick",
    bars: 3,
    lookbackRequired: false,
    directions: ["bearish"],
    tolerance: ["bodyMinPct"],
  },
  breakout: {
    category: "technical",
    bars: null,
    lookbackRequired: true,
    directions: ["bullish", "bearish"],
    tolerance: ["bufferPct"],
  },
  bullish_reversal: {
    category: "technical",
    bars: null,
    lookbackRequired: true,
    directions: ["bullish"],
    tolerance: ["retracePct"],
  },
  bearish_reversal: {
    category: "technical",
    bars: null,
    lookbackRequired: true,
    directions: ["bearish"],
    tolerance: ["retracePct"],
  },
};

const PriorTrendSchema = z.strictObject({
  direction: z.enum(["up", "down", "any"]),
  bars: z.int().min(1).max(50),
});

// A discriminated union on `type`: each type has exactly its own fields.
export const PatternConfirmationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("next_bar_close"), bars: z.int().min(1).max(3) }),
  z.strictObject({
    type: z.literal("volume"),
    minRatio: z.number().min(1).max(20),
    lookback: z.int().min(2).max(60),
  }),
]);

const PatternSpecBaseSchema = z.strictObject({
  pattern: PatternKindSchema,
  direction: PatternDirectionSchema,
  timeframe: TimeframeSchema,
  lookback: z.int().min(2).max(260).optional(),
  priorTrend: PriorTrendSchema.optional(),
  confirmation: PatternConfirmationSchema,
  tolerance: PatternToleranceSchema,
});

// Standalone on purpose: custom-strategy.ts embeds a PatternSpec in each entry of `patterns`.
export const PatternSpecSchema = PatternSpecBaseSchema.superRefine((spec, ctx) => {
  const rule = PATTERN_RULES[spec.pattern];

  // directionAllowed
  if (!rule.directions.includes(spec.direction)) {
    ctx.addIssue({
      code: "custom",
      path: ["direction"],
      message: `${spec.pattern} allows direction ${rule.directions.join(" or ")}, not ${spec.direction}`,
    });
  }

  // lookbackMatchesKind: present exactly for the technical kinds
  if (rule.lookbackRequired !== (spec.lookback !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["lookback"],
      message: rule.lookbackRequired ? `${spec.pattern} requires lookback` : `${spec.pattern} takes no lookback`,
    });
  }

  // toleranceKeysMatchKind: exactly the kind's keys, no more and no less
  const present = Object.keys(spec.tolerance).filter(
    (key) => spec.tolerance[key as ToleranceKey] !== undefined,
  );
  for (const key of rule.tolerance) {
    if (!present.includes(key)) {
      ctx.addIssue({ code: "custom", path: ["tolerance", key], message: `${spec.pattern} requires tolerance ${key}` });
    }
  }
  for (const key of present) {
    if (!(rule.tolerance as readonly string[]).includes(key)) {
      ctx.addIssue({ code: "custom", path: ["tolerance", key], message: `${spec.pattern} takes no tolerance ${key}` });
    }
  }

  // priorTrendMatchesDirection: candlestick kinds only (doji is neutral and unconstrained)
  if (spec.priorTrend && rule.category === "candlestick") {
    if (spec.direction === "bullish" && spec.priorTrend.direction === "up") {
      ctx.addIssue({
        code: "custom",
        path: ["priorTrend", "direction"],
        message: "a bullish pattern needs a down or any prior trend",
      });
    }
    if (spec.direction === "bearish" && spec.priorTrend.direction === "down") {
      ctx.addIssue({
        code: "custom",
        path: ["priorTrend", "direction"],
        message: "a bearish pattern needs an up or any prior trend",
      });
    }
  }
});
export type PatternSpec = z.infer<typeof PatternSpecSchema>;

export const PatternPresetSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kind: z.literal("pattern"),
  id: SlugSchema,
  name: NameSchema,
  description: DescriptionSchema.optional(),
  spec: PatternSpecSchema,
});
export type PatternPreset = z.infer<typeof PatternPresetSchema>;
