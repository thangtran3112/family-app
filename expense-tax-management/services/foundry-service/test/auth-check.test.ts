import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createFoundryConfig } from "../src/config.js";
import type { AuthPrincipal } from "../src/auth/types.js";
import type { PlatformOperatorDomain } from "../src/domain/platform-operators.js";

const env = {
  AUTH_PROVIDER: "clerk",
  FOUNDRY_DATABASE_URL: "postgresql://foundry.test/foundry",
  FOUNDRY_PLATFORM_TOKEN_ISSUER: "https://identity.test",
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: "expense-foundry-platform",
  FOUNDRY_PLATFORM_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  FOUNDRY_SERVICE_TOKEN_ISSUER: "https://services.test",
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: "expense-foundry-internal",
  FOUNDRY_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
};

const platformPrincipal: AuthPrincipal = {
  tokenType: "platform",
  subject: "clerk-user-123",
  clientId: null,
  audience: "platform-audience",
  issuer: "https://clerk.test",
  roles: [],
  scopes: [],
  tokenId: "platform-token",
};

const workerPrincipal: AuthPrincipal = {
  tokenType: "service",
  subject: "ai-worker-foundry-machine",
  clientId: "ai-worker-foundry-machine",
  audience: "foundry-service-audience",
  issuer: "https://clerk.test",
  roles: [],
  scopes: ["routes:read"],
  tokenId: "worker-token",
};

describe("Foundry auth-check routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const app = buildApp({
      config: createFoundryConfig({ env }),
      logger: false,
      authVerifiers: {
        platform: { verify: async () => platformPrincipal },
        service: { verify: async () => workerPrincipal },
      },
      platformOperatorDomain: {
        hasRole: async (_subject, role) => role === "catalog_manager",
      } as PlatformOperatorDomain,
    });
    apps.add(app);
    return app;
  }

  it("requires catalog_manager platform auth and returns verified role metadata", async () => {
    const app = createTestApp();
    expect((await app.inject({ method: "GET", url: "/internal/v1/auth-check/platform" })).statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/auth-check/platform",
      headers: { authorization: "Bearer platform-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      claimsVerified: {
        issuer: "https://clerk.test",
        audience: "platform-audience",
        subject: "clerk-user-123",
        tokenType: "platform",
      },
      role: "catalog_manager",
    });
  });

  it("guards worker auth-check with configured subject and routes:read", async () => {
    const response = await createTestApp().inject({
      method: "GET",
      url: "/internal/v1/auth-check/worker",
      headers: { authorization: "Bearer worker-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().claimsVerified).toMatchObject({
      subject: "ai-worker-foundry-machine",
      audience: "foundry-service-audience",
      tokenType: "service",
    });
  });
});
