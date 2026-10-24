import { z } from "zod";
import { JsonPointerSchema, resolvePointer } from "./json-pointer.ts";
import {
  DescriptionSchema,
  NameSchema,
  SchemaVersionSchema,
  SlugSchema,
  TimeframeSchema,
  UniverseSchema,
} from "./strategy-common.ts";

// Filter strategy (kind "filter") and its shipped preset catalog entry (kind "filter_preset").
// A filter is a boolean tree of metric thresholds over bars. Every rule below has a same-named
// model_validator with the same message in the Pydantic mirror (ai_trading.contracts.filter_strategy).

const LookbackSchema = z.int().min(2).max(500);
const ParamKeySchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/);

function lookbackMetric<M extends string>(metric: M) {
  return z.strictObject({ metric: z.literal(metric), lookback: LookbackSchema });
}

const METRICS = [
  z.strictObject({ metric: z.literal("close") }),
  z.strictObject({ metric: z.literal("volume") }),
  z.strictObject({ metric: z.literal("dollar_volume") }),
  z.strictObject({ metric: z.literal("gap_pct") }),
  lookbackMetric("avg_volume"),
  lookbackMetric("volume_ratio"),
  lookbackMetric("atr"),
  lookbackMetric("atr_pct"),
  lookbackMetric("stdev_pct"),
  lookbackMetric("pct_from_high"),
  lookbackMetric("pct_from_low"),
  lookbackMetric("sma"),
  lookbackMetric("ema"),
  lookbackMetric("rsi"),
  z.strictObject({ metric: z.literal("change_pct"), lookback: z.int().min(1).max(500) }),
  z.strictObject({
    metric: z.literal("volatility_percentile"),
    measure: z.enum(["atr", "stdev"]),
    lookback: LookbackSchema,
    window: z.int().min(20).max(1000),
  }),
] as const;

export const FilterMetricSchema = z.discriminatedUnion("metric", METRICS);
export type FilterMetric = z.infer<typeof FilterMetricSchema>;

// Allowed threshold range per metric, inclusive. null = unbounded on that side.
export const FILTER_METRIC_DOMAIN: Record<FilterMetric["metric"], readonly [number, number | null]> = {
  close: [0, null],
  volume: [0, null],
  dollar_volume: [0, null],
  gap_pct: [-100, null],
  avg_volume: [0, null],
  volume_ratio: [0, null],
  atr: [0, null],
  atr_pct: [0, null],
  stdev_pct: [0, null],
  pct_from_high: [0, 100],
  pct_from_low: [0, null],
  sma: [0, null],
  ema: [0, null],
  rsi: [0, 100],
  change_pct: [-100, null],
  volatility_percentile: [0, 100],
};

function inDomain(metric: FilterMetric["metric"], value: number): boolean {
  const [min, max] = FILTER_METRIC_DOMAIN[metric];
  return value >= min && (max === null || value <= max);
}

// A condition is one metric's fields plus either a comparison or a closed range.
export const FilterConditionSchema = z
  .union(
    METRICS.flatMap((metric) => [
      metric.extend({ op: z.enum(["gt", "gte", "lt", "lte"]), threshold: z.number() }),
      metric.extend({ op: z.literal("between"), min: z.number(), max: z.number() }),
    ]),
  )
  .superRefine((condition, ctx) => {
    if (condition.op === "between") {
      if (condition.min >= condition.max) {
        ctx.addIssue({ code: "custom", path: ["max"], message: "between needs min < max" });
      }
      if (!inDomain(condition.metric, condition.min)) {
        ctx.addIssue({ code: "custom", path: ["min"], message: `min outside the ${condition.metric} domain` });
      }
      if (!inDomain(condition.metric, condition.max)) {
        ctx.addIssue({ code: "custom", path: ["max"], message: `max outside the ${condition.metric} domain` });
      }
    } else if (!inDomain(condition.metric, condition.threshold)) {
      ctx.addIssue({ code: "custom", path: ["threshold"], message: `threshold outside the ${condition.metric} domain` });
    }
  });

// Node = condition | group. Getters make the group recursive (same style as strategy-spec-v1).
const AllGroupSchema = z.strictObject({
  get all(): z.ZodArray<typeof FilterNodeSchema> {
    return z.array(FilterNodeSchema).min(1).max(20);
  },
});

const AnyGroupSchema = z.strictObject({
  get any(): z.ZodArray<typeof FilterNodeSchema> {
    return z.array(FilterNodeSchema).min(1).max(20);
  },
});

export const FilterGroupSchema = z.union([AllGroupSchema, AnyGroupSchema]);
export type FilterGroup = z.infer<typeof FilterGroupSchema>;

