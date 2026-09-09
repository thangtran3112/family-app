import { createHash } from "node:crypto";

import type { ExportManifest } from "@expense-tax/contracts";

export interface ExportExpenseRow {
  readonly expenseId: string;
  readonly incurredOn: string;
  readonly merchant: string;
  readonly description: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly includedInTotals: boolean;
  readonly spendingCategory: string | null;
  readonly project: string | null;
  readonly taxCategoryCode: string | null;
  readonly taxCategoryName: string | null;
  readonly deductiblePercent: string | null;
  readonly deductibleAmount: string;
  readonly reviewStatus: string | null;
  readonly receiptFileId: string | null;
  readonly source: string;
  readonly status: string;
}

export interface ExportCategoryRow {
  readonly code: string;
  readonly name: string;
  readonly officialForm: string | null;
  readonly officialLine: string | null;
}

export interface ManifestCounts {
  readonly expenses: number;
  readonly included: number;
  readonly excludedUnresolved: number;
  readonly foreignExcluded: number;
}

export interface ManifestFileRef {
  readonly path: string;
  readonly sha256Hex: string;
  readonly bytes: number;
}

export interface ManifestInput {
  readonly bundleId: string;
  readonly businessId: string;
  readonly taxYear: number;
  readonly taxonomy: { readonly versionId: string; readonly code: string; readonly name: string };
  readonly profile: { readonly id: string; readonly status: string };
  readonly baseCurrency: string;
  readonly includeUnresolved: boolean;
  readonly generatedAt: string;
  readonly appVersion: string;
  readonly counts: ManifestCounts;
  readonly grossTotal: string;
  readonly deductibleTotal: string;
  readonly foreignSummary: { readonly excludedCount: number; readonly currencies: readonly string[] };
  readonly review: {
    readonly total: number;
    readonly treated: number;
    readonly reviewed: number;
    readonly unreviewed: number;
    readonly excluded: number;
    readonly missingTreatment: number;
  };
  readonly files: readonly ManifestFileRef[];
}

/**
 * Future tax-software adapters (TXF, IRS forms, connected-app payloads)
 * implement this interface. None may file a return — adapters produce
 * files for human review/import only.
 */
export interface ExportAdapter {
  buildExpensesCsv(rows: readonly ExportExpenseRow[]): string;
  buildMappingCsv(categories: readonly ExportCategoryRow[]): string;
  buildManifest(input: ManifestInput): ExportManifest;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function escapeCsvCell(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const EXPENSE_CSV_HEADER = [
  "expense_id",
  "incurred_on",
  "merchant",
  "description",
  "amount",
  "currency",
  "included_in_totals",
  "spending_category",
  "project",
  "tax_category_code",
  "tax_category_name",
  "deductible_percent",
  "deductible_amount",
  "review_status",
  "receipt_file_id",
  "source",
  "status",
].join(",");

const MAPPING_CSV_HEADER = [
  "tax_category_code",
  "name",
  "official_form",
  "official_line",
].join(",");

function expenseRowToCsv(row: ExportExpenseRow): string {
  return [
    row.expenseId,
    row.incurredOn,
    escapeCsvCell(row.merchant),
    escapeCsvCell(row.description ?? ""),
    row.amount,
    row.currency,
    row.includedInTotals ? "true" : "false",
    escapeCsvCell(row.spendingCategory ?? ""),
    escapeCsvCell(row.project ?? ""),
    row.taxCategoryCode ?? "",
    escapeCsvCell(row.taxCategoryName ?? ""),
    row.deductiblePercent ?? "",
    row.deductibleAmount,
    row.reviewStatus ?? "",
    row.receiptFileId ?? "",
    row.source,
    row.status,
  ].join(",");
}

export const CanonicalExportAdapter: ExportAdapter = {
  buildExpensesCsv(rows: readonly ExportExpenseRow[]): string {
    return `${[EXPENSE_CSV_HEADER, ...rows.map(expenseRowToCsv)].join("\n")}\n`;
  },

  buildMappingCsv(categories: readonly ExportCategoryRow[]): string {
    const lines = categories.map((category) =>
      [
        category.code,
        escapeCsvCell(category.name),
        escapeCsvCell(category.officialForm ?? ""),
        escapeCsvCell(category.officialLine ?? ""),
      ].join(","),
    );
    return `${[MAPPING_CSV_HEADER, ...lines].join("\n")}\n`;
  },

  buildManifest(input: ManifestInput): ExportManifest {
    return {
      bundleId: input.bundleId,
      businessId: input.businessId,
      taxYear: input.taxYear,
      taxonomy: { ...input.taxonomy },
      profile: { ...input.profile },
      baseCurrency: input.baseCurrency,
      filters: { includeUnresolved: input.includeUnresolved },
      generatedAt: input.generatedAt,
      appVersion: input.appVersion,
      counts: { ...input.counts },
      totals: {
        grossTotal: input.grossTotal,
        deductibleTotal: input.deductibleTotal,
      },
      foreignSummary: {
        excludedCount: input.foreignSummary.excludedCount,
        currencies: [...input.foreignSummary.currencies],
      },
      review: { ...input.review },
      files: input.files.map((file) => ({ ...file })),
    };
  },
};
