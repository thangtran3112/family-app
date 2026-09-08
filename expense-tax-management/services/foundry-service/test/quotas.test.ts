import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createFoundryConfig } from "../src/config.js";
import type { QuotasDomain } from "../src/domain/quotas.js";

const TEST_ENV = {
  FOUNDRY_PLATFORM_TOKEN_ISSUER: "https://identity.test",
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: "expense-foundry-platform",
  FOUNDRY_PLATFORM_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  FOUNDRY_SERVICE_TOKEN_ISSUER: "https://services.test",
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: "expense-foundry-internal",
  FOUNDRY_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  FOUNDRY_DATABASE_URL: "postgresql://foundry-runtime.test/foundry",
};

const RESERVATION = {
  id: "55555555-5555-4555-8555-555555555555",
  tenantId: "22222222-2222-4222-8222-222222222222",
  operation: "AI_SEARCH" as const,
  aiModelId: "66666666-6666-4666-8666-666666666666",
  idempotencyKey: "job-1",
  status: "RESERVED" as const,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  callStartedAt: null,
  resolvedAt: null,
};

function platformPrincipal(roles: readonly string[]): AuthPrincipal {
  return {
    tokenType: "platform",
    subject: "operator-1",
    clientId: null,
    audience: "expense-foundry-platform",
    issuer: "https://identity.test",
    roles,
    scopes: [],
    tokenId: "platform-token-id",
  };
}

function servicePrincipal(
  clientId: string,
  scopes: readonly string[],
): AuthPrincipal {
  return {
    tokenType: "service",
    subject: `${clientId}-subject`,
    clientId,
    audience: "expense-foundry-internal",
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${clientId}-token-id`,
  };
}

describe("Foundry quota/reservation routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const quotasDomain: QuotasDomain = {
      createTenantAiQuota: vi.fn(),
      listTenantAiQuotas: vi.fn(async () => []),
      reserve: vi.fn(async () => RESERVATION),
      recordCallAttempt: vi.fn(),
      recordProviderOutcome: vi.fn(),
      markReconciliationRequired: vi.fn(),
      release: vi.fn(),
      resolveReconciliation: vi.fn(async () => ({
        ...RESERVATION,
        status: "RECONCILIATION_REQUIRED" as const,
      })),
      getQuotaStatus: vi.fn(async () => ({
        isAvailable: true,
        remainingJobs: 5,
        resetsAt: "2026-10-01T00:00:00.000Z",
      })),
    };
    const platformVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "reconciler-token") return platformPrincipal(["quota_reconciler"]);
        if (token === "catalog-manager-token") return platformPrincipal(["catalog_manager"]);
        throw new Error("wrong token");
      }),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "ai-worker-token") {
          return servicePrincipal("ai-worker", ["reservations:write"]);
        }
        if (token === "ai-worker-missing-scope-token") {
          return servicePrincipal("ai-worker", []);
        }
        if (token === "app-api-token") {
          return servicePrincipal("app-api", ["quota-status:read"]);
        }
        throw new Error("wrong token");
      }),
    };
    const app = buildApp({
      config: createFoundryConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { platform: platformVerifier, service: serviceVerifier },
      quotasDomain,
    });
    apps.add(app);
    return { app, quotasDomain };
  }

  it("reserves for ai-worker with the right scope", async () => {
    const { app, quotasDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/ai-quota-reservations",
      headers: { authorization: "Bearer ai-worker-token" },
      payload: {
        tenantId: RESERVATION.tenantId,
        operation: "AI_SEARCH",
        aiModelId: RESERVATION.aiModelId,
        idempotencyKey: "job-1",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(RESERVATION);
    expect(quotasDomain.reserve).toHaveBeenCalledWith({
      request: {
        tenantId: RESERVATION.tenantId,
        operation: "AI_SEARCH",
        aiModelId: RESERVATION.aiModelId,
        idempotencyKey: "job-1",
      },
      requestId: expect.any(String),
    });
  });

  it("forbids ai-worker missing the reservations:write scope", async () => {
    const { app, quotasDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/ai-quota-reservations",
      headers: { authorization: "Bearer ai-worker-missing-scope-token" },
      payload: {
        tenantId: RESERVATION.tenantId,
        operation: "AI_SEARCH",
        aiModelId: RESERVATION.aiModelId,
        idempotencyKey: "job-1",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(quotasDomain.reserve).not.toHaveBeenCalled();
  });

  it("rejects a catalog_manager platform token from resolving reconciliation (wrong role)", async () => {
    const { app, quotasDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/ai-quota-reservations/${RESERVATION.id}/resolve`,
      headers: { authorization: "Bearer catalog-manager-token" },
      payload: { decision: "released", reason: "test" },
    });

    expect(response.statusCode).toBe(403);
    expect(quotasDomain.resolveReconciliation).not.toHaveBeenCalled();
  });

  it("lets quota_reconciler resolve, using the resolved platform subject not a spoofable field", async () => {
    const { app, quotasDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/ai-quota-reservations/${RESERVATION.id}/resolve`,
      headers: {
        authorization: "Bearer reconciler-token",
        "x-resolved-by": "spoofed-subject",
      },
      payload: { decision: "released", reason: "ambiguous timeout" },
    });

    expect(response.statusCode).toBe(200);
    expect(quotasDomain.resolveReconciliation).toHaveBeenCalledWith({
      reservationId: RESERVATION.id,
      resolvedBySubject: "operator-1",
      request: { decision: "released", reason: "ambiguous timeout" },
      requestId: expect.any(String),
    });
  });

  it("forbids ai-worker (wrong principal) from reading quota status", async () => {
    const { app, quotasDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/quota-status?tenantId=${RESERVATION.tenantId}&operation=AI_SEARCH`,
      headers: { authorization: "Bearer ai-worker-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(quotasDomain.getQuotaStatus).not.toHaveBeenCalled();
  });

  it("lets app-api read quota status", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/quota-status?tenantId=${RESERVATION.tenantId}&operation=AI_SEARCH`,
      headers: { authorization: "Bearer app-api-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      isAvailable: true,
      remainingJobs: 5,
      resetsAt: "2026-10-01T00:00:00.000Z",
    });
  });
});
