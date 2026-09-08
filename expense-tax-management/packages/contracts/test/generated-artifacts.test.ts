import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";
import type { paths as AppApiPaths } from "../generated/typescript/app-api.paths.js";
import type { paths as FoundryServicePaths } from "../generated/typescript/foundry-service.paths.js";
import { JobReferenceV1Schema } from "../src/index.js";
import { createAppApiClient } from "../src/clients/app-api.js";
import { createFoundryServiceClient } from "../src/clients/foundry-service.js";

const jobReferenceFixture: unknown = JSON.parse(
  readFileSync(
    new URL("../fixtures/job-reference-v1.json", import.meta.url),
    "utf8",
  ),
);

function readArtifact(relativePath: string): string {
  return readFileSync(new URL(`../generated/${relativePath}`, import.meta.url), "utf8");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function expectStableJson(relativePath: string): Record<string, unknown> {
  const raw = readArtifact(relativePath);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  expect(raw).not.toMatch(/\/Users\/|[A-Z]:\\\\/);
  expect(raw).not.toMatch(/generatedAt|timestamp/i);
  expect(raw).toBe(`${JSON.stringify(sortJson(parsed), null, 2)}\n`);
  return parsed;
}

describe("generated API artifacts", () => {
  it("publishes service-specific OpenAPI 3.1 documents", () => {
    const appDocument = expectStableJson("openapi/app-api.openapi.json");
    const foundryDocument = expectStableJson(
      "openapi/foundry-service.openapi.json",
    );

    expect(appDocument.openapi).toBe("3.1.0");
    expect(appDocument.info).toMatchObject({ title: "Expense Tax App API" });
    expect(appDocument.paths).toHaveProperty("/health/live");
    expect(JSON.stringify(appDocument)).not.toContain("Foundry");

    expect(foundryDocument.openapi).toBe("3.1.0");
    expect(foundryDocument.info).toMatchObject({ title: "Expense Tax Foundry Service" });
    expect(foundryDocument.paths).toHaveProperty("/health/live");
    expect(JSON.stringify(foundryDocument)).not.toContain("App API");
  });

  it("publishes JSON Schema from the canonical internal contract", () => {
    const schema = expectStableJson("json-schema/internal-messages.schema.json");

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    expect(JobReferenceV1Schema.parse(jobReferenceFixture)).toEqual(
      jobReferenceFixture,
    );
  });

  it("publishes typed paths and maintained clients", () => {
    type AppHasLivePath = "/health/live" extends keyof AppApiPaths ? true : false;
    type FoundryHasLivePath =
      "/health/live" extends keyof FoundryServicePaths ? true : false;

    expectTypeOf<AppHasLivePath>().toEqualTypeOf<true>();
    expectTypeOf<FoundryHasLivePath>().toEqualTypeOf<true>();
    expectTypeOf(createAppApiClient("https://app.test")).toHaveProperty("GET");
    expectTypeOf(createFoundryServiceClient("https://foundry.test")).toHaveProperty(
      "GET",
    );
  });
});
