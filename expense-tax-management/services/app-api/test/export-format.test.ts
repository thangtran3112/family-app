import { describe, expect, it } from "vitest";

import {
  CanonicalExportAdapter,
  escapeCsvCell,
  sha256Hex,
} from "../src/domain/export-format.js";

describe("CSV escaping", () => {
  it("quotes cells containing commas, quotes, or newlines", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell("Deli, Corner")).toBe('"Deli, Corner"');
    expect(escapeCsvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(escapeCsvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(escapeCsvCell("")).toBe("");
  });
});

describe("canonical expenses CSV", () => {
  it("emits a fixed header plus one line per row with trailing newline", () => {
    const csv = CanonicalExportAdapter.buildExpensesCsv([
      {
        expenseId: "11111111-1111-4111-8111-111111111111",
        incurredOn: "2025-03-01",
        merchant: "Corner, Deli",
        description: null,
        amount: "12.34",
        currency: "USD",
        includedInTotals: true,
        spendingCategory: "Meals",
        project: null,
        taxCategoryCode: "meals",
        taxCategoryName: "Meals",
        deductiblePercent: "50.00",
        deductibleAmount: "6.17",
        reviewStatus: "reviewed",
        receiptFileId: null,
        source: "manual",
        status: "ready",
      },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "expense_id,incurred_on,merchant,description,amount,currency,included_in_totals,spending_category,project,tax_category_code,tax_category_name,deductible_percent,deductible_amount,review_status,receipt_file_id,source,status",
    );
    expect(lines[1]).toContain('"Corner, Deli"');
    expect(lines[1]).toContain("6.17");
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("emits header-only output for zero rows", () => {
    const csv = CanonicalExportAdapter.buildExpensesCsv([]);
    expect(csv.split("\n")).toHaveLength(2);
  });
});

describe("mapping CSV", () => {
  it("lists pinned taxonomy categories", () => {
    const csv = CanonicalExportAdapter.buildMappingCsv([
      { code: "meals", name: "Meals", officialForm: "Schedule C", officialLine: "24b" },
    ]);
    expect(csv).toContain("tax_category_code,name,official_form,official_line");
    expect(csv).toContain("meals,Meals,Schedule C,24b");
  });
});

describe("sha256Hex", () => {
  it("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
  });
});
