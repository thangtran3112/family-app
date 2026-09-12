import {
  DuplicateMatchListSchema,
  DuplicateResolutionResponseSchema,
  type DuplicateMatch,
  type AuthenticatedUser,
} from "@expense-tax/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { DeduplicationDomain } from "../src/domain/deduplication.js";

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

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const BUSINESS_ID = "44444444-4444-4444-8444-444444444444";
const MATCH_ID = "55555555-5555-4555-8555-555555555555";
const EXISTING_EXPENSE_ID = "66666666-6666-4666-8666-666666666666";
const CANDIDATE_EXPENSE_ID = "77777777-7777-4777-8777-777777777777";
const TIMESTAMP = "2026-09-11T00:00:00.000Z";

const MATCH: DuplicateMatch = {
  id: MATCH_ID,
  tenantId: TENANT_ID,
  personalProfileId: PROFILE_ID,
  businessId: null,
  existingExpenseId: EXISTING_EXPENSE_ID,
  candidateExpenseId: CANDIDATE_EXPENSE_ID,
  matchType: "fingerprint",
  confidence: 1,
  evidence: { fingerprintHash: "a".repeat(64) },
  status: "pending",
  version: 1,
  resolvedBy: null,
  resolvedAt: null,
  resolutionIdempotencyKey: null,
  idempotencyKey: "evidence-1",
  createdAt: TIMESTAMP,
};

function principal(): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject: "tenant-user",
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: "tenant-token-id",
    email: "owner@example.test",
    emailVerified: true,
    displayName: "Owner",
  };
}

describe("duplicate resolution routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const listMatches = vi.fn(async () => ({ items: [MATCH], nextCursor: null }));
    const resolveMatch = vi.fn(async (input: {
      action: "merge" | "keep_both" | "discard_new";
      matchId: string;
      expectedMatchVersion: number;
      idempotencyKey: string;
    }) => ({
      matchId: input.matchId,
      action: input.action,
      status: input.action === "merge" ? "merged" as const : input.action === "keep_both" ? "separate" as const : "dismissed" as const,
      version: input.expectedMatchVersion + 1,
      idempotencyKey: input.idempotencyKey,
    }));
    const domain: DeduplicationDomain = {
      recordEvidence: vi.fn(async () => ({ decision: "no_match" as const, matchIds: [] })),
      listMatches,
      resolveMatch,
    };
    const identityResolver = {
      resolve: vi.fn(async (): Promise<AuthenticatedUser> => ({
        id: USER_ID,
        primaryEmail: "owner@example.test",
        displayName: "Owner",
        status: "active",
      })),
    };
    const tenantVerifier: TokenVerifier = { verify: vi.fn(async () => principal()) };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      },
      identityDomain: identityResolver,
      deduplicationDomain: domain,
    });
    apps.add(app);
    return { app, listMatches, resolveMatch };
  }

  it("lists Personal matches inside explicit profile scope", async () => {
    const { app, listMatches } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/duplicate-matches?status=pending&limit=10&cursor=cursor-1`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(DuplicateMatchListSchema.parse(response.json())).toEqual({
      items: [MATCH],
      nextCursor: null,
    });
    expect(listMatches).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID },
      status: "pending",
      limit: 10,
      cursor: "cursor-1",
    });
  });

  it.each([
    ["merge", "merged"],
    ["keep_both", "separate"],
    ["discard_new", "dismissed"],
  ] as const)("resolves Business match with %s", async (action, status) => {
    const { app, resolveMatch } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/duplicate-matches/${MATCH_ID}/resolve`,
      headers: { authorization: "Bearer tenant-token" },
      payload: {
        action,
        expectedMatchVersion: 1,
        idempotencyKey: `resolve-${action}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(DuplicateResolutionResponseSchema.parse(response.json())).toEqual({
      matchId: MATCH_ID,
      action,
      status,
      version: 2,
      idempotencyKey: `resolve-${action}`,
    });
    expect(resolveMatch).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "business", businessId: BUSINESS_ID },
      matchId: MATCH_ID,
      action,
      expectedMatchVersion: 1,
      idempotencyKey: `resolve-${action}`,
      requestId: expect.any(String),
    });
  });
});
