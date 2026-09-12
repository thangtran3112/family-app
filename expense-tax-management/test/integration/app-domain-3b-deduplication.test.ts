import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { runMigrations } from "../../services/app-api/src/database/migrate.js";
import { createDeduplicationDomain } from "../../services/app-api/src/domain/deduplication.js";

const requested = process.env.PHASE_3B_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_dedup_${runKey}`;
const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

function composePostgresAvailable(): boolean {
  if (!requested || !dockerAvailable) return false;
  try {
    return execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;
  } catch {
    return false;
  }
}

const integrationEnabled = composePostgresAvailable();

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;
let migrationDatabaseUrl = "";
let runtimeDatabaseUrl = "";

function dockerPsql(
  databaseNameForConnection: string,
  username: string,
  password: string,
  sql: string,
): string {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      username,
      "--dbname",
      databaseNameForConnection,
      "--tuples-only",
      "--no-align",
      "--pset",
      "footer=off",
      "--command",
      sql,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function adminSql(sql: string, databaseNameForConnection = "postgres"): string {
  return dockerPsql(databaseNameForConnection, "postgres", "postgrespassword", sql);
}

function runtimeSql(sql: string): string {
  return dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sql);
}

function seedBusinessScope(): {
  readonly userId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly foreignBusinessId: string;
  readonly existingExpenseId: string;
  readonly candidateExpenseId: string;
  readonly matchId: string;
  readonly existingFileId: string;
  readonly candidateFileId: string;
} {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const businessId = randomUUID();
  const foreignBusinessId = randomUUID();
  const existingExpenseId = randomUUID();
  const candidateExpenseId = randomUUID();
  const matchId = randomUUID();
  const existingFileId = randomUUID();
  const candidateFileId = randomUUID();
  const sourcePrefix = `3b-${runKey}`;
  runtimeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${userId}', '${sourcePrefix}@example.test', '3B User');
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${tenantId}', '3B Tenant', '${sourcePrefix}');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
    VALUES ('${tenantId}', '${userId}', 'owner');
    INSERT INTO app.businesses
      (id, tenant_id, name, industry_code, timezone, base_currency)
    VALUES
      ('${businessId}', '${tenantId}', '3B Business', 'restaurant', 'UTC', 'USD'),
      ('${foreignBusinessId}', '${tenantId}', '3B Foreign Business', 'restaurant', 'UTC', 'USD');
    INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role)
    VALUES ('${businessId}', '${tenantId}', '${userId}', 'owner');
    INSERT INTO app.expenses
      (id, tenant_id, created_by_user_id, business_id, merchant, description,
       amount, currency, incurred_on, source, status)
    VALUES
      ('${existingExpenseId}', '${tenantId}', '${userId}', '${businessId}',
       'Canonical Cafe', NULL, 10.00, 'USD', '2026-09-11', 'manual', 'ready'),
      ('${candidateExpenseId}', '${tenantId}', '${userId}', '${businessId}',
       'OCR Cafe', 'OCR receipt details', 12.00, 'USD', '2026-09-11', 'manual', 'ready');
    INSERT INTO app.expense_files
      (id, tenant_id, business_id, expense_id, original_filename, content_type,
       size_bytes, sha256_hex, storage_key, thumbnail_status, status)
    VALUES
      ('${existingFileId}', '${tenantId}', '${businessId}', '${existingExpenseId}',
       'existing.pdf', 'application/pdf', 10, '${"a".repeat(64)}',
       '3b/${existingFileId}', 'skipped', 'READY'),
      ('${candidateFileId}', '${tenantId}', '${businessId}', '${candidateExpenseId}',
       'candidate.pdf', 'application/pdf', 10, '${"b".repeat(64)}',
       '3b/${candidateFileId}', 'skipped', 'READY');
    INSERT INTO app.expense_sources
      (id, tenant_id, business_id, expense_id, source_type, source_file_id, metadata)
    VALUES
      ('${randomUUID()}', '${tenantId}', '${businessId}', '${existingExpenseId}',
       'manual_upload', '${existingFileId}', '{}'::jsonb),
      ('${randomUUID()}', '${tenantId}', '${businessId}', '${candidateExpenseId}',
       'manual_upload', '${candidateFileId}', '{}'::jsonb);
    INSERT INTO app.expense_duplicate_matches
      (id, tenant_id, business_id, existing_expense_id, candidate_expense_id,
       match_type, confidence, evidence, idempotency_key)
    VALUES
      ('${matchId}', '${tenantId}', '${businessId}', '${existingExpenseId}',
       '${candidateExpenseId}', 'fingerprint', 1.0000,
       '{"fingerprintHash":"${"c".repeat(64)}"}'::jsonb, '${sourcePrefix}-match');
  `);
  return {
    userId,
    tenantId,
    businessId,
    foreignBusinessId,
    existingExpenseId,
    candidateExpenseId,
    matchId,
    existingFileId,
    candidateFileId,
  };
}

