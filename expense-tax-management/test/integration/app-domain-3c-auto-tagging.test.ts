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
      // Proof strategy (two-part):
      //
      // Part A – pg_index catalog: confirm the index flag indnullsnotdistinct=true
      //   for enrichment_operation_keys_composite_binding_unique.
      //
      // Part B – behavioral test: temporarily drop the simple (tenant_id, operation_key)
      //   constraint so it cannot fire first, then attempt two inserts that share
      //   the same 7-tuple binding with candidate_id=NULL. The second insert must fail
      //   on the composite NULLS NOT DISTINCT constraint specifically. Restore after.
      //
      // Processing job must carry the same Personal scope as the expense because
      // processing_jobs_scope_check enforces (personal_profile_id IS NULL) <> (business_id IS NULL).

      const nullProofJobId   = "3c000000-0000-4000-8000-ff0000000001";
      const nullProofExpId   = "3c000000-0000-4000-8000-ff0000000002";
      const evidenceHash     = "a".repeat(64);
      const payloadHash      = "b".repeat(64);
      // Two distinct operation_key values so the simple unique does NOT fire.
      // The composite 7-tuple (including operation_key) must differ only in the row's
      // primary key — here we use two different "dummy" operation keys to bypass the
      // simple constraint, then test with the SAME operation key on the NULLS NOT
      // DISTINCT path once the simple constraint is removed.
      const opKeyA           = `op-null-proof-a-${runKey}`;
      const opKeyShared      = `op-null-proof-shared-${runKey}`;

      // Seed: processing job with Personal scope (profile A, no business).
      runtimeSql(`
        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           input_params, allowed_result_schema_version)
        VALUES
          ('${nullProofJobId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'EnrichmentNullProof', gen_random_uuid()::text, 'enrichment', 'PENDING',
           '{}', '1')
        ON CONFLICT DO NOTHING;
      `);

      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES
          ('${nullProofExpId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'NullProofMerchant', '1.00', 'USD', '2026-09-12', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      // Part A: pg_index catalog assertion — indnullsnotdistinct must be true
      const catalogResult = adminSql(
        `SELECT indnullsnotdistinct::text
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'enrichment_operation_keys_composite_binding_unique';`,
        databaseName,
      );
      expect(
        catalogResult,
        "pg_index.indnullsnotdistinct must be true for composite_binding_unique",
      ).toBe("true");

      // Part B: temporarily remove simple constraint, prove composite NULLS NOT DISTINCT fires.
      adminSql(
        `ALTER TABLE app.enrichment_operation_keys
           DROP CONSTRAINT enrichment_operation_keys_operation_key_unique;`,
        databaseName,
      );

      try {
        // Insert first row: candidate_id IS NULL, operation_key = opKeyShared
        adminSql(
          `INSERT INTO app.enrichment_operation_keys
             (id, tenant_id, job_id, expense_id, kind,
              candidate_id, evidence_hash, operation_key, payload_hash)
           VALUES
             (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}', '${nullProofJobId}',
              '${nullProofExpId}', 'tag',
              NULL, '${evidenceHash}', '${opKeyShared}', '${payloadHash}');`,
          databaseName,
        );

        // Insert second row: SAME 7-tuple (same operation_key, same candidate_id=NULL).
        // Without UNIQUE NULLS NOT DISTINCT, NULLs would not match and this would succeed.
        // With UNIQUE NULLS NOT DISTINCT, this must fail.
        let compositeConflictRaised = false;
        try {
          adminSql(
            `INSERT INTO app.enrichment_operation_keys
               (id, tenant_id, job_id, expense_id, kind,
                candidate_id, evidence_hash, operation_key, payload_hash)
             VALUES
               (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}', '${nullProofJobId}',
                '${nullProofExpId}', 'tag',
                NULL, '${evidenceHash}', '${opKeyShared}', '${payloadHash}');`,
            databaseName,
          );
        } catch {
          compositeConflictRaised = true;
        }

        expect(
          compositeConflictRaised,
          "enrichment_operation_keys_composite_binding_unique with NULLS NOT DISTINCT must reject duplicate null candidate_id",
        ).toBe(true);

        // Verify: different candidate_id (non-null) with same other fields SUCCEEDS
        // (showing the constraint targets the null specifically, not just a general dup).
        const differentCandidateId = "3c000000-0000-4000-8000-ee0000000001";
        let differentCandidateSucceeded = false;
        try {
          adminSql(
            `INSERT INTO app.enrichment_operation_keys
               (id, tenant_id, job_id, expense_id, kind,
                candidate_id, evidence_hash, operation_key, payload_hash)
             VALUES
               (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}', '${nullProofJobId}',
                '${nullProofExpId}', 'tag',
                '${differentCandidateId}', '${evidenceHash}', '${opKeyA}', '${payloadHash}');`,
            databaseName,
          );
          differentCandidateSucceeded = true;
        } catch {
          differentCandidateSucceeded = false;
        }
        expect(
          differentCandidateSucceeded,
          "Row with different (non-null) candidate_id and different operation_key must succeed",
        ).toBe(true);
      } finally {
        // Restore the simple unique constraint
        adminSql(
          `ALTER TABLE app.enrichment_operation_keys
             ADD CONSTRAINT enrichment_operation_keys_operation_key_unique
               UNIQUE (tenant_id, operation_key);`,
          databaseName,
        );
      }
    },
  );

  it(
    "expense_tags scope validation trigger rejects row with mismatched Business scope",
    () => {
      // Prove that validate_enrichment_child_scope fires when the expense_tag's
      // business_id doesn't match the referenced expense's personal scope.
      // The expense is Personal (PHASE_3C_PROFILE_A_ID, no business_id).
      // Attempting to insert an expense_tag scoped to Business A must fail.

      const crossScopeExpId = "3c000000-0000-4000-8000-dd0000000001";
      const crossScopeTagId = "3c000000-0000-4000-8000-dd0000000002";

      // Seed a personal expense for this test
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES
          ('${crossScopeExpId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'CrossScopeMerchant', '5.00', 'USD', '2026-09-12', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      // Seed a tenant-level tag for this test
      runtimeSql(`
        INSERT INTO app.tags
          (id, tenant_id, key, name, origin, status)
        VALUES
          ('${crossScopeTagId}', '${PHASE_3C_TENANT_A_ID}',
           'cross-scope-test', 'Cross Scope Test', 'rule', 'active')
        ON CONFLICT DO NOTHING;
      `);

      // Attempt expense_tag with business_id = PHASE_3C_BUSINESS_A_ID (wrong scope)
      let crossScopeRejected = false;
      try {
        runtimeSql(`
          INSERT INTO app.expense_tags
            (id, tenant_id, personal_profile_id, business_id,
             expense_id, tag_id, source, confidence, status)
          VALUES
            (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}',
             NULL, '${PHASE_3C_BUSINESS_A_ID}',
             '${crossScopeExpId}', '${crossScopeTagId}',
             'rule', 1.0, 'active');
        `);
      } catch {
        crossScopeRejected = true;
      }
      expect(
        crossScopeRejected,
        "expense_tag with Business scope must be rejected when expense has Personal scope",
      ).toBe(true);
    },
  );

  it(
    "expense_spending_category_decisions is append-only: UPDATE and DELETE are rejected",
    () => {
      const appendOnlyExpId = "3c000000-0000-4000-8000-cc0000000001";
      const appendOnlyDecId = "3c000000-0000-4000-8000-cc0000000002";

      // Seed expense
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES
          ('${appendOnlyExpId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'AppendOnlyMerchant', '10.00', 'USD', '2026-09-12', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      // Insert a decision row
      runtimeSql(`
        INSERT INTO app.expense_spending_category_decisions
          (id, tenant_id, personal_profile_id, business_id, expense_id,
           prior_spending_category_id, new_spending_category_id,
           source, expense_version)
        VALUES
          ('${appendOnlyDecId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL, '${appendOnlyExpId}',
           NULL, NULL, 'manual_baseline', 1)
        ON CONFLICT DO NOTHING;
      `);

      // UPDATE must be rejected
      let updateRejected = false;
      try {
        adminSql(
          `UPDATE app.expense_spending_category_decisions
              SET source = 'manual'
            WHERE id = '${appendOnlyDecId}';`,
          databaseName,
        );
      } catch {
        updateRejected = true;
      }
      expect(updateRejected, "UPDATE on category decision must be rejected (append-only)").toBe(true);

      // DELETE must be rejected
      let deleteRejected = false;
      try {
        adminSql(
          `DELETE FROM app.expense_spending_category_decisions WHERE id = '${appendOnlyDecId}';`,
          databaseName,
        );
      } catch {
        deleteRejected = true;
      }
      expect(deleteRejected, "DELETE on category decision must be rejected (append-only)").toBe(true);
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
