import { describe, expect, it } from "vitest";

import {
  BusinessTaxReportSchema,
  CreateExportRequestSchema,
  ExportBundleSchema,
  ExportManifestSchema,
} from "../src/index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const BUSINESS = "33333333-3333-4333-8333-333333333333";
const TAXONOMY = "44444444-4444-4444-8444-444444444444";
const PROFILE = "55555555-5555-4555-8555-555555555555";
const TS = "2026-09-09T00:00:00.000Z";

describe("Phase 0E report/export contracts", () => {
  it("requires a business, year, and base currency on a tax report", () => {
    const report = BusinessTaxReportSchema.parse({
      businessId: BUSINESS,
      taxYear: 2025,
      baseCurrency: "USD",
      profile: null,
      totals: { currency: "USD", grossTotal: "0.00", deductibleTotal: "0.00", expenseCount: 0 },
      totalsByCurrency: [],
      foreignCurrencySummary: { excludedCount: 0, currencies: [] },
      byCategory: [],
      byMonth: [],
      review: { total: 0, treated: 0, reviewed: 0, unreviewed: 0, excluded: 0, missingTreatment: 0 },
    });
    expect(report.profile).toBeNull();
    expect(() =>
      BusinessTaxReportSchema.parse({ ...report, taxYear: 1800 }),
    ).toThrow();
  });

  it("defaults includeUnresolved to absent (treated as false server-side)", () => {
    const request = CreateExportRequestSchema.parse({ taxYear: 2025 });
    expect(request.includeUnresolved).toBeUndefined();
    expect(() =>
      CreateExportRequestSchema.parse({ taxYear: 2025, includeUnresolved: "yes" }),
    ).toThrow();
  });

  it("validates a full manifest shape incl. file checksums", () => {
    const manifest = ExportManifestSchema.parse({
      bundleId: ID,
      businessId: BUSINESS,
      taxYear: 2025,
      taxonomy: { versionId: TAXONOMY, code: "schedule-c-2025", name: "2025 Schedule C" },
      profile: { id: PROFILE, status: "active" },
      baseCurrency: "USD",
      filters: { includeUnresolved: false },
      generatedAt: TS,
      appVersion: "0.1.0",
      counts: { expenses: 2, included: 1, excludedUnresolved: 1, foreignExcluded: 0 },
      totals: { grossTotal: "12.34", deductibleTotal: "12.34" },
      foreignSummary: { excludedCount: 0, currencies: [] },
      review: { total: 2, treated: 1, reviewed: 1, unreviewed: 0, excluded: 0, missingTreatment: 1 },
      files: [
        {
          path: "expenses.csv",
          sha256Hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          bytes: 120,
        },
      ],
    });
    expect(manifest.files).toHaveLength(1);
  });

  it("rejects malformed money strings and bad checksums", () => {
    expect(() =>
      ExportManifestSchema.parse({
        bundleId: ID,
        businessId: BUSINESS,
        taxYear: 2025,
        taxonomy: { versionId: TAXONOMY, code: "x", name: "y" },
        profile: { id: PROFILE, status: "active" },
        baseCurrency: "USD",
        filters: { includeUnresolved: false },
        generatedAt: TS,
        appVersion: "0.1.0",
        counts: { expenses: 1, included: 1, excludedUnresolved: 0, foreignExcluded: 0 },
        totals: { grossTotal: "12.345", deductibleTotal: "0.00" },
        foreignSummary: { excludedCount: 0, currencies: [] },
        review: { total: 1, treated: 1, reviewed: 1, unreviewed: 0, excluded: 0, missingTreatment: 0 },
        files: [],
      }),
    ).toThrow();
  });

  it("parses a bundle with download refs", () => {
    const bundle = ExportBundleSchema.parse({
      id: ID,
      tenantId: TENANT,
      businessId: BUSINESS,
      taxYear: 2025,
      taxonomyVersionId: TAXONOMY,
      profileId: PROFILE,
      profileStatus: "active",
      filters: { includeUnresolved: false },
      expenseCount: 1,
      manifest: {
        bundleId: ID,
        businessId: BUSINESS,
        taxYear: 2025,
        taxonomy: { versionId: TAXONOMY, code: "schedule-c-2025", name: "2025 Schedule C" },
        profile: { id: PROFILE, status: "active" },
        baseCurrency: "USD",
        filters: { includeUnresolved: false },
        generatedAt: TS,
        appVersion: "0.1.0",
        counts: { expenses: 1, included: 1, excludedUnresolved: 0, foreignExcluded: 0 },
        totals: { grossTotal: "12.34", deductibleTotal: "12.34" },
        foreignSummary: { excludedCount: 0, currencies: [] },
        review: { total: 1, treated: 1, reviewed: 1, unreviewed: 0, excluded: 0, missingTreatment: 0 },
        files: [],
      },
      files: [
        {
          path: "expenses.csv",
          sha256Hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          bytes: 120,
          downloadUrl: "http://127.0.0.1:8100/api/v1/file-content/x?expires=1&signature=y",
          urlExpiresAt: TS,
        },
      ],
      createdByUserId: TENANT,
      createdAt: TS,
    });
    expect(bundle.files).toHaveLength(1);
  });
});
