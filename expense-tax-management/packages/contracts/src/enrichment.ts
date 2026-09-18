import { z } from "zod";

import { TimestampSchema, TaxYearSchema, VersionSchema } from "./expenses.js";

// ------------------------------------------------------------------ //
// Scope
// Canonical personal/business discriminated union.
// Do NOT re-export from spending-categories.ts or any other public module.
// ------------------------------------------------------------------ //

export const ScopeSchema = z.union([
  z.strictObject({ kind: z.literal("personal"), profileId: z.uuid() }),
  z.strictObject({ kind: z.literal("business"), businessId: z.uuid() }),
]);
export type Scope = z.infer<typeof ScopeSchema>;

// ------------------------------------------------------------------ //
// Tag
// ------------------------------------------------------------------ //

export const TagStatusSchema = z.enum(["active", "archived"]);
export type TagStatus = z.infer<typeof TagStatusSchema>;

export const TagOriginSchema = z.enum(["ai", "manual_baseline"]);
export type TagOrigin = z.infer<typeof TagOriginSchema>;

const TagKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_-]+$/, "Tag key must be lowercase alphanumeric with underscores or hyphens");

const ColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const TagSchema = z
  .strictObject({
    id: z.uuid(),
    tenantId: z.uuid(),
    personalProfileId: z.uuid().nullable(),
    businessId: z.uuid().nullable(),
    key: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    color: ColorSchema,
    origin: TagOriginSchema,
    status: TagStatusSchema,
    version: VersionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .refine(
    (value) => (value.personalProfileId !== null) !== (value.businessId !== null),
    { message: "Exactly one personal profile or business scope is required" },
  );
export type Tag = z.infer<typeof TagSchema>;

export const TagCreateRequestSchema = z.strictObject({
  key: TagKeySchema,
  name: z.string().trim().min(1).max(100),
  color: ColorSchema,
});
export type TagCreateRequest = z.infer<typeof TagCreateRequestSchema>;

export const TagUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    name: z.string().trim().min(1).max(100).optional(),
    color: ColorSchema.optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.color !== undefined,
    { message: "At least one tag change is required" },
  );
export type TagUpdateRequest = z.infer<typeof TagUpdateRequestSchema>;

export const TagArchiveRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});
export type TagArchiveRequest = z.infer<typeof TagArchiveRequestSchema>;

export const TagListSchema = z.strictObject({
  items: z.array(TagSchema),
  nextCursor: z.string().nullable(),
});
export type TagList = z.infer<typeof TagListSchema>;

// ------------------------------------------------------------------ //
// ExpenseTag  (tag association)
// ------------------------------------------------------------------ //

export const ExpenseTagSchema = z.strictObject({
  expenseId: z.uuid(),
  tagId: z.uuid(),
  tenantId: z.uuid(),
  createdAt: TimestampSchema,
});
export type ExpenseTag = z.infer<typeof ExpenseTagSchema>;

export const ExpenseTagAssociateRequestSchema = z.strictObject({
  tagId: z.uuid(),
});
export type ExpenseTagAssociateRequest = z.infer<typeof ExpenseTagAssociateRequestSchema>;

export const ExpenseTagRemoveRequestSchema = z.strictObject({
  tagId: z.uuid(),
});
export type ExpenseTagRemoveRequest = z.infer<typeof ExpenseTagRemoveRequestSchema>;

// ------------------------------------------------------------------ //
// ExpenseSpendingCategoryDecision
// ------------------------------------------------------------------ //

export const DecisionSourceSchema = z.enum(["ai", "manual_baseline", "manual_user"]);
export type DecisionSource = z.infer<typeof DecisionSourceSchema>;

export const ExpenseSpendingCategoryDecisionSchema = z.strictObject({
  id: z.uuid(),
  expenseId: z.uuid(),
  tenantId: z.uuid(),
  spendingCategoryId: z.uuid().nullable(),
  source: DecisionSourceSchema,
  actorUserId: z.uuid().nullable(),
  expenseVersion: VersionSchema,
  createdAt: TimestampSchema,
});
export type ExpenseSpendingCategoryDecision = z.infer<typeof ExpenseSpendingCategoryDecisionSchema>;

export const ExpenseSpendingCategoryDecisionListSchema = z.strictObject({
  items: z.array(ExpenseSpendingCategoryDecisionSchema),
  nextCursor: z.string().nullable(),
});
export type ExpenseSpendingCategoryDecisionList = z.infer<
  typeof ExpenseSpendingCategoryDecisionListSchema
>;

// ------------------------------------------------------------------ //
// EnrichmentSuggestion
// ------------------------------------------------------------------ //

export const EnrichmentSuggestionKindSchema = z.enum(["tag", "spending_category", "tax_category"]);
export type EnrichmentSuggestionKind = z.infer<typeof EnrichmentSuggestionKindSchema>;

