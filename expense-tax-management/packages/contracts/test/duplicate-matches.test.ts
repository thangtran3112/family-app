import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DeduplicationEvidenceV1Schema,
  DuplicateMatchListSchema,
  DuplicateMatchSchema,
  DuplicateResolutionRequestSchema,
  DuplicateResolutionResponseSchema,
  type DeduplicationEvidenceV1,
} from "../src/index.js";

const ids = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  personalProfileId: "00000000-0000-4000-8000-000000000002",
  businessId: "00000000-0000-4000-8000-000000000003",
  existingExpenseId: "00000000-0000-4000-8000-000000000004",
  candidateExpenseId: "00000000-0000-4000-8000-000000000005",
  matchId: "00000000-0000-4000-8000-000000000006",
  resolvedBy: "00000000-0000-4000-8000-000000000007",
};

const evidence = {
  schemaVersion: 1,
  jobId: "00000000-0000-4000-8000-000000000008",
  sourceFileId: "00000000-0000-4000-8000-000000000009",
  merchant: "Acme Market",
  amount: "12.34",
  currency: "USD",
  incurredOn: "2026-09-11",
  orderNumber: "ORDER-123",
  expectedJobVersion: 2,
  idempotencyKey: "dedup-2026-09-11-1",
};

const match = {
  id: ids.matchId,
  tenantId: ids.tenantId,
  personalProfileId: ids.personalProfileId,
  businessId: null,
  existingExpenseId: ids.existingExpenseId,
  candidateExpenseId: ids.candidateExpenseId,
  matchType: "file_sha256" as const,
  confidence: 1,
  evidence: {
    fileSha256: "a".repeat(64),
  },
  status: "pending" as const,
  version: 1,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-09-11T12:00:00.000Z",
};

describe("deduplication contracts", () => {
  it("accepts strictly scoped duplicate matches", () => {
    expect(DuplicateMatchSchema.parse(match)).toEqual(match);
    expect(
      DuplicateMatchSchema.safeParse({ ...match, extra: true }).success,
    ).toBe(false);
    expect(
      DuplicateMatchSchema.safeParse({
        ...match,
        personalProfileId: null,
        businessId: ids.businessId,
      }).success,
    ).toBe(true);
    expect(
      DuplicateMatchSchema.safeParse({
        ...match,
        personalProfileId: ids.personalProfileId,
        businessId: ids.businessId,
      }).success,
    ).toBe(false);
  });

  it("enforces match types, statuses, and confidence bounds", () => {
    expect(DuplicateMatchSchema.safeParse({ ...match, status: "pending" }).success).toBe(true);
    expect(DuplicateMatchSchema.safeParse({ ...match, status: "merged" }).success).toBe(true);
    expect(DuplicateMatchSchema.safeParse({ ...match, status: "separate" }).success).toBe(true);
    expect(DuplicateMatchSchema.safeParse({ ...match, status: "dismissed" }).success).toBe(true);
    expect(DuplicateMatchSchema.safeParse({ ...match, matchType: "unknown" }).success).toBe(false);
    expect(DuplicateMatchSchema.safeParse({ ...match, confidence: -0.01 }).success).toBe(false);
    expect(DuplicateMatchSchema.safeParse({ ...match, confidence: 1.01 }).success).toBe(false);
  });

  it("validates list, resolution, and strict worker evidence contracts", () => {
    expect(DuplicateMatchListSchema.parse({ items: [match], nextCursor: null })).toEqual({
      items: [match],
      nextCursor: null,
    });
    expect(
      DuplicateResolutionRequestSchema.safeParse({
        action: "merge",
        expectedMatchVersion: 1,
        idempotencyKey: "resolve-1",
      }).success,
    ).toBe(true);
    expect(
      DuplicateResolutionRequestSchema.safeParse({
        action: "delete",
        expectedMatchVersion: 1,
        idempotencyKey: "resolve-1",
      }).success,
    ).toBe(false);
    expect(
      DuplicateResolutionResponseSchema.safeParse({
        matchId: ids.matchId,
        action: "keep_both",
        status: "separate",
        version: 2,
      }).success,
    ).toBe(true);
    expect(DeduplicationEvidenceV1Schema.parse(evidence)).toEqual(evidence);
    expect(
      DeduplicationEvidenceV1Schema.safeParse({ ...evidence, tenantId: ids.tenantId }).success,
    ).toBe(false);
    expect(
      DeduplicationEvidenceV1Schema.safeParse({ ...evidence, amount: "12.345" }).success,
    ).toBe(false);
  });

  it("exports inferred evidence with exact worker fields", () => {
    expectTypeOf<DeduplicationEvidenceV1>().toEqualTypeOf<{
      schemaVersion: 1;
      jobId: string;
      sourceFileId: string;
      merchant: string;
      amount: string;
      currency: string;
      incurredOn: string;
      orderNumber?: string | undefined;
      expectedJobVersion: number;
      idempotencyKey: string;
    }>();
  });
});
