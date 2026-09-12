import { generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  createConfiguredAuthVerifiers,
  createTokenVerifier,
} from "../src/auth/verifier.js";
import { platformGuard, serviceGuard } from "../src/plugins/auth.js";
import { createFoundryConfig } from "../src/config.js";

const PLATFORM_ISSUER = "https://identity.test";
const PLATFORM_AUDIENCE = "expense-foundry-platform";
const SERVICE_ISSUER = "https://services.test";
const SERVICE_AUDIENCE = "expense-foundry-internal";
const APP_INTERNAL_AUDIENCE = "app-service-audience";
const APP_SERVICE_SUBJECT = "ai-worker-app-machine";

const AUTH_ENV = {
  AUTH_PROVIDER: "legacy",
  FOUNDRY_PLATFORM_TOKEN_ISSUER: PLATFORM_ISSUER,
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: PLATFORM_AUDIENCE,
  FOUNDRY_PLATFORM_JWKS_URL:
    "https://identity.test/.well-known/jwks.json",
  FOUNDRY_SERVICE_TOKEN_ISSUER: SERVICE_ISSUER,
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: SERVICE_AUDIENCE,
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

const REQUIRED_AUTH_ENV_KEYS = (
  Object.keys(AUTH_ENV) as Array<keyof typeof AUTH_ENV>
).filter((key) => key !== "AUTH_PROVIDER");

const OPERATOR_PATH = "/_test/platform/operator";
const QUOTA_RECONCILER_PATH = "/_test/platform/quota-reconciler";
const ENTITLEMENT_PUBLISH_PATH = "/_test/internal/entitlements";
const RESERVATION_PATH = "/_test/internal/reservations";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
type RequiredClaim = "sub" | "jti" | "iat" | "exp";

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

describe("Foundry authentication", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();
  let platformKeys: KeyPair;
  let serviceKeys: KeyPair;
  let attackerKeys: KeyPair;
  let ellipticKeys: KeyPair;

  beforeAll(async () => {
    [platformKeys, serviceKeys, attackerKeys, ellipticKeys] =
      await Promise.all([
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
    let token = new SignJWT(options.claims ?? { roles: ["operator"] })
      .setProtectedHeader({
        alg: options.algorithm ?? "RS256",
        kid: "test-key",
      })
      .setIssuer(options.issuer ?? PLATFORM_ISSUER)
      .setAudience(options.audience ?? PLATFORM_AUDIENCE);

    if (!omitted.has("sub")) {
      token = token.setSubject(options.subject ?? "platform-account-123");
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

    return token.sign(options.key ?? platformKeys.privateKey);
  }

  async function signServiceToken(
    clientId: string,
    scope: string,
    options: SignTokenOptions = {},
  ): Promise<string> {
    return signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      subject: options.subject ?? clientId,
      ...options,
      claims: {
        client_id: clientId,
        scope,
        ...options.claims,
      },
    });
  }

  function createTestApp(options: Record<string, unknown> = {}) {
    const platformVerifier = createTokenVerifier({
      tokenType: "platform",
      issuer: PLATFORM_ISSUER,
      audience: PLATFORM_AUDIENCE,
      keyResolver: async () => platformKeys.publicKey,
    });
    const serviceVerifier = createTokenVerifier({
      tokenType: "service",
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      keyResolver: async () => serviceKeys.publicKey,
    });
    const app = buildApp({
      config: createFoundryConfig({ env: AUTH_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        platform: platformVerifier,
        service: serviceVerifier,
      },
      platformOperatorDomain: {
        async hasRole(subject, role) {
          return (
            (subject === "mapped-operator" && role === "operator") ||
            (subject === "mapped-reconciler" && role === "quota_reconciler")
          );
        },
      },
      ...options,
    } as Parameters<typeof buildApp>[0]);
    apps.add(app);

    app.get(
      OPERATOR_PATH,
      { preHandler: platformGuard("operator") },
      async (request) => ({ principal: request.authPrincipal }),
    );
    app.get(
      QUOTA_RECONCILER_PATH,
      { preHandler: platformGuard("quota_reconciler") },
      async (request) => ({ principal: request.authPrincipal }),
    );
    app.get(
      ENTITLEMENT_PUBLISH_PATH,
      {
         preHandler: serviceGuard("app-api", ["entitlements:publish"]),
      },
      async (request) => ({ principal: request.authPrincipal }),
    );
    app.get(
      RESERVATION_PATH,
      {
        preHandler: serviceGuard("ai-worker", ["reservations:write"]),
      },
      async (request) => ({ principal: request.authPrincipal }),
    );

    return app;
  }

  async function request(
    path: string,
    authorization?: string | string[],
  ) {
    return createTestApp().inject({
      method: "GET",
      url: path,
      headers: authorization === undefined ? {} : { authorization },
    });
  }

  async function requestWithToken(path: string, token: string) {
    return request(path, `Bearer ${token}`);
  }

  function expectGenericError(
    response: {
      readonly statusCode: number;
      json(): unknown;
    },
    statusCode: 401 | 403,
  ): void {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({
      error: {
        code: "REQUEST_ERROR",
        message: "Request failed",
        requestId: expect.any(String),
      },
    });
  }

  it.each(REQUIRED_AUTH_ENV_KEYS)(
    "prevents startup when %s is missing",
    (key) => {
      const env: Record<string, string> = { ...AUTH_ENV };
      if (key.startsWith("CLERK_")) {
        env.AUTH_PROVIDER = "clerk";
      }
      delete env[key];

      expect(() => createFoundryConfig({ env })).toThrow(
        `Missing required environment variable: ${key}`,
      );
    },
  );

  it("fails clearly when Clerk runtime config is absent", () => {
    expect(() =>
      createConfiguredAuthVerifiers({
        authProvider: "clerk",
        auth: {} as never,
        clerk: undefined,
      }),
    ).toThrow("Clerk auth configuration is required when AUTH_PROVIDER=clerk");
  });

  it("rejects a tenant owner on the platform operator guard", async () => {
    const token = await signToken({
      audience: "expense-app",
      claims: { roles: ["owner"] },
    });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("accepts only the exact platform operator role", async () => {
    const response = await requestWithToken(
      OPERATOR_PATH,
      await signToken({ subject: "mapped-operator" }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      principal: {
        tokenType: "platform",
        subject: "mapped-operator",
        clientId: null,
        audience: PLATFORM_AUDIENCE,
        issuer: PLATFORM_ISSUER,
        roles: ["operator"],
        scopes: [],
        tokenId: "token-123",
      },
    });
  });

  it("selects Clerk authorities for runtime route verifiers", async () => {
    const authorities: string[] = [];
    const app = buildApp({
      config: createFoundryConfig({
        env: { ...AUTH_ENV, AUTH_PROVIDER: "clerk" },
        version: "test-clerk",
      }),
      logger: false,
      authKeyResolverFactory: (authority) => {
        authorities.push(`${authority.issuer}|${authority.audience}`);
        return async () =>
          authority.audience === "platform-audience"
            ? platformKeys.publicKey
            : serviceKeys.publicKey;
      },
      platformOperatorDomain: {
        async hasRole(subject, role) {
          return subject === "mapped-operator" && role === "operator";
        },
      },
    });
    apps.add(app);
    app.get(
      "/_test/platform/clerk-operator",
      { preHandler: platformGuard("operator") },
      async (request) => ({ principal: request.authPrincipal }),
    );
    app.get(
      "/_test/platform/clerk-service",
      {
        preHandler: serviceGuard(APP_SERVICE_SUBJECT, ["entitlements:publish"]),
      },
      async (request) => ({ principal: request.authPrincipal }),
    );

    const token = await signToken({
      subject: "mapped-operator",
      issuer: "https://clerk.test",
      audience: "platform-audience",
    });
    const response = await app.inject({
      method: "GET",
      url: "/_test/platform/clerk-operator",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(authorities).toEqual([
      "https://clerk.test|platform-audience",
      "https://clerk.test|foundry-service-audience",
    ]);

    const serviceToken = await signToken({
      key: serviceKeys.privateKey,
      issuer: "https://clerk.test",
      audience: "foundry-service-audience",
       subject: APP_SERVICE_SUBJECT,
      claims: {
        azp: "app-api",
        scope: "entitlements:publish",
      },
    });
    const platformWithServiceToken = await app.inject({
      method: "GET",
      url: "/_test/platform/clerk-operator",
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    const serviceResponse = await app.inject({
      method: "GET",
      url: "/_test/platform/clerk-service",
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    const serviceWithPlatformToken = await app.inject({
      method: "GET",
      url: "/_test/platform/clerk-service",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(platformWithServiceToken.statusCode).toBe(401);
    expect(serviceResponse.statusCode).toBe(200);
    expect(serviceWithPlatformToken.statusCode).toBe(401);
  });

  it("rejects Clerk organization role claims as platform roles", async () => {
    const token = await signToken({
      claims: {
        org_id: "org_clerk_123",
        org_role: "operator",
      },
    });
    const response = await requestWithToken(OPERATOR_PATH, token);

    expectGenericError(response, 401);
  });

  it("rejects an organization role without org_id", async () => {
    const token = await signToken({ claims: { org_role: "operator" } });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("rejects a v2 organization role without o.id", async () => {
    const token = await signToken({ claims: { o: { rol: "operator" } } });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("rejects an untrusted top-level role claim", async () => {
    const token = await signToken({ claims: { role: "operator" } });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("rejects a platform_role claim without an application operator mapping", async () => {
    const token = await signToken({ claims: { platform_role: "operator" } });
    const response = await requestWithToken(OPERATOR_PATH, token);

    expectGenericError(response, 403);
  });

  it("rejects provider roles for an organization member", async () => {
    const token = await signToken({
      claims: {
        org_id: "org_clerk_123",
        org_role: "admin",
        roles: ["operator"],
      },
    });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 403);
  });

  it("accepts a mapped application platform operator", async () => {
    const app = createTestApp({
      platformOperatorDomain: {
        async hasRole(subject, role) {
          return subject === "platform-account-123" && role === "operator";
        },
      },
    });
    const token = await signToken({ claims: { roles: [] } });

    const response = await app.inject({
      method: "GET",
      url: OPERATOR_PATH,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: { subject: "platform-account-123", roles: [] },
    });
  });

  it("rejects a future-issued platform token beyond clock tolerance", async () => {
    const token = await signToken({
      issuedAt: Math.floor(Date.now() / 1_000) + 60,
    });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("forbids an operator on the quota reconciler guard", async () => {
    expectGenericError(
      await requestWithToken(QUOTA_RECONCILER_PATH, await signToken()),
      403,
    );
  });

  it("accepts only the exact platform quota_reconciler role", async () => {
    const token = await signToken({
      subject: "mapped-reconciler",
      claims: { roles: ["quota_reconciler"] },
    });
    const response = await requestWithToken(QUOTA_RECONCILER_PATH, token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: { tokenType: "platform", roles: ["quota_reconciler"] },
    });
  });

  it("forbids a quota reconciler on the operator guard", async () => {
    const token = await signToken({ claims: { roles: ["quota_reconciler"] } });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 403);
  });

  it("rejects an implied platform operator role", async () => {
    const token = await signToken({ claims: { roles: ["operator:*"] } });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 403);
  });

  it("accepts app-api entitlement publication", async () => {
    const token = await signServiceToken(
      "app-api",
      "entitlements:publish unused:scope",
    );
    const response = await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: {
        tokenType: "service",
        clientId: "app-api",
        scopes: ["entitlements:publish", "unused:scope"],
      },
    });
  });

  it("accepts an app-api service token with Clerk singleton audience array", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: [SERVICE_AUDIENCE],
      subject: "app-api",
      claims: {
        scope: "entitlements:publish",
      },
    });

    const response = await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: {
        tokenType: "service",
        audience: SERVICE_AUDIENCE,
      },
    });
  });

  it.each([
    [SERVICE_AUDIENCE, SERVICE_AUDIENCE],
    [SERVICE_AUDIENCE, "other-service"],
    ["other-service", SERVICE_AUDIENCE],
  ])("rejects a service token with extra audience entries", async (first, second) => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: [first, second],
      subject: "app-api",
      claims: {
        scope: "entitlements:publish",
      },
    });

    expectGenericError(
      await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token),
      401,
    );
  });

  it("accepts a Clerk M2M token using azp as service client ID", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      subject: "app-api",
      claims: {
        azp: "app-api",
        scope: "entitlements:publish",
      },
    });
    const response = await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: { tokenType: "service", clientId: "app-api" },
    });
  });

  it("authorizes service routes from signed source subject, not client_id", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      subject: "app-api",
      claims: {
        client_id: "untrusted-claim",
        scope: "entitlements:publish",
      },
    });

    expect(
      (await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token)).statusCode,
    ).toBe(200);
  });

  it("rejects service routes when signed source subject is wrong", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      subject: "other-worker",
      claims: {
        client_id: "app-api",
        scope: "entitlements:publish",
      },
    });

    expectGenericError(
      await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token),
      403,
    );
  });

  it("ignores empty client_id when source subject is valid", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      subject: "app-api",
      claims: {
        client_id: "",
        azp: "app-api",
        scope: "entitlements:publish",
      },
    });

    expect(
      (await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token)).statusCode,
    ).toBe(200);
  });

  it("uses client_id over azp when both service identity claims are present", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      claims: {
        client_id: "other-service",
        azp: "app-api",
        scope: "entitlements:publish",
      },
    });

    expectGenericError(
      await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token),
      403,
    );
  });

  it("does not fall back from an empty jti to sid", async () => {
    const token = await signToken({
      tokenId: "",
      claims: { sid: "sess_clerk_123" },
    });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("uses jti over sid when both token identity claims are present", async () => {
    const token = await signToken({
      subject: "mapped-operator",
      tokenId: "primary-token",
      claims: { roles: ["operator"], sid: "fallback-session" },
    });
    const response = await requestWithToken(OPERATOR_PATH, token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: { tokenId: "primary-token" },
    });
  });

  it("accepts ai-worker reservation access", async () => {
    const token = await signServiceToken(
      "ai-worker",
      "reservations:write unused:scope",
    );
    const response = await requestWithToken(RESERVATION_PATH, token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: {
        tokenType: "service",
        clientId: "ai-worker",
        scopes: ["reservations:write", "unused:scope"],
      },
    });
  });

  it("forbids app-api on an ai-worker reservation action", async () => {
    const token = await signServiceToken("app-api", "reservations:write");

    expectGenericError(await requestWithToken(RESERVATION_PATH, token), 403);
  });

  it("forbids implied service scopes", async () => {
    const token = await signServiceToken("app-api", "entitlements:*");

    expectGenericError(
      await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token),
      403,
    );
  });

  it("rejects the App internal audience on a Foundry service guard", async () => {
    const token = await signServiceToken("app-api", "entitlements:publish", {
      audience: APP_INTERNAL_AUDIENCE,
    });

    expectGenericError(
      await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token),
      401,
    );
  });

  it("rejects a platform token on a service guard", async () => {
    expectGenericError(
      await requestWithToken(ENTITLEMENT_PUBLISH_PATH, await signToken()),
      401,
    );
  });

  it("rejects an expired platform token", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const token = await signToken({ issuedAt: now - 120, expiresAt: now - 60 });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("rejects a platform token from the wrong issuer", async () => {
    const token = await signToken({ issuer: "https://wrong-issuer.test" });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("rejects a platform token with an invalid signature", async () => {
    const token = await signToken({ key: attackerKeys.privateKey });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("rejects a platform token using a non-RS256 algorithm", async () => {
    const token = await signToken({
      algorithm: "ES256",
      key: ellipticKeys.privateKey,
    });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it.each(["sub", "jti", "iat", "exp"] as const)(
    "rejects a platform token missing %s",
    async (claim) => {
      const token = await signToken({ omit: [claim] });

      expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
    },
  );

  it.each(["iat", "exp"] as const)(
    "rejects a platform token with non-numeric %s",
    async (claim) => {
      const token = await signToken({
        omit: [claim],
        claims: { roles: ["operator"], [claim]: "invalid" },
      });

      expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
    },
  );

  it("rejects a platform token with non-numeric nbf", async () => {
    const token = await signToken({
      claims: { roles: ["operator"], nbf: "invalid" },
    });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("rejects a platform token with nbf beyond clock tolerance", async () => {
    const token = await signToken({
      notBefore: Math.floor(Date.now() / 1_000) + 60,
    });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("rejects a platform token with an audience array", async () => {
    const token = await signToken({ audience: [PLATFORM_AUDIENCE] });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("rejects a platform token without a roles array", async () => {
    const token = await signToken({ claims: {} });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("does not require client_id on service tokens", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      subject: "app-api",
      claims: { scope: "entitlements:publish" },
    });

    expect(
      (await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token)).statusCode,
    ).toBe(200);
  });

  it.each([
    undefined,
    "",
    "Bearer",
    "Basic credentials",
    "Bearer token with spaces",
    "Bearer first, Bearer second",
  ])("rejects malformed bearer authorization %#", async (authorization) => {
    expectGenericError(await request(OPERATOR_PATH, authorization), 401);
  });

  it("rejects duplicate bearer headers", async () => {
    const token = await signToken();

    expectGenericError(
      await request(OPERATOR_PATH, [`Bearer ${token}`, `Bearer ${token}`]),
      401,
    );
  });
});
