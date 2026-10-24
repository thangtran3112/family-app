import { z } from "zod";
import { ConditionSchema, RunOnSchema, SeriesOperandSchema, TickerSchema } from "./strategy-spec-v1.ts";

// FilterStrategySpecV1: a screener. It names a universe, a liquidity floor, and a `when` rule
// (the same ConditionSchema and operands a StrategySpecV1 uses), and returns up to `maxResults`
// matches ranked by one series. It places no alert and no order; a StrategySpecV1 can watch its
// matches through `watch.universe.filter`. Paper-persona-split-plan section e.
export const FilterStrategySpecV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(80),
    watch: z.strictObject({
      universe: z.union([
        z.strictObject({ market: z.literal("us_equities") }),
        z.strictObject({ watchlist: z.string().min(1).max(80) }),
        z.strictObject({ symbols: z.array(TickerSchema).min(1).max(70) }),
      ]),
      session: z.enum(["regular", "extended"]),
      runOn: RunOnSchema,
    }),
    assetTypes: z.array(z.enum(["stock", "etf"])).min(1).max(2).optional(),
    liquidity: z
      .strictObject({
        minPrice: z.number().positive().max(100_000).optional(),
        minAvgVolume: z.int().min(1).max(10_000_000_000).optional(),
        avgVolumeDays: z.int().min(5).max(60).optional(),
      })
      .optional(),
    when: ConditionSchema,
    rank: z.strictObject({ by: SeriesOperandSchema, order: z.enum(["desc", "asc"]) }).optional(),
    maxResults: z.int().min(1).max(100),
  })
  .meta({ id: "FilterStrategySpecV1" });

export type FilterStrategySpecV1 = z.infer<typeof FilterStrategySpecV1Schema>;
