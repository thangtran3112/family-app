import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorResponseSchema, HealthResponseSchema } from "@expense-tax/contracts";
import { buildApp } from "../src/app.js";
import { createAppConfig } from "../src/config.js";

describe("App API application factory", () => {
  const apps = new Set<Awaited<ReturnType<typeof buildApp>>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  it("builds without opening a listening socket", () => {
    const app = buildApp({ config: createAppConfig({ version: "test" }), logger: false });
    apps.add(app);
    expect(app.server.listening).toBe(false);
  });

  it("serves contract-valid live health without a database", async () => {
    const app = buildApp({ config: createAppConfig({ version: "test" }), logger: false });
    apps.add(app);
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      service: "app-api",
      version: "test",
    });
  });

  it("returns a contract-valid 404 envelope with a request ID", async () => {
    const app = buildApp({ config: createAppConfig(), logger: false });
    apps.add(app);
    const response = await app.inject({ method: "GET", url: "/missing" });
    expect(response.statusCode).toBe(404);
    const body = ErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Route not found");
    expect(body.error.requestId).toEqual(expect.any(String));
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it("redacts root-level sensitive logger fields", () => {
    const logLines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(String(chunk));
        callback();
      },
    });
    const app = buildApp({
      config: createAppConfig(),
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
    };
    app.log.info(sensitiveFields, "sensitive fields");

    const output = logLines.join("");
    for (const value of Object.values(sensitiveFields)) {
      expect(output).not.toContain(value);
    }
  });
});
