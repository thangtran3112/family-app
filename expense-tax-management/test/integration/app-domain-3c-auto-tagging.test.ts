/**
 * Phase 3C integration test -- auto-tagging enrichment boundary.
 *
 * RED until Task 4 wires the enrichment job into insertExpenseInTransaction.
 *
 * Lifecycle: disposable PostgreSQL database per run (Phase 3B pattern).
 * Fixture scope is isolated to PHASE_3C_TENANT_A_ID so Task 11's multi-expense
 * seeds cannot change this test's exact-one job/outbox count.
 *
 * Generic pnpm test:integration skips when PHASE_3C_INTEGRATION is unset.
 * Dedicated test:integration:3c sets PHASE_3C_INTEGRATION=1; if Docker or
 * Postgres is then unavailable, beforeAll throws rather than silently skipping.
 * The JSON inspection rejects any skipped/pending outcome as a second guard.
 *
 * Docker availability is probed inside beforeAll only -- never at module
 * evaluation -- so generic runs do not pay the cost of a subprocess call.
 *
 * Migration 016 typecheck: importing the module at the top of this file
 * ensures the TypeScript compiler (and vitest's esbuild transform) rejects
 * malformed TypeScript such as a bare SQL comment outside a template literal.
 */
import * as migration016 from "../../services/app-api/src/database/migrations/016_expense_enrichment.js";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { runMigrations } from "../../services/app-api/src/database/migrate.js";
import { createExpenseDomain } from "../../services/app-api/src/domain/expenses.js";

// --- Deterministic Phase 3C fixture UUIDs ---
// Kept here (not in a shared module) so later tasks cannot accidentally
// cross scopes by importing a convenience re-export.
//
// Schema note: personal_profiles has UNIQUE (tenant_id) -- only one profile
// per tenant. Profile A belongs to Tenant A; Profile B is reserved for Tenant B
// (a second isolated scope used in Task 11 multi-expense scenarios).

const PHASE_3C_TENANT_A_ID    = "3c000000-0000-4000-8000-000000000001";
const PHASE_3C_TENANT_B_ID    = "3c000000-0000-4000-8000-000000000011";
const PHASE_3C_USER_ID        = "3c000000-0000-4000-8000-000000000002";
const PHASE_3C_PROFILE_A_ID   = "3c000000-0000-4000-8000-000000000003";
const PHASE_3C_PROFILE_B_ID   = "3c000000-0000-4000-8000-000000000004";
const PHASE_3C_BUSINESS_A_ID  = "3c000000-0000-4000-8000-000000000005";
const PHASE_3C_BUSINESS_B_ID  = "3c000000-0000-4000-8000-000000000006";
// Taxonomy/profile/category IDs reserved for later tasks (T8 / T11).
const _PHASE_3C_TAXONOMY_VERSION_ID  = "3c000000-0000-4000-8000-000000000007";
const _PHASE_3C_TAX_PROFILE_ID       = "3c000000-0000-4000-8000-000000000008";
const _PHASE_3C_SPENDING_CATEGORY_ID = "3c000000-0000-4000-8000-000000000009";
const _PHASE_3C_EXPENSE_V1_ID        = "3c000000-0000-4000-8000-00000000000a";
const _PHASE_3C_EXPENSE_V2_ID        = "3c000000-0000-4000-8000-00000000000b";

// --- Module-level constants (no subprocess calls) ---

const requested = process.env.PHASE_3C_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_3c_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

// Skip condition: env not requested only. Docker/Postgres probing happens
// inside beforeAll so it never runs during generic pnpm test:integration.
const integrationEnabled = requested;

// --- State ---

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;

// --- psql helpers ---

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

function adminSql(sql: string, db = "postgres"): string {
  return dockerPsql(db, "postgres", "postgrespassword", sql);
}

function runtimeSql(sql: string): string {
  return dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sql);
}

// --- Fixture seeding ---
// Two isolated tenant scopes:
//   Tenant A -- Profile A, Business A, Business B (this test's scope)
//   Tenant B -- Profile B (reserved for Task 11 multi-expense scenarios)
//
// Row counts for the enrichment job assertion below target Tenant A only, so
// Task 11 adding expenses under Tenant B or a random tenant cannot inflate
// the exact-one count.

