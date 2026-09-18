/**
 * Canonical worker input contract for ExpenseEnrichmentWorkflow (Task 3).
 *
 * Security properties:
 * - No tenantId, personalProfileId, businessId, selectors, receipt/OCR text,
 *   receipt bytes, amount, tax descriptions, percentages, or filing/review state.
 * - All arrays and string fields are explicitly bounded.
 * - strictObject / no extra fields at every level.
 * - Eligible Business tax snapshot exact tuple per cross-task contract.
 *
 * Spec authority: 2026-09-12-phase-3c-auto-tagging-design.md
 */
import { z } from "zod";

import { DateOnlySchema, TaxYearSchema, VersionSchema } from "../expenses.js";

// ------------------------------------------------------------------ //
// Eligible tax snapshot (Business only; null for Personal)
// Exact tuple: businessTaxProfileId, businessTaxProfileVersion,
//              taxonomyVersionId, taxYear, activeTaxCategoryIds
// ------------------------------------------------------------------ //
export const EligibleTaxSnapshotSchema = z.strictObject({
  businessTaxProfileId: z.uuid(),
  businessTaxProfileVersion: VersionSchema,
  taxonomyVersionId: z.uuid(),
  taxYear: TaxYearSchema,
  activeTaxCategoryIds: z.array(z.uuid()).max(100),
});
export type EligibleTaxSnapshot = z.infer<typeof EligibleTaxSnapshotSchema>;

// ------------------------------------------------------------------ //
// History bounded aggregate candidate facts
// - max 50 examples (spec: "at most the 50 most recent")
// - bounded candidate arrays, no arbitrary/raw content
// ------------------------------------------------------------------ //

const CandidateTagKeySchema = z.strictObject({
  key: z.string().min(1).max(100),
  count: z.number().int().positive(),
});

const CandidateCategoryIdSchema = z.strictObject({
  id: z.uuid(),
  count: z.number().int().positive(),
});

export const EnrichmentHistorySchema = z.strictObject({
  /** Total qualifying examples seen (0-50). */
  exampleCount: z.number().int().min(0).max(50),
  /** Tag key candidates with occurrence count. Max 20. */
  candidateTagKeys: z.array(CandidateTagKeySchema).max(20),
  /** Spending category ID candidates with occurrence count. Max 10. */
  candidateSpendingCategoryIds: z.array(CandidateCategoryIdSchema).max(10),
  /** Tax category definition ID candidates with occurrence count. Max 10. */
  candidateTaxCategoryIds: z.array(CandidateCategoryIdSchema).max(10),
});
export type EnrichmentHistory = z.infer<typeof EnrichmentHistorySchema>;

// ------------------------------------------------------------------ //
// Worker input — no tenant/scope/expense selectors, no raw content
// ------------------------------------------------------------------ //
export const ExpenseEnrichmentInputV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  expenseId: z.uuid(),
  expenseVersion: VersionSchema,
  /** Normalized merchant slug, null when blank/unknown. Max 100 chars. */
  normalizedMerchant: z.string().trim().min(1).max(100).nullable(),
  /** ISO date the expense was incurred. */
  incurredOn: DateOnlySchema,
  /** Currently selected spending category, null if none. */
  spendingCategoryId: z.uuid().nullable(),
  /** Monotone versioned rules registry version. */
  rulesVersion: z.number().int().positive(),
  /** Tag keys the worker may assert in results. Max 100 entries. */
  eligibleTagKeys: z.array(z.string().min(1).max(100)).max(100),
  /** Spending category IDs the worker may suggest. Max 100 entries. */
  eligibleSpendingCategoryIds: z.array(z.uuid()).max(100),
  /** Full Business tax snapshot for eligibility; null for Personal scope. */
  eligibleTaxSnapshot: EligibleTaxSnapshotSchema.nullable(),
  /** Bounded history summary computed server-side; worker reads only. */
  history: EnrichmentHistorySchema,
});
export type ExpenseEnrichmentInputV1 = z.infer<typeof ExpenseEnrichmentInputV1Schema>;

// ------------------------------------------------------------------ //
// App API response discriminated union (consumed by Task 4 / 7)
// - evaluate: provides input for the worker to act on
// - stale:    expense version changed; worker should mark job stale
// - skipped:  expense archived/ineligible; worker should mark job skipped
// ------------------------------------------------------------------ //
export const ExpenseEnrichmentInputResponseV1Schema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("evaluate"),
    input: ExpenseEnrichmentInputV1Schema,
  }),
  z.strictObject({
    outcome: z.literal("stale"),
  }),
  z.strictObject({
    outcome: z.literal("skipped"),
  }),
]);
export type ExpenseEnrichmentInputResponseV1 = z.infer<typeof ExpenseEnrichmentInputResponseV1Schema>;
