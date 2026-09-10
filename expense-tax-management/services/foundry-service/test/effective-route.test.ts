import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createFoundryConfig } from "../src/config.js";
import type { QuotasDomain } from "../src/domain/quotas.js";
import type { RoutesDomain } from "../src/domain/routes.js";

const TEST_ENV = {
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
  FOUNDRY_DATABASE_URL: "postgresql://foundry-runtime.test/foundry",
};

const ROUTE = {
  aiModeId: "55555555-5555-4555-8555-555555555555",
  routeVersionId: "66666666-6666-4666-8666-666666666666",
  routeVersionNumber: 1,
  aiModelId: "77777777-7777-4777-8777-777777777777",
  providerKind: "fake" as const,
  providerModelId: "fake-ocr-v1",
};

function servicePrincipal(
  clientId: string,
  scopes: readonly string[],
): AuthPrincipal {
  return {
    tokenType: "service",
    subject: clientId === "ai-worker" ? "ai-worker-foundry-machine" : clientId,
    clientId,
    audience: "expense-foundry-internal",
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${clientId}-token-id`,
  };
}

describe("Foundry effective-route route", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const routesDomain: RoutesDomain = {
      resolveEffectiveRoute: vi.fn(async () => ROUTE),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "ai-worker-routes-token") {
          return servicePrincipal("ai-worker", ["routes:read"]);
        }
        if (token === "ai-worker-wrong-scope-token") {
          return servicePrincipal("ai-worker", ["reservations:write"]);
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
      authVerifiers: {
        platform: { verify: vi.fn(async () => { throw new Error("unused"); }) },
        service: serviceVerifier,
      },
      quotasDomain: {} as QuotasDomain,
      routesDomain,
    });
    apps.add(app);
    return { app, routesDomain };
  }

  it("resolves the effective route for ai-worker with routes:read", async () => {
    const { app, routesDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/effective-route?operation=RECEIPT_OCR&modeKey=ocr_mode_balanced",
      headers: { authorization: "Bearer ai-worker-routes-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(ROUTE);
    expect(routesDomain.resolveEffectiveRoute).toHaveBeenCalledWith({
      operation: "RECEIPT_OCR",
      modeKey: "ocr_mode_balanced",
    });
  });

  it("forbids ai-worker holding only reservations:write", async () => {
    const { app, routesDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/effective-route?operation=RECEIPT_OCR&modeKey=ocr_mode_balanced",
      headers: { authorization: "Bearer ai-worker-wrong-scope-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(routesDomain.resolveEffectiveRoute).not.toHaveBeenCalled();
  });

  it("forbids other service principals even with a valid token", async () => {
    const { app, routesDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/effective-route?operation=RECEIPT_OCR&modeKey=ocr_mode_balanced",
      headers: { authorization: "Bearer app-api-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(routesDomain.resolveEffectiveRoute).not.toHaveBeenCalled();
  });

  it("rejects unknown operations and mode keys at the contract layer", async () => {
    const { app, routesDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/effective-route?operation=NOT_AN_OP&modeKey=BAD KEY!",
      headers: { authorization: "Bearer ai-worker-routes-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(routesDomain.resolveEffectiveRoute).not.toHaveBeenCalled();
  });
});
