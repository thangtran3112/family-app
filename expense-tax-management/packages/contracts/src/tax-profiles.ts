import { z } from "zod";

import { TaxYearSchema, TimestampSchema, VersionSchema } from "./expenses.js";

export const TaxFormSchema = z.literal("schedule_c");
export const AccountingMethodSchema = z.enum(["cash", "accrual"]);
export const BusinessTaxProfileStatusSchema = z.enum([
  "draft",
  "active",
  "closed",
]);
export type BusinessTaxProfileStatus = z.infer<
  typeof BusinessTaxProfileStatusSchema
>;

export const BusinessTaxProfileSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  businessId: z.uuid(),
  taxYear: TaxYearSchema,
  taxonomyVersionId: z.uuid(),
  taxForm: TaxFormSchema,
  accountingMethod: AccountingMethodSchema,
  status: BusinessTaxProfileStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type BusinessTaxProfile = z.infer<typeof BusinessTaxProfileSchema>;

export const BusinessTaxProfileCreateRequestSchema = z.strictObject({
  taxYear: TaxYearSchema,
  accountingMethod: AccountingMethodSchema,
});
export type BusinessTaxProfileCreateRequest = z.infer<
  typeof BusinessTaxProfileCreateRequestSchema
>;

export const BusinessTaxProfileUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    accountingMethod: AccountingMethodSchema.optional(),
    status: z.enum(["draft", "active", "closed"]).optional(),
  })
  .refine(
    (value) => value.accountingMethod !== undefined || value.status !== undefined,
    { message: "At least one tax profile change is required" },
  );
export type BusinessTaxProfileUpdateRequest = z.infer<
  typeof BusinessTaxProfileUpdateRequestSchema
>;

export const BusinessTaxProfileCloseRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});
export type BusinessTaxProfileCloseRequest = z.infer<
  typeof BusinessTaxProfileCloseRequestSchema
>;

export const BusinessTaxProfileListSchema = z.strictObject({
  items: z.array(BusinessTaxProfileSchema),
});
export type BusinessTaxProfileList = z.infer<typeof BusinessTaxProfileListSchema>;

export const BusinessTaxProfileParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
  taxYear: z.coerce.number().int().min(1_900).max(9_999),
});
export type BusinessTaxProfileParams = z.infer<
  typeof BusinessTaxProfileParamsSchema
>;
