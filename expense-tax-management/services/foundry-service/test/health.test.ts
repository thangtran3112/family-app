import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorResponseSchema, HealthResponseSchema } from "@expense-tax/contracts";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { buildApp } from "../src/app.js";
import { createFoundryConfig } from "../src/config.js";

describe("Foundry application factory", () => {
  const apps = new Set<Awaited<ReturnType<typeof buildApp>>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  it("builds without opening a listening socket", () => {
    const app = buildApp({
      config: createFoundryConfig({ version: "test" }),
      logger: false,
    });
    apps.add(app);
    expect(app.server.listening).toBe(false);
  });

  it("uses the Foundry service identity and default port", () => {
    expect(createFoundryConfig()).toEqual({
      service: "foundry-service",
      version: "0.1.0",
      port: 8200,
      authProvider: "clerk",
    });
  });

  it("serves contract-valid live health without a database", async () => {
    const app = buildApp({
      config: createFoundryConfig({ version: "test" }),
      logger: false,
    });
    apps.add(app);
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      service: "foundry-service",
      version: "test",
    });
  });

  it("returns a contract-valid 404 envelope with a request ID", async () => {
    const app = buildApp({ config: createFoundryConfig(), logger: false });
    apps.add(app);
    const response = await app.inject({ method: "GET", url: "/missing" });
    expect(response.statusCode).toBe(404);
    const body = ErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Route not found");
    expect(body.error.requestId).toEqual(expect.any(String));
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it("returns generic internal errors without implementation details", async () => {
    const app = buildApp({ config: createFoundryConfig(), logger: false });
    apps.add(app);
    app.get("/failure", async () => {
      throw new Error("provider credential leaked in stack");
    });

    const response = await app.inject({ method: "GET", url: "/failure" });
    expect(response.statusCode).toBe(500);
    const body = ErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
    expect(response.body).not.toContain("provider credential leaked in stack");
    expect(response.body).not.toContain("stack");
  });

  it("returns generic validation errors without raw validation details", async () => {
    const app = buildApp({ config: createFoundryConfig(), logger: false });
    apps.add(app);
    app.withTypeProvider<ZodTypeProvider>().get(
      "/validated",
      {
        schema: {
          querystring: z.strictObject({ provider: z.string() }),
        },
      },
      async () => ({ status: "ok" }),
    );

    const response = await app.inject({ method: "GET", url: "/validated" });
    expect(response.statusCode).toBe(400);
    const body = ErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Request validation failed");
    expect(response.body).not.toContain("provider");
    expect(response.body).not.toContain("validationContext");
  });

  it("redacts generic and provider/model credential logger fields", () => {
    const logLines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(String(chunk));
        callback();
      },
    });
    const app = buildApp({
      config: createFoundryConfig(),
      logger: { stream },
    });
    apps.add(app);

    const sensitiveFields = {
      authorization: "root-authorization",
      cookies: "root-cookies",
      databaseUrl: "root-database-url",
      key: "root-key",
      secret: "root-secret",
      token: "root-token",
      providerApiKey: "root-provider-api-key",
      providerCredentials: "root-provider-credentials",
      modelApiKey: "root-model-api-key",
      modelCredentials: "root-model-credentials",
    };
    app.log.info(sensitiveFields, "sensitive fields");

    const output = logLines.join("");
    for (const value of Object.values(sensitiveFields)) {
      expect(output).not.toContain(value);
    }
  });
});
