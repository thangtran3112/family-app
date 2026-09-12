import { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import { tenantGuard, serviceGuard } from "../src/plugins/auth.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/jwks",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/jwks",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  APP_DATABASE_URL: "postgresql://unused.test/app",
  TEMPORAL_HOST: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/gateway-hardening-test",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "test-storage-key",
  INBOUND_EMAIL_BASE_ADDRESS: "receipts@inbound.test",
  INBOUND_WEBHOOK_SIGNING_KEY: "test-webhook-key",
  INBOUND_ROUTING_TOKEN_SECRET: "test-routing-key",
  INBOUND_CHALLENGE_DIR: "/tmp/gateway-hardening-challenges",
};

function principal(tokenType: "tenant" | "service"): AuthPrincipal {
  return {
    tokenType,
    subject: tokenType === "service" ? "expected-service" : "tenant-subject",
    clientId: tokenType === "service" ? "expected-service" : null,
    audience: tokenType === "service" ? "expense-app-internal" : "expense-app",
    issuer: tokenType === "service" ? "https://services.test" : "https://identity.test",
    roles: [],
    scopes: tokenType === "service" ? ["test:read"] : [],
    tokenId: "token-id",
    email: tokenType === "tenant" ? "person@example.test" : null,
    emailVerified: tokenType === "tenant" ? true : null,
    displayName: tokenType === "tenant" ? "Person" : null,
  };
}

describe("App API gateway hardening", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp(options: { logger?: false | { stream: Writable } } = {}) {
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token !== "tenant-token") throw new Error("invalid tenant token");
        return principal("tenant");
      }),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token !== "service-token") throw new Error("invalid service token");
        return principal("service");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: options.logger ?? false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: {
        provision: vi.fn(),
        resolve: vi.fn(async () => null),
      },
    });
    apps.add(app);
    return { app, tenantVerifier, serviceVerifier };
  }

  it("sets security headers on every response without CSP", async () => {
    const { app } = createTestApp();

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["permissions-policy"]).toContain("camera=(self)");
    expect(response.headers["permissions-policy"]).toBe(
      "camera=(self), microphone=(), geolocation=()",
    );
    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });

  it.each([
    { path: "/_test/api", max: 120 },
    { path: "/internal/v1/_test", max: 300 },
  ])("applies exact $max-request route-class limit to $path", async ({ path, max }) => {
    const { app } = createTestApp();
    let handlerCalls = 0;
    app.get(path, async () => {
      handlerCalls += 1;
      return { ok: true };
    });

    for (let index = 0; index < max; index += 1) {
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(200);
    }
    const rejected = await app.inject({ method: "GET", url: path });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toMatch(/^\d+$/);
    expect(handlerCalls).toBe(max);
  });

  it("rate-limits health route at configured threshold", async () => {
    const { app } = createTestApp();

    for (let index = 0; index < 30; index += 1) {
      expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    }
    const rejected = await app.inject({ method: "GET", url: "/health/live" });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBeDefined();
  });

  it("rate-limits Clerk webhook route at configured threshold", async () => {
    const { app } = createTestApp();
    const request = {
      method: "POST" as const,
      url: "/api/v1/integrations/clerk/webhook",
      headers: {
        "content-type": "application/json",
        "svix-id": "test-event",
        "svix-timestamp": "now",
        "svix-signature": "test",
      },
      payload: "{}",
    };

    for (let index = 0; index < 20; index += 1) {
      expect((await app.inject(request)).statusCode).not.toBe(429);
    }
    const rejected = await app.inject(request);

    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBeDefined();
  });

  it("rejects before auth and handler when authorization key is over limit", async () => {
    const { app, tenantVerifier } = createTestApp();
    let handlerCalls = 0;
    app.get("/_test/authenticated", { preHandler: tenantGuard }, async () => {
      handlerCalls += 1;
      return { ok: true };
    });

    for (let index = 0; index < 120; index += 1) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/_test/authenticated",
            headers: { authorization: "Bearer tenant-token" },
          })
        ).statusCode,
      ).toBe(200);
    }
    const rejected = await app.inject({
      method: "GET",
      url: "/_test/authenticated",
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(rejected.statusCode).toBe(429);
    expect(tenantVerifier.verify).toHaveBeenCalledTimes(120);
    expect(handlerCalls).toBe(120);
  });

  it("preserves existing 401 and 403 authorization decisions", async () => {
    const { app } = createTestApp();
    app.get("/_test/tenant", { preHandler: tenantGuard }, async () => ({ ok: true }));
    app.get(
      "/_test/service",
      { preHandler: serviceGuard("different-service", ["test:read"]) },
      async () => ({ ok: true }),
    );

    const unauthenticated = await app.inject({ method: "GET", url: "/_test/tenant" });
    const forbidden = await app.inject({
      method: "GET",
      url: "/_test/service",
      headers: { authorization: "Bearer service-token" },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
  });

  it("does not expose raw authorization values in logs or responses", async () => {
    const logLines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(String(chunk));
        callback();
      },
    });
    const { app } = createTestApp({ logger: { stream } });
    const authorization = "Bearer raw-secret-token";
    const response = await app.inject({
      method: "GET",
      url: "/missing",
      headers: { authorization },
    });

    expect(response.body).not.toContain(authorization);
    expect(Object.values(response.headers).join(" ")).not.toContain(authorization);
    expect(logLines.join("")).not.toContain(authorization);
  });

  it("keeps default body limit at 1 MiB", async () => {
    const { app } = createTestApp();
    app.post("/_test/body", async () => ({ ok: true }));

    const response = await app.inject({
      method: "POST",
      url: "/_test/body",
      headers: { "content-type": "application/json" },
      payload: Buffer.alloc(1024 * 1024 + 1, "x"),
    });

    expect(response.statusCode).toBe(413);
  });

  it("keeps Clerk webhook body cap at 1 MiB", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: {
        "content-type": "application/json",
        "content-length": String(1024 * 1024 + 1),
        "svix-id": "test-event",
        "svix-timestamp": "now",
        "svix-signature": "test",
      },
      payload: Buffer.alloc(1024 * 1024 + 1, "x"),
    });

    expect(response.statusCode).toBe(413);
  });

  it("keeps larger upload and inbound-email parsers above the default cap", async () => {
    const { app } = createTestApp();
    const largeBody = Buffer.alloc(2 * 1024 * 1024, "x");
    const uploadResponse = await app.inject({
      method: "PUT",
      url: "/api/v1/file-content/11111111-1111-4111-8111-111111111111?expires=4102444800&signature=invalid",
      headers: { "content-type": "image/jpeg" },
      payload: largeBody,
    });
    const inboundResponse = await app.inject({
      method: "POST",
      url: "/internal/v1/inbound-email/provider-webhook",
      headers: {
        "content-type": "application/vnd.expense-tax.inbound+json",
        "x-inbound-signature": "0".repeat(64),
      },
      payload: largeBody,
    });

    expect(uploadResponse.statusCode).toBe(403);
    expect(inboundResponse.statusCode).toBe(401);
  });
});
