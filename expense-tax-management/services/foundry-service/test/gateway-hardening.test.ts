import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createFoundryConfig } from "../src/config.js";
import type { AuthPrincipal } from "../src/auth/types.js";
import type { PlatformOperatorDomain } from "../src/domain/platform-operators.js";
import { platformGuard, serviceGuard } from "../src/plugins/auth.js";

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
  subject: "platform-user",
  clientId: null,
  audience: "platform-audience",
  issuer: "https://clerk.test",
  roles: [],
  scopes: [],
  tokenId: "platform-token",
};

const servicePrincipal: AuthPrincipal = {
  tokenType: "service",
  subject: "ai-worker-foundry-machine",
  clientId: "ai-worker-foundry-machine",
  audience: "foundry-service-audience",
  issuer: "https://clerk.test",
  roles: [],
  scopes: ["routes:read"],
  tokenId: "service-token",
};

describe("Foundry gateway hardening", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const app = buildApp({
      config: createFoundryConfig({ env, version: "test" }),
      logger: false,
      authVerifiers: {
        platform: { verify: async () => platformPrincipal },
        service: { verify: async () => servicePrincipal },
      },
      platformOperatorDomain: {
        hasRole: async (_subject, role) => role === "catalog_manager",
      } as PlatformOperatorDomain,
    });
    apps.add(app);
    return app;
  }

  it("sets security headers and no-store on every response without CSP", async () => {
    const response = await createTestApp().inject({ method: "GET", url: "/health/live" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["permissions-policy"]).toBe(
      "camera=(self), microphone=(), geolocation=()",
    );
    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toBeUndefined();
    expect(response.headers["x-user-id"]).toBeUndefined();
  });

  it.each([
    { path: "/_test/api", max: 120 },
    { path: "/internal/v1/_test", max: 300 },
  ])("applies exact $max-request route-class limit to $path", async ({ path, max }) => {
    const app = createTestApp();
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

  it("rate-limits health and webhook routes at shared policy thresholds", async () => {
    const healthApp = createTestApp();
    for (let index = 0; index < 30; index += 1) {
      expect((await healthApp.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    }
    const healthRejected = await healthApp.inject({ method: "GET", url: "/health/live" });
    expect(healthRejected.statusCode).toBe(429);

    const webhookApp = createTestApp();
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
      expect((await webhookApp.inject(request)).statusCode).not.toBe(429);
    }
    const webhookRejected = await webhookApp.inject(request);
    expect(webhookRejected.statusCode).toBe(429);
    expect(webhookRejected.headers["retry-after"]).toBeDefined();
  });

  it("limits authorization key before auth and handler", async () => {
    const app = createTestApp();
    let handlerCalls = 0;
    app.get(
      "/_test/authenticated",
      { preHandler: async () => undefined },
      async () => {
        handlerCalls += 1;
        return { ok: true };
      },
    );

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
    expect(handlerCalls).toBe(120);
  });

  it("keeps Foundry body and server timeout bounds", async () => {
    const app = createTestApp();
    app.post("/_test/body", async () => ({ ok: true }));

    const response = await app.inject({
      method: "POST",
      url: "/_test/body",
      headers: { "content-type": "application/json" },
      payload: Buffer.alloc(1024 * 1024 + 1, "x"),
    });

    expect(response.statusCode).toBe(413);
    expect(app.server.timeout).toBe(15_000);
    expect(app.server.keepAliveTimeout).toBe(5_000);
  });

  it("preserves platform and service auth-check audience, role, and source decisions", async () => {
    const app = createTestApp();
    app.get(
      "/_test/platform",
      { preHandler: platformGuard("catalog_manager") },
      async () => ({ ok: true }),
    );
    app.get(
      "/_test/service",
      { preHandler: serviceGuard("different-service", ["routes:read"]) },
      async () => ({ ok: true }),
    );

    expect((await app.inject({ method: "GET", url: "/_test/platform" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/_test/platform",
          headers: { authorization: "Bearer platform-token" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/_test/service",
          headers: { authorization: "Bearer service-token" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("rejects unsupported methods and unknown paths without running handlers", async () => {
    const app = createTestApp();
    let handlerCalls = 0;
    app.get("/_test/routes", async () => {
      handlerCalls += 1;
      return { ok: true };
    });

    const unsupported = await app.inject({ method: "POST", url: "/_test/routes" });
    const unknown = await app.inject({ method: "GET", url: "/_test/unknown" });

    expect([404, 405]).toContain(unsupported.statusCode);
    expect(unknown.statusCode).toBe(404);
    expect(handlerCalls).toBe(0);
  });
});
