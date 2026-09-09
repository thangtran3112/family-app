import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activeVersionIds,
  buildProductionBundle,
} from "./production-secret-bundle.mjs";

const databaseFixture = {
  APP_DATABASE_URL:
    "postgresql://app:app-password@127.0.0.1:15432/expense_tax_db",
  APP_MIGRATION_DATABASE_URL:
    "postgresql://migrator:migrator-password@127.0.0.1:15432/expense_tax_db",
  FOUNDRY_DATABASE_URL:
    "postgresql://foundry:foundry-password@127.0.0.1:15432/expense_tax_db",
  FOUNDRY_MIGRATION_DATABASE_URL:
    "postgresql://foundry-migrator:foundry-migrator-password@127.0.0.1:15432/expense_tax_db",
};

const requiredShellEnv = {
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
};

const productionRoot = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "deploy/production",
);

describe("buildProductionBundle", () => {
  it("rewrites database URLs and preserves generated keys", () => {
    const bundle = buildProductionBundle({
      shellEnv: { ...requiredShellEnv, IMAGE_TAG: "attacker-supplied-tag" },
      databaseEnv: databaseFixture,
      currentEnv: { STORAGE_URL_SIGNING_KEY: "a".repeat(64) },
      randomBytes: () => Buffer.alloc(32, 7),
    });

    expect(bundle).toContain("@postgres:5432/expense_tax_db");
    expect(bundle).toContain(`STORAGE_URL_SIGNING_KEY=${"a".repeat(64)}`);
    expect(bundle).not.toContain("127.0.0.1:15432");
  });

  it("emits every required production Compose value with fail-closed defaults", () => {
    const bundle = buildProductionBundle({
      shellEnv: requiredShellEnv,
      databaseEnv: databaseFixture,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    const keys = new Set(bundle.split("\n").filter(Boolean).map((line) => line.split("=", 1)[0]));
    const compose = readFileSync(join(productionRoot, "docker-compose.yml"), "utf8");
    const requiredComposeKeys = [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?/gu)]
      .map(([, key]) => key)
      .filter((key) => key !== "IMAGE_TAG");

    expect(new Set(requiredComposeKeys)).not.toContain("IMAGE_TAG");
    expect([...new Set(requiredComposeKeys)].filter((key) => !keys.has(key))).toEqual([]);
    expect(bundle).toContain("APP_TENANT_TOKEN_ISSUER=https://identity.not-configured.invalid");
    expect(bundle).toContain("STORAGE_BACKEND=local");
    expect(bundle).toContain("AI_WORKER_APP_API_SERVICE_TOKEN=not-configured");
    expect(bundle).not.toContain("IMAGE_TAG=");
  });

  it("rewrites only database URL authority and preserves query text", () => {
    const url =
      "postgresql://app:password@127.0.0.1:15432/expense_tax_db?host=127.0.0.1:15432&marker=@127.0.0.1:15432#fragment";
    const bundle = buildProductionBundle({
      shellEnv: requiredShellEnv,
      databaseEnv: { ...databaseFixture, APP_DATABASE_URL: url },
      randomBytes: () => Buffer.alloc(32, 7),
    });

    expect(bundle).toContain(
      "APP_DATABASE_URL=postgresql://app:password@postgres:5432/expense_tax_db?host=127.0.0.1:15432&marker=@127.0.0.1:15432#fragment",
    );
  });

  it.each([
    ["APP_DATABASE_URL", "not-a-url"],
    ["APP_MIGRATION_DATABASE_URL", "https://app@127.0.0.1:15432/database"],
  ])("rejects invalid database URL %s without exposing its value", (key, value) => {
    expect(() =>
      buildProductionBundle({
        shellEnv: requiredShellEnv,
        databaseEnv: { ...databaseFixture, [key]: value },
      }),
    ).toThrowError(new RegExp(key));

    try {
      buildProductionBundle({
        shellEnv: requiredShellEnv,
        databaseEnv: { ...databaseFixture, [key]: value },
      });
    } catch (error) {
      expect(error.message).not.toContain(value);
    }
  });

  it("rejects missing required keys without exposing values", () => {
    expect(() =>
      buildProductionBundle({
        shellEnv: { OPENAI_API_KEY: "top-secret-openai" },
        databaseEnv: databaseFixture,
      }),
    ).toThrowError(/OPENROUTER_API_KEY/);

    try {
      buildProductionBundle({
        shellEnv: { OPENAI_API_KEY: "top-secret-openai" },
        databaseEnv: databaseFixture,
      });
    } catch (error) {
      expect(error.message).not.toContain("top-secret-openai");
    }
  });

  it("generates 32-byte hexadecimal keys on first run", () => {
    const bundle = buildProductionBundle({
      shellEnv: requiredShellEnv,
      databaseEnv: databaseFixture,
      randomBytes: () => Buffer.alloc(32, 7),
    });

    for (const key of [
      "STORAGE_URL_SIGNING_KEY",
      "INBOUND_WEBHOOK_SIGNING_KEY",
      "INBOUND_ROUTING_TOKEN_SECRET",
      "TEMPORAL_DB_PASSWORD",
    ]) {
      expect(bundle).toContain(`${key}=${"07".repeat(32)}`);
    }
  });

  it("serializes keys in deterministic dotenv order", () => {
    const bundle = buildProductionBundle({
      shellEnv: requiredShellEnv,
      databaseEnv: databaseFixture,
      currentEnv: {
        TEMPORAL_DB_PASSWORD: "11".repeat(32),
        INBOUND_ROUTING_TOKEN_SECRET: "22".repeat(32),
        INBOUND_WEBHOOK_SIGNING_KEY: "33".repeat(32),
        STORAGE_URL_SIGNING_KEY: "44".repeat(32),
      },
      randomBytes: () => Buffer.alloc(32),
    });

    expect(bundle.split("\n").filter(Boolean)).toEqual([
      "AI_WORKER_APP_API_SERVICE_TOKEN=not-configured",
      "AI_WORKER_FOUNDRY_SERVICE_TOKEN=not-configured",
      "APP_DATABASE_URL=postgresql://app:app-password@postgres:5432/expense_tax_db",
      "APP_MIGRATION_DATABASE_URL=postgresql://migrator:migrator-password@postgres:5432/expense_tax_db",
      "APP_SERVICE_JWKS_URL=https://services.not-configured.invalid/.well-known/jwks.json",
      "APP_SERVICE_TOKEN_AUDIENCE=phase-1b-inert-service",
      "APP_SERVICE_TOKEN_ISSUER=https://services.not-configured.invalid",
      "APP_TENANT_JWKS_URL=https://identity.not-configured.invalid/.well-known/jwks.json",
      "APP_TENANT_TOKEN_AUDIENCE=phase-1b-inert-tenant",
      "APP_TENANT_TOKEN_ISSUER=https://identity.not-configured.invalid",
      "FOUNDRY_DATABASE_URL=postgresql://foundry:foundry-password@postgres:5432/expense_tax_db",
      "FOUNDRY_MIGRATION_DATABASE_URL=postgresql://foundry-migrator:foundry-migrator-password@postgres:5432/expense_tax_db",
      "FOUNDRY_PLATFORM_JWKS_URL=https://identity.not-configured.invalid/.well-known/jwks.json",
      "FOUNDRY_PLATFORM_TOKEN_AUDIENCE=phase-1b-inert-platform",
      "FOUNDRY_PLATFORM_TOKEN_ISSUER=https://identity.not-configured.invalid",
      "FOUNDRY_SERVICE_JWKS_URL=https://services.not-configured.invalid/.well-known/jwks.json",
      "FOUNDRY_SERVICE_TOKEN_AUDIENCE=phase-1b-inert-service",
      "FOUNDRY_SERVICE_TOKEN_ISSUER=https://services.not-configured.invalid",
      "INBOUND_EMAIL_BASE_ADDRESS=receipts@inbound.expense-tax.local",
      `INBOUND_ROUTING_TOKEN_SECRET=${"22".repeat(32)}`,
      `INBOUND_WEBHOOK_SIGNING_KEY=${"33".repeat(32)}`,
      "OPENAI_API_KEY=openai",
      "OPENROUTER_API_KEY=openrouter",
      "STORAGE_BACKEND=local",
      "STORAGE_LOCAL_BASE_URL=http://127.0.0.1:8100",
      `STORAGE_URL_SIGNING_KEY=${"44".repeat(32)}`,
      `TEMPORAL_DB_PASSWORD=${"11".repeat(32)}`,
    ]);
  });

  it.each(["bad\nvalue", "bad\rvalue", "bad\u0000value"])(
    "rejects unsafe dotenv value %j",
    (unsafeValue) => {
      expect(() =>
        buildProductionBundle({
          shellEnv: { ...requiredShellEnv, OPENAI_API_KEY: unsafeValue },
          databaseEnv: databaseFixture,
          randomBytes: () => Buffer.alloc(32),
        }),
      ).toThrow(/unsafe|invalid/i);
    },
  );

  it.each([
    ["STORAGE_URL_SIGNING_KEY", "not-hex"],
    ["INBOUND_WEBHOOK_SIGNING_KEY", "a".repeat(63)],
    ["INBOUND_ROUTING_TOKEN_SECRET", "g".repeat(64)],
    ["TEMPORAL_DB_PASSWORD", "b".repeat(65)],
  ])("rejects malformed preserved secret %s without exposing its value", (key, value) => {
    expect(() =>
      buildProductionBundle({
        shellEnv: requiredShellEnv,
        databaseEnv: databaseFixture,
        currentEnv: { [key]: value },
        randomBytes: () => Buffer.alloc(32),
      }),
    ).toThrowError(new RegExp(key));

    try {
      buildProductionBundle({
        shellEnv: requiredShellEnv,
        databaseEnv: databaseFixture,
        currentEnv: { [key]: value },
        randomBytes: () => Buffer.alloc(32),
      });
    } catch (error) {
      expect(error.message).not.toContain(value);
    }
  });
});

describe("activeVersionIds", () => {
  it("returns enabled and disabled version IDs but excludes destroyed versions", () => {
    expect(
      activeVersionIds([
        { name: "projects/example/secrets/app/versions/1", state: "ENABLED" },
        { name: "projects/example/secrets/app/versions/2", state: "DISABLED" },
        { name: "projects/example/secrets/app/versions/3", state: "DESTROYED" },
      ]),
    ).toEqual(["1", "2"]);
  });
});
