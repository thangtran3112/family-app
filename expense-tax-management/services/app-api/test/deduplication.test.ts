import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import { DeduplicationEvidenceV1Schema } from "@expense-tax/contracts";
import {
  buildDeduplicationFingerprint,
  buildMatchIdempotencyKey,
  findDeterministicCandidates,
  normalizeMerchant,
  resolveCandidateExpenseId,
  toAmountMinorUnits,
  type DeduplicationDomain,
} from "../src/domain/deduplication.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
};

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";
const MATCH_ID = "33333333-3333-4333-8333-333333333333";

function servicePrincipal(
  clientId: string,
  scopes: readonly string[],
): AuthPrincipal {
  return {
    tokenType: "service",
    subject: "ai-worker-app-machine",
    clientId,
    audience: "expense-app-internal",
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: "worker-token-id",
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

describe("deduplication canonicalization", () => {
  it("normalizes Unicode merchant names and decimal money deterministically", () => {
    expect(normalizeMerchant("  Café   Déjà-Vu, Inc. ")).toBe("cafe dejavu inc");
    expect(toAmountMinorUnits("12.30")).toBe(1230);
    expect(buildDeduplicationFingerprint({
      merchant: "  Café   Déjà-Vu, Inc. ",
      amount: "12.30",
      currency: "usd",
      incurredOn: "2026-09-11",
    })).toMatchObject({
      version: 1,
      normalizedMerchant: "cafe dejavu inc",
      amountMinorUnits: 1230,
      currency: "USD",
      incurredOn: "2026-09-11",
    });
  });

  it("rejects incomplete fingerprint evidence while allowing exact file evidence", () => {
    expect(buildDeduplicationFingerprint({
      merchant: "",
      amount: "12.30",
      currency: "USD",
      incurredOn: "2026-09-11",
    })).toBeNull();
    expect(() => DeduplicationEvidenceV1Schema.parse({
      schemaVersion: 1,
      jobId: JOB_ID,
      sourceFileId: FILE_ID,
      expectedJobVersion: 3,
      idempotencyKey: "dedup-sha-only",
    })).not.toThrow();
  });

  it("rejects unsafe money, invalid dates, and non-canonical currencies", () => {
    expect(() => buildDeduplicationFingerprint({
      merchant: "Cafe",
      amount: "0.00",
      currency: "USD",
      incurredOn: "2026-09-11",
    })).toThrow();
    expect(() => buildDeduplicationFingerprint({
      merchant: "Cafe",
      amount: "1.234",
      currency: "USD",
      incurredOn: "2026-09-11",
    })).toThrow();
    expect(() => buildDeduplicationFingerprint({
      merchant: "Cafe",
      amount: "1.00",
      currency: "US",
      incurredOn: "2026-09-11",
    })).toThrow();
    expect(() => buildDeduplicationFingerprint({
      merchant: "Cafe",
      amount: "1.00",
      currency: " usd ",
      incurredOn: "2026-02-30",
    })).toThrow();
  });

  it("uses documented currency scales in canonical minor units", () => {
    expect(buildDeduplicationFingerprint({
      merchant: "Tokyo Shop",
      amount: "1000",
      currency: "jpy",
      incurredOn: "2026-09-11",
    })).toMatchObject({ amountMinorUnits: 1000, currency: "JPY" });
    expect(buildDeduplicationFingerprint({
      merchant: "Kuwait Shop",
      amount: "1.23",
      currency: "KWD",
      incurredOn: "2026-09-11",
    })).toMatchObject({ amountMinorUnits: 1230, currency: "KWD" });
    expect(buildDeduplicationFingerprint({
      merchant: "Large Tokyo Shop",
      amount: "9007199254740991",
      currency: "JPY",
      incurredOn: "2026-09-11",
    })).toMatchObject({ amountMinorUnits: 9007199254740991, currency: "JPY" });
  });

  it("bounds derived match idempotency keys while preserving identity", () => {
    const longRequestKey = "x".repeat(255);
    const first = buildMatchIdempotencyKey(longRequestKey, "fuzzy_fields", "expense-1");
    expect(first).toHaveLength(70);
    expect(first).toBe(buildMatchIdempotencyKey(longRequestKey, "fuzzy_fields", "expense-1"));
    expect(first).not.toBe(buildMatchIdempotencyKey(longRequestKey, "fingerprint", "expense-1"));
  });

  it("rejects an unbound or mismatched candidate expense", () => {
    expect(() => resolveCandidateExpenseId({
      targetAggregateId: null,
      fileExpenseId: null,
    })).toThrow();
    expect(() => resolveCandidateExpenseId({
      targetAggregateId: "target",
      fileExpenseId: "different",
    })).toThrow();
    expect(resolveCandidateExpenseId({
      targetAggregateId: "target",
      fileExpenseId: "target",
    })).toBe("target");
  });

  it("matches exact and fuzzy candidates only inside exact tenant-derived scope", () => {
    const fingerprint = buildDeduplicationFingerprint({
      merchant: "Cafe",
      amount: "100.00",
      currency: "USD",
      incurredOn: "2026-09-11",
    });
    const candidates = findDeterministicCandidates({
      scope: { kind: "personal", profileId: "33333333-3333-4333-8333-333333333333" },
      candidateExpenseId: "candidate-expense",
      file: {
        expenseId: "candidate-expense",
        sha256Hex: "a".repeat(64),
        personalProfileId: "33333333-3333-4333-8333-333333333333",
        businessId: null,
      },
      fingerprint,
      files: [
        {
          expenseId: "same-file",
          sha256Hex: "a".repeat(64),
          status: "READY",
          personalProfileId: "33333333-3333-4333-8333-333333333333",
          businessId: null,
        },
        {
          expenseId: "deleted-file",
          sha256Hex: "a".repeat(64),
          status: "DELETED",
          personalProfileId: "33333333-3333-4333-8333-333333333333",
          businessId: null,
        },
        {
          expenseId: "other-profile",
          sha256Hex: "a".repeat(64),
          personalProfileId: "44444444-4444-4444-8444-444444444444",
          businessId: null,
        },
      ],
      fingerprints: [
        {
          expenseId: "same-fingerprint",
          fingerprintHash: fingerprint.hash,
          normalizedMerchant: fingerprint.normalizedMerchant,
          amountMinorUnits: fingerprint.amountMinorUnits,
          currency: fingerprint.currency,
          incurredOn: fingerprint.incurredOn,
          personalProfileId: "33333333-3333-4333-8333-333333333333",
          businessId: null,
        },
        {
          expenseId: "fuzzy",
          fingerprintHash: "b".repeat(64),
          normalizedMerchant: fingerprint.normalizedMerchant,
          amountMinorUnits: 10400,
          currency: fingerprint.currency,
          incurredOn: "2026-09-13",
          personalProfileId: "33333333-3333-4333-8333-333333333333",
          businessId: null,
        },
        {
          expenseId: "different-currency",
          fingerprintHash: "c".repeat(64),
          normalizedMerchant: fingerprint.normalizedMerchant,
          amountMinorUnits: 10100,
          currency: "CAD",
          incurredOn: "2026-09-12",
          personalProfileId: "33333333-3333-4333-8333-333333333333",
          businessId: null,
        },
        {
          expenseId: "other-business",
          fingerprintHash: fingerprint.hash,
          normalizedMerchant: fingerprint.normalizedMerchant,
          amountMinorUnits: fingerprint.amountMinorUnits,
          currency: fingerprint.currency,
          incurredOn: fingerprint.incurredOn,
          personalProfileId: null,
          businessId: "55555555-5555-4555-8555-555555555555",
        },
      ],
    });

    expect(candidates.map(({ existingExpenseId, matchType }) => ({ existingExpenseId, matchType }))).toEqual([
      { existingExpenseId: "same-file", matchType: "file_sha256" },
      { existingExpenseId: "same-fingerprint", matchType: "fingerprint" },
      { existingExpenseId: "fuzzy", matchType: "fuzzy_fields" },
    ]);
    expect(candidates).not.toContainEqual(expect.objectContaining({ existingExpenseId: "deleted-file" }));
    expect(candidates[2]?.evidence).toMatchObject({
      existingAmountMinorUnits: 10400,
      candidateAmountMinorUnits: 10000,
      existingIncurredOn: "2026-09-13",
      candidateIncurredOn: "2026-09-11",
    });
  });

  it("only queries READY source files for exact SHA candidates", () => {
    const source = readFileSync(
      new URL("../src/domain/deduplication.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('.where("file.status", "=", "READY")');
  });
});

describe("App API deduplication callback route", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  it("accepts only the authenticated worker and passes opaque evidence to the domain", async () => {
    const deduplicationDomain: DeduplicationDomain = {
      recordEvidence: vi.fn(async () => ({ decision: "review" as const, matchIds: [MATCH_ID] })),
      listMatches: vi.fn(async () => ({ items: [], nextCursor: null })),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "worker-token") return servicePrincipal("ai-worker", ["jobs:write"]);
        throw new Error("wrong token");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: { verify: vi.fn(async () => { throw new Error("no tenant token"); }) },
        service: serviceVerifier,
      },
      deduplicationDomain,
    });
    apps.add(app);

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/deduplication`,
      headers: { authorization: "Bearer worker-token" },
      payload: {
        schemaVersion: 1,
        jobId: JOB_ID,
        sourceFileId: FILE_ID,
        merchant: "Cafe",
        amount: "12.30",
        currency: "USD",
        incurredOn: "2026-09-11",
        expectedJobVersion: 2,
        idempotencyKey: "dedup-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ decision: "review", matchIds: [MATCH_ID] });
    expect(deduplicationDomain.recordEvidence).toHaveBeenCalledWith({
      request: expect.objectContaining({ jobId: JOB_ID, sourceFileId: FILE_ID }),
      actorServicePrincipal: "ai-worker",
      requestId: expect.any(String),
    });
  });

  it("rejects evidence that tries to select tenant or scope", async () => {
    const deduplicationDomain: DeduplicationDomain = {
      recordEvidence: vi.fn(async () => ({ decision: "no_match" as const, matchIds: [] })),
      listMatches: vi.fn(async () => ({ items: [], nextCursor: null })),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async () => servicePrincipal("ai-worker", ["jobs:write"])),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: { verify: vi.fn(async () => { throw new Error("no tenant token"); }) },
        service: serviceVerifier,
      },
      deduplicationDomain,
    });
    apps.add(app);

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/deduplication`,
      headers: { authorization: "Bearer worker-token" },
      payload: {
        schemaVersion: 1,
        jobId: JOB_ID,
        sourceFileId: FILE_ID,
        merchant: "Cafe",
        amount: "12.30",
        currency: "USD",
        incurredOn: "2026-09-11",
        expectedJobVersion: 2,
        idempotencyKey: "dedup-1",
        tenantId: "44444444-4444-4444-8444-444444444444",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(deduplicationDomain.recordEvidence).not.toHaveBeenCalled();
  });
});