export const EnrichmentSuggestionStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "superseded",
]);
export type EnrichmentSuggestionStatus = z.infer<typeof EnrichmentSuggestionStatusSchema>;

const EvidenceHashSchema = z.string().regex(/^[a-f0-9]{64}$/, "Evidence hash must be a 64-char hex SHA-256");

const BaseSuggestionFields = {
  id: z.uuid(),
  tenantId: z.uuid(),
  expenseId: z.uuid(),
  jobId: z.uuid(),
  kind: EnrichmentSuggestionKindSchema,
  status: EnrichmentSuggestionStatusSchema,
  candidateId: z.uuid().nullable(),
  evidence: z.record(z.string(), z.unknown()),
  evidenceHash: EvidenceHashSchema,
  confidence: z.number().min(0).max(1),
  workerSchemaVersion: z.number().int().positive(),
  expenseVersion: z.number().int().positive(),
  createdAt: TimestampSchema,
};

const TaxSnapshotPresentFields = {
  businessTaxProfileId: z.uuid(),
  businessTaxProfileVersion: VersionSchema,
  taxonomyVersionId: z.uuid(),
  taxYear: TaxYearSchema,
  taxCategoryDefinitionId: z.uuid(),
};

const TaxSnapshotNullFields = {
  businessTaxProfileId: z.null(),
  businessTaxProfileVersion: z.null(),
  taxonomyVersionId: z.null(),
  taxYear: z.null(),
  taxCategoryDefinitionId: z.null(),
};

export const EnrichmentSuggestionSchema = z
  .discriminatedUnion("kind", [
    // tag suggestion: no tax snapshot
    z.strictObject({
      ...BaseSuggestionFields,
      kind: z.literal("tag"),
      ...TaxSnapshotNullFields,
    }),
    // spending_category suggestion: no tax snapshot
    z.strictObject({
      ...BaseSuggestionFields,
      kind: z.literal("spending_category"),
      ...TaxSnapshotNullFields,
    }),
    // tax_category suggestion: full Business snapshot required
    z.strictObject({
      ...BaseSuggestionFields,
      kind: z.literal("tax_category"),
      ...TaxSnapshotPresentFields,
    }),
  ]);
export type EnrichmentSuggestion = z.infer<typeof EnrichmentSuggestionSchema>;

export const EnrichmentSuggestionListSchema = z.strictObject({
  items: z.array(EnrichmentSuggestionSchema),
  nextCursor: z.string().nullable(),
});
export type EnrichmentSuggestionList = z.infer<typeof EnrichmentSuggestionListSchema>;

// ------------------------------------------------------------------ //
// Strict kind-specific candidate XOR objects (worker-facing)
// ------------------------------------------------------------------ //

export const TagCandidateSchema = z.strictObject({
  tagId: z.uuid(),
});
export type TagCandidate = z.infer<typeof TagCandidateSchema>;

export const SpendingCategoryCandidateSchema = z.strictObject({
  spendingCategoryId: z.uuid(),
});
export type SpendingCategoryCandidate = z.infer<typeof SpendingCategoryCandidateSchema>;

export const TaxCategoryCandidateSchema = z.strictObject({
  taxCategoryDefinitionId: z.uuid(),
  businessTaxProfileId: z.uuid(),
  businessTaxProfileVersion: VersionSchema,
  taxonomyVersionId: z.uuid(),
  taxYear: TaxYearSchema,
  activeTaxCategoryIds: z.array(z.uuid()),
});
export type TaxCategoryCandidate = z.infer<typeof TaxCategoryCandidateSchema>;

// ------------------------------------------------------------------ //
// Suggestion action schemas (resolve / merge / rerun)
// ------------------------------------------------------------------ //

const TerminalStatusSchema = z.enum(["accepted", "rejected", "superseded"]);

export const SuggestionResolveRequestSchema = z.strictObject({
  action: TerminalStatusSchema,
  expectedVersion: VersionSchema,
});
export type SuggestionResolveRequest = z.infer<typeof SuggestionResolveRequestSchema>;

export const SuggestionResolveResponseSchema = z.strictObject({
  suggestionId: z.uuid(),
  status: EnrichmentSuggestionStatusSchema,
  version: VersionSchema,
});
export type SuggestionResolveResponse = z.infer<typeof SuggestionResolveResponseSchema>;

export const SuggestionMergeRequestSchema = z.strictObject({
  suggestionIds: z.array(z.uuid()).min(1),
  action: TerminalStatusSchema,
});
export type SuggestionMergeRequest = z.infer<typeof SuggestionMergeRequestSchema>;

export const SuggestionRerunRequestSchema = z.strictObject({
  expenseId: z.uuid(),
  kinds: z.array(EnrichmentSuggestionKindSchema).min(1),
});
export type SuggestionRerunRequest = z.infer<typeof SuggestionRerunRequestSchema>;
