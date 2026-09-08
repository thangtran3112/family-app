import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.PHASE_0I_INTEGRATION === "1";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const composeScript = path.join(repoRoot, "scripts", "compose.sh");

interface ComposeService {
  readonly environment?: Record<string, string | null>;
}

interface ComposeConfig {
  readonly services: Record<string, ComposeService>;
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface DatabaseRole {
  readonly name: string;
  password: string;
}

const appMigrator: DatabaseRole = {
  name: "expense_app_migrator",
  password: "",
};
const appRuntime: DatabaseRole = {
  name: "expense_app_runtime",
  password: "",
};
const foundryMigrator: DatabaseRole = {
  name: "expense_foundry_migrator",
  password: "",
};
const foundryRuntime: DatabaseRole = {
  name: "expense_foundry_runtime",
  password: "",
};

let postgresContainerId = "";

function composeConfig(): ComposeConfig {
  return JSON.parse(
    execFileSync(composeScript, ["config", "--format", "json"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as ComposeConfig;
}

function requiredEnvironment(
  service: ComposeService,
  key: string,
): string {
  const value = service.environment?.[key];
  if (!value) {
    throw new Error(`Missing Compose environment key: ${key}`);
  }
  return value;
}

function runPsql(role: DatabaseRole, sql: string): CommandResult {
  return spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${role.password}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      role.name,
      "--dbname",
      "expense_tax_db",
      "--tuples-only",
      "--no-align",
      "--pset",
      "footer=off",
      "--command",
      sql,
    ],
    { encoding: "utf8" },
  );
}

function queryPsql(role: DatabaseRole, sql: string): string {
  const result = runPsql(role, sql);
  if (result.status !== 0) {
    throw new Error(result.stderr || `psql exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

function expectDenied(role: DatabaseRole, sql: string): void {
  expect(runPsql(role, sql).status).not.toBe(0);
}

const boundaryKey = `phase-0i-boundary-${process.pid}`;

describe.skipIf(!integrationEnabled)("Phase 0I PostgreSQL boundaries", () => {
  beforeAll(() => {
    const config = composeConfig();
    postgresContainerId = execFileSync(
      composeScript,
      ["ps", "-q", "postgres"],
      { cwd: repoRoot, env: process.env, encoding: "utf8" },
    ).trim();
    if (!postgresContainerId) {
      throw new Error("Phase 0I Postgres container is not running");
    }

    const postgres = config.services.postgres;
    appMigrator.password = requiredEnvironment(
      postgres,
      "APP_MIGRATOR_DB_PASSWORD",
    );
    appRuntime.password = requiredEnvironment(
      postgres,
      "APP_RUNTIME_DB_PASSWORD",
    );
    foundryMigrator.password = requiredEnvironment(
      postgres,
      "FOUNDRY_MIGRATOR_DB_PASSWORD",
    );
    foundryRuntime.password = requiredEnvironment(
      postgres,
      "FOUNDRY_RUNTIME_DB_PASSWORD",
    );
  });

  afterAll(() => {
    if (postgresContainerId) {
      for (const role of [appRuntime, foundryRuntime]) {
        runPsql(
          role,
          `DELETE FROM ${role === appRuntime ? "app" : "foundry"}.service_metadata WHERE key = '${boundaryKey}';`,
        );
      }
    }
  });

  it("keeps migration metadata owned and search paths isolated", () => {
    expect(
      queryPsql(
        appMigrator,
        "SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relname = 'service_metadata';",
      ),
    ).toBe(appMigrator.name);
    expect(
      queryPsql(
        foundryMigrator,
        "SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'foundry' AND c.relname = 'service_metadata';",
      ),
    ).toBe(foundryMigrator.name);

    expect(queryPsql(appRuntime, "SELECT current_schemas(false)::text;")).toBe(
      "{pg_catalog}",
    );
    expect(
      queryPsql(appMigrator, "SELECT current_schemas(false)::text;"),
    ).toBe("{app,app_migrations,pg_catalog}");
    expect(
      queryPsql(foundryRuntime, "SELECT current_schemas(false)::text;"),
    ).toBe("{pg_catalog}");
    expect(
      queryPsql(foundryMigrator, "SELECT current_schemas(false)::text;"),
    ).toBe("{foundry,foundry_migrations,pg_catalog}");
  });

  it("allows owning-schema runtime DML and denies cross-schema access", () => {
    expect(
      runPsql(
        appRuntime,
        `INSERT INTO app.service_metadata (key, value) VALUES ('${boundaryKey}', '{"service":"app"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
      ).status,
    ).toBe(0);
    expect(
      runPsql(
        appRuntime,
        `UPDATE app.service_metadata SET value = '{"service":"app-updated"}' WHERE key = '${boundaryKey}';`,
      ).status,
    ).toBe(0);
    expect(
      queryPsql(
        appRuntime,
        `SELECT value->>'service' FROM app.service_metadata WHERE key = '${boundaryKey}';`,
      ),
    ).toBe("app-updated");
    expect(
      runPsql(
        appRuntime,
        `DELETE FROM app.service_metadata WHERE key = '${boundaryKey}';`,
      ).status,
    ).toBe(0);

    expect(
      runPsql(
        foundryRuntime,
        `INSERT INTO foundry.service_metadata (key, value) VALUES ('${boundaryKey}', '{"service":"foundry"}');`,
      ).status,
    ).toBe(0);
    expectDenied(
      appRuntime,
      "SELECT * FROM foundry.service_metadata;",
    );
    expectDenied(appRuntime, "SELECT * FROM app_migrations.kysely_migration;");
    expectDenied(
      foundryRuntime,
      "SELECT * FROM app.service_metadata;",
    );
    expectDenied(
      foundryRuntime,
      "SELECT * FROM foundry_migrations.kysely_migration;",
    );
    expectDenied(appRuntime, "CREATE TABLE app.phase0i_forbidden (id integer);");
    expectDenied(
      foundryRuntime,
      "CREATE TABLE foundry.phase0i_forbidden (id integer);",
    );
  });

  it("denies extension creation, ownership changes, and SET ROLE", () => {
    for (const [role, migratorName] of [
      [appRuntime, appMigrator.name],
      [foundryRuntime, foundryMigrator.name],
    ] as const) {
      expectDenied(role, "CREATE EXTENSION vector;");
      expectDenied(
        role,
        "ALTER TABLE app.service_metadata OWNER TO expense_app_runtime;",
      );
      expectDenied(role, `SET ROLE ${migratorName};`);
    }
  });

  it("denies each migrator access to the other service domain", () => {
    expectDenied(appMigrator, "SELECT * FROM foundry.service_metadata;");
    expectDenied(appMigrator, "SELECT * FROM foundry_migrations.kysely_migration;");
    expectDenied(
      appMigrator,
      "CREATE TABLE foundry.phase0i_migrator_forbidden (id integer);",
    );
    expectDenied(foundryMigrator, "SELECT * FROM app.service_metadata;");
    expectDenied(foundryMigrator, "SELECT * FROM app_migrations.kysely_migration;");
    expectDenied(
      foundryMigrator,
      "CREATE TABLE app.phase0i_migrator_forbidden (id integer);",
    );
  });
});
