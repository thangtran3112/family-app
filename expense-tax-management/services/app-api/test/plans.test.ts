import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { PlansDomain } from "../src/domain/plans.js";

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

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_USER_ID = "11111111-1111-4111-8111-111111111111";

function tenantPrincipal(): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject: "identity-subject",
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

function servicePrincipal(
  clientId: string,
  scopes: readonly string[],
): AuthPrincipal {
  return {
    tokenType: "service",
    subject: clientId === "foundry-service" ? "ai-worker-foundry-machine" : clientId,
    clientId,
    audience: "expense-app-internal",
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${clientId}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

const PLAN = {
  id: "33333333-3333-4333-8333-333333333333",
  key: "team",
  name: "Team",
  description: null,
  isActive: true,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const SUBSCRIPTION = {
  tenantId: TENANT_ID,
  planKey: "trial",
  planVersionId: "44444444-4444-4444-8444-444444444444",
  status: "trialing" as const,
  currentEntitlementVersion: 1,
  startedAt: "2026-09-08T00:00:00.000Z",
  version: 1,
  updatedAt: "2026-09-08T00:00:00.000Z",
};

describe("App API plans routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const plansDomain: PlansDomain = {
      createPlan: vi.fn(async () => PLAN),
      createPlanVersion: vi.fn(),
      createFeatureDefinition: vi.fn(),
      listPlansAdmin: vi.fn(async () => []),
      listActivePlans: vi.fn(async () => []),
      getSubscription: vi.fn(async () => SUBSCRIPTION),
      updateSubscription: vi.fn(async () => SUBSCRIPTION),
      addAddon: vi.fn(),
      removeAddon: vi.fn(),
      resolveEffectiveEntitlements: vi.fn(async () => []),
      listEntitlementSnapshotsAfter: vi.fn(async () => ({
        items: [],
        nextAfterSequence: null,
      })),
    };
    const resolve = vi.fn(async () => ({
      id: ACTOR_USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active" as const,
    }));
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token !== "tenant-token") throw new Error("wrong token");
        return tenantPrincipal();
      }),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "platform-admin-token") {
          return servicePrincipal("platform-admin", ["plans:manage"]);
        }
        if (token === "platform-admin-missing-scope-token") {
          return servicePrincipal("platform-admin", []);
        }
        if (token === "wrong-principal-token") {
          return servicePrincipal("ai-worker", ["plans:manage"]);
        }
        if (token === "foundry-token") {
          return servicePrincipal("foundry-service", ["entitlements:read"]);
        }
        throw new Error("wrong token");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: { provision: vi.fn(), resolve },
      plansDomain,
    });
    apps.add(app);
    return { app, plansDomain };
  }

  it("prevents tenant tokens from managing plans", async () => {
    const { app, plansDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/plans",
      headers: { authorization: "Bearer tenant-token" },
      payload: { key: "team", name: "Team" },
    });

    expect(response.statusCode).toBe(401);
    expect(plansDomain.createPlan).not.toHaveBeenCalled();
  });

  it("forbids a service token missing the plans:manage scope", async () => {
    const { app, plansDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/plans",
      headers: { authorization: "Bearer platform-admin-missing-scope-token" },
      payload: { key: "team", name: "Team" },
    });

    expect(response.statusCode).toBe(403);
    expect(plansDomain.createPlan).not.toHaveBeenCalled();
  });

  it("forbids a service token with the right scope but wrong principal", async () => {
    const { app, plansDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/plans",
      headers: { authorization: "Bearer wrong-principal-token" },
      payload: { key: "team", name: "Team" },
    });

    expect(response.statusCode).toBe(403);
    expect(plansDomain.createPlan).not.toHaveBeenCalled();
  });

  it("creates a plan for platform-admin with the right scope", async () => {
    const { app, plansDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/plans",
      headers: { authorization: "Bearer platform-admin-token" },
      payload: { key: "team", name: "Team" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(PLAN);
    expect(plansDomain.createPlan).toHaveBeenCalledWith({
      request: { key: "team", name: "Team" },
      actorServicePrincipal: "platform-admin",
      requestId: expect.any(String),
    });
  });

  it("forbids platform-admin from reading entitlement snapshots (wrong principal)", async () => {
    const { app, plansDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/entitlement-snapshots",
      headers: { authorization: "Bearer platform-admin-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(plansDomain.listEntitlementSnapshotsAfter).not.toHaveBeenCalled();
  });

  it("lets foundry-service read entitlement snapshots with a default window", async () => {
    const { app, plansDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/entitlement-snapshots?afterSequence=5",
      headers: { authorization: "Bearer foundry-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(plansDomain.listEntitlementSnapshotsAfter).toHaveBeenCalledWith({
      afterSequence: 5,
      limit: 100,
    });
  });

  it("lists active plans for a tenant token", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/plans",
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it("updates a subscription using the resolved identity, ignoring spoofed headers", async () => {
    const { app, plansDomain } = createTestApp();
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/tenants/${TENANT_ID}/subscription`,
      headers: {
        authorization: "Bearer tenant-token",
        "x-user-id": "spoofed-user",
      },
      payload: { planKey: "team" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(SUBSCRIPTION);
    expect(plansDomain.updateSubscription).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      actorUserId: ACTOR_USER_ID,
      request: { planKey: "team" },
      requestId: expect.any(String),
    });
  });
});
