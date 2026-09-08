import { generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/verifier.js";
import { serviceGuard, tenantGuard } from "../src/plugins/auth.js";
import { createAppConfig } from "../src/config.js";

const TENANT_ISSUER = "https://identity.test";
const TENANT_AUDIENCE = "expense-app";
const SERVICE_ISSUER = "https://services.test";
const SERVICE_AUDIENCE = "expense-app-internal";

const AUTH_ENV = {
  APP_TENANT_TOKEN_ISSUER: TENANT_ISSUER,
  APP_TENANT_TOKEN_AUDIENCE: TENANT_AUDIENCE,
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: SERVICE_ISSUER,
  APP_SERVICE_TOKEN_AUDIENCE: SERVICE_AUDIENCE,
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
};

const REQUIRED_AUTH_ENV_KEYS = Object.keys(AUTH_ENV) as Array<
  keyof typeof AUTH_ENV
>;

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
type RequiredClaim =
  | "sub"
  | "jti"
  | "iat"
  | "exp"
  | "email"
  | "email_verified"
  | "display_name";

interface SignTokenOptions {
  readonly key?: KeyPair["privateKey"];
  readonly algorithm?: "RS256" | "ES256";
  readonly issuer?: string;
  readonly audience?: string | string[];
  readonly subject?: string;
  readonly tokenId?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly notBefore?: number;
  readonly omit?: readonly RequiredClaim[];
  readonly claims?: Record<string, unknown>;
}

describe("App API authentication", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();
  let tenantKeys: KeyPair;
  let serviceKeys: KeyPair;
  let attackerKeys: KeyPair;
  let ellipticKeys: KeyPair;

  beforeAll(async () => {
    [tenantKeys, serviceKeys, attackerKeys, ellipticKeys] = await Promise.all([
      generateKeyPair("RS256"),
      generateKeyPair("RS256"),
      generateKeyPair("RS256"),
      generateKeyPair("ES256"),
    ]);
  });

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  async function signToken(options: SignTokenOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const omitted = new Set(options.omit);
    const claims: Record<string, unknown> = {
      email: "person@example.test",
      email_verified: true,
      display_name: "Person Name",
      ...options.claims,
    };
    for (const claim of omitted) {
      delete claims[claim];
    }
    let token = new SignJWT(claims).setProtectedHeader({
      alg: options.algorithm ?? "RS256",
      kid: "test-key",
    });

    token = token
      .setIssuer(options.issuer ?? TENANT_ISSUER)
      .setAudience(options.audience ?? TENANT_AUDIENCE);

    if (!omitted.has("sub")) {
      token = token.setSubject(options.subject ?? "account-123");
    }
    if (!omitted.has("jti")) {
      token = token.setJti(options.tokenId ?? "token-123");
    }
    if (!omitted.has("iat")) {
      token = token.setIssuedAt(options.issuedAt ?? now);
    }
    if (!omitted.has("exp")) {
      token = token.setExpirationTime(options.expiresAt ?? now + 300);
    }
    if (options.notBefore !== undefined) {
      token = token.setNotBefore(options.notBefore);
    }

    return token.sign(options.key ?? tenantKeys.privateKey);
  }

  function createTestApp() {
    const tenantVerifier = createTokenVerifier({
      tokenType: "tenant",
      issuer: TENANT_ISSUER,
      audience: TENANT_AUDIENCE,
      keyResolver: async () => tenantKeys.publicKey,
    });
    const serviceVerifier = createTokenVerifier({
      tokenType: "service",
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      keyResolver: async () => serviceKeys.publicKey,
    });
    const app = buildApp({
      config: createAppConfig({ env: AUTH_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: serviceVerifier,
      },
    });
    apps.add(app);

    app.get(
      "/_test/private/tenant",
      { preHandler: tenantGuard },
      async (request) => ({
        principal: request.authPrincipal,
        verifiedIdentity: request.verifiedIdentity,
      }),
    );
    app.get(
      "/_test/private/service",
      {
        preHandler: serviceGuard("ai-worker", [
          "expenses:extract",
          "expenses:write",
        ]),
      },
      async (request) => ({ principal: request.authPrincipal }),
    );

    return app;
  }

  async function requestTenant(authorization?: string | string[]) {
    return createTestApp().inject({
      method: "GET",
      url: "/_test/private/tenant",
      headers:
        authorization === undefined ? {} : { authorization },
    });
  }

  async function requestService(token: string) {
    return createTestApp().inject({
      method: "GET",
      url: "/_test/private/service",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function expectGenericError(response: {
    readonly statusCode: number;
    json(): unknown;
  }, statusCode: 401 | 403): void {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({
      error: {
        code: statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
        message: statusCode === 401 ? "Authentication required" : "Access denied",
        requestId: expect.any(String),
      },
    });
  }

  it.each(REQUIRED_AUTH_ENV_KEYS)(
    "prevents startup when %s is missing",
    (key) => {
      const env: Record<string, string> = { ...AUTH_ENV };
      delete env[key];

      expect(() => createAppConfig({ env })).toThrow(
        `Missing required environment variable: ${key}`,
      );
    },
  );

  it("accepts a valid tenant token", async () => {
    const token = await signToken();
    const response = await requestTenant(`Bearer ${token}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      verifiedIdentity: {
        issuer: TENANT_ISSUER,
        subject: "account-123",
        verifiedEmail: "person@example.test",
        displayName: "Person Name",
        tokenId: "token-123",
      },
      principal: {
        tokenType: "tenant",
        subject: "account-123",
        clientId: null,
        audience: TENANT_AUDIENCE,
        issuer: TENANT_ISSUER,
        roles: [],
        scopes: [],
        tokenId: "token-123",
        email: "person@example.test",
        emailVerified: true,
        displayName: "Person Name",
      },
    });
  });

  it("rejects a platform audience on the tenant guard", async () => {
    const token = await signToken({ audience: "expense-platform" });

    expectGenericError(await requestTenant(`Bearer ${token}`), 401);
  });

  it("rejects an expired tenant token", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const token = await signToken({ issuedAt: now - 120, expiresAt: now - 60 });

    expectGenericError(await requestTenant(`Bearer ${token}`), 401);
  });

  it("rejects a tenant token from the wrong issuer", async () => {
    const token = await signToken({ issuer: "https://wrong-issuer.test" });

    expectGenericError(await requestTenant(`Bearer ${token}`), 401);
  });

  it("rejects a tenant token with an invalid signature", async () => {
    const token = await signToken({ key: attackerKeys.privateKey });

    expectGenericError(await requestTenant(`Bearer ${token}`), 401);
  });

  it("rejects a tenant token using a non-RS256 algorithm", async () => {
    const token = await signToken({
      algorithm: "ES256",
      key: ellipticKeys.privateKey,
    });

    expectGenericError(await requestTenant(`Bearer ${token}`), 401);
  });

  it.each([
    "sub",
    "jti",
    "iat",
    "exp",
    "email",
    "email_verified",
    "display_name",
  ] as const)(
    "rejects a tenant token missing %s",
    async (claim) => {
      const token = await signToken({ omit: [claim] });

      expectGenericError(await requestTenant(`Bearer ${token}`), 401);
    },
  );

  it("rejects a tenant token with nbf beyond clock tolerance", async () => {
    const token = await signToken({
      notBefore: Math.floor(Date.now() / 1_000) + 60,
    });

    expectGenericError(await requestTenant(`Bearer ${token}`), 401);
  });

  it("rejects a tenant token with an audience array", async () => {
    const token = await signToken({ audience: [TENANT_AUDIENCE] });

    expectGenericError(await requestTenant(`Bearer ${token}`), 401);
  });

  it.each([
    undefined,
    "",
    "Bearer",
    "Basic credentials",
    "Bearer token with spaces",
    "Bearer first, Bearer second",
  ])("rejects malformed bearer authorization %#", async (authorization) => {
    expectGenericError(await requestTenant(authorization), 401);
  });

  it("rejects duplicate bearer headers", async () => {
    const token = await signToken();

    expectGenericError(
      await requestTenant([`Bearer ${token}`, `Bearer ${token}`]),
      401,
    );
  });

  it("accepts an ai-worker service token with every required scope", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      subject: "service-account-123",
      claims: {
        client_id: "ai-worker",
        scope: "expenses:write expenses:extract unused:scope",
      },
    });
    const response = await requestService(token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      principal: {
        tokenType: "service",
        subject: "service-account-123",
        clientId: "ai-worker",
        audience: SERVICE_AUDIENCE,
        issuer: SERVICE_ISSUER,
        roles: [],
        scopes: ["expenses:write", "expenses:extract", "unused:scope"],
        tokenId: "token-123",
        email: null,
        emailVerified: null,
        displayName: null,
      },
    });
  });

  it("rejects a tenant token on the service guard", async () => {
    expectGenericError(await requestService(await signToken()), 401);
  });

  it("rejects a Foundry internal audience on the service guard", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: "foundry-internal",
      claims: {
        client_id: "ai-worker",
        scope: "expenses:extract expenses:write",
      },
    });

    expectGenericError(await requestService(token), 401);
  });

  it("rejects a service token without client_id", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      claims: { scope: "expenses:extract expenses:write" },
    });

    expectGenericError(await requestService(token), 401);
  });

  it("forbids an ai-worker service token missing a required scope", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      claims: {
        client_id: "ai-worker",
        scope: "expenses:extract",
      },
    });

    expectGenericError(await requestService(token), 403);
  });

  it("forbids a service token from the wrong principal", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      claims: {
        client_id: "other-worker",
        scope: "expenses:extract expenses:write",
      },
    });

    expectGenericError(await requestService(token), 403);
  });
});
