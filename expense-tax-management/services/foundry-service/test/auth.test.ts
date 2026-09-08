import { generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/verifier.js";
import { platformGuard, serviceGuard } from "../src/plugins/auth.js";
import { createFoundryConfig } from "../src/config.js";

const PLATFORM_ISSUER = "https://identity.test";
const PLATFORM_AUDIENCE = "expense-foundry-platform";
const SERVICE_ISSUER = "https://services.test";
const SERVICE_AUDIENCE = "expense-foundry-internal";
const APP_INTERNAL_AUDIENCE = "expense-app-internal";

const AUTH_ENV = {
  FOUNDRY_PLATFORM_TOKEN_ISSUER: PLATFORM_ISSUER,
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: PLATFORM_AUDIENCE,
  FOUNDRY_PLATFORM_JWKS_URL:
    "https://identity.test/.well-known/jwks.json",
  FOUNDRY_SERVICE_TOKEN_ISSUER: SERVICE_ISSUER,
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: SERVICE_AUDIENCE,
  FOUNDRY_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
};

const REQUIRED_AUTH_ENV_KEYS = Object.keys(AUTH_ENV) as Array<
  keyof typeof AUTH_ENV
>;

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
      subject: "service-account-123",
      ...options,
      claims: {
        client_id: clientId,
        scope,
        ...options.claims,
      },
    });
  }

  function createTestApp() {
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
    });
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
      delete env[key];

      expect(() => createFoundryConfig({ env })).toThrow(
        `Missing required environment variable: ${key}`,
      );
    },
  );

  it("rejects a tenant owner on the platform operator guard", async () => {
    const token = await signToken({
      audience: "expense-app",
      claims: { roles: ["owner"] },
    });

    expectGenericError(await requestWithToken(OPERATOR_PATH, token), 401);
  });

  it("accepts only the exact platform operator role", async () => {
    const response = await requestWithToken(OPERATOR_PATH, await signToken());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      principal: {
        tokenType: "platform",
        subject: "platform-account-123",
        clientId: null,
        audience: PLATFORM_AUDIENCE,
        issuer: PLATFORM_ISSUER,
        roles: ["operator"],
        scopes: [],
        tokenId: "token-123",
      },
    });
  });

  it("forbids an operator on the quota reconciler guard", async () => {
    expectGenericError(
      await requestWithToken(QUOTA_RECONCILER_PATH, await signToken()),
      403,
    );
  });

  it("accepts only the exact platform quota_reconciler role", async () => {
    const token = await signToken({ claims: { roles: ["quota_reconciler"] } });
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

  it("rejects a service token without client_id", async () => {
    const token = await signToken({
      key: serviceKeys.privateKey,
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      claims: { scope: "entitlements:publish" },
    });

    expectGenericError(
      await requestWithToken(ENTITLEMENT_PUBLISH_PATH, token),
      401,
    );
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
