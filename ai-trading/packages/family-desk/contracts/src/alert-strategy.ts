import { z } from "zod";
import { StrategySpecV1Schema } from "./strategy-spec-v1.ts";

// An alert strategy is a StrategySpecV1 for a strategy at stage "alert_only" (02a: only strategies
// create alerts): the same watch/when/limits, but `then` carries the alert alone, never a
// paperOrder. The alert's channels are unique and start with "inbox", the in-app channel, so a
// delivery always lands in the Desk inbox first.
export const ALERT_RULES = [
  { id: "channels-unique", description: "alert channels must not repeat" },
  { id: "channels-inbox-first", description: "the first alert channel must be inbox" },
] as const;

type AlertRuleId = (typeof ALERT_RULES)[number]["id"];
const RULE_TEXT = Object.fromEntries(ALERT_RULES.map((rule) => [rule.id, rule.description])) as Record<
  AlertRuleId,
  string
>;

export const AlertStrategySpecV1Schema = StrategySpecV1Schema.extend({
  then: z.strictObject({ alert: StrategySpecV1Schema.shape.then.shape.alert }),
}).superRefine((spec, ctx) => {
  const { channels } = spec.then.alert;
  const path = ["then", "alert", "channels"];
  if (new Set(channels).size !== channels.length) {
    ctx.addIssue({ code: "custom", path, message: RULE_TEXT["channels-unique"] });
  }
  if (channels[0] !== "inbox") {
    ctx.addIssue({ code: "custom", path, message: RULE_TEXT["channels-inbox-first"] });
  }
});

export type AlertStrategySpecV1 = z.infer<typeof AlertStrategySpecV1Schema>;
