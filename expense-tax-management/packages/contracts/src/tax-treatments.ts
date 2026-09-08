import { z } from "zod";

import { TimestampSchema, VersionSchema } from "./expenses.js";

export const TaxTreatmentReviewStatusSchema = z.enum([
  "unreviewed",
  "reviewed",
  "excluded",
]);
export type TaxTreatmentReviewStatus = z.infer<
  typeof TaxTreatmentReviewStatusSchema
>;

export const DeductiblePercentSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) <= 100, "Deductible percent must be 0..100");

export const ExpenseTaxTreatmentSchema = z.strictObject({
  expenseId: z.uuid(),
  tenantId: z.uuid(),
  businessId: z.uuid(),
  taxYear: z.number().int().min(1_900).max(9_999),
  businessTaxProfileId: z.uuid(),
  taxonomyVersionId: z.uuid(),
  taxCategoryDefinitionId: z.uuid(),
  deductiblePercent: DeductiblePercentSchema,
  reviewStatus: TaxTreatmentReviewStatusSchema,
  note: z.string().max(2_000).nullable(),
  version: VersionSchema,
  createdByUserId: z.uuid(),
  updatedByUserId: z.uuid(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ExpenseTaxTreatment = z.infer<typeof ExpenseTaxTreatmentSchema>;

export const ExpenseTaxTreatmentCreateRequestSchema = z.strictObject({
  businessTaxProfileId: z.uuid(),
  taxonomyVersionId: z.uuid(),
  taxCategoryDefinitionId: z.uuid(),
  deductiblePercent: DeductiblePercentSchema,
  reviewStatus: TaxTreatmentReviewStatusSchema,
  note: z.string().trim().max(2_000).nullable().optional(),
});
export type ExpenseTaxTreatmentCreateRequest = z.infer<
  typeof ExpenseTaxTreatmentCreateRequestSchema
>;

export const ExpenseTaxTreatmentUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    businessTaxProfileId: z.uuid().optional(),
    taxonomyVersionId: z.uuid().optional(),
    taxCategoryDefinitionId: z.uuid().optional(),
    deductiblePercent: DeductiblePercentSchema.optional(),
    reviewStatus: TaxTreatmentReviewStatusSchema.optional(),
    note: z.string().trim().max(2_000).nullable().optional(),
  })
  .refine(
    (value) =>
      value.businessTaxProfileId !== undefined ||
      value.taxonomyVersionId !== undefined ||
      value.taxCategoryDefinitionId !== undefined ||
      value.deductiblePercent !== undefined ||
      value.reviewStatus !== undefined ||
      value.note !== undefined,
    { message: "At least one tax treatment change is required" },
  );
export type ExpenseTaxTreatmentUpdateRequest = z.infer<
  typeof ExpenseTaxTreatmentUpdateRequestSchema
>;

export const ExpenseTaxTreatmentParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
  expenseId: z.uuid(),
});
export type ExpenseTaxTreatmentParams = z.infer<
  typeof ExpenseTaxTreatmentParamsSchema
>;
