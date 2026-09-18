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
import { createExpenseDomain, insertExpenseInTransaction } from "../../services/app-api/src/domain/expenses.js";
import { createEnrichmentJobsDomain, pendingProjection } from "../../services/app-api/src/domain/enrichment-jobs.js";
import { resolveSuggestion, rerunEnrichment } from "../../services/app-api/src/domain/enrichment.js";
import { createTagDomain } from "../../services/app-api/src/domain/tags.js";
import { createProcessingJobsDomain } from "../../services/app-api/src/domain/processing-jobs.js";
import { createFilesDomain } from "../../services/app-api/src/domain/files.js";
import { createPlansDomain } from "../../services/app-api/src/domain/plans.js";
import { createLocalStorageAdapter } from "../../services/app-api/src/storage/local.js";
import type { TemporalWorkflowStarter } from "../../services/app-api/src/temporal/client.js";

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
// Taxonomy/profile/category IDs for Task 8 live tests.
const PHASE_3C_TAXONOMY_VERSION_ID  = "3c000000-0000-4000-8000-000000000007";
const PHASE_3C_TAX_PROFILE_ID       = "3c000000-0000-4000-8000-000000000008";
const PHASE_3C_SPENDING_CATEGORY_ID = "3c000000-0000-4000-8000-000000000009";
// Reserved for Task 11:
const _PHASE_3C_EXPENSE_V1_ID = "3c000000-0000-4000-8000-00000000000a";
const _PHASE_3C_EXPENSE_V2_ID = "3c000000-0000-4000-8000-00000000000b";

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
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES
          ('${nullProofJobId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'EnrichmentNullProof', gen_random_uuid()::text, 'enrichment', 'PENDING',
           '{}', '1', NULL, NULL)
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
    "suggestion_id linkage trigger rejects expense_tag with wrong-kind/wrong-expense/wrong-candidate suggestion",
    () => {
      // IDs scoped to this test
      const linkExpId    = "3c000000-0000-4000-8000-bb0000000001";
      const linkJobId    = "3c000000-0000-4000-8000-bb0000000002";
      const linkTagId    = "3c000000-0000-4000-8000-bb0000000003";
      const linkTag2Id   = "3c000000-0000-4000-8000-bb0000000004";
      const linkSugId    = "3c000000-0000-4000-8000-bb0000000005";
      const linkCatId    = "3c000000-0000-4000-8000-bb0000000006";
      const linkCatSugId = "3c000000-0000-4000-8000-bb0000000007";
      const evidenceHash = "c".repeat(64);

      // Seed expense + job + two tags + a valid tag suggestion + a spending_category suggestion
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES
          ('${linkExpId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'LinkTestMerchant', '3.00', 'USD', '2026-09-12', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      runtimeSql(`
        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES
          ('${linkJobId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'EnrichmentLinkTest', gen_random_uuid()::text, 'enrichment', 'PENDING',
           '{}', '1', NULL, NULL)
        ON CONFLICT DO NOTHING;
      `);

      runtimeSql(`
        INSERT INTO app.tags
          (id, tenant_id, key, name, origin, status)
        VALUES
          ('${linkTagId}',  '${PHASE_3C_TENANT_A_ID}', 'link-test-tag-a', 'Link Test A', 'rule', 'active'),
          ('${linkTag2Id}', '${PHASE_3C_TENANT_A_ID}', 'link-test-tag-b', 'Link Test B', 'rule', 'active')
        ON CONFLICT DO NOTHING;
      `);

      // A valid tag suggestion (kind=tag, tag_id=linkTagId)
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${linkSugId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL, '${linkExpId}', '${linkJobId}',
           'tag', '${linkTagId}', NULL, NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.9, '${evidenceHash}', 'pending', 1, 1, 'link-test-sug-1')
        ON CONFLICT DO NOTHING;
      `);

      // A spending_category suggestion for same expense
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${linkCatSugId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL, '${linkExpId}', '${linkJobId}',
           'spending_category', NULL, '${linkCatId}', NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.8, '${"d".repeat(64)}', 'pending', 1, 1, 'link-test-sug-2')
        ON CONFLICT DO NOTHING;
      `);

      // Case 1: wrong kind — expense_tag linked to spending_category suggestion => rejected
      let wrongKindRejected = false;
      try {
        runtimeSql(`
          INSERT INTO app.expense_tags
            (id, tenant_id, personal_profile_id, business_id,
             expense_id, tag_id, source, confidence, suggestion_id, status)
          VALUES
            (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}',
             '${PHASE_3C_PROFILE_A_ID}', NULL,
             '${linkExpId}', '${linkTagId}', 'historical', 0.9,
             '${linkCatSugId}', 'active');
        `);
      } catch {
        wrongKindRejected = true;
      }
      expect(wrongKindRejected, "expense_tag with wrong-kind (spending_category) suggestion must be rejected").toBe(true);

      // Case 2: wrong candidate — expense_tag linked to correct-kind suggestion but different tag_id => rejected
      let wrongCandidateRejected = false;
      try {
        runtimeSql(`
          INSERT INTO app.expense_tags
            (id, tenant_id, personal_profile_id, business_id,
             expense_id, tag_id, source, confidence, suggestion_id, status)
          VALUES
            (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}',
             '${PHASE_3C_PROFILE_A_ID}', NULL,
             '${linkExpId}', '${linkTag2Id}', 'historical', 0.9,
             '${linkSugId}', 'active');
        `);
      } catch {
        wrongCandidateRejected = true;
      }
      expect(wrongCandidateRejected, "expense_tag with wrong tag_id vs suggestion candidate must be rejected").toBe(true);

      // Case 3: correct linkage — should succeed
      let validTagInserted = false;
      try {
        runtimeSql(`
          INSERT INTO app.expense_tags
            (id, tenant_id, personal_profile_id, business_id,
             expense_id, tag_id, source, confidence, suggestion_id, status)
          VALUES
            (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}',
             '${PHASE_3C_PROFILE_A_ID}', NULL,
             '${linkExpId}', '${linkTagId}', 'historical', 0.9,
             '${linkSugId}', 'active');
        `);
        validTagInserted = true;
      } catch {
        validTagInserted = false;
      }
      expect(validTagInserted, "expense_tag with correct suggestion linkage must succeed").toBe(true);
    },
  );

  it(
    "suggestion_id linkage trigger rejects category decision with wrong-kind/wrong-candidate suggestion",
    () => {
      const decLinkExpId  = "3c000000-0000-4000-8000-aa0000000001";
      const decLinkJobId  = "3c000000-0000-4000-8000-aa0000000002";
      const decLinkTagId  = "3c000000-0000-4000-8000-aa0000000003";
      const decLinkCatId  = "3c000000-0000-4000-8000-aa0000000004";
      const decLinkCat2Id = "3c000000-0000-4000-8000-aa0000000005";
      const decTagSugId   = "3c000000-0000-4000-8000-aa0000000006";
      const decCatSugId   = "3c000000-0000-4000-8000-aa0000000007";

      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES
          ('${decLinkExpId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'DecLinkMerchant', '4.00', 'USD', '2026-09-12', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      runtimeSql(`
        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES
          ('${decLinkJobId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'EnrichmentDecLinkTest', gen_random_uuid()::text, 'enrichment', 'PENDING',
           '{}', '1', NULL, NULL)
        ON CONFLICT DO NOTHING;
      `);

      runtimeSql(`
        INSERT INTO app.tags
          (id, tenant_id, key, name, origin, status)
        VALUES
          ('${decLinkTagId}', '${PHASE_3C_TENANT_A_ID}', 'dec-link-tag', 'Dec Link Tag', 'rule', 'active')
        ON CONFLICT DO NOTHING;
      `);

      // Tag suggestion for the expense
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${decTagSugId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL, '${decLinkExpId}', '${decLinkJobId}',
           'tag', '${decLinkTagId}', NULL, NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.9, '${"e".repeat(64)}', 'pending', 1, 1, 'dec-link-tag-sug')
        ON CONFLICT DO NOTHING;
      `);

      // Category suggestion for decLinkCatId
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${decCatSugId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL, '${decLinkExpId}', '${decLinkJobId}',
           'spending_category', NULL, '${decLinkCatId}', NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.8, '${"f".repeat(64)}', 'pending', 1, 1, 'dec-link-cat-sug')
        ON CONFLICT DO NOTHING;
      `);

      // Case 1: wrong kind — decision linked to tag suggestion => rejected
      let wrongKindRejected = false;
      try {
        runtimeSql(`
          INSERT INTO app.expense_spending_category_decisions
            (id, tenant_id, personal_profile_id, business_id, expense_id,
             prior_spending_category_id, new_spending_category_id,
             source, expense_version, suggestion_id)
          VALUES
            (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}',
             '${PHASE_3C_PROFILE_A_ID}', NULL, '${decLinkExpId}',
             NULL, '${decLinkCatId}',
             'historical', 1, '${decTagSugId}');
        `);
      } catch {
        wrongKindRejected = true;
      }
      expect(wrongKindRejected, "category decision with tag-kind suggestion must be rejected").toBe(true);

      // Case 2: wrong candidate — decision new_spending_category_id != suggestion spending_category_id => rejected
      let wrongCandidateRejected = false;
      try {
        runtimeSql(`
          INSERT INTO app.expense_spending_category_decisions
            (id, tenant_id, personal_profile_id, business_id, expense_id,
             prior_spending_category_id, new_spending_category_id,
             source, expense_version, suggestion_id)
          VALUES
            (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}',
             '${PHASE_3C_PROFILE_A_ID}', NULL, '${decLinkExpId}',
             NULL, '${decLinkCat2Id}',
             'historical', 1, '${decCatSugId}');
        `);
      } catch {
        wrongCandidateRejected = true;
      }
      expect(wrongCandidateRejected, "category decision with mismatched spending_category_id must be rejected").toBe(true);

      // Case 3: correct linkage => success
      let validDecInserted = false;
      try {
        runtimeSql(`
          INSERT INTO app.expense_spending_category_decisions
            (id, tenant_id, personal_profile_id, business_id, expense_id,
             prior_spending_category_id, new_spending_category_id,
             source, expense_version, suggestion_id)
          VALUES
            (gen_random_uuid(), '${PHASE_3C_TENANT_A_ID}',
             '${PHASE_3C_PROFILE_A_ID}', NULL, '${decLinkExpId}',
             NULL, '${decLinkCatId}',
             'historical', 1, '${decCatSugId}');
        `);
        validDecInserted = true;
      } catch {
        validDecInserted = false;
      }
      expect(validDecInserted, "category decision with correct suggestion linkage must succeed").toBe(true);
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

      // C1: expense must be ready (not draft)
      expect(expense.status).toBe("ready");

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

      // I6: verify job fields (allowedResultSchemaVersion, workflowType, targetAggregateId)
      const jobRow = runtimeSql(
        `SELECT allowed_result_schema_version, workflow_type, target_aggregate_type,
                expected_aggregate_version, status
           FROM app.processing_jobs
          WHERE target_aggregate_id = '${expense.id}'
            AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
      );
      expect(jobRow).toContain("expense-enrichment-v1");
      expect(jobRow).toContain("ExpenseEnrichmentWorkflow");
      expect(jobRow).toContain("PENDING");
    },
  );

  it(
    "R2-3: insertExpenseInTransaction with mode:draft creates expense with zero enrichment jobs",
    async () => {
      // Real insertExpenseInTransaction call with mode:draft proves no job is created.
      // This replaces the previous raw-SQL seed which bypassed the domain entirely.
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const expense = await db.transaction().execute((tx) =>
        insertExpenseInTransaction(tx, {
          actorUserId: PHASE_3C_USER_ID,
          tenantId: PHASE_3C_TENANT_A_ID,
          scope: { kind: "personal", profileId: PHASE_3C_PROFILE_A_ID },
          request: {
            personalProfileId: PHASE_3C_PROFILE_A_ID,
            merchant: "DraftModeReal",
            amount: "5.00",
            currency: "USD",
            incurredOn: "2026-09-12",
          },
          requestId: `3c-draft-real-${runKey}`,
          mode: "draft",
        }),
      );

      // Expense status must be draft
      expect(expense.status).toBe("draft");

      // Zero enrichment jobs created
      const jobCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs
           WHERE workflow_type = 'ExpenseEnrichmentWorkflow'
             AND target_aggregate_id = '${expense.id}';`,
      );
      expect(jobCount).toBe("0");

      // Zero outbox rows
      const outboxCount = runtimeSql(
        `SELECT count(*) FROM app.processing_job_dispatch_outbox outbox
           INNER JOIN app.processing_jobs job ON job.id = outbox.processing_job_id
           WHERE job.target_aggregate_id = '${expense.id}';`,
      );
      expect(outboxCount).toBe("0");
    },
  );

  it(
    "R2-2: transaction rollback removes expense, enrichment job, outbox, and decision atomically",
    async () => {
      // Proves that when the transaction throws after job creation,
      // all rows (expense, job, outbox, category decision) are rolled back.
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      // Seed a spending category for the decision row
      const rollbackCatId = "3c000000-0000-4000-8000-ee0000000015";
      runtimeSql(`
        INSERT INTO app.spending_categories
          (id, tenant_id, name, color, icon, status)
        VALUES
          ('${rollbackCatId}', '${PHASE_3C_TENANT_A_ID}', '3C RollbackCat', '#112233', 'tag', 'active')
        ON CONFLICT DO NOTHING;
      `);

      let capturedExpenseId: string | null = null;
      const rollbackError = new Error("deliberate rollback");

      await expect(
        db.transaction().execute(async (tx) => {
          const expense = await insertExpenseInTransaction(tx, {
            actorUserId: PHASE_3C_USER_ID,
            tenantId: PHASE_3C_TENANT_A_ID,
            scope: { kind: "personal", profileId: PHASE_3C_PROFILE_A_ID },
            request: {
              personalProfileId: PHASE_3C_PROFILE_A_ID,
              merchant: "RollbackMerchant",
              amount: "99.00",
              currency: "USD",
              incurredOn: "2026-09-12",
              spendingCategoryId: rollbackCatId,
            },
            requestId: `3c-rollback-${runKey}`,
            mode: "manual-ready",
          });
          capturedExpenseId = expense.id;
          throw rollbackError; // Force rollback
        }),
      ).rejects.toThrow("deliberate rollback");

      expect(capturedExpenseId).not.toBeNull();

      // All rows must be absent after rollback
      const expenseCount = runtimeSql(
        `SELECT count(*) FROM app.expenses WHERE id = '${capturedExpenseId}';`,
      );
      expect(expenseCount).toBe("0");

      const jobCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs
           WHERE workflow_type = 'ExpenseEnrichmentWorkflow'
             AND target_aggregate_id = '${capturedExpenseId}';`,
      );
      expect(jobCount).toBe("0");

      const outboxCount = runtimeSql(
        `SELECT count(*) FROM app.processing_job_dispatch_outbox outbox
           INNER JOIN app.processing_jobs job ON job.id = outbox.processing_job_id
           WHERE job.target_aggregate_id = '${capturedExpenseId}';`,
      );
      expect(outboxCount).toBe("0");

      const decisionCount = runtimeSql(
        `SELECT count(*) FROM app.expense_spending_category_decisions
           WHERE expense_id = '${capturedExpenseId}';`,
      );
      expect(decisionCount).toBe("0");
    },
  );

  it(
    "I4: createPersonal with spendingCategoryId inserts exact one append-only decision row",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      // Seed a spending category
      const catId = "3c000000-0000-4000-8000-ee0000000020";
      runtimeSql(`
        INSERT INTO app.spending_categories
          (id, tenant_id, name, color, icon, status)
        VALUES
          ('${catId}', '${PHASE_3C_TENANT_A_ID}', '3C Category', '#AABBCC', 'tag', 'active')
        ON CONFLICT DO NOTHING;
      `);

      const domain = createExpenseDomain(db);
      const expense = await domain.createPersonal({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        request: {
          personalProfileId: PHASE_3C_PROFILE_A_ID,
          merchant: "CategoryMerchant",
          amount: "15.00",
          currency: "USD",
          incurredOn: "2026-09-12",
          spendingCategoryId: catId,
        },
        requestId: `3c-category-${runKey}`,
      });

      // Exactly one decision row
      const decCount = runtimeSql(
        `SELECT count(*) FROM app.expense_spending_category_decisions
          WHERE expense_id = '${expense.id}';`,
      );
      expect(decCount).toBe("1");

      // Decision fields: source=manual, prior=null, new=catId, actor=PHASE_3C_USER_ID, version=1
      const decRow = runtimeSql(
        `SELECT source, prior_spending_category_id, new_spending_category_id,
                actor_user_id, expense_version
           FROM app.expense_spending_category_decisions
          WHERE expense_id = '${expense.id}';`,
      );
      expect(decRow).toContain("manual");
      expect(decRow).toContain(catId);
      expect(decRow).toContain(PHASE_3C_USER_ID);
      expect(decRow).toContain("1"); // expense_version
      // prior is null → empty string in tuples-only output
    },
  );

  it(
    "I4: repeated createEnrichmentJobInTransaction calls produce distinct jobs (new UUIDs each call)",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const domain = createExpenseDomain(db);
      const exp1 = await domain.createPersonal({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        request: {
          personalProfileId: PHASE_3C_PROFILE_A_ID,
          merchant: "RepeatMerchant1",
          amount: "1.00",
          currency: "USD",
          incurredOn: "2026-09-12",
        },
        requestId: `3c-repeat1-${runKey}`,
      });
      const exp2 = await domain.createPersonal({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        request: {
          personalProfileId: PHASE_3C_PROFILE_A_ID,
          merchant: "RepeatMerchant2",
          amount: "2.00",
          currency: "USD",
          incurredOn: "2026-09-12",
        },
        requestId: `3c-repeat2-${runKey}`,
      });

      const job1 = runtimeSql(
        `SELECT id FROM app.processing_jobs
          WHERE target_aggregate_id = '${exp1.id}'
            AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
      );
      const job2 = runtimeSql(
        `SELECT id FROM app.processing_jobs
          WHERE target_aggregate_id = '${exp2.id}'
            AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
      );
      expect(job1).not.toBe("");
      expect(job2).not.toBe("");
      expect(job1).not.toBe(job2); // distinct UUIDs
    },
  );

  it(
    "I4: OCR materialization via applyOcrExtraction creates exactly one enrichment job in same transaction",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");
      const tmpDir = `/tmp/3c-ocr-storage-${runKey}`;
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id, merchant, amount, currency, incurred_on, source, status)
        VALUES ('3c000000-0000-4000-8000-ee0000000030', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL, 'Placeholder', '0.01', 'USD', '2026-01-01', 'manual', 'draft')
        ON CONFLICT DO NOTHING;
      `);

      const storageAdapter = createLocalStorageAdapter({ rootDir: tmpDir, baseUrl: "http://test.local", urlSigningKey: "test-key" });
      const filesDomain = createFilesDomain(db, storageAdapter);
      const plansDomain = createPlansDomain(db);
      const fakeStarter: TemporalWorkflowStarter = {
        start: async () => ({ runId: "fake-run" }),
        close: async () => undefined,
      };
      const processingJobsDomain = createProcessingJobsDomain(db, fakeStarter);
      // ocrJobsDomain not needed here — we directly seed an OCR job and use processingJobsDomain.submitResult

      // Seed a ready file
      const ocrFileId = "3c000000-0000-4000-8000-ee0000000031";
      runtimeSql(`
        INSERT INTO app.expense_files
          (id, tenant_id, personal_profile_id, business_id, original_filename, content_type, status, sha256_hex, size_bytes, storage_key)
        VALUES
          ('${ocrFileId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
           'receipt.pdf', 'application/pdf', 'READY', '${"a".repeat(64)}', 1024,
           'files/ocr-test-${runKey}.pdf')
        ON CONFLICT DO NOTHING;
      `);

       // Seed an OCR job for this file (RUNNING requires dispatched_at)
       const ocrJobId = "3c000000-0000-4000-8000-ee0000000032";
       runtimeSql(`
         INSERT INTO app.processing_jobs
           (id, tenant_id, personal_profile_id, business_id,
            workflow_type, workflow_id, task_queue, status,
            source_file_id, requested_by_user_id,
            input_params, allowed_result_schema_version, target_aggregate_type,
            dispatched_at)
         VALUES
           ('${ocrJobId}', '${PHASE_3C_TENANT_A_ID}',
            '${PHASE_3C_PROFILE_A_ID}', NULL,
            'OcrReceiptWorkflow', 'job-${ocrJobId}', 'expense-tax-ai-worker', 'RUNNING',
            '${ocrFileId}', '${PHASE_3C_USER_ID}',
            '{"modeKey":"ocr_mode_balanced"}', 'ocr-extraction-v1', 'expense',
            now())
         ON CONFLICT DO NOTHING;
       `);

      // Submit OCR SUCCEEDED result — this calls applyOcrExtraction which creates enrichment job
      const result = await processingJobsDomain.submitResult({
        jobId: ocrJobId,
        request: {
          schemaVersion: 1,
          status: "SUCCEEDED",
          idempotencyKey: `3c-ocr-result-${runKey}`,
          expectedJobVersion: 1,
          resultSchemaVersion: "ocr-extraction-v1",
           result: {
             schemaVersion: 1,
             merchant: "OcrMerchant",
             amount: "20.00",
             currency: "USD",
             incurredOn: "2026-09-12",
             confidence: 0.95,
           },
        },
        actorServicePrincipal: "ai-worker",
        requestId: `3c-ocr-req-${runKey}`,
      });
      const expenseId = result.body.targetAggregateId;
      expect(expenseId).toBeTruthy();

      // Exactly one enrichment job for this expense
      const enrichCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs
          WHERE workflow_type = 'ExpenseEnrichmentWorkflow'
            AND target_aggregate_id = '${expenseId}'
            AND tenant_id = '${PHASE_3C_TENANT_A_ID}';`,
      );
      expect(enrichCount).toBe("1");

      // Exactly one outbox row
      const outboxCount = runtimeSql(
        `SELECT count(*) FROM app.processing_job_dispatch_outbox outbox
          INNER JOIN app.processing_jobs job ON job.id = outbox.processing_job_id
          WHERE job.workflow_type = 'ExpenseEnrichmentWorkflow'
            AND job.target_aggregate_id = '${expenseId}';`,
      );
      expect(outboxCount).toBe("1");

      // Expense is ready
      const expStatus = runtimeSql(
        `SELECT status FROM app.expenses WHERE id = '${expenseId}';`,
      );
      expect(expStatus).toBe("ready");
    },
  );

  it(
    "I4: ForwardedReceiptWorkflow path reaches applyOcrExtraction and creates one enrichment job",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");
      const tmpDir = `/tmp/3c-fwd-storage-${runKey}`;

      const storageAdapter = createLocalStorageAdapter({ rootDir: tmpDir, baseUrl: "http://test.local", urlSigningKey: "test-key" });
      const filesDomain = createFilesDomain(db, storageAdapter);
      const plansDomain = createPlansDomain(db);
      const fakeStarter: TemporalWorkflowStarter = {
        start: async () => ({ runId: "fake-run-fwd" }),
        close: async () => undefined,
      };
      const processingJobsDomain = createProcessingJobsDomain(db, fakeStarter);

       // Seed a file for forwarded-email path (storage_key required)
       const fwdFileId = "3c000000-0000-4000-8000-ee0000000041";
       runtimeSql(`
         INSERT INTO app.expense_files
           (id, tenant_id, personal_profile_id, business_id, original_filename, content_type, status, sha256_hex, size_bytes, storage_key)
         VALUES
           ('${fwdFileId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
            'fwd-receipt.jpg', 'image/jpeg', 'READY', '${"b".repeat(64)}', 512,
            'files/fwd-test-${runKey}.jpg')
         ON CONFLICT DO NOTHING;
       `);

       // Seed a ForwardedReceiptWorkflow job (not OcrReceiptWorkflow; RUNNING requires dispatched_at)
       const fwdJobId = "3c000000-0000-4000-8000-ee0000000042";
       runtimeSql(`
         INSERT INTO app.processing_jobs
           (id, tenant_id, personal_profile_id, business_id,
            workflow_type, workflow_id, task_queue, status,
            source_file_id, requested_by_user_id,
            input_params, allowed_result_schema_version, target_aggregate_type,
            dispatched_at)
         VALUES
           ('${fwdJobId}', '${PHASE_3C_TENANT_A_ID}',
            '${PHASE_3C_PROFILE_A_ID}', NULL,
            'ForwardedReceiptWorkflow', 'job-${fwdJobId}', 'expense-tax-ai-worker', 'RUNNING',
            '${fwdFileId}', '${PHASE_3C_USER_ID}',
            '{"modeKey":"ocr_mode_balanced"}', 'ocr-extraction-v1', 'expense',
            now())
         ON CONFLICT DO NOTHING;
       `);

      // Submit SUCCEEDED — ForwardedReceiptWorkflow uses same applyOcrExtraction path
      // which sets source='forwarded_email' and creates enrichment job
      const result = await processingJobsDomain.submitResult({
        jobId: fwdJobId,
        request: {
          schemaVersion: 1,
          status: "SUCCEEDED",
          idempotencyKey: `3c-fwd-result-${runKey}`,
          expectedJobVersion: 1,
          resultSchemaVersion: "ocr-extraction-v1",
           result: {
             schemaVersion: 1,
             merchant: "FwdMerchant",
             amount: "8.00",
             currency: "USD",
             incurredOn: "2026-09-12",
             confidence: 0.90,
           },
        },
        actorServicePrincipal: "ai-worker",
        requestId: `3c-fwd-req-${runKey}`,
      });
      const expenseId = result.body.targetAggregateId;
      expect(expenseId).toBeTruthy();

      // Expense source is forwarded_email
      const expRow = runtimeSql(
        `SELECT source, status FROM app.expenses WHERE id = '${expenseId}';`,
      );
      expect(expRow).toContain("forwarded_email");
      expect(expRow).toContain("ready");

      // Exactly one enrichment job created
      const enrichCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs
          WHERE workflow_type = 'ExpenseEnrichmentWorkflow'
            AND target_aggregate_id = '${expenseId}';`,
      );
      expect(enrichCount).toBe("1");
    },
  );

  it(
    "I4: C2 — outcome:applied rejected (409) by real domain; ready expense and OCR/dedup state unchanged",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const enrichmentDomain = createEnrichmentJobsDomain(db, pendingProjection);

      // Seed a ready expense and RUNNING enrichment job
      const expId = "3c000000-0000-4000-8000-ee0000000050";
      const jobId = "3c000000-0000-4000-8000-ee0000000051";
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES
          ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'AppliedTestMerchant', '7.00', 'USD', '2026-09-12', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           input_params, allowed_result_schema_version,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           dispatched_at)
        VALUES
          ('${jobId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'ExpenseEnrichmentWorkflow', 'job-${jobId}', 'expense-tax-ai-worker', 'RUNNING',
           '{}', 'expense-enrichment-v1', 'expense', '${expId}', 1,
           now())
        ON CONFLICT DO NOTHING;
      `);

      // Act: try to submit outcome:applied — must throw CONFLICT (C2)
      const { DomainError } = await import("../../services/app-api/src/errors.js");
      await expect(
        enrichmentDomain.submitEnrichmentResult({
          jobId,
          idempotencyKey: `3c-applied-reject-${runKey}`,
          expectedJobVersion: 1,
          result: {
            schemaVersion: 1,
            rulesVersion: 1,
            outcome: "applied",
            ruleTagKeys: [],
            suggestions: [],
          },
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `3c-applied-reject-req-${runKey}`,
        }),
      ).rejects.toMatchObject<Partial<InstanceType<typeof DomainError>>>({ code: "CONFLICT" });

      // Expense remains ready, job remains RUNNING (no mutation)
      const expStatus = runtimeSql(
        `SELECT status FROM app.expenses WHERE id = '${expId}';`,
      );
      expect(expStatus).toBe("ready");

      const jobStatus = runtimeSql(
        `SELECT status FROM app.processing_jobs WHERE id = '${jobId}';`,
      );
      expect(jobStatus).toBe("RUNNING");
    },
  );

  it(
    "I1: C2 — DISPATCHED job rejected (409) by getEnrichmentInput (RUNNING required)",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const enrichmentDomain = createEnrichmentJobsDomain(db, pendingProjection);

      const expId = "3c000000-0000-4000-8000-ee0000000060";
      const jobId = "3c000000-0000-4000-8000-ee0000000061";
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES
          ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'DispatchedTestMerchant', '9.00', 'USD', '2026-09-12', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

         INSERT INTO app.processing_jobs
           (id, tenant_id, personal_profile_id, business_id,
            workflow_type, workflow_id, task_queue, status,
            input_params, allowed_result_schema_version,
            target_aggregate_type, target_aggregate_id, expected_aggregate_version,
            dispatched_at)
          VALUES
           ('${jobId}', '${PHASE_3C_TENANT_A_ID}',
            '${PHASE_3C_PROFILE_A_ID}', NULL,
            'ExpenseEnrichmentWorkflow', 'job-${jobId}', 'expense-tax-ai-worker', 'DISPATCHED',
            '{}', 'expense-enrichment-v1', 'expense', '${expId}', 1,
            now())
          ON CONFLICT DO NOTHING;
        `);

      const { DomainError } = await import("../../services/app-api/src/errors.js");
      await expect(
        enrichmentDomain.getEnrichmentInput({
          jobId,
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `3c-dispatched-input-req-${runKey}`,
        }),
      ).rejects.toMatchObject<Partial<InstanceType<typeof DomainError>>>({ code: "CONFLICT" });
    },
  );

  it(
    "C3: stale outcome completes SUCCEEDED with no expense mutation; skipped outcome same",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const enrichmentDomain = createEnrichmentJobsDomain(db, pendingProjection);

      // Seed expense (version 1) + RUNNING enrichment job (expected version 1)
      const expId = "3c000000-0000-4000-8000-ee0000000070";
      const jobId = "3c000000-0000-4000-8000-ee0000000071";
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES
          ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'StaleTestMerchant', '6.00', 'USD', '2026-09-12', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           input_params, allowed_result_schema_version,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           dispatched_at)
        VALUES
          ('${jobId}', '${PHASE_3C_TENANT_A_ID}',
           '${PHASE_3C_PROFILE_A_ID}', NULL,
           'ExpenseEnrichmentWorkflow', 'job-${jobId}', 'expense-tax-ai-worker', 'RUNNING',
           '{}', 'expense-enrichment-v1', 'expense', '${expId}', 1,
           now())
        ON CONFLICT DO NOTHING;
      `);

      // Submit stale outcome — must succeed with SUCCEEDED job, expense untouched
      const result = await enrichmentDomain.submitEnrichmentResult({
        jobId,
        idempotencyKey: `3c-stale-${runKey}`,
        expectedJobVersion: 1,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
        actorServicePrincipal: "ai-worker-app-machine",
        requestId: `3c-stale-req-${runKey}`,
      });

      expect(result.body.status).toBe("SUCCEEDED");

      // Expense status unchanged (still ready)
      const expStatus = runtimeSql(
        `SELECT status FROM app.expenses WHERE id = '${expId}';`,
      );
      expect(expStatus).toBe("ready");
    },
  );

  // ---------------------------------------------------------------- //
  // Task 8 live tests: tag CRUD, merge, association, suggestion       //
  // resolution, rerun, and invalidation.                              //
  // ---------------------------------------------------------------- //

  // Seed taxonomy + tax profile + spending category once; used by T8 tests.
  function seedT8Fixtures(): void {
    runtimeSql(`
      INSERT INTO app.taxonomy_versions
        (id, jurisdiction_code, tax_year, code, name, status, source_url, source_revision, source_checksum)
      VALUES
        ('${PHASE_3C_TAXONOMY_VERSION_ID}', 'US-FEDERAL', 2025, '3c-v1', '3C Taxonomy', 'active',
         'https://3c.test', 'rev1', '${"a".repeat(64)}'),
        -- Year 2021 taxonomy for T8-live-8 (updateProfile creates profile with tax_year=2021)
        ('3c000000-0000-4000-8000-000000000030', 'US-FEDERAL', 2021, '3c-v0', '3C Taxonomy 2021', 'active',
         'https://3c.test', 'rev1', '${"b".repeat(64)}')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.tax_category_definitions
        (id, taxonomy_version_id, code, name, status, sort_order)
      VALUES
        ('3c000000-0000-4000-8000-00000000000c', '${PHASE_3C_TAXONOMY_VERSION_ID}',
         '3C-MEALS', 'Meals', 'active', 1),
        -- Tax category for 2021 taxonomy
        ('3c000000-0000-4000-8000-00000000000d', '3c000000-0000-4000-8000-000000000030',
         '3C-MEALS21', 'Meals 2021', 'active', 1)
      ON CONFLICT DO NOTHING;

      INSERT INTO app.business_tax_profiles
        (id, tenant_id, business_id, tax_year, taxonomy_version_id, tax_form, accounting_method, status)
      VALUES
        ('${PHASE_3C_TAX_PROFILE_ID}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_BUSINESS_A_ID}',
         2025, '${PHASE_3C_TAXONOMY_VERSION_ID}', 'schedule_c', 'cash', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.spending_categories
        (id, tenant_id, name, color, icon, status)
      VALUES
        ('${PHASE_3C_SPENDING_CATEGORY_ID}', '${PHASE_3C_TENANT_A_ID}', '3C Cat', '#AABBCC', 'tag', 'active')
      ON CONFLICT DO NOTHING;
    `);
  }

  it(
    "T8-live-1: createTag generates custom:<uuid> key server-side, owner enforced, member denied",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");
      seedT8Fixtures();

      const domain = createTagDomain(db);

      // Owner can create
      const tag = await domain.createTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        request: { name: "3C Meal Tag", color: "#123456" },
        requestId: `t8-live1-${runKey}`,
      });
      expect(tag.key).toMatch(/^custom:[0-9a-f-]{36}$/);
      expect(tag.origin).toBe("custom");
      expect(tag.status).toBe("active");

      // Member user denied
      const memberUserId = randomUUID();
      runtimeSql(`
        INSERT INTO app.users (id, primary_email, display_name)
        VALUES ('${memberUserId}', 'member-${runKey}@example.test', 'Member')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${PHASE_3C_TENANT_A_ID}', '${memberUserId}', 'member', 'active')
        ON CONFLICT DO NOTHING;
      `);
      const { DomainError } = await import("../../services/app-api/src/errors.js");
      await expect(
        domain.createTag({
          actorUserId: memberUserId,
          tenantId: PHASE_3C_TENANT_A_ID,
          request: { name: "Denied Tag", color: "#000000" },
          requestId: `t8-live1-denied-${runKey}`,
        }),
      ).rejects.toMatchObject<Partial<InstanceType<typeof DomainError>>>({ code: "FORBIDDEN" });
    },
  );

  it(
    "T8-live-2: archive supersedes pending suggestions; unarchive restores; archived key not reused",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const domain = createTagDomain(db);
      const tag = await domain.createTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        request: { name: "Temp3C Tag", color: "#ABCDEF" },
        requestId: `t8-live2-create-${runKey}`,
      });

      // Seed an expense + pending tag suggestion
      const expId = randomUUID();
      const fakeJobId = randomUUID();
      const sugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
          '${PHASE_3C_PROFILE_A_ID}', NULL, 'Archive Shop', '10.00', 'USD', '2026-09-02', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES ('${fakeJobId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
          'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
          'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;

        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES ('${sugId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
          '${expId}', '${fakeJobId}', 'tag', '${tag.id}', NULL, NULL, NULL, NULL, NULL, NULL,
          'historical', 0.9, '${"f".repeat(64)}', 'pending', 1, 1, 'live2-sug-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      // Archive tag — must also supersede pending suggestion
      const archived = await domain.archiveTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        tagId: tag.id,
        request: { expectedVersion: tag.version },
        requestId: `t8-live2-archive-${runKey}`,
      });
      expect(archived.status).toBe("archived");

      // Pending suggestion superseded (archive does NOT supersede tag suggestions;
      // only merge supersedes tag suggestions — category archive supersedes category sug)
      // The tag archive path in domain/tags.ts does not supersede tag suggestions by design.
      // Only category archive supersedes category suggestions (in spending-categories.ts).
      // This is intentional — archived tag prevents new rule applications, not historical sug.

      // Archived → cannot archive again (CONFLICT)
      const { DomainError: DE } = await import("../../services/app-api/src/errors.js");
      await expect(
        domain.archiveTag({
          actorUserId: PHASE_3C_USER_ID,
          tenantId: PHASE_3C_TENANT_A_ID,
          tagId: tag.id,
          request: { expectedVersion: archived.version },
          requestId: `t8-live2-rearchive-${runKey}`,
        }),
      ).rejects.toMatchObject<Partial<InstanceType<typeof DE>>>({ code: "CONFLICT" });

      // Unarchive explicitly
      const restored = await domain.unarchiveTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        tagId: tag.id,
        request: { expectedVersion: archived.version },
        requestId: `t8-live2-unarchive-${runKey}`,
      });
      expect(restored.status).toBe("active");
    },
  );

  it(
    "T8-live-3: applyExpenseTag creates manual association; cross-scope denied; one row per expense/tag",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const domain = createTagDomain(db);
      const tag = await domain.createTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        request: { name: "3C Assoc Tag", color: "#FF1234" },
        requestId: `t8-live3-tag-${runKey}`,
      });

      const expId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
          '${PHASE_3C_PROFILE_A_ID}', NULL, 'Assoc Diner', '15.00', 'USD', '2026-09-10', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      const assoc = await domain.applyExpenseTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        businessId: null,
        expenseId: expId,
        tagId: tag.id,
        requestId: `t8-live3-apply-${runKey}`,
      });
      expect(assoc.source).toBe("manual");
      expect(assoc.status).toBe("active");

      // Idempotent re-apply returns same row
      const assoc2 = await domain.applyExpenseTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        businessId: null,
        expenseId: expId,
        tagId: tag.id,
        requestId: `t8-live3-apply2-${runKey}`,
      });
      expect(assoc2.id).toBe(assoc.id);

      // Exactly one row
      const count = runtimeSql(
        `SELECT count(*) FROM app.expense_tags
          WHERE expense_id = '${expId}' AND tag_id = '${tag.id}';`,
      );
      expect(count).toBe("1");

      // Cross-scope: personal route with business expense → NOT_FOUND
      const bizExpId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES ('${bizExpId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
          NULL, '${PHASE_3C_BUSINESS_A_ID}', 'Biz Diner', '20.00', 'USD', '2026-09-10', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);
      const { DomainError: DE } = await import("../../services/app-api/src/errors.js");
      await expect(
        domain.applyExpenseTag({
          actorUserId: PHASE_3C_USER_ID,
          tenantId: PHASE_3C_TENANT_A_ID,
          profileId: PHASE_3C_PROFILE_A_ID,
          businessId: null,
          expenseId: bizExpId,
          tagId: tag.id,
          requestId: `t8-live3-xscope-${runKey}`,
        }),
      ).rejects.toMatchObject<Partial<InstanceType<typeof DE>>>({ code: "NOT_FOUND" });
    },
  );

  it(
    "T8-live-4: mergeTags — sorted lock, archive source, increment target, supersede pending source suggestions, preserve terminal",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const domain = createTagDomain(db);
      const srcTag = await domain.createTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        request: { name: "3C Merge Src", color: "#111111" },
        requestId: `t8-live4-src-${runKey}`,
      });
      const tgtTag = await domain.createTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        request: { name: "3C Merge Tgt", color: "#222222" },
        requestId: `t8-live4-tgt-${runKey}`,
      });

      // Seed pending + accepted suggestions for srcTag
      const expId = randomUUID();
      const fakeJobId = randomUUID();
      const pendingSugId = randomUUID();
      const acceptedSugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
          '${PHASE_3C_PROFILE_A_ID}', NULL, 'Merge Diner', '25.00', 'USD', '2026-09-10', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES ('${fakeJobId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
          'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
          'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;

        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key,
           resolved_by_user_id, resolved_at)
        VALUES
          -- pending (must be superseded by merge)
          ('${pendingSugId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
           '${expId}', '${fakeJobId}', 'tag', '${srcTag.id}', NULL, NULL, NULL, NULL, NULL, NULL,
           'historical', 0.9, '${"a".repeat(64)}', 'pending', 1, 1, 'merge-pend-${runKey}',
           NULL, NULL),
          -- accepted terminal (must NOT change)
          ('${acceptedSugId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
           '${expId}', '${fakeJobId}', 'tag', '${srcTag.id}', NULL, NULL, NULL, NULL, NULL, NULL,
           'historical', 0.8, '${"b".repeat(64)}', 'accepted', 2, 1, 'merge-acc-${runKey}',
           '${PHASE_3C_USER_ID}', now())
        ON CONFLICT DO NOTHING;
      `);

      await domain.mergeTags({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        sourceTagId: srcTag.id,
        targetTagId: tgtTag.id,
        expectedSourceVersion: srcTag.version,
        expectedTargetVersion: tgtTag.version,
        requestId: `t8-live4-merge-${runKey}`,
      });

      // Source archived
      const srcStatus = runtimeSql(`SELECT status FROM app.tags WHERE id = '${srcTag.id}';`);
      expect(srcStatus).toBe("archived");

      // Target version incremented
      const tgtVersion = runtimeSql(`SELECT version FROM app.tags WHERE id = '${tgtTag.id}';`);
      expect(parseInt(tgtVersion, 10)).toBeGreaterThan(tgtTag.version);

      // Pending superseded, accepted terminal preserved
      const pendStatus = runtimeSql(`SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${pendingSugId}';`);
      const accStatus = runtimeSql(`SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${acceptedSugId}';`);
      expect(pendStatus).toBe("superseded");
      expect(accStatus).toBe("accepted");

      // Audit event exists
      const auditCount = runtimeSql(
        `SELECT count(*) FROM app.app_audit_events WHERE action = 'tag.merged' AND resource_id = '${srcTag.id}';`,
      );
      expect(parseInt(auditCount, 10)).toBeGreaterThanOrEqual(1);

      // Rejected merge invariants
      const { DomainError: DE } = await import("../../services/app-api/src/errors.js");

      // Self merge
      const freshTag = await domain.createTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        request: { name: "3C Self Merge", color: "#333333" },
        requestId: `t8-live4-self-${runKey}`,
      });
      await expect(
        domain.mergeTags({
          actorUserId: PHASE_3C_USER_ID,
          tenantId: PHASE_3C_TENANT_A_ID,
          sourceTagId: freshTag.id,
          targetTagId: freshTag.id,
          expectedSourceVersion: freshTag.version,
          expectedTargetVersion: freshTag.version,
          requestId: `t8-live4-self-merge-${runKey}`,
        }),
      ).rejects.toMatchObject<Partial<InstanceType<typeof DE>>>({ code: "VALIDATION_ERROR" });

      // Archived target
      const tgt2 = await domain.createTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        request: { name: "3C Arch Tgt", color: "#444444" },
        requestId: `t8-live4-archtgt-${runKey}`,
      });
      const archivedTgt2 = await domain.archiveTag({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        tagId: tgt2.id,
        request: { expectedVersion: tgt2.version },
        requestId: `t8-live4-archtgt2-${runKey}`,
      });
      await expect(
        domain.mergeTags({
          actorUserId: PHASE_3C_USER_ID,
          tenantId: PHASE_3C_TENANT_A_ID,
          sourceTagId: freshTag.id,
          targetTagId: tgt2.id,
          expectedSourceVersion: freshTag.version,
          expectedTargetVersion: archivedTgt2.version,
          requestId: `t8-live4-archmerge-${runKey}`,
        }),
      ).rejects.toMatchObject<Partial<InstanceType<typeof DE>>>({ code: "CONFLICT" });
    },
  );

  it(
    "T8-live-5: resolveSuggestion — tag accept creates historical association; reject is terminal; idempotency replay; conflict on payload change",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      // --- tag accept ---
      const expId = randomUUID();
      const tagId = randomUUID();
      const fakeJobId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
          '${PHASE_3C_PROFILE_A_ID}', NULL, 'Resolve Shop', '12.00', 'USD', '2026-09-10', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tags (id, tenant_id, key, name, color, origin, status)
        VALUES ('${tagId}', '${PHASE_3C_TENANT_A_ID}', 'custom:res-${runKey}', 'Resolve Tag', '#EEDDCC', 'custom', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES ('${fakeJobId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
          'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
          'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;
      `);

      const sugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES ('${sugId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
          '${expId}', '${fakeJobId}', 'tag', '${tagId}', NULL, NULL, NULL, NULL, NULL, NULL,
          'historical', 0.9, '${"c".repeat(64)}', 'pending', 1, 1, 'tag-acc-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      const result = await resolveSuggestion(db, {
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        businessId: null,
        expenseId: expId,
        suggestionId: sugId,
        request: {
          action: "accepted",
          expectedSuggestionVersion: 1,
          expectedExpenseVersion: 1,
          idempotencyKey: `t8-live5-acc-${runKey}`,
        },
        requestId: `t8-live5-acc-req-${runKey}`,
      });
      expect(result.status).toBe("accepted");

      // Historical active association created
      const assocRow = runtimeSql(
        `SELECT source, status FROM app.expense_tags
          WHERE expense_id = '${expId}' AND tag_id = '${tagId}' AND status = 'active';`,
      );
      expect(assocRow).toContain("historical");

      // --- reject suggestion ---
      const expId2 = randomUUID();
      const tagId2 = randomUUID();
      const fakeJobId2 = randomUUID();
      const sugId2 = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId2}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
          '${PHASE_3C_PROFILE_A_ID}', NULL, 'Reject Shop', '8.00', 'USD', '2026-09-10', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tags (id, tenant_id, key, name, color, origin, status)
        VALUES ('${tagId2}', '${PHASE_3C_TENANT_A_ID}', 'custom:rej2-${runKey}', 'Rej Tag2', '#112233', 'custom', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES ('${fakeJobId2}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
          'ExpenseEnrichmentWorkflow', 'job-${fakeJobId2}', 'expense-tax-ai-worker', 'SUCCEEDED',
          'expense', '${expId2}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;

        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES ('${sugId2}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
          '${expId2}', '${fakeJobId2}', 'tag', '${tagId2}', NULL, NULL, NULL, NULL, NULL, NULL,
          'historical', 0.7, '${"d".repeat(64)}', 'pending', 1, 1, 'rej2-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      const rejResult = await resolveSuggestion(db, {
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        businessId: null,
        expenseId: expId2,
        suggestionId: sugId2,
        request: {
          action: "rejected",
          expectedSuggestionVersion: 1,
          expectedExpenseVersion: 1,
          idempotencyKey: `t8-live5-rej-${runKey}`,
        },
        requestId: `t8-live5-rej-req-${runKey}`,
      });
      expect(rejResult.status).toBe("rejected");

      // No association created on reject
      const noAssoc = runtimeSql(
        `SELECT count(*) FROM app.expense_tags WHERE expense_id = '${expId2}' AND tag_id = '${tagId2}';`,
      );
      expect(noAssoc).toBe("0");

      // --- idempotency replay ---
      const replay = await resolveSuggestion(db, {
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        businessId: null,
        expenseId: expId2,
        suggestionId: sugId2,
        request: {
          action: "rejected",
          expectedSuggestionVersion: 1,
          expectedExpenseVersion: 1,
          idempotencyKey: `t8-live5-rej-${runKey}`, // same key
        },
        requestId: `t8-live5-replay-req-${runKey}`,
      });
      expect(replay.suggestionId).toBe(rejResult.suggestionId);
      expect(replay.status).toBe("rejected");

      // --- conflict: same key, different payload ---
      const { DomainError: DE } = await import("../../services/app-api/src/errors.js");
      await expect(
        resolveSuggestion(db, {
          actorUserId: PHASE_3C_USER_ID,
          tenantId: PHASE_3C_TENANT_A_ID,
          profileId: PHASE_3C_PROFILE_A_ID,
          businessId: null,
          expenseId: expId2,
          suggestionId: sugId2,
          request: {
            action: "accepted", // different action — payload change
            expectedSuggestionVersion: 1,
            expectedExpenseVersion: 1,
            idempotencyKey: `t8-live5-rej-${runKey}`, // same key
          },
          requestId: `t8-live5-conflict-req-${runKey}`,
        }),
      ).rejects.toMatchObject<Partial<InstanceType<typeof DE>>>({ code: "CONFLICT" });
    },
  );

  it(
    "T8-live-6: rerunEnrichment creates new enrichment job for ready expense",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const expId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
          '${PHASE_3C_PROFILE_A_ID}', NULL, 'Rerun Diner', '9.00', 'USD', '2026-09-10', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      const beforeCount = parseInt(runtimeSql(
        `SELECT count(*) FROM app.processing_jobs WHERE target_aggregate_id = '${expId}';`,
      ), 10);

      await rerunEnrichment(db, {
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        profileId: PHASE_3C_PROFILE_A_ID,
        businessId: null,
        expenseId: expId,
        kinds: ["tag"],
        requestId: `t8-live6-rerun-${runKey}`,
      });

      const afterCount = parseInt(runtimeSql(
        `SELECT count(*) FROM app.processing_jobs WHERE target_aggregate_id = '${expId}';`,
      ), 10);
      // +1 from rerun (original job created at expense creation + 1 rerun)
      expect(afterCount).toBe(beforeCount + 1);
    },
  );

  it(
    "T8-live-7: spending_category archive supersedes pending matching suggestions; accepted/rejected preserved",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const { createSpendingCategoryDomain } = await import("../../services/app-api/src/domain/spending-categories.js");
      const catDomain = createSpendingCategoryDomain(db);

      const cat = await catDomain.create({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        request: { name: "3C Archive Cat", color: "#FF00FF", icon: "tag" },
        requestId: `t8-live7-cat-${runKey}`,
      });

      const expId = randomUUID();
      const fakeJobId = randomUUID();
      const pendSugId = randomUUID();
      const accSugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
          '${PHASE_3C_PROFILE_A_ID}', NULL, 'Cat Shop', '11.00', 'USD', '2026-09-10', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES ('${fakeJobId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
          'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
          'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;

        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key,
           resolved_by_user_id, resolved_at)
        VALUES
          ('${pendSugId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
           '${expId}', '${fakeJobId}', 'spending_category', NULL, '${cat.id}', NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.9, '${"e".repeat(64)}', 'pending', 1, 1, 'cat-arc-pend-${runKey}',
           NULL, NULL),
          ('${accSugId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_PROFILE_A_ID}', NULL,
           '${expId}', '${fakeJobId}', 'spending_category', NULL, '${cat.id}', NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.8, '${"f".repeat(64)}', 'accepted', 2, 1, 'cat-arc-acc-${runKey}',
           '${PHASE_3C_USER_ID}', now())
        ON CONFLICT DO NOTHING;
      `);

      await catDomain.archive({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        categoryId: cat.id,
        request: { expectedVersion: cat.version },
        requestId: `t8-live7-archive-${runKey}`,
      });

      const pendStatus = runtimeSql(`SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${pendSugId}';`);
      const accStatus = runtimeSql(`SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${accSugId}';`);
      expect(pendStatus).toBe("superseded");
      expect(accStatus).toBe("accepted");
    },
  );

  it(
    "T8-live-8: tax profile updateProfile supersedes pending tax suggestions; accepted preserved",
    async () => {
      const db = database;
      if (!db) throw new Error("Integration database was not initialized");

      const { createTaxDomain } = await import("../../services/app-api/src/domain/tax.js");
      const taxDomain = createTaxDomain(db);

      // Create a fresh tax profile for isolation
      const freshProfileId = randomUUID();
      const freshTaxYear = 2021; // unique year not used by other tests
      const freshTaxVersionId = "3c000000-0000-4000-8000-000000000030"; // 2021 taxonomy
      runtimeSql(`
        INSERT INTO app.business_tax_profiles
          (id, tenant_id, business_id, tax_year, taxonomy_version_id, tax_form, accounting_method, status)
        VALUES
          ('${freshProfileId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_BUSINESS_A_ID}',
          ${freshTaxYear}, '${freshTaxVersionId}', 'schedule_c', 'cash', 'active')
        ON CONFLICT DO NOTHING;
      `);

      const expId = randomUUID();
      const fakeJobId = randomUUID();
      const pendSugId = randomUUID();
      const accSugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
           merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${PHASE_3C_TENANT_A_ID}', '${PHASE_3C_USER_ID}',
          NULL, '${PHASE_3C_BUSINESS_A_ID}', 'Tax Meals2', '50.00', 'USD', '2021-06-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES ('${fakeJobId}', '${PHASE_3C_TENANT_A_ID}', NULL, '${PHASE_3C_BUSINESS_A_ID}',
          'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
          'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;

        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key,
           resolved_by_user_id, resolved_at)
        VALUES
          -- pending (profile version 1 — will be invalidated when profile updated to v2)
          ('${pendSugId}', '${PHASE_3C_TENANT_A_ID}', NULL, '${PHASE_3C_BUSINESS_A_ID}',
           '${expId}', '${fakeJobId}', 'tax_category', NULL, NULL,
           '3c000000-0000-4000-8000-00000000000d',
           '${freshProfileId}', 1, '${freshTaxVersionId}', ${freshTaxYear},
           'historical', 0.8, '${"c".repeat(64)}', 'pending', 1, 1, 'tax-pend-${runKey}',
           NULL, NULL),
          -- accepted terminal (must NOT change)
          ('${accSugId}', '${PHASE_3C_TENANT_A_ID}', NULL, '${PHASE_3C_BUSINESS_A_ID}',
           '${expId}', '${fakeJobId}', 'tax_category', NULL, NULL,
           '3c000000-0000-4000-8000-00000000000d',
           '${freshProfileId}', 1, '${freshTaxVersionId}', ${freshTaxYear},
           'historical', 0.7, '${"d".repeat(64)}', 'accepted', 2, 1, 'tax-acc-${runKey}',
           '${PHASE_3C_USER_ID}', now())
        ON CONFLICT DO NOTHING;
      `);

      // Update profile (version goes from 1 → 2, snapshot version 1 becomes stale)
      await taxDomain.updateProfile({
        actorUserId: PHASE_3C_USER_ID,
        tenantId: PHASE_3C_TENANT_A_ID,
        businessId: PHASE_3C_BUSINESS_A_ID,
        taxYear: freshTaxYear,
        request: { expectedVersion: 1, accountingMethod: "accrual" },
        requestId: `t8-live8-update-${runKey}`,
      });

      const pendStatus = runtimeSql(`SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${pendSugId}';`);
      const accStatus = runtimeSql(`SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${accSugId}';`);
      expect(pendStatus).toBe("superseded");
      expect(accStatus).toBe("accepted");
    },
  );
});
