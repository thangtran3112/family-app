import { describe, expect, it } from "vitest";
import { createFoundryConfig } from "../src/config.js";

const ENV = {
  AUTH_PROVIDER: "clerk",
  FOUNDRY_PLATFORM_TOKEN_ISSUER: "https://identity.test",
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: "expense-foundry-platform",
  FOUNDRY_PLATFORM_JWKS_URL: "https://identity.test/jwks",
  FOUNDRY_SERVICE_TOKEN_ISSUER: "https://services.test",
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: "expense-foundry-internal",
  FOUNDRY_SERVICE_JWKS_URL: "https://services.test/jwks",
  FOUNDRY_DATABASE_URL: "postgresql://foundry.test/foundry",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
};

const LEGACY_ENV = { ...ENV, AUTH_PROVIDER: "legacy" };
for (const key of [
  "CLERK_ISSUER_URL",
  "CLERK_JWKS_URL",
  "CLERK_TENANT_AUDIENCE",
  "CLERK_PLATFORM_AUDIENCE",
  "CLERK_APP_SERVICE_AUDIENCE",
  "CLERK_FOUNDRY_SERVICE_AUDIENCE",
] as const) {
  delete LEGACY_ENV[key];
}

describe("Foundry Clerk configuration", () => {
  it("does not require Clerk values in legacy mode", () => {
    const config = createFoundryConfig({ env: LEGACY_ENV });

    expect(config.authProvider).toBe("legacy");
    expect(config.clerk).toBeUndefined();
  });

  it("parses required Clerk values and leaves secrets optional", () => {
    const config = createFoundryConfig({ env: ENV });

    expect(config.authProvider).toBe("clerk");
    expect(config.clerk).toEqual({
      issuerUrl: "https://clerk.test",
      jwksUrl: "https://clerk.test/.well-known/jwks.json",
      tenantAudience: "tenant-audience",
      platformAudience: "platform-audience",
      appServiceAudience: "app-service-audience",
      foundryServiceAudience: "foundry-service-audience",
      appServiceSubject: "ai-worker-app-machine",
      foundryServiceSubject: "ai-worker-foundry-machine",
      publishableKey: undefined,
      secretKey: undefined,
      webhookSigningSecret: undefined,
    });
  });

  it.each([
    "http://clerk.test",
    "file:///tmp/issuer",
    "data:text/plain,issuer",
  ])("rejects non-HTTPS Clerk issuer URLs: %s", (issuerUrl) => {
    const env = { ...ENV, CLERK_ISSUER_URL: issuerUrl };

    expect(() => createFoundryConfig({ env })).toThrow(
      "Invalid URL in environment variable: CLERK_ISSUER_URL",
    );
  });

  it.each([
    "http://clerk.test/jwks",
    "file:///tmp/jwks.json",
    "data:application/json,{}",
  ])("rejects non-HTTPS Clerk JWKS URLs: %s", (jwksUrl) => {
    const env = { ...ENV, CLERK_JWKS_URL: jwksUrl };

    expect(() => createFoundryConfig({ env })).toThrow(
      "Invalid URL in environment variable: CLERK_JWKS_URL",
    );
  });

  it("does not use ambient Clerk values with an explicit env object", () => {
    const previousValues = Object.fromEntries(
      [
        "CLERK_ISSUER_URL",
        "CLERK_JWKS_URL",
        "CLERK_TENANT_AUDIENCE",
        "CLERK_PLATFORM_AUDIENCE",
        "CLERK_APP_SERVICE_AUDIENCE",
        "CLERK_FOUNDRY_SERVICE_AUDIENCE",
      ].map((key) => [key, process.env[key]]),
    );
    process.env.CLERK_ISSUER_URL = "https://ambient-clerk.test";
    process.env.CLERK_JWKS_URL = "https://ambient-clerk.test/jwks";
    process.env.CLERK_TENANT_AUDIENCE = "ambient-tenant";
    process.env.CLERK_PLATFORM_AUDIENCE = "ambient-platform";
    process.env.CLERK_APP_SERVICE_AUDIENCE = "ambient-app-service";
    process.env.CLERK_FOUNDRY_SERVICE_AUDIENCE = "ambient-foundry-service";
    const env = { ...ENV };
    delete env.CLERK_ISSUER_URL;
    delete env.CLERK_JWKS_URL;
    delete env.CLERK_TENANT_AUDIENCE;
    delete env.CLERK_PLATFORM_AUDIENCE;
    delete env.CLERK_APP_SERVICE_AUDIENCE;
    delete env.CLERK_FOUNDRY_SERVICE_AUDIENCE;

    try {
      expect(() => createFoundryConfig({ env })).toThrow(
        "Missing required environment variable: CLERK_ISSUER_URL",
      );
    } finally {
      for (const [key, value] of Object.entries(previousValues)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
