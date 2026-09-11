import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ErrorResponseSchema, HealthResponseSchema } from "@expense-tax/contracts";
import { sql } from "kysely";
import { buildApp } from "../src/app.js";
import { createFoundryConfig } from "../src/config.js";
import { up as migrateOperatorRoles } from "../src/database/migrations/006_platform_operator_identity_roles.js";
import { createFoundryDatabase } from "../src/database/client.js";

const TEST_ENV = {
  FOUNDRY_PLATFORM_TOKEN_ISSUER: "https://identity.test",
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: "expense-foundry-platform",
  FOUNDRY_PLATFORM_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  FOUNDRY_SERVICE_TOKEN_ISSUER: "https://services.test",
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: "expense-foundry-internal",
  FOUNDRY_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  FOUNDRY_DATABASE_URL: "postgresql://foundry-runtime.test/foundry",
};

const migrationTestUrl = process.env.FOUNDRY_MIGRATION_TEST_DATABASE_URL;
const migrationTestMarker = process.env.FOUNDRY_MIGRATION_TEST_DISPOSABLE;

function isDisposableMigrationTestAllowed(
  url: string | undefined,
  marker: string | undefined,
): boolean {
  if (marker !== "1" || url === undefined) return false;
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

const migrationTestAllowed = isDisposableMigrationTestAllowed(
  migrationTestUrl,
  migrationTestMarker,
);

describe("Foundry database boundaries", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();
  let migrationDatabase: ReturnType<typeof createFoundryDatabase> | undefined;

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  beforeAll(async () => {
    if (!migrationTestAllowed || !migrationTestUrl) return;
    migrationDatabase = createFoundryDatabase(migrationTestUrl);
    await sql`CREATE SCHEMA IF NOT EXISTS foundry`.execute(migrationDatabase);
    await sql`DROP TABLE IF EXISTS foundry.platform_operator_identities`.execute(
      migrationDatabase,
    );
    await sql`
      CREATE TABLE foundry.platform_operator_identities (
        clerk_user_id text PRIMARY KEY,
        role text NOT NULL CHECK (role IN ('operator', 'catalog_manager', 'quota_reconciler')),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(migrationDatabase);
    await migrateOperatorRoles(migrationDatabase);
  });

  afterEach(async () => {
    if (!migrationDatabase) return;
    await sql`TRUNCATE foundry.platform_operator_identities`.execute(migrationDatabase);
  });

  afterAll(async () => {
    await migrationDatabase?.destroy();
  });

  it.each([
    [undefined, "postgresql://user@127.0.0.1/task2_migration_test", false],
    ["0", "postgresql://user@127.0.0.1/task2_migration_test", false],
    ["1", "postgresql://user@db.internal/task2_migration_test", false],
    ["1", "postgresql://user@127.0.0.1/task2_migration_test", true],
  ])(
    "enables migration setup only for explicit disposable marker and local URL",
    (marker, url, expected) => {
      expect(isDisposableMigrationTestAllowed(url, marker)).toBe(expected);
    },
  );

  it.skipIf(!migrationTestAllowed)(
    "allows one Clerk user to hold both operator roles and rejects duplicate role rows",
    async () => {
      if (!migrationDatabase) throw new Error("migration test database is not configured");
      await sql`
        INSERT INTO foundry.platform_operator_identities (clerk_user_id, role)
        VALUES ('user_thang', 'operator'), ('user_thang', 'catalog_manager')
      `.execute(migrationDatabase);

      const rows = await sql<{ role: string }>`
        SELECT role FROM foundry.platform_operator_identities
        WHERE clerk_user_id = 'user_thang' ORDER BY role
      `.execute(migrationDatabase);
      expect(rows.rows.map((row) => row.role)).toEqual([
        "catalog_manager",
        "operator",
      ]);

      await expect(
        sql`
          INSERT INTO foundry.platform_operator_identities (clerk_user_id, role)
          VALUES ('user_thang', 'operator')
        `.execute(migrationDatabase),
      ).rejects.toThrow(/duplicate key|platform_operator_identities_pkey/);
    },
  );

  it("accepts runtime configuration without a migration database URL", () => {
    const runtimeEnv: Record<string, string> = { ...TEST_ENV };
    delete runtimeEnv.FOUNDRY_MIGRATION_DATABASE_URL;

    expect(createFoundryConfig({ env: runtimeEnv }).databaseUrl).toBe(
      TEST_ENV.FOUNDRY_DATABASE_URL,
    );
  });

  it("reports ready after the injected database probe succeeds", async () => {
    const readinessProbe = vi.fn(async () => undefined);
    const app = buildApp({
      config: createFoundryConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      readinessProbe,
    });
    apps.add(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      service: "foundry-service",
      version: "test",
    });
    expect(readinessProbe).toHaveBeenCalledOnce();
  });

  it("returns a generic 503 when the database probe fails", async () => {
    const readinessProbe = vi.fn(async () => {
      throw new Error("sensitive database failure");
    });
    const app = buildApp({
      config: createFoundryConfig({ env: TEST_ENV }),
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
      config: createFoundryConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      readinessProbe,
    });
    apps.add(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      service: "foundry-service",
      version: "test",
    });
    expect(readinessProbe).not.toHaveBeenCalled();
  });

  it("migrates operator identities to a composite user and role key", async () => {
    const migration = await readFile(
      path.join(
        import.meta.dirname,
        "../src/database/migrations/006_platform_operator_identity_roles.ts",
      ),
      "utf8",
    );

    expect(migration).toContain("PRIMARY KEY (clerk_user_id, role)");
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS platform_operator_identities_pkey");
    expect(migration).toContain("duplicate");
  });

  it("keeps role checks exact so one user can hold both roles", async () => {
    const domain = await readFile(
      path.join(import.meta.dirname, "../src/domain/platform-operators.ts"),
      "utf8",
    );

    expect(domain).toContain('.where("role", "=", role)');
    expect(domain).toContain('.where("status", "=", "active")');
  });
});
