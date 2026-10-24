import { z } from "zod";
import { AlertStrategySchema } from "./alert-strategy.ts";
import { FilterStrategySchema } from "./filter-strategy.ts";
import { EditError, EditSchema, applyEdits, jsonEqual } from "./json-pointer.ts";
import { SchemaVersionSchema, SlugSchema, UtcTimestampSchema } from "./strategy-common.ts";

// Strategy draft (kind "draft"): an AI assistant's proposal for a filter or an alert, the user's
// edits to it (RFC 6902-style ops at JSON pointers into draftConfig), and the final config the user
// accepted. Every rule in DRAFT_RULES has a same-named model_validator with the same message in the
// Pydantic mirror (ai_trading.contracts.strategy_draft). Nothing here places an order.

export const DRAFT_RULES = [
  { id: "proposed-no-edits", description: "a proposed draft has no edits" },
  { id: "proposed-no-final-config", description: "a proposed draft has no finalConfig" },
  { id: "edited-has-edits", description: "an edited draft has at least one edit" },
  { id: "edited-no-final-config", description: "an edited draft has no finalConfig" },
  { id: "final-has-final-config", description: "a final draft has a finalConfig" },
  { id: "rejected-no-final-config", description: "a rejected draft has no finalConfig" },
  { id: "final-config-kind", description: "finalConfig.kind must equal draftConfig.kind" },
  { id: "edits-apply", description: "edits must apply cleanly to draftConfig" },
  {
    id: "edited-config-valid",
    description: "draftConfig with the edits applied must be a valid config of its kind",
  },
  { id: "final-round-trip", description: "draftConfig with the edits applied must equal finalConfig" },
] as const;

type DraftRuleId = (typeof DRAFT_RULES)[number]["id"];
const RULE_TEXT = Object.fromEntries(DRAFT_RULES.map((rule) => [rule.id, rule.description])) as Record<
  DraftRuleId,
  string
>;

function ruleIssue(ctx: z.RefinementCtx, rule: DraftRuleId, path: PropertyKey[]): void {
  ctx.addIssue({ code: "custom", path, message: RULE_TEXT[rule] });
}

export const DraftConfigSchema = z.discriminatedUnion("kind", [FilterStrategySchema, AlertStrategySchema]);
export type DraftConfig = z.infer<typeof DraftConfigSchema>;

export const StrategyDraftSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    kind: z.literal("draft"),
    draftId: SlugSchema,
    createdAt: UtcTimestampSchema,
    request: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(2000),
    status: z.enum(["proposed", "edited", "final", "rejected"]),
    draftConfig: DraftConfigSchema,
    edits: z.array(EditSchema).max(50),
    finalConfig: DraftConfigSchema.optional(),
  })
  .superRefine((draft, ctx) => {
    const { status, edits, draftConfig, finalConfig } = draft;

    if (status === "proposed" && edits.length > 0) ruleIssue(ctx, "proposed-no-edits", ["edits"]);
    if (status === "proposed" && finalConfig) ruleIssue(ctx, "proposed-no-final-config", ["finalConfig"]);
    if (status === "edited" && edits.length === 0) ruleIssue(ctx, "edited-has-edits", ["edits"]);
    if (status === "edited" && finalConfig) ruleIssue(ctx, "edited-no-final-config", ["finalConfig"]);
    if (status === "final" && !finalConfig) ruleIssue(ctx, "final-has-final-config", ["finalConfig"]);
    if (status === "rejected" && finalConfig) ruleIssue(ctx, "rejected-no-final-config", ["finalConfig"]);
    const kindsMatch = !finalConfig || finalConfig.kind === draftConfig.kind;
    if (!kindsMatch) ruleIssue(ctx, "final-config-kind", ["finalConfig"]);

    if (status !== "edited" && status !== "final") return;
    let edited: unknown;
    try {
      edited = applyEdits(draftConfig, edits);
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      ruleIssue(ctx, "edits-apply", ["edits"]);
      return;
    }

    const replayed =
      draftConfig.kind === "filter" ? FilterStrategySchema.safeParse(edited) : AlertStrategySchema.safeParse(edited);
    if (!replayed.success) {
      ruleIssue(ctx, "edited-config-valid", ["draftConfig"]);
      return;
    }
    if (status === "final" && finalConfig && kindsMatch && !jsonEqual(replayed.data, finalConfig)) {
      ruleIssue(ctx, "final-round-trip", ["finalConfig"]);
    }
  });
export type StrategyDraft = z.infer<typeof StrategyDraftSchema>;
