import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAppConfig } from "../src/config.js";
import type { AuthPrincipal } from "../src/auth/types.js";
import type { ClerkIdentityMappingDomain } from "../src/domain/clerk-identity.js";
import type { TemporalWorkflowStarter } from "../src/temporal/client.js";

const env = {
  AUTH_PROVIDER: "clerk",
  APP_DATABASE_URL: "postgresql://app.test/app",
  TEMPORAL_HOST: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/auth-check-storage",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "test-key",
  INBOUND_EMAIL_BASE_ADDRESS: "receipts@example.test",
  INBOUND_WEBHOOK_SIGNING_KEY: "test-key",
  INBOUND_ROUTING_TOKEN_SECRET: "test-key",
  INBOUND_CHALLENGE_DIR: "/tmp/auth-check-challenges",
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
};

const tenantPrincipal: AuthPrincipal = {
  tokenType: "tenant",
  subject: "clerk-user-123",
  clientId: null,
  audience: "tenant-audience",
  issuer: "https://clerk.test",
  roles: [],
  scopes: [],
  tokenId: "tenant-token",
  email: "person@example.test",
  emailVerified: true,
  displayName: "Person",
  organizationId: "clerk-org-123",
};

const workerPrincipal: AuthPrincipal = {
  tokenType: "service",
  subject: "ai-worker-app-machine",
  clientId: "ai-worker-app-machine",
  audience: "app-service-audience",
  issuer: "https://clerk.test",
  roles: [],
  scopes: ["jobs:write"],
  tokenId: "worker-token",
  email: null,
  emailVerified: null,
  displayName: null,
};

const temporalStarter: TemporalWorkflowStarter = {
  start: async () => ({ workflowId: "test", runId: "test" }),
  close: async () => {},
};

describe("App auth-check routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  it("requires tenant auth and returns mapped tenant/user metadata", async () => {
    const app = buildApp({
      config: createAppConfig({ env }),
      logger: false,
      temporalStarter,
      authVerifiers: {
        tenant: { verify: async () => tenantPrincipal },
        service: { verify: async () => workerPrincipal },
      },
      clerkIdentityDomain: {
        resolveTenantIdentity: async () => ({
          status: "resolved",
          tenantId: "app-tenant-123",
          userId: "app-user-123",
          role: "member",
        }),
      } as ClerkIdentityMappingDomain,
    });
    apps.add(app);

    expect((await app.inject({ method: "GET", url: "/internal/v1/auth-check/tenant" })).statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/auth-check/tenant",
      headers: { authorization: "Bearer tenant-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      claimsVerified: {
        issuer: "https://clerk.test",
        audience: "tenant-audience",
        subject: "clerk-user-123",
        tokenType: "tenant",
      },
      tenantId: "app-tenant-123",
      userId: "app-user-123",
    });
  });

  it("guards worker auth-check with configured subject and scope", async () => {
    const app = buildApp({
      config: createAppConfig({ env }),
      logger: false,
      temporalStarter,
      authVerifiers: {
        tenant: { verify: async () => tenantPrincipal },
        service: { verify: async () => workerPrincipal },
      },
    });
    apps.add(app);

    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/auth-check/worker",
      headers: { authorization: "Bearer worker-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().claimsVerified).toMatchObject({
      subject: "ai-worker-app-machine",
      audience: "app-service-audience",
      tokenType: "service",
    });
  });
});
