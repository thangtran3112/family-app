import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createFoundryConfig } from "../src/config.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import type { OperationsDomain } from "../src/domain/operations.js";

const ENV = {
  FOUNDRY_PLATFORM_TOKEN_ISSUER: "https://identity.test",
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: "expense-foundry-platform",
  FOUNDRY_PLATFORM_JWKS_URL: "https://identity.test/jwks",
  FOUNDRY_SERVICE_TOKEN_ISSUER: "https://services.test",
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: "expense-foundry-internal",
  FOUNDRY_SERVICE_JWKS_URL: "https://services.test/jwks",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  FOUNDRY_DATABASE_URL: "postgresql://unused.test/foundry",
};
function principal(roles: readonly string[]): AuthPrincipal {
  return { tokenType: "platform", subject: "operator", clientId: null,
    audience: "expense-foundry-platform", issuer: "https://identity.test",
    roles, scopes: [], tokenId: "token" };
}

describe("Foundry operations read routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();
  afterEach(async () => { await Promise.all([...apps].map((app) => app.close())); apps.clear(); });
  function setup() {
    const operationsDomain: OperationsDomain = {
      listProviderCalls: vi.fn(async () => []), listQuotaPeriods: vi.fn(async () => []),
      listReconciliationQueue: vi.fn(async () => []), listAuditEvents: vi.fn(async () => []),
    };
    const verifier: TokenVerifier = { verify: vi.fn(async (token) => token === "reconciler" ? principal(["quota_reconciler"]) : principal(["catalog_manager"])) };
    const app = buildApp({ config: createFoundryConfig({ env: ENV }), logger: false,
      authVerifiers: { platform: verifier, service: { verify: vi.fn(async () => { throw new Error("unused"); }) } },
      catalogDomain: {} as never, quotasDomain: {} as never, routesDomain: {} as never, operationsDomain });
    apps.add(app); return { app, operationsDomain };
  }
  it("separates reconciler telemetry from catalog audit/period reads", async () => {
    const { app, operationsDomain } = setup();
    expect((await app.inject({ method: "GET", url: "/internal/v1/reconciliation-queue", headers: { authorization: "Bearer reconciler" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/internal/v1/provider-call-logs", headers: { authorization: "Bearer reconciler" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/internal/v1/quota-periods", headers: { authorization: "Bearer catalog" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/internal/v1/foundry-audit-events", headers: { authorization: "Bearer catalog" } })).statusCode).toBe(200);
    expect(operationsDomain.listReconciliationQueue).toHaveBeenCalledOnce();
  });
  it("rejects cross-role reads", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/internal/v1/reconciliation-queue", headers: { authorization: "Bearer catalog" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/internal/v1/foundry-audit-events", headers: { authorization: "Bearer reconciler" } })).statusCode).toBe(403);
  });
});