function seedPersonalScope(): void {
  runtimeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${PHASE_3C_USER_ID}', '3c-owner@example.test', '3C Owner');

    -- Tenant A: Profile A scope (used by this integration test)
    INSERT INTO app.tenants (id, name, slug, status)
    VALUES ('${PHASE_3C_TENANT_A_ID}', '3C Tenant A', '3c-tenant-a-${runKey}', 'active');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
    VALUES ('${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}', 'owner', 'active');
    INSERT INTO app.personal_profiles (id, tenant_id, name)
    VALUES ('${PHASE_3C_PROFILE_A_ID}', '${PHASE_3C_TENANT_A_ID}', '3C Profile A');
    INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
    VALUES ('${PHASE_3C_PROFILE_A_ID}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}', 'owner', 'active');
    INSERT INTO app.businesses
      (id, tenant_id, name, industry_code, timezone, base_currency, status)
    VALUES
      ('${PHASE_3C_BUSINESS_A_ID}', '${PHASE_3C_TENANT_A_ID}', '3C Biz A', 'restaurant', 'UTC', 'USD', 'active'),
      ('${PHASE_3C_BUSINESS_B_ID}', '${PHASE_3C_TENANT_A_ID}', '3C Biz B', 'restaurant', 'UTC', 'USD', 'active');
    INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role, status)
    VALUES
      ('${PHASE_3C_BUSINESS_A_ID}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}', 'owner', 'active'),
      ('${PHASE_3C_BUSINESS_B_ID}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}', 'owner', 'active');

    -- Tenant B: Profile B scope (reserved for Task 11)
    INSERT INTO app.tenants (id, name, slug, status)
    VALUES ('${PHASE_3C_TENANT_B_ID}', '3C Tenant B', '3c-tenant-b-${runKey}', 'active');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
    VALUES ('${PHASE_3C_TENANT_B_ID}', '${PHASE_3C_USER_ID}', 'owner', 'active');
    INSERT INTO app.personal_profiles (id, tenant_id, name)
    VALUES ('${PHASE_3C_PROFILE_B_ID}', '${PHASE_3C_TENANT_B_ID}', '3C Profile B');
    INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
    VALUES ('${PHASE_3C_PROFILE_B_ID}', '${PHASE_3C_TENANT_B_ID}', '${PHASE_3C_USER_ID}', 'owner', 'active');
  `);
}

// --- Test suite ---

// Static typecheck: migration016 must export up/down; this assertion runs
// regardless of integrationEnabled so a malformed migration always fails.
if (typeof migration016.up !== "function" || typeof migration016.down !== "function") {
  throw new Error("migration016 does not export up/down functions — TypeScript compilation failed");
}

describe.skipIf(!integrationEnabled)("Phase 3C auto-tagging enrichment PostgreSQL integration", () => {
  beforeAll(async () => {
    // Probe Docker and Postgres here (not at module level) so generic runs
    // never spawn subprocesses. Both failure paths use the exact required
    // message so the dedicated command always errors rather than silently
    // skipping when infrastructure is absent.
    const dockerAvailable =
      spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    if (!dockerAvailable) {
      throw new Error("Phase 3C PostgreSQL prerequisites unavailable");
    }

    let postgresRunning = false;
    try {
      postgresRunning =
        execFileSync(composeScript, ["ps", "-q", "postgres"], {
          cwd: repoRoot,
          env: process.env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim().length > 0;
    } catch {
      postgresRunning = false;
    }
    if (!postgresRunning) {
      throw new Error("Phase 3C PostgreSQL prerequisites unavailable");
    }

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
      throw new Error("Phase 3C PostgreSQL prerequisites unavailable");
    }

    adminSql(`CREATE DATABASE ${databaseName};`);
    adminSql(`
      CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
      CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;
      GRANT USAGE ON SCHEMA app TO expense_app_runtime;
    `, databaseName);
    const migrationDatabaseUrl =
      `postgresql://expense_app_migrator:${encodeURIComponent(migratorPassword)}@127.0.0.1:5433/${databaseName}`;
    const runtimeDatabaseUrl =
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/${databaseName}`;
    await runMigrations(migrationDatabaseUrl);
    adminSql(`
      GRANT USAGE ON SCHEMA app TO expense_app_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;
    `, databaseName);
    database = createAppDatabase(runtimeDatabaseUrl);
    seedPersonalScope();
  });

  afterAll(async () => {
    await database?.destroy();
    if (postgresContainerId && databaseName) {
      adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    }
  });

  it(
    "migration 016 UNIQUE NULLS NOT DISTINCT rejects duplicate null candidate_id binding (live PostgreSQL proof)",
    () => {
      // This proves that two operation key rows with identical binding and
      // candidate_id IS NULL both collide via the PG17 UNIQUE NULLS NOT DISTINCT
      // constraint. Standard UNIQUE would treat NULL != NULL and allow duplicates.
      //
      // We need a real tenant, processing_job, and expense row. Use Tenant A
      // and a dedicated job/expense pair seeded directly via adminSql so this
      // proof is self-contained and does not touch domain logic.

      const nullProofJobId   = "3c000000-0000-4000-8000-ff0000000001";
      const nullProofExpId   = "3c000000-0000-4000-8000-ff0000000002";
      // Both rows share the same composite binding (same operation_key, same candidate_id=NULL).
      // The second insert must fail because UNIQUE NULLS NOT DISTINCT treats NULL==NULL.
      const nullProofOperationKey = "op-null-proof-shared";
      const evidenceHash          = "a".repeat(64);
      const payloadHash           = "b".repeat(64);

      // Seed a processing job and expense for this proof
      runtimeSql(`
        INSERT INTO app.processing_jobs
          (id, tenant_id, workflow_type, workflow_id, task_queue, status,
           input_params, allowed_result_schema_version)
        VALUES
          ('${nullProofJobId}', '${PHASE_3C_TENANT_A_ID}',
           'EnrichmentNullProof', gen_random_uuid()::text, 'enrichment', 'PENDING',
           '{}', '1')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES
          ('${nullProofExpId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
           '${PHASE_3C_PROFILE_A_ID}',
           'NullProofMerchant', '1.00', 'USD', '2026-09-12', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      // Insert first operation key row: candidate_id IS NULL
      runtimeSql(`
        INSERT INTO app.enrichment_operation_keys
          (id, tenant_id, job_id, expense_id, kind,
           candidate_id, evidence_hash, operation_key, payload_hash)
        VALUES
          (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}', '${nullProofJobId}',
           '${nullProofExpId}', 'tag',
           NULL, '${evidenceHash}', '${nullProofOperationKey}', '${payloadHash}');
      `);

      // Second row: same composite binding (same operation_key, same candidate_id=NULL).
      // Under standard UNIQUE, NULL != NULL so this would succeed.
      // Under UNIQUE NULLS NOT DISTINCT, NULL == NULL so this must fail.
      let conflictRaised = false;
      try {
        runtimeSql(`
          INSERT INTO app.enrichment_operation_keys
            (id, tenant_id, job_id, expense_id, kind,
             candidate_id, evidence_hash, operation_key, payload_hash)
          VALUES
            (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}', '${nullProofJobId}',
             '${nullProofExpId}', 'tag',
             NULL, '${evidenceHash}', '${nullProofOperationKey}', '${payloadHash}');
        `);
      } catch {
        conflictRaised = true;
      }

      expect(
        conflictRaised,
        "UNIQUE NULLS NOT DISTINCT must reject duplicate null candidate_id composite binding",
      ).toBe(true);
    },
  );

  it(
    "createPersonal creates exactly one ExpenseEnrichmentWorkflow job and one outbox row targeting the new expense",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const domain = createExpenseDomain(db);
      const requestId = `3c-enrich-${runKey}`;

      // Act: create a Personal expense under Tenant A / Profile A
      const expense = await domain.createPersonal({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        request: {
          personalProfileId: PHASE_3C_PROFILE_A_ID,
          merchant: "3C Merchant",
          amount: "42.00",
          currency: "USD",
          incurredOn: "2026-09-12",
        },
        requestId,
      });

      // Assert: exactly one ExpenseEnrichmentWorkflow job targeting this expense.
      // Scoped to Tenant A so Task 11's Tenant B or random-UUID seeds cannot
      // inflate this count.
      const enrichmentJobCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs
         WHERE workflow_type = 'ExpenseEnrichmentWorkflow'
           AND target_aggregate_type = 'expense'
           AND target_aggregate_id = '${expense.id}'
           AND tenant_id = '${PHASE_3C_TENANT_A_ID}';`,
      );
      expect(enrichmentJobCount).toBe("1");

      // Assert: exactly one outbox row targets the enrichment job
      const outboxCount = runtimeSql(
        `SELECT count(*) FROM app.processing_job_dispatch_outbox outbox
         INNER JOIN app.processing_jobs job ON job.id = outbox.processing_job_id
         WHERE job.workflow_type = 'ExpenseEnrichmentWorkflow'
           AND job.target_aggregate_id = '${expense.id}'
           AND outbox.status = 'PENDING';`,
      );
      expect(outboxCount).toBe("1");
    },
  );
});
