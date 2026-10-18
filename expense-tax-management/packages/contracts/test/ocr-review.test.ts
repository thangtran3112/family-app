import { describe, expect, it } from "vitest";

import {
  BusinessOcrReviewJobParamsSchema,
  CaptureOcrReviewDetailV1Schema,
  CaptureOcrReviewListV1Schema,
  CaptureOcrReviewStatusQuerySchema,
  CaptureOcrReviewCompleteResponseV1Schema,
  PersonalOcrReviewJobParamsSchema,
} from "../src/ocr-review.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";
const tenantId = "33333333-3333-4333-8333-333333333333";
const profileId = "44444444-4444-4444-8444-444444444444";
const businessId = "55555555-5555-4555-8555-555555555555";

const item = {
  schemaVersion: 1,
  jobId,
  fileId,
  jobVersion: 4,
  fields: {
    merchant: "Acme",
    total: "42.50",
    currency: "USD",
    incurredOn: null,
    taxAmount: "0.00",
  },
  issues: ["date_missing", "tax_zero_requires_confirmation"],
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:01:00.000Z",
} as const;

describe("OCR review endpoint contracts", () => {
  it("requires the needs_input list status", () => {
    expect(CaptureOcrReviewStatusQuerySchema.parse({ status: "needs_input" })).toEqual({
      status: "needs_input",
      limit: 50,
    });
    expect(CaptureOcrReviewStatusQuerySchema.parse({ status: "needs_input", limit: "100" })).toEqual({
      status: "needs_input",
      limit: 100,
    });
    expect(
      CaptureOcrReviewStatusQuerySchema.safeParse({ status: "needs_input", limit: "101" }).success,
    ).toBe(false);
    expect(CaptureOcrReviewStatusQuerySchema.safeParse({ status: "complete" }).success).toBe(false);
  });

  it("parses exact Personal and business job scopes", () => {
    expect(PersonalOcrReviewJobParamsSchema.parse({ tenantId, profileId, jobId })).toEqual({ tenantId, profileId, jobId });
    expect(BusinessOcrReviewJobParamsSchema.parse({ tenantId, businessId, jobId })).toEqual({ tenantId, businessId, jobId });
  });

  it("parses review lists and signed preview details", () => {
    expect(CaptureOcrReviewListV1Schema.parse({ items: [item], nextCursor: null })).toEqual({
      items: [item],
      nextCursor: null,
    });
    expect(CaptureOcrReviewDetailV1Schema.parse({
      ...item,
      previewUrl: "/api/v1/file-content/signed",
      previewExpiresAt: "2026-10-18T00:16:00.000Z",
    })).toMatchObject({ jobId, fileId, previewUrl: "/api/v1/file-content/signed" });
  });

  it("parses completion responses", () => {
    expect(CaptureOcrReviewCompleteResponseV1Schema.parse({
      schemaVersion: 1,
      jobId,
      expenseId: fileId,
      jobVersion: 5,
      duplicateDecision: "review",
      duplicateMatchIds: [profileId],
    })).toMatchObject({ jobId, expenseId: fileId, duplicateDecision: "review" });
  });
});