const FilterNodeSchema = z.union([FilterConditionSchema, FilterGroupSchema]);

/** Depth (the top group is 1) and number of condition leaves. Every consumer must keep depth <= 3, leaves <= 30. */
export function filterGroupStats(group: FilterGroup): { depth: number; leaves: number } {
  const nodes = "all" in group ? group.all : group.any;
  let depth = 1;
  let leaves = 0;
  for (const node of nodes) {
    if ("all" in node || "any" in node) {
      const inner = filterGroupStats(node);
      depth = Math.max(depth, inner.depth + 1);
      leaves += inner.leaves;
    } else {
      leaves += 1;
    }
  }
  return { depth, leaves };
}

const RankSchema = z.strictObject({
  by: FilterMetricSchema,
  order: z.enum(["asc", "desc"]),
  limit: z.int().min(1).max(200),
});

// Provenance of a customized shipped preset. The values are the ones the user chose.
const PresetRefSchema = z.strictObject({
  id: SlugSchema,
  params: z.record(ParamKeySchema, z.number()),
});

export const FilterStrategySchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    kind: z.literal("filter"),
    name: NameSchema,
    description: DescriptionSchema.optional(),
    timeframe: TimeframeSchema,
    universe: UniverseSchema.optional(),
    match: FilterGroupSchema,
    rank: RankSchema.optional(),
    preset: PresetRefSchema.optional(),
  })
  .superRefine((strategy, ctx) => {
    const { depth, leaves } = filterGroupStats(strategy.match);
    if (depth > 3) ctx.addIssue({ code: "custom", path: ["match"], message: `group depth ${depth} exceeds 3` });
    if (leaves > 30) ctx.addIssue({ code: "custom", path: ["match"], message: `${leaves} conditions exceed 30` });
  });
export type FilterStrategy = z.infer<typeof FilterStrategySchema>;

const PresetParamSchema = z.strictObject({
  key: ParamKeySchema,
  label: z.string().min(1).max(60),
  unit: z.enum(["x", "pct", "percentile", "bars", "usd", "shares"]),
  path: JsonPointerSchema,
  default: z.number(),
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
});

export const FilterPresetSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    kind: z.literal("filter_preset"),
    id: SlugSchema,
    name: NameSchema,
    description: DescriptionSchema,
    category: z.enum(["volume", "volatility", "gap", "range", "proximity"]),
    params: z.array(PresetParamSchema).min(1).max(8),
    strategy: FilterStrategySchema,
  })
  .superRefine((preset, ctx) => {
    const ref = preset.strategy.preset;
    if (!ref) {
      ctx.addIssue({ code: "custom", path: ["strategy", "preset"], message: "strategy.preset is required" });
    } else if (ref.id !== preset.id) {
      ctx.addIssue({ code: "custom", path: ["strategy", "preset", "id"], message: "must equal the preset id" });
    }

    const keys = new Set<string>();
    const paths = new Set<string>();
    preset.params.forEach((param, i) => {
      if (keys.has(param.key)) ctx.addIssue({ code: "custom", path: ["params", i, "key"], message: "duplicate key" });
      keys.add(param.key);
      if (paths.has(param.path)) ctx.addIssue({ code: "custom", path: ["params", i, "path"], message: "duplicate path" });
      paths.add(param.path);

      if (!(param.min < param.max)) {
        ctx.addIssue({ code: "custom", path: ["params", i, "max"], message: "needs min < max" });
      }
      if (!(param.min <= param.default && param.default <= param.max)) {
        ctx.addIssue({ code: "custom", path: ["params", i, "default"], message: "default must lie in min..max" });
      }
      if (ref && !(Object.hasOwn(ref.params, param.key) && ref.params[param.key] === param.default)) {
        ctx.addIssue({ code: "custom", path: ["strategy", "preset", "params"], message: `${param.key} must equal its default` });
      }

      const found = resolvePointer(preset.strategy, param.path);
      if (!found.found || typeof found.value !== "number") {
        ctx.addIssue({ code: "custom", path: ["params", i, "path"], message: "path does not resolve to a number" });
      } else if (found.value !== param.default) {
        ctx.addIssue({ code: "custom", path: ["params", i, "path"], message: "value at path differs from default" });
      }
    });

    if (ref && Object.keys(ref.params).length !== preset.params.length) {
      ctx.addIssue({ code: "custom", path: ["strategy", "preset", "params"], message: "keys must equal the param keys" });
    }
  });
export type FilterPreset = z.infer<typeof FilterPresetSchema>;
