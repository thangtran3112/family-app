/**
 * Canonical worker result contract for ExpenseEnrichmentWorkflow (Task 3).
 *
 * Security properties:
 * - No tenantId, personalProfileId, businessId, expenseId, or any scope/expense
 *   selectors; App API resolves these from the persisted job row.
 * - No raw receipt text, bytes, or arbitrary content in evidence.
 * - Evidence contains aggregate counts only and a bounded hash.
 * - Tax suggestion carries the complete Business profile version/taxonomy/year/
 *   category/expense-version snapshot required for server revalidation.
 * - All arrays explicitly bounded to prevent unbounded payloads.
 * - strictObject at every level — unknown fields are rejected.
 *
 * Spec authority: 2026-09-12-phase-3c-auto-tagging-design.md
 */
import { z } from "zod";

import { TaxYearSchema, VersionSchema } from "../expenses.js";

// ------------------------------------------------------------------ //
// Evidence hash — 64-char lowercase hex SHA-256
// ------------------------------------------------------------------ //
const EvidenceHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Evidence hash must be a 64-char lowercase hex SHA-256");

// ------------------------------------------------------------------ //
// Aggregate counts only — no raw content
// ------------------------------------------------------------------ //
const AggregateCounts = z.strictObject({
  exampleCount: z.number().int().min(0),
  matchCount: z.number().int().min(0),
});

// ------------------------------------------------------------------ //
// Suggestion variants — strictly discriminated by kind
// ------------------------------------------------------------------ //

const TagSuggestionSchema = z.strictObject({
  kind: z.literal("tag"),
  tagKey: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1),
  evidenceHash: EvidenceHashSchema,
  aggregateCounts: AggregateCounts,
});

const SpendingCategorySuggestionSchema = z.strictObject({
  kind: z.literal("spending_category"),
  spendingCategoryId: z.uuid(),
  confidence: z.number().min(0).max(1),
  evidenceHash: EvidenceHashSchema,
  aggregateCounts: AggregateCounts,
});

/**
 * Tax category suggestion — complete Business profile version/taxonomy/year/
 * category/expense-version snapshot required for server revalidation on accept.
 * Exact tuple per cross-task contract.
 */
const TaxCategorySuggestionSchema = z.strictObject({
  kind: z.literal("tax_category"),
  taxCategoryDefinitionId: z.uuid(),
  businessTaxProfileId: z.uuid(),
  businessTaxProfileVersion: VersionSchema,
  taxonomyVersionId: z.uuid(),
  taxYear: TaxYearSchema,
  /** Expense version at inference time; required for server stale-detection. */
  expenseVersion: VersionSchema,
  confidence: z.number().min(0).max(1),
  evidenceHash: EvidenceHashSchema,
  aggregateCounts: AggregateCounts,
});

const EnrichmentSuggestionResultSchema = z.discriminatedUnion("kind", [
  TagSuggestionSchema,
  SpendingCategorySuggestionSchema,
  TaxCategorySuggestionSchema,
]);
export type EnrichmentSuggestionResult = z.infer<typeof EnrichmentSuggestionResultSchema>;

// ------------------------------------------------------------------ //
// Worker result — top-level (no tenant/scope/expense selectors)
// ------------------------------------------------------------------ //
export const ExpenseEnrichmentResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  rulesVersion: z.number().int().positive(),
  /**
   * applied: rules ran and result is actionable
   * stale:   expense version changed before worker submitted result
   * skipped: expense was archived/ineligible; nothing to apply
   */
  outcome: z.enum(["applied", "stale", "skipped"]),
  /** Tag keys asserted by deterministic rules. Max 50. */
  ruleTagKeys: z.array(z.string().min(1).max(100)).max(50),
  /** Historical/future suggestions. Max 50. */
  suggestions: z.array(EnrichmentSuggestionResultSchema).max(50),
});
export type ExpenseEnrichmentResultV1 = z.infer<typeof ExpenseEnrichmentResultV1Schema>;

// Re-export suggestion schema for consumers
export { EnrichmentSuggestionResultSchema };
