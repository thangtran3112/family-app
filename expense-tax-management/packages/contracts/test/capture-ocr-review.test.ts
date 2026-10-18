import { describe, expect, it } from "vitest";

import {
  CaptureOcrCompleteRequestV1Schema,
  CaptureOcrIssueCodeSchema,
  CaptureOcrResultV1Schema,
  CaptureOcrReviewPolicySchema,
  CaptureOcrTaxInputV1Schema,
  CreateOcrJobRequestSchema,
  ExpenseSchema,
  OcrJobInputV1Schema,
} from "../src/index.js";

const FILE_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";

const completeFields = {
  merchant: "Market",
  total: "12.34",
  currency: "USD",
  incurredOn: "2026-10-17",
  taxAmount: "1.23",
} as const;

const expenseResponse = {
  id: "33333333-3333-4333-8333-333333333333",
  tenantId: TENANT_ID,
  createdByUserId: "44444444-4444-4444-8444-444444444444",
  personalProfileId: FILE_ID,
  businessId: null,
  projectId: null,
  spendingCategoryId: null,
  merchant: "Market",
  description: null,
  amount: "12.34",
  currency: "USD",
  incurredOn: "2026-10-17",
  taxYear: 2026,
  source: "ocr",
  mailboxProvenance: null,
  status: "ready",
  version: 1,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
} as const;

describe("Capture OCR review contracts", () => {
  it("parses an expense response without tax amount", () => {
    expect(ExpenseSchema.parse(expenseResponse)).toMatchObject(expenseResponse);
  });

  it("parses an expense response with null tax amount", () => {
    expect(ExpenseSchema.parse({ ...expenseResponse, taxAmount: null }).taxAmount).toBeNull();
  });

  it("parses an expense response with a decimal tax amount", () => {
    expect(ExpenseSchema.parse({ ...expenseResponse, taxAmount: "5.53" }).taxAmount).toBe(
      "5.53",
    );
  });

  it("rejects invalid expense response tax amounts", () => {
    for (const taxAmount of ["-1", "1.001"]) {
      expect(ExpenseSchema.safeParse({ ...expenseResponse, taxAmount }).success).toBe(false);
    }
  });

  it("parses complete and incomplete OCR review results", () => {
    expect(
      CaptureOcrResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "complete",
        fields: completeFields,
      }),
    ).toEqual({ schemaVersion: 1, outcome: "complete", fields: completeFields });

    expect(
      CaptureOcrResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "needs_input",
        fields: {
          merchant: null,
          total: "0.00",
          currency: null,
          incurredOn: null,
          taxAmount: null,
        },
        issues: ["merchant_missing", "tax_missing"],
      }),
    ).toMatchObject({ issues: ["merchant_missing", "tax_missing"] });

    expect(
      CaptureOcrResultV1Schema.safeParse({
        schemaVersion: 1,
        outcome: "needs_input",
        fields: completeFields,
        issues: [],
      }).success,
    ).toBe(false);
    expect(
      CaptureOcrResultV1Schema.safeParse({
        schemaVersion: 1,
        outcome: "complete",
        fields: { ...completeFields, total: "0.00" },
      }).success,
    ).toBe(false);
    expect(
      CaptureOcrResultV1Schema.safeParse({
        schemaVersion: 1,
        outcome: "complete",
        fields: { ...completeFields, taxAmount: "0.00" },
      }).success,
    ).toBe(false);
    expect(
      CaptureOcrResultV1Schema.safeParse({
        schemaVersion: 1,
        outcome: "complete",
        fields: { ...completeFields, taxAmount: "12.35" },
      }).success,
    ).toBe(false);
  });

  it("accepts every canonical issue code", () => {
    const issueCodes = [
      "merchant_missing",
      "total_missing",
      "total_zero",
      "currency_missing",
      "date_missing",
      "tax_missing",
      "tax_zero_requires_confirmation",
    ] as const;

    expect(CaptureOcrIssueCodeSchema.options).toEqual(issueCodes);
    for (const issue of issueCodes) {
      expect(
        CaptureOcrResultV1Schema.parse({
          schemaVersion: 1,
          outcome: "needs_input",
          fields: {
            merchant: null,
            total: null,
            currency: null,
            incurredOn: null,
            taxAmount: null,
          },
          issues: [issue],
        }),
      ).toMatchObject({ issues: [issue] });
    }
  });

  it("requires positive amount tax and reserves zero tax for no_tax", () => {
    expect(
      CaptureOcrTaxInputV1Schema.parse({ kind: "amount", amount: "1.23" }),
    ).toEqual({ kind: "amount", amount: "1.23" });
    for (const amount of ["0", "0.00", "-1.00", "1.234"]) {
      expect(
        CaptureOcrTaxInputV1Schema.safeParse({ kind: "amount", amount }).success,
      ).toBe(false);
    }
    expect(CaptureOcrTaxInputV1Schema.parse({ kind: "no_tax" })).toEqual({
      kind: "no_tax",
    });
  });

  it("validates corrected fields and rejects tax greater than total", () => {
    const request = {
      expectedJobVersion: 1,
      merchant: "Market",
      total: "12.34",
      currency: "USD",
      incurredOn: "2026-10-17",
      tax: { kind: "amount", amount: "1.23" },
    } as const;

    expect(CaptureOcrCompleteRequestV1Schema.parse(request)).toEqual(request);
    expect(
      CaptureOcrCompleteRequestV1Schema.safeParse({
        ...request,
        tax: { kind: "amount", amount: "12.35" },
      }).success,
    ).toBe(false);
    expect(
      CaptureOcrCompleteRequestV1Schema.parse({
        ...request,
        tax: { kind: "no_tax" },
      }).tax,
    ).toEqual({ kind: "no_tax" });
  });

  it("keeps review policy optional for existing OCR callers", () => {
    expect(CreateOcrJobRequestSchema.parse({ modeKey: "ocr_mode_fast" })).toEqual({
      modeKey: "ocr_mode_fast",
    });
    expect(
      CreateOcrJobRequestSchema.parse({
        modeKey: "ocr_mode_fast",
        reviewPolicy: "capture_required_fields_v1",
      }).reviewPolicy,
    ).toBe("capture_required_fields_v1");

    const input = {
      schemaVersion: 1,
      fileId: FILE_ID,
      modeKey: "ocr_mode_fast",
      expectedSha256: null,
      tenantId: TENANT_ID,
    } as const;
    expect(OcrJobInputV1Schema.parse(input)).toEqual(input);
    expect(
      OcrJobInputV1Schema.parse({
        ...input,
        reviewPolicy: CaptureOcrReviewPolicySchema.value,
      }).reviewPolicy,
    ).toBe("capture_required_fields_v1");
  });
});
