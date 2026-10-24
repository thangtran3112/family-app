import { z } from "zod";
import { FilterGroupSchema, filterGroupStats } from "./filter-strategy.ts";
import { PatternSpecSchema } from "./pattern-preset-strategy.ts";
import {
  DescriptionSchema,
  NameSchema,
  SchemaVersionSchema,
  SlugSchema,
  TimeframeSchema,
  UniverseSchema,
  timeframeAtLeast,
} from "./strategy-common.ts";

// Custom strategy (kind "custom", spec 02k section 5): a filter group and/or pattern detectors,
// plus optional risk sizing hints. Nothing here places an order: risk fields are hints only.
// Mirror: ai_trading.contracts.custom_strategy (same fields, same ranges, same CUSTOM_RULES ids).
// Every superRefine issue carries its rule id in `params.rule`, so the tests can prove that each
// rule's fixture fails on that rule and not on a shape error.

export const CUSTOM_RULES = [
  { id: "rule-1-no-filters-or-patterns", description: "filters or patterns present" },
  { id: "rule-2-filter-group-size", description: "filter group depth <= 3 and leaves <= 30" },
  { id: "rule-3-pattern-timeframe", description: "every pattern spec timeframe is the strategy timeframe or longer" },
  { id: "rule-4-duplicate-pattern", description: "no two pattern entries share (pattern, timeframe, direction)" },
  { id: "rule-5-all-mixed-direction", description: "patterns.match all cannot mix bullish and bearish entries" },
  {
    id: "rule-6-direction-conflict",
    description: "direction long rejects bearish entries; short rejects bullish entries",
  },
  { id: "rule-7-r-multiple-needs-stop", description: "an r_multiple target requires a stop" },
  { id: "rule-8-empty-risk", description: "risk, when present, has at least one of stop, target, positionSizeHint" },
] as const;

export type CustomRuleId = (typeof CUSTOM_RULES)[number]["id"];

function fail(ctx: z.RefinementCtx, rule: CustomRuleId, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: "custom", path, message, params: { rule } });
}

export const StopSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pct"), value: z.number().gt(0).max(50) }),
  z.strictObject({ type: z.literal("atr_multiple"), value: z.number().gt(0).max(20) }),
]);

export const TargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pct"), value: z.number().gt(0).max(500) }),
  z.strictObject({ type: z.literal("r_multiple"), value: z.number().gt(0).max(20) }),
  z.strictObject({ type: z.literal("atr_multiple"), value: z.number().gt(0).max(40) }),
]);

export const SizeHintSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("risk_pct_of_book"), value: z.number().gt(0).max(5) }),
  z.strictObject({ type: z.literal("notional_usd"), value: z.number().gt(0).max(1000000) }),
  z.strictObject({ type: z.literal("shares"), value: z.int().min(1).max(100000) }),
]);

// Non-empty: at least one key is required (rule-8-empty-risk).
export const RiskSchema = z.strictObject({
  stop: StopSchema.optional(),
  target: TargetSchema.optional(),
  positionSizeHint: SizeHintSchema.optional(),
});

const PatternEntrySchema = z.strictObject({
  presetId: SlugSchema.optional(),
  spec: PatternSpecSchema,
});

const PatternSetSchema = z.strictObject({
  match: z.enum(["all", "any"]),
  entries: z.array(PatternEntrySchema).min(1).max(8),
});

export const CustomStrategySchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    kind: z.literal("custom"),
    name: NameSchema,
    description: DescriptionSchema.optional(),
    timeframe: TimeframeSchema,
    universe: UniverseSchema.optional(),
    direction: z.enum(["long", "short", "either"]),
    filters: FilterGroupSchema.optional(),
    patterns: PatternSetSchema.optional(),
    risk: RiskSchema.optional(),
  })
  .superRefine((strategy, ctx) => {
    const { direction, filters, patterns, risk } = strategy;

    if (!filters && !patterns) {
      fail(ctx, "rule-1-no-filters-or-patterns", [], "a custom strategy needs filters, patterns, or both");
    }

    if (filters) {
      const { depth, leaves } = filterGroupStats(filters);
      if (depth > 3) fail(ctx, "rule-2-filter-group-size", ["filters"], `group depth ${depth} exceeds 3`);
      if (leaves > 30) fail(ctx, "rule-2-filter-group-size", ["filters"], `${leaves} conditions exceed 30`);
    }

    if (patterns) {
      const { match, entries } = patterns;

      entries.forEach((entry, i) => {
        if (!timeframeAtLeast(entry.spec.timeframe, strategy.timeframe)) {
          fail(
            ctx,
            "rule-3-pattern-timeframe",
            ["patterns", "entries", i, "spec", "timeframe"],
            `${entry.spec.timeframe} is shorter than the strategy timeframe ${strategy.timeframe}`,
          );
        }
      });

      const seen = new Set<string>();
      entries.forEach((entry, i) => {
        const key = [entry.spec.pattern, entry.spec.timeframe, entry.spec.direction].join(" ");
        if (seen.has(key)) fail(ctx, "rule-4-duplicate-pattern", ["patterns", "entries", i], `duplicate ${key}`);
        seen.add(key);
      });

      const sides = new Set(entries.map((entry) => entry.spec.direction));
      if (match === "all" && sides.has("bullish") && sides.has("bearish")) {
        fail(
          ctx,
          "rule-5-all-mixed-direction",
          ["patterns", "match"],
          "match all cannot mix bullish and bearish entries",
        );
      }

      entries.forEach((entry, i) => {
        const side = entry.spec.direction;
        if ((direction === "long" && side === "bearish") || (direction === "short" && side === "bullish")) {
          fail(
            ctx,
            "rule-6-direction-conflict",
            ["patterns", "entries", i, "spec", "direction"],
            `direction ${direction} rejects ${side} entries`,
          );
        }
      });
    }

    if (risk) {
      if (risk.target?.type === "r_multiple" && !risk.stop) {
        fail(ctx, "rule-7-r-multiple-needs-stop", ["risk", "target"], "an r_multiple target needs a stop");
      }
      if (!risk.stop && !risk.target && !risk.positionSizeHint) {
        fail(ctx, "rule-8-empty-risk", ["risk"], "risk needs at least one of stop, target, positionSizeHint");
      }
    }
  });
export type CustomStrategy = z.infer<typeof CustomStrategySchema>;
