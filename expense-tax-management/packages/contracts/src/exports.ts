import { z } from "zod";

import { TaxYearSchema, TimestampSchema } from "./expenses.js";

const MoneyStringSchema = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);

export const BusinessTaxReportParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
  taxYear: z.coerce.number().int().min(1_900).max(9_999),
});
export type BusinessTaxReportParams = z.infer<typeof BusinessTaxReportParamsSchema>;

export const ProjectCostReportParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
  projectId: z.uuid(),
});
export type ProjectCostReportParams = z.infer<typeof ProjectCostReportParamsSchema>;

export const MoneyTotalSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  grossTotal: MoneyStringSchema,
  deductibleTotal: MoneyStringSchema,
  expenseCount: z.int().nonnegative(),
});
export type MoneyTotal = z.infer<typeof MoneyTotalSchema>;

export const CategoryTotalSchema = z.strictObject({
  categoryCode: z.string().min(1).nullable(),
  categoryName: z.string().min(1),
  expenseCount: z.int().nonnegative(),
  grossTotal: MoneyStringSchema,
  deductibleTotal: MoneyStringSchema,
});
export type CategoryTotal = z.infer<typeof CategoryTotalSchema>;

export const MonthTotalSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  expenseCount: z.int().nonnegative(),
  grossTotal: MoneyStringSchema,
  deductibleTotal: MoneyStringSchema,
});
export type MonthTotal = z.infer<typeof MonthTotalSchema>;

export const ReviewSummarySchema = z.strictObject({
  total: z.int().nonnegative(),
  treated: z.int().nonnegative(),
  reviewed: z.int().nonnegative(),
  unreviewed: z.int().nonnegative(),
  excluded: z.int().nonnegative(),
  missingTreatment: z.int().nonnegative(),
});
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

export const ForeignCurrencySummarySchema = z.strictObject({
  excludedCount: z.int().nonnegative(),
  currencies: z.array(z.string().regex(/^[A-Z]{3}$/)),
});
export type ForeignCurrencySummary = z.infer<typeof ForeignCurrencySummarySchema>;

export const BusinessTaxReportSchema = z.strictObject({
  businessId: z.uuid(),
  taxYear: TaxYearSchema,
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  profile: z
    .strictObject({
      id: z.uuid(),
      status: z.string().min(1),
      taxonomyVersionId: z.uuid(),
    })
    .nullable(),
  totals: MoneyTotalSchema,
  totalsByCurrency: z.array(MoneyTotalSchema),
  foreignCurrencySummary: ForeignCurrencySummarySchema,
  byCategory: z.array(CategoryTotalSchema),
  byMonth: z.array(MonthTotalSchema),
  review: ReviewSummarySchema,
});
export type BusinessTaxReport = z.infer<typeof BusinessTaxReportSchema>;

export const SpendingCategoryTotalSchema = z.strictObject({
  categoryId: z.uuid().nullable(),
  categoryName: z.string().min(1),
  expenseCount: z.int().nonnegative(),
  grossTotal: MoneyStringSchema,
});
export type SpendingCategoryTotal = z.infer<typeof SpendingCategoryTotalSchema>;

export const ProjectCostReportSchema = z.strictObject({
  projectId: z.uuid(),
  businessId: z.uuid(),
  projectName: z.string().min(1),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  totals: MoneyTotalSchema,
  totalsByCurrency: z.array(MoneyTotalSchema),
  foreignCurrencySummary: ForeignCurrencySummarySchema,
  byMonth: z.array(MonthTotalSchema),
  bySpendingCategory: z.array(SpendingCategoryTotalSchema),
});
export type ProjectCostReport = z.infer<typeof ProjectCostReportSchema>;

export const CreateExportRequestSchema = z.strictObject({
  taxYear: TaxYearSchema,
  includeUnresolved: z.boolean().optional(),
});
export type CreateExportRequest = z.infer<typeof CreateExportRequestSchema>;

export const BusinessExportParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
});
export type BusinessExportParams = z.infer<typeof BusinessExportParamsSchema>;

export const ExportBundleParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
  exportId: z.uuid(),
});
export type ExportBundleParams = z.infer<typeof ExportBundleParamsSchema>;

export const ExportFileRefSchema = z.strictObject({
  path: z.string().min(1),
  sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.int().nonnegative(),
  downloadUrl: z.string().min(1),
  urlExpiresAt: TimestampSchema,
});
export type ExportFileRef = z.infer<typeof ExportFileRefSchema>;

export const ExportManifestSchema = z.strictObject({
  bundleId: z.uuid(),
  businessId: z.uuid(),
  taxYear: TaxYearSchema,
  taxonomy: z.strictObject({
    versionId: z.uuid(),
    code: z.string().min(1),
    name: z.string().min(1),
  }),
  profile: z.strictObject({
    id: z.uuid(),
    status: z.string().min(1),
  }),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  filters: z.strictObject({ includeUnresolved: z.boolean() }),
  generatedAt: TimestampSchema,
  appVersion: z.string().min(1),
  counts: z.strictObject({
    expenses: z.int().nonnegative(),
    included: z.int().nonnegative(),
    excludedUnresolved: z.int().nonnegative(),
    foreignExcluded: z.int().nonnegative(),
  }),
  totals: z.strictObject({
    grossTotal: MoneyStringSchema,
    deductibleTotal: MoneyStringSchema,
  }),
  foreignSummary: ForeignCurrencySummarySchema,
  review: ReviewSummarySchema,
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.int().nonnegative(),
    }),
  ),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;

export const ExportBundleSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  businessId: z.uuid(),
  taxYear: TaxYearSchema,
  taxonomyVersionId: z.uuid(),
  profileId: z.uuid(),
  profileStatus: z.string().min(1),
  filters: z.strictObject({ includeUnresolved: z.boolean() }),
  expenseCount: z.int().nonnegative(),
  manifest: ExportManifestSchema,
  files: z.array(ExportFileRefSchema),
  createdByUserId: z.uuid(),
  createdAt: TimestampSchema,
});
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export const ExportBundleListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});
export type ExportBundleListQuery = z.infer<typeof ExportBundleListQuerySchema>;

export const ExportBundleListSchema = z.strictObject({
  items: z.array(ExportBundleSchema),
  nextCursor: z.string().nullable(),
});
export type ExportBundleList = z.infer<typeof ExportBundleListSchema>;
