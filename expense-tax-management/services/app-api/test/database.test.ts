import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorResponseSchema, HealthResponseSchema } from "@expense-tax/contracts";
import { buildApp } from "../src/app.js";
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

describe("App API database boundaries", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  it("accepts runtime configuration without a migration database URL", () => {
    const runtimeEnv: Record<string, string> = { ...TEST_ENV };
    delete runtimeEnv.APP_MIGRATION_DATABASE_URL;

    expect(createAppConfig({ env: runtimeEnv }).databaseUrl).toBe(
      TEST_ENV.APP_DATABASE_URL,
    );
  });

  it("reports ready after the injected database probe succeeds", async () => {
    const readinessProbe = vi.fn(async () => undefined);
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      readinessProbe,
    });
    apps.add(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      service: "app-api",
      version: "test",
    });
    expect(readinessProbe).toHaveBeenCalledOnce();
  });

  it("returns a generic 503 when the database probe fails", async () => {
    const readinessProbe = vi.fn(async () => {
      throw new Error("sensitive database failure");
    });
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV }),
      logger: false,
      readinessProbe,
    });
    apps.add(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(ErrorResponseSchema.parse(response.json())).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        requestId: expect.any(String),
      },
    });
    expect(response.body).not.toContain("sensitive database failure");
    expect(readinessProbe).toHaveBeenCalledOnce();
  });

  it("keeps live health database-free", async () => {
    const readinessProbe = vi.fn(async () => {
      throw new Error("probe must not run");
    });
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      readinessProbe,
    });
    apps.add(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      service: "app-api",
      version: "test",
    });
    expect(readinessProbe).not.toHaveBeenCalled();
  });
});
