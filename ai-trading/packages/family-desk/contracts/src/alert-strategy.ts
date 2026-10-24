import { z } from "zod";
import { FILTER_METRIC_DOMAIN, FilterMetricSchema, type FilterMetric } from "./filter-strategy.ts";
import {
  DescriptionSchema,
  HhMmSchema,
  NameSchema,
  SchemaVersionSchema,
  SeveritySchema,
  SlugSchema,
  TickerSchema,
  TimeframeSchema,
} from "./strategy-common.ts";

// Alert strategy (kind "alert"): when to notify and where. Nothing here places an order.
// Every rule in ALERT_RULES has a same-named model_validator with the same message in the Pydantic
// mirror (ai_trading.contracts.alert_strategy). Times are New York wall-clock HH:MM; HH:MM strings are
// zero-padded, so string comparison is time comparison.

export const ALERT_RULES = [
  { id: "channels-unique", description: "channels must be unique" },
  { id: "channels-in-app-first", description: "channels[0] must be in_app" },
  { id: "days-unique", description: "days must be unique" },
  { id: "days-weekday-session", description: "regular and extended sessions cannot include sat or sun" },
  { id: "window-start-before-end", description: "window.start must be before window.end" },
  { id: "window-regular-bounds", description: "a regular window must lie inside 09:30-16:00" },
  { id: "window-extended-bounds", description: "an extended window must lie inside 04:00-20:00" },
  { id: "threshold-in-domain", description: "threshold must lie in the indicator metric's domain" },
] as const;

type AlertRuleId = (typeof ALERT_RULES)[number]["id"];
const RULE_TEXT = Object.fromEntries(ALERT_RULES.map((rule) => [rule.id, rule.description])) as Record<
  AlertRuleId,
  string
>;

function ruleIssue(ctx: z.RefinementCtx, rule: AlertRuleId, path: PropertyKey[]): void {
  ctx.addIssue({ code: "custom", path, message: RULE_TEXT[rule] });
}

export const AlertChannelSchema = z.enum(["in_app", "telegram", "slack"]);

const WeekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const StrategyMatchTriggerSchema = z.strictObject({
  type: z.literal("strategy_match"),
  strategyId: SlugSchema,
});

export const PriceCrossTriggerSchema = z.strictObject({
  type: z.literal("price_cross"),
  symbol: TickerSchema,
  direction: z.enum(["above", "below"]),
  level: z.number().gt(0).max(1000000),
});

function inDomain(metric: FilterMetric["metric"], value: number): boolean {
  const [min, max] = FILTER_METRIC_DOMAIN[metric];
  return value >= min && (max === null || value <= max);
}

export const IndicatorThresholdTriggerSchema = z
  .strictObject({
    type: z.literal("indicator_threshold"),
    symbol: TickerSchema,
    indicator: FilterMetricSchema,
    op: z.enum(["gt", "gte", "lt", "lte", "crosses_above", "crosses_below"]),
    threshold: z.number(),
  })
  .superRefine((trigger, ctx) => {
    if (trigger.indicator && !inDomain(trigger.indicator.metric, trigger.threshold)) {
      ruleIssue(ctx, "threshold-in-domain", ["threshold"]);
    }
  });

export const AlertTriggerSchema = z.discriminatedUnion("type", [
  StrategyMatchTriggerSchema,
  PriceCrossTriggerSchema,
  IndicatorThresholdTriggerSchema,
]);
export type AlertTrigger = z.infer<typeof AlertTriggerSchema>;

export const AlertScheduleSchema = z
  .strictObject({
    sessions: z.enum(["regular", "extended", "always"]),
    days: z.array(WeekdaySchema).min(1).max(7),
    window: z.strictObject({ start: HhMmSchema, end: HhMmSchema }).optional(),
  })
  .superRefine((schedule, ctx) => {
    if (new Set(schedule.days).size !== schedule.days.length) ruleIssue(ctx, "days-unique", ["days"]);
    if (schedule.sessions !== "always" && schedule.days.some((day) => day === "sat" || day === "sun")) {
      ruleIssue(ctx, "days-weekday-session", ["days"]);
    }

    const { window } = schedule;
    if (!window) return;
    if (window.start >= window.end) ruleIssue(ctx, "window-start-before-end", ["window", "end"]);
    if (schedule.sessions === "regular" && (window.start < "09:30" || window.end > "16:00")) {
      ruleIssue(ctx, "window-regular-bounds", ["window"]);
    }
    if (schedule.sessions === "extended" && (window.start < "04:00" || window.end > "20:00")) {
      ruleIssue(ctx, "window-extended-bounds", ["window"]);
    }
  });
export type AlertSchedule = z.infer<typeof AlertScheduleSchema>;

export const AlertCooldownSchema = z.strictObject({
  minutes: z.int().min(0).max(1440),
  dedupe: z.enum(["per_symbol", "per_trigger", "per_bar"]),
});
export type AlertCooldown = z.infer<typeof AlertCooldownSchema>;

const AlertChannelsSchema = z
  .array(AlertChannelSchema)
  .min(1)
  .max(3)
  .superRefine((channels, ctx) => {
    if (new Set(channels).size !== channels.length) ruleIssue(ctx, "channels-unique", []);
    if (channels.length > 0 && channels[0] !== "in_app") ruleIssue(ctx, "channels-in-app-first", []);
  });

export const AlertStrategySchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kind: z.literal("alert"),
  name: NameSchema,
  description: DescriptionSchema.optional(),
  severity: SeveritySchema.optional(),
  timeframe: TimeframeSchema,
  trigger: AlertTriggerSchema,
  schedule: AlertScheduleSchema,
  cooldown: AlertCooldownSchema,
  maxPerDay: z.int().min(1).max(50).optional(),
  channels: AlertChannelsSchema,
});
export type AlertStrategy = z.infer<typeof AlertStrategySchema>;
