import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createFoundryConfig } from "../src/config.js";
import type { CatalogDomain } from "../src/domain/catalog.js";

const TEST_ENV = {
  FOUNDRY_PLATFORM_TOKEN_ISSUER: "https://identity.test",
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: "expense-foundry-platform",
  FOUNDRY_PLATFORM_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  FOUNDRY_SERVICE_TOKEN_ISSUER: "https://services.test",
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: "expense-foundry-internal",
  FOUNDRY_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  FOUNDRY_DATABASE_URL: "postgresql://foundry-runtime.test/foundry",
};

const PROVIDER_CONNECTION = {
  id: "33333333-3333-4333-8333-333333333333",
  key: "openai-primary",
  providerKind: "openai" as const,
  displayName: "OpenAI Primary",
  secretReference: "44444444-4444-4444-8444-444444444444",
  status: "active" as const,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
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

describe("Foundry catalog routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const catalogDomain: CatalogDomain = {
      createProviderConnection: vi.fn(async () => PROVIDER_CONNECTION),
      updateProviderConnection: vi.fn(async () => PROVIDER_CONNECTION),
      listProviderConnections: vi.fn(async () => []),
      createAiModel: vi.fn(),
      listAiModels: vi.fn(async () => []),
      createAiMode: vi.fn(),
      listAiModes: vi.fn(async () => []),
      createRouteVersion: vi.fn(),
    };
    const platformVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "catalog-manager-token") {
          return platformPrincipal(["catalog_manager"]);
        }
        if (token === "no-role-token") {
          return platformPrincipal([]);
        }
        throw new Error("wrong token");
      }),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "ai-worker-token") {
          return servicePrincipal("ai-worker", ["reservations:write"]);
        }
        throw new Error("wrong token");
      }),
    };
    const app = buildApp({
      config: createFoundryConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { platform: platformVerifier, service: serviceVerifier },
      catalogDomain,
    });
    apps.add(app);
    return { app, catalogDomain };
  }

  it("rejects a service token entirely (wrong token type for platform-only routes)", async () => {
    const { app, catalogDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/provider-connections",
      headers: { authorization: "Bearer ai-worker-token" },
      payload: {
        key: "openai-primary",
        providerKind: "openai",
        displayName: "OpenAI Primary",
        secretValue: "sk-test",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(catalogDomain.createProviderConnection).not.toHaveBeenCalled();
  });

  it("forbids a platform token missing the catalog_manager role", async () => {
    const { app, catalogDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/provider-connections",
      headers: { authorization: "Bearer no-role-token" },
      payload: {
        key: "openai-primary",
        providerKind: "openai",
        displayName: "OpenAI Primary",
        secretValue: "sk-test",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(catalogDomain.createProviderConnection).not.toHaveBeenCalled();
  });

  it("creates a provider connection for catalog_manager, never echoing the secret value", async () => {
    const { app, catalogDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/provider-connections",
      headers: { authorization: "Bearer catalog-manager-token" },
      payload: {
        key: "openai-primary",
        providerKind: "openai",
        displayName: "OpenAI Primary",
        secretValue: "sk-test-super-secret",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toEqual(PROVIDER_CONNECTION);
    expect(JSON.stringify(body)).not.toContain("sk-test-super-secret");
    expect(catalogDomain.createProviderConnection).toHaveBeenCalledWith({
      request: {
        key: "openai-primary",
        providerKind: "openai",
        displayName: "OpenAI Primary",
        secretValue: "sk-test-super-secret",
      },
      actorPlatformSubject: "operator-1",
      requestId: expect.any(String),
    });
  });

  it("lists provider connections for catalog_manager", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/provider-connections",
      headers: { authorization: "Bearer catalog-manager-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it("rejects an empty provider connection update body", async () => {
    const { app, catalogDomain } = createTestApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/internal/v1/provider-connections/${PROVIDER_CONNECTION.id}`,
      headers: { authorization: "Bearer catalog-manager-token" },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(catalogDomain.updateProviderConnection).not.toHaveBeenCalled();
  });
});
