import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthPrincipal } from "../src/auth/types.js";
import type {
  AuthenticatedUserContext,
  IdentityResolver,
} from "../src/domain/authenticated-user.js";
import { DomainError, registerErrorHandlers } from "../src/errors.js";
import {
  authenticatedUserGuard,
  registerAuthPlugin,
  tenantGuard,
} from "../src/plugins/auth.js";

const TENANT_PRINCIPAL: AuthPrincipal = {
  tokenType: "tenant",
  subject: "identity-subject-secret",
  clientId: null,
  audience: "expense-app",
  issuer: "https://identity.test",
  roles: [],
  scopes: [],
  tokenId: "token-123",
  email: "person@example.test",
  emailVerified: true,
  displayName: "Person Name",
};

describe("App API domain authentication", () => {
  const apps = new Set<ReturnType<typeof Fastify>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createApp(resolvedUser: AuthenticatedUserContext | null) {
    const app = Fastify({ logger: false });
    const resolve = vi.fn(async () => resolvedUser);
    const identityResolver: IdentityResolver = { resolve };
    apps.add(app);
    registerErrorHandlers(app);
    registerAuthPlugin(app, {
      authVerifiers: {
        tenant: { verify: vi.fn(async () => TENANT_PRINCIPAL) },
        service: { verify: vi.fn(async () => TENANT_PRINCIPAL) },
      },
    });
    app.get(
      "/_test/domain-auth",
      { preHandler: [tenantGuard, authenticatedUserGuard(identityResolver)] },
      async (request) => ({ user: request.authenticatedUser }),
    );

    return { app, resolve };
  }

  it("rejects an unprovisioned identity without revealing its subject", async () => {
    const { app, resolve } = createApp(null);
    const response = await app.inject({
      method: "GET",
      url: "/_test/domain-auth",
      headers: { authorization: "Bearer signed-token" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    expect(response.body).not.toContain(TENANT_PRINCIPAL.subject);
    expect(resolve).toHaveBeenCalledWith(
      TENANT_PRINCIPAL.issuer,
      TENANT_PRINCIPAL.subject,
    );
  });

  it("rejects a disabled resolved user", async () => {
    const { app } = createApp({
      id: "4a476842-13ed-4828-bc0b-0ea9419eb34f",
      primaryEmail: "person@example.test",
      displayName: "Person Name",
      status: "disabled",
    });
    const response = await app.inject({
      method: "GET",
      url: "/_test/domain-auth",
      headers: { authorization: "Bearer signed-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "FORBIDDEN", message: "Access denied" },
    });
  });

  it("attaches an active resolved user", async () => {
    const user: AuthenticatedUserContext = {
      id: "4a476842-13ed-4828-bc0b-0ea9419eb34f",
      primaryEmail: "person@example.test",
      displayName: "Person Name",
      status: "active",
    };
    const { app } = createApp(user);
    const response = await app.inject({
      method: "GET",
      url: "/_test/domain-auth",
      headers: { authorization: "Bearer signed-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user });
  });

  it.each([
    [DomainError.notFound(), 404, "NOT_FOUND", "Resource not found"],
    [
      DomainError.conflict(),
      409,
      "CONFLICT",
      "Request conflicts with current state",
    ],
  ] as const)("serializes typed domain errors", async (error, status, code, message) => {
    const app = Fastify({ logger: false });
    apps.add(app);
    registerErrorHandlers(app);
    app.get("/_test/domain-error", async () => {
      throw error;
    });

    const response = await app.inject({
      method: "GET",
      url: "/_test/domain-error",
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({
      error: { code, message, requestId: expect.any(String) },
    });
  });
});