describe.skipIf(!integrationEnabled)("Phase 3B duplicate resolution PostgreSQL integration", () => {
  let seed: ReturnType<typeof seedBusinessScope>;

  beforeAll(async () => {
    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as ComposeConfig;
    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    }).trim();
    runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    migratorPassword = config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword || !migratorPassword) {
      throw new Error("Phase 3B PostgreSQL prerequisites are missing");
    }

    adminSql(`CREATE DATABASE ${databaseName};`);
    adminSql(`
      CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
      CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;
      GRANT USAGE ON SCHEMA app TO expense_app_runtime;
    `, databaseName);
    migrationDatabaseUrl = `postgresql://expense_app_migrator:${encodeURIComponent(migratorPassword)}@127.0.0.1:5433/${databaseName}`;
    runtimeDatabaseUrl = `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/${databaseName}`;
    await runMigrations(migrationDatabaseUrl);
    adminSql(`
      GRANT USAGE ON SCHEMA app TO expense_app_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;
    `, databaseName);
    database = createAppDatabase(runtimeDatabaseUrl);
    seed = seedBusinessScope();
  });

  afterAll(async () => {
    await database?.destroy();
    if (postgresContainerId && databaseName) {
      adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    }
  });

  it("lists and resolves Business matches, denies foreign scope, and rolls back partial merge", async () => {
    const db = database;
    if (!db) throw new Error("Integration database was not initialized");
    const domain = createDeduplicationDomain(db);
    const scope = { kind: "business" as const, businessId: seed.businessId };

    const listed = await domain.listMatches({
      actorUserId: seed.userId,
      tenantId: seed.tenantId,
      scope,
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.id).toBe(seed.matchId);

    await expect(domain.listMatches({
      actorUserId: seed.userId,
      tenantId: seed.tenantId,
      scope: { kind: "business", businessId: seed.foreignBusinessId },
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(domain.resolveMatch?.({
      actorUserId: seed.userId,
      tenantId: seed.tenantId,
      scope: { kind: "business", businessId: seed.foreignBusinessId },
      matchId: seed.matchId,
      action: "merge",
      expectedMatchVersion: 1,
      idempotencyKey: `3b-${runKey}-foreign`,
      requestId: `3b-${runKey}-foreign`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    adminSql(`
      CREATE OR REPLACE FUNCTION app.test_3b_force_rollback()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced Task 4 rollback'; END;
      $$;
      CREATE TRIGGER test_3b_force_rollback_trigger
      BEFORE UPDATE ON app.expense_duplicate_matches
      FOR EACH ROW EXECUTE FUNCTION app.test_3b_force_rollback();
    `, databaseName);
    await expect(domain.resolveMatch?.({
      actorUserId: seed.userId,
      tenantId: seed.tenantId,
      scope,
      matchId: seed.matchId,
      action: "merge",
      expectedMatchVersion: 1,
      idempotencyKey: `3b-${runKey}-rollback`,
      requestId: `3b-${runKey}-rollback`,
    })).rejects.toThrow("forced Task 4 rollback");
    expect(runtimeSql(`SELECT status FROM app.expenses WHERE id = '${seed.candidateExpenseId}';`)).toBe("ready");
    expect(runtimeSql(`SELECT expense_id FROM app.expense_files WHERE id = '${seed.candidateFileId}';`)).toBe(seed.candidateExpenseId);
    expect(runtimeSql(`SELECT expense_id FROM app.expense_sources WHERE source_file_id = '${seed.candidateFileId}';`)).toBe(seed.candidateExpenseId);
    expect(runtimeSql(`SELECT status || ':' || version FROM app.expense_duplicate_matches WHERE id = '${seed.matchId}';`)).toBe("pending:1");
    expect(runtimeSql(`SELECT count(*) FROM app.app_audit_events WHERE request_id = '3b-${runKey}-rollback';`)).toBe("0");

    adminSql("DROP TRIGGER test_3b_force_rollback_trigger ON app.expense_duplicate_matches; DROP FUNCTION app.test_3b_force_rollback();", databaseName);
    const resolved = await domain.resolveMatch?.({
      actorUserId: seed.userId,
      tenantId: seed.tenantId,
      scope,
      matchId: seed.matchId,
      action: "merge",
      expectedMatchVersion: 1,
      idempotencyKey: `3b-${runKey}-success`,
      requestId: `3b-${runKey}-success`,
    });
    expect(resolved).toMatchObject({ status: "merged", version: 2 });
    expect(runtimeSql(`SELECT status FROM app.expenses WHERE id = '${seed.candidateExpenseId}';`)).toBe("archived");
    expect(runtimeSql(`SELECT expense_id FROM app.expense_files WHERE id = '${seed.candidateFileId}';`)).toBe(seed.existingExpenseId);
    expect(runtimeSql(`SELECT expense_id FROM app.expense_sources WHERE source_file_id = '${seed.candidateFileId}';`)).toBe(seed.existingExpenseId);
    expect(runtimeSql(`SELECT count(*) FROM app.app_audit_events WHERE request_id = '3b-${runKey}-success';`)).toBe("1");
  });
});
