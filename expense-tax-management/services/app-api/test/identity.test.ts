import {
  CurrentUserResponseSchema,
  IdentityProvisioningResponseSchema,
  type AuthenticatedUser,
  type User,
} from "@expense-tax/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";

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
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
};
const USER: User = {
  id: "11111111-1111-4111-8111-111111111111",
  primaryEmail: "person@example.test",
  displayName: "Person Name",
  status: "active",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const AUTHENTICATED_USER: AuthenticatedUser = {
  id: USER.id,
  primaryEmail: USER.primaryEmail,
  displayName: USER.displayName,
  status: USER.status,
};

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
    email: USER.primaryEmail,
    emailVerified: true,
    displayName: USER.displayName,
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

describe("App API identity routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const provision = vi
      .fn()
      .mockResolvedValueOnce({ user: USER, created: true })
      .mockResolvedValue({ user: USER, created: false });
    const resolve = vi.fn(async () => AUTHENTICATED_USER);
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token !== "tenant-token") throw new Error("wrong token");
        return tenantPrincipal();
      }),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "gateway-token") {
          return servicePrincipal("gateway-auth", ["identity:provision"]);
        }
        if (token === "wrong-principal-token") {
          return servicePrincipal("other-service", ["identity:provision"]);
        }
        if (token === "missing-scope-token") {
          return servicePrincipal("gateway-auth", []);
        }
        throw new Error("wrong token");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: { provision, resolve },
    });
    apps.add(app);
    return { app, provision, resolve };
  }

  const identityRequest = {
    issuer: "https://identity.test",
    subject: "identity-subject",
    email: "PERSON@EXAMPLE.TEST",
    emailVerified: true,
    displayName: " Person Name ",
  };

  it("prevents tenant tokens from provisioning identities", async () => {
    const { app, provision } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/identity-provisionings",
      headers: { authorization: "Bearer tenant-token" },
      payload: identityRequest,
    });

    expect(response.statusCode).toBe(401);
    expect(provision).not.toHaveBeenCalled();
  });

  it.each(["wrong-principal-token", "missing-scope-token"])(
    "forbids service token %s",
    async (token) => {
      const { app, provision } = createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/internal/v1/identity-provisionings",
        headers: { authorization: `Bearer ${token}` },
        payload: identityRequest,
      });

      expect(response.statusCode).toBe(403);
      expect(provision).not.toHaveBeenCalled();
    },
  );

  it("creates then idempotently resolves the same identity", async () => {
    const { app, provision } = createTestApp();
    const request = {
      method: "POST" as const,
      url: "/internal/v1/identity-provisionings",
      headers: { authorization: "Bearer gateway-token" },
      payload: identityRequest,
    };
    const created = await app.inject(request);
    const repeated = await app.inject(request);

    expect(created.statusCode).toBe(201);
    expect(repeated.statusCode).toBe(200);
    expect(IdentityProvisioningResponseSchema.parse(created.json())).toEqual({
      user: USER,
    });
    expect(IdentityProvisioningResponseSchema.parse(repeated.json())).toEqual({
      user: USER,
    });
    expect(provision).toHaveBeenNthCalledWith(1, {
      identity: {
        ...identityRequest,
        email: "person@example.test",
        displayName: "Person Name",
      },
      actorServicePrincipal: "gateway-auth",
      requestId: expect.any(String),
    });
  });

  it("rejects unknown provisioning fields", async () => {
    const { app, provision } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/identity-provisionings",
      headers: { authorization: "Bearer gateway-token" },
      payload: { ...identityRequest, tenantId: "spoofed-tenant" },
    });

    expect(response.statusCode).toBe(400);
    expect(provision).not.toHaveBeenCalled();
  });

  it("returns current user from verified identity, ignoring spoofed headers", async () => {
    const { app, resolve } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: {
        authorization: "Bearer tenant-token",
        "x-user-id": "spoofed-user",
        "x-identity-subject": "spoofed-subject",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(CurrentUserResponseSchema.parse(response.json())).toEqual({
      user: AUTHENTICATED_USER,
    });
    expect(resolve).toHaveBeenCalledWith(
      "https://identity.test",
      "identity-subject",
    );
  });
});
