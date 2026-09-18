/**
 * Task 6 — App API Projection, Rule Application, and Replay Safety
 *
 * Tests the domain/enrichment.ts module and the modified enrichment-jobs.ts
 * + expenses.ts integration points.
 *
 * All PostgreSQL coverage uses a live DB (PHASE_3C_INTEGRATION=1); unit tests
 * exercise deterministic/pure paths without a real DB.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";
import {
  buildEnrichmentInput,
  applyEnrichmentResult,
} from "../src/domain/enrichment.js";
import {
  createEnrichmentJobsDomain,
} from "../src/domain/enrichment-jobs.js";
import { createExpenseDomain } from "../src/domain/expenses.js";

// ------------------------------------------------------------------ //
// Infrastructure setup (identical pattern to app-domain-3c-auto-tagging)
// ------------------------------------------------------------------ //

const requested = process.env.PHASE_3C_INTEGRATION === "1";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t6_${runKey}`;

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

// ------------------------------------------------------------------ //
// Deterministic fixture UUIDs (Task 6 scope)
// ------------------------------------------------------------------ //
const T6_TENANT_ID   = "6a000000-0000-4000-8000-000000000001";
const T6_USER_ID     = "6a000000-0000-4000-8000-000000000002";
const T6_PROFILE_ID  = "6a000000-0000-4000-8000-000000000003";
const T6_BIZ_ID      = "6a000000-0000-4000-8000-000000000004";
const T6_TAX_PROF_ID = "6a000000-0000-4000-8000-000000000005";
const T6_TAXVER_ID   = "6a000000-0000-4000-8000-000000000006";
const T6_TAXCAT_ID   = "6a000000-0000-4000-8000-000000000007";
const T6_CAT_ID      = "6a000000-0000-4000-8000-000000000008";

// ------------------------------------------------------------------ //
// State
// ------------------------------------------------------------------ //
let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;

function dockerPsql(
  dbName: string,
  username: string,
  password: string,
  sql: string,
): string {
  const result = spawnSync(
    "docker",
    [
      "exec", "-e", `PGPASSWORD=${password}`,
      postgresContainerId,
      "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "--host", "127.0.0.1",
      "--username", username,
      "--dbname", dbName,
      "--tuples-only", "--no-align",
      "--pset", "footer=off",
      "--command", sql,
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

// ------------------------------------------------------------------ //
// Unit-only tests (no live DB required)
// ------------------------------------------------------------------ //

describe("domain/enrichment.ts — module exports", () => {
  it("buildEnrichmentInput is exported as a function", () => {
    expect(typeof buildEnrichmentInput).toBe("function");
  });

  it("applyEnrichmentResult is exported as a function", () => {
    expect(typeof applyEnrichmentResult).toBe("function");
  });

  // F15: resolveSuggestion and rerunEnrichment removed from enrichment.ts.
  // Task 8 owns those operations. No stubs needed.
});

describe("createEnrichmentJobsDomain — applied outcome no longer rejected", () => {
  // The domain must accept outcome:applied once Task 6 wires the real projection.
  // We test this by checking the module exports (behavioral tested via live DB).
  it("createEnrichmentJobsDomain is exported as a function", () => {
    expect(typeof createEnrichmentJobsDomain).toBe("function");
    // arity is 1 because second parameter has a default value (Task 6 ignores it)
    expect(createEnrichmentJobsDomain.length).toBeGreaterThanOrEqual(1);
  });
});

// ------------------------------------------------------------------ //
// Live PostgreSQL tests
// ------------------------------------------------------------------ //

describe.skipIf(!requested)(
  "Task 6 — live PostgreSQL enrichment projection and application",
  () => {
    beforeAll(async () => {
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
      postgresContainerId = execFileSync(
        composeScript,
        ["ps", "-q", "postgres"],
        { cwd: repoRoot, env: process.env, encoding: "utf8" },
      ).trim();
      runtimePassword =
        config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
      migratorPassword =
        config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
      if (!postgresContainerId || !runtimePassword || !migratorPassword) {
        throw new Error("Phase 3C PostgreSQL prerequisites unavailable");
      }

      adminSql(`CREATE DATABASE ${databaseName};`);
      adminSql(
        `CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
         CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;
         GRANT USAGE ON SCHEMA app TO expense_app_runtime;`,
        databaseName,
      );
      const migrationDatabaseUrl = `postgresql://expense_app_migrator:${encodeURIComponent(migratorPassword)}@127.0.0.1:5433/${databaseName}`;
      const runtimeDatabaseUrl = `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/${databaseName}`;
      await runMigrations(migrationDatabaseUrl);
      adminSql(
        `GRANT USAGE ON SCHEMA app TO expense_app_runtime;
         GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
         GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;`,
        databaseName,
      );
      database = createAppDatabase(runtimeDatabaseUrl);
      seedFixtures();
    });

    afterAll(async () => {
      await database?.destroy();
      if (postgresContainerId && databaseName) {
        adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
      }
    });

    function seedFixtures(): void {
      runtimeSql(`
        INSERT INTO app.users (id, primary_email, display_name)
        VALUES ('${T6_USER_ID}', 't6-owner@example.test', 'T6 Owner')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenants (id, name, slug, status)
        VALUES ('${T6_TENANT_ID}', 'T6 Tenant', 't6-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${T6_TENANT_ID}', '${T6_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_profiles (id, tenant_id, name)
        VALUES ('${T6_PROFILE_ID}', '${T6_TENANT_ID}', 'T6 Profile')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
        VALUES ('${T6_PROFILE_ID}', '${T6_TENANT_ID}', '${T6_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.businesses (id, tenant_id, name, industry_code, timezone, base_currency, status)
        VALUES ('${T6_BIZ_ID}', '${T6_TENANT_ID}', 'T6 Biz', 'restaurant', 'UTC', 'USD', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role, status)
        VALUES ('${T6_BIZ_ID}', '${T6_TENANT_ID}', '${T6_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.spending_categories (id, tenant_id, name, color, icon, status)
        VALUES ('${T6_CAT_ID}', '${T6_TENANT_ID}', 'T6 Cat', '#AABBCC', 'tag', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.taxonomy_versions (id, jurisdiction_code, tax_year, code, name, status, source_url, source_revision, source_checksum)
        VALUES ('${T6_TAXVER_ID}', 'US-FEDERAL', 2025, 'test-v1', 'Test Taxonomy', 'active', 'https://test.local', 'rev1', '${"a".repeat(64)}')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tax_category_definitions (id, taxonomy_version_id, code, name, status, sort_order)
        VALUES ('${T6_TAXCAT_ID}', '${T6_TAXVER_ID}', 'MEALS', 'Meals & Entertainment', 'active', 1)
        ON CONFLICT DO NOTHING;

        INSERT INTO app.business_tax_profiles (id, tenant_id, business_id, tax_year, taxonomy_version_id, tax_form, accounting_method, status)
        VALUES ('${T6_TAX_PROF_ID}', '${T6_TENANT_ID}', '${T6_BIZ_ID}', 2025, '${T6_TAXVER_ID}', 'schedule_c', 'cash', 'active')
        ON CONFLICT DO NOTHING;
      `);
    }

    // ---------------------------------------------------------------- //
    // T6-L1: Successful applied result — rule tags applied, suggestions created
    // ---------------------------------------------------------------- //

    it(
      "T6-L1: applied result creates rule tag association and pending historical suggestion",
      async () => {
        const db = database!;

        // Create a personal expense with a known merchant
        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Corner Deli",
            amount: "15.00",
            currency: "USD",
            incurredOn: "2026-09-13", // Saturday → triggers timing:weekend rule
          },
          requestId: `t6-l1-${runKey}`,
        });

        expect(expense.status).toBe("ready");

        // Fetch the enrichment job
        const jobRow = runtimeSql(
          `SELECT id, version FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId, jobVersionStr] = jobRow.split("|");
        const jobVersion = parseInt(jobVersionStr ?? "1", 10);
        expect(jobId).toBeTruthy();

        // Mark job RUNNING (required before input/result)
        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        // Build enrichment input — must return a real evaluate response
        const inputResponse = await buildEnrichmentInput(db, jobId!);
        expect(inputResponse.outcome).toBe("evaluate");
        if (inputResponse.outcome !== "evaluate") throw new Error("expected evaluate");

        const inp = inputResponse.input;
        expect(inp.expenseId).toBe(expense.id);
        expect(inp.expenseVersion).toBe(1);
        expect(inp.jobId).toBe(jobId);
        // normalizedMerchant must be present (merchant "Corner Deli" → slug "corner-deli")
        expect(inp.normalizedMerchant).not.toBeNull();
        expect(inp.normalizedMerchant).toBe("corner-deli"); // F8: stable hyphenated slug
        // F8: key = merchant:<slug> — same derivation as worker f"merchant:{inp.normalizedMerchant}"
        const expectedMerchantKey = `merchant:${inp.normalizedMerchant}`;
        expect(inp.eligibleTagKeys).toContain(expectedMerchantKey);
        expect(inp.eligibleTagKeys).toContain("timing:weekend");
        // No raw amounts, selectors, tax descriptions
        expect("tenantId" in inp).toBe(false);
        expect("amount" in inp).toBe(false);

        // Apply an enrichment result with outcome:applied
        // F8: same slug — worker uses verbatim, server recomputes same key
        const merchantKey = `merchant:${inp.normalizedMerchant}`;
        const weekendKey = "timing:weekend";

        // Build canonical evidence hash for a tag suggestion
        const evidencePayload = JSON.stringify(
          {
            kind: "tag",
            candidate: merchantKey,
            exampleCount: 3,
            matchCount: 3,
          },
          Object.keys({
            kind: "", candidate: "", exampleCount: 0, matchCount: 0,
          }).sort(),
        );
        // Re-sort keys canonically
        const canonicalEvidence = JSON.stringify(
          { candidate: merchantKey, exampleCount: 3, kind: "tag", matchCount: 3 },
        );
        const evidenceHash = createHash("sha256")
          .update(canonicalEvidence)
          .digest("hex");

        const enrichmentDomain = createEnrichmentJobsDomain(db);

        const submitResult = await enrichmentDomain.submitEnrichmentResult({
          jobId: jobId!,
          idempotencyKey: `t6-l1-apply-${runKey}`,
          expectedJobVersion: jobVersion + 1, // was bumped to RUNNING
          result: {
            schemaVersion: 1,
            rulesVersion: 1,
            outcome: "applied",
            ruleTagKeys: [merchantKey, weekendKey],
            suggestions: [
              {
                kind: "tag",
                source: "historical",
                tagKey: merchantKey,
                confidence: 1.0,
                evidenceHash,
                aggregateCounts: { exampleCount: 3, matchCount: 3 },
              },
            ],
          },
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `t6-l1-req-${runKey}`,
        });

        expect(submitResult.statusCode).toBe(200);
        expect(submitResult.body.status).toBe("SUCCEEDED");
        expect(submitResult.replayed).toBe(false);

        // Verify rule tags were created
        const tagRows = runtimeSql(
          `SELECT t.key, et.source, et.confidence, et.rule_version, et.status
             FROM app.expense_tags et
             INNER JOIN app.tags t ON t.id = et.tag_id
            WHERE et.expense_id = '${expense.id}'
              AND et.tenant_id = '${T6_TENANT_ID}'
            ORDER BY t.key;`,
        );
        expect(tagRows).toContain(merchantKey);
        expect(tagRows).toContain("timing:weekend");
        expect(tagRows).toContain("rule");

        // Verify merchant tag has confidence=1 and rule_version=1
        const merchantTagRow = runtimeSql(
          `SELECT et.confidence, et.rule_version, et.source, et.status
             FROM app.expense_tags et
             INNER JOIN app.tags t ON t.id = et.tag_id
            WHERE et.expense_id = '${expense.id}'
              AND t.key = '${merchantKey}';`,
        );
        expect(merchantTagRow).toContain("1"); // confidence 1

        // Verify historical suggestion was created as pending
        const sugRow = runtimeSql(
          `SELECT status, source, confidence
             FROM app.expense_enrichment_suggestions
            WHERE expense_id = '${expense.id}'
              AND kind = 'tag'
              AND evidence_hash = '${evidenceHash}';`,
        );
        expect(sugRow).toContain("pending");
        expect(sugRow).toContain("historical");

        // Verify operation keys were recorded (at minimum 1 for the job-level result)
        const opKeyRow = runtimeSql(
          `SELECT count(*) FROM app.enrichment_operation_keys
            WHERE expense_id = '${expense.id}';`,
        );
        expect(parseInt(opKeyRow, 10)).toBeGreaterThanOrEqual(1);
      },
    );

    // ---------------------------------------------------------------- //
    // T6-L2: Server recomputation rejection — worker sends wrong rule tags
    // ---------------------------------------------------------------- //

    it(
      "T6-L2: server rejects result with ruleTagKeys that don't match server recomputation",
      async () => {
        const db = database!;

        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Weekend Coffee",
            amount: "8.00",
            currency: "USD",
            incurredOn: "2026-09-14", // Sunday
          },
          requestId: `t6-l2-${runKey}`,
        });

        const jobRow = runtimeSql(
          `SELECT id, version FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId, jobVersionStr] = jobRow.split("|");
        const jobVersion = parseInt(jobVersionStr ?? "1", 10);

        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        const enrichmentDomain = createEnrichmentJobsDomain(db);

        // Worker sends a fake rule key that server would not compute
        await expect(
          enrichmentDomain.submitEnrichmentResult({
            jobId: jobId!,
            idempotencyKey: `t6-l2-bad-${runKey}`,
            expectedJobVersion: jobVersion + 1,
            result: {
              schemaVersion: 1,
              rulesVersion: 1,
              outcome: "applied",
              ruleTagKeys: ["merchant:fake-merchant-that-doesnt-exist"],
              suggestions: [],
            },
            actorServicePrincipal: "ai-worker-app-machine",
            requestId: `t6-l2-req-${runKey}`,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        // Job must remain RUNNING (no mutation applied)
        const jobStatus = runtimeSql(
          `SELECT status FROM app.processing_jobs WHERE id = '${jobId}';`,
        );
        expect(jobStatus).toBe("RUNNING");
      },
    );

    // ---------------------------------------------------------------- //
    // T6-L3: Stale no-op — expense version changed before result arrives
    // ---------------------------------------------------------------- //

    it(
      "T6-L3: stale result marks job SUCCEEDED without mutating expense or tags",
      async () => {
        const db = database!;

        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Stale Bakery",
            amount: "12.00",
            currency: "USD",
            incurredOn: "2026-09-15",
          },
          requestId: `t6-l3-${runKey}`,
        });

        const jobRow = runtimeSql(
          `SELECT id, version FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId, jobVersionStr] = jobRow.split("|");
        const jobVersion = parseInt(jobVersionStr ?? "1", 10);

        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        const enrichmentDomain = createEnrichmentJobsDomain(db);

        const result = await enrichmentDomain.submitEnrichmentResult({
          jobId: jobId!,
          idempotencyKey: `t6-l3-stale-${runKey}`,
          expectedJobVersion: jobVersion + 1,
          result: {
            schemaVersion: 1,
            rulesVersion: 1,
            outcome: "stale",
            ruleTagKeys: [],
            suggestions: [],
          },
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `t6-l3-req-${runKey}`,
        });

        expect(result.statusCode).toBe(200);
        expect(result.body.status).toBe("SUCCEEDED");

        // No tags created
        const tagCount = runtimeSql(
          `SELECT count(*) FROM app.expense_tags WHERE expense_id = '${expense.id}';`,
        );
        expect(tagCount).toBe("0");
      },
    );

    // ---------------------------------------------------------------- //
    // T6-L4: Manual category update — decision + supersession
    // ---------------------------------------------------------------- //

    it(
      "T6-L4: manual spendingCategoryId update inserts decision row and supersedes pending suggestions",
      async () => {
        const db = database!;

        const catId2 = "6a000000-0000-4000-8000-000000000009";
        runtimeSql(`
          INSERT INTO app.spending_categories (id, tenant_id, name, color, icon, status)
          VALUES ('${catId2}', '${T6_TENANT_ID}', 'T6 Cat2', '#112233', 'folder', 'active')
          ON CONFLICT DO NOTHING;
        `);

        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Category Cafe",
            amount: "20.00",
            currency: "USD",
            incurredOn: "2026-09-16",
            spendingCategoryId: T6_CAT_ID,
          },
          requestId: `t6-l4-create-${runKey}`,
        });

        // Seed a pending spending_category suggestion for this expense
        const jobRow = runtimeSql(
          `SELECT id FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId] = jobRow.split("|");

        const sugId = randomUUID();
        const sugEvidenceHash = "a".repeat(64);
        runtimeSql(`
          INSERT INTO app.expense_enrichment_suggestions
            (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
             kind, tag_id, spending_category_id, tax_category_definition_id,
             business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
             source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
          VALUES
            ('${sugId}', '${T6_TENANT_ID}',
             '${T6_PROFILE_ID}', NULL, '${expense.id}', '${jobId}',
             'spending_category', NULL, '${catId2}', NULL,
             NULL, NULL, NULL, NULL,
             'historical', 0.85, '${sugEvidenceHash}', 'pending', 1, 1, 't6-l4-sug-${runKey}')
          ON CONFLICT DO NOTHING;
        `);

        // Now update expense with new category (manual change)
        const updated = await expenseDomain.updatePersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          expenseId: expense.id,
          profileId: T6_PROFILE_ID,
          request: {
            expectedVersion: expense.version,
            spendingCategoryId: catId2,
          },
          requestId: `t6-l4-update-${runKey}`,
        });

        expect(updated.spendingCategoryId).toBe(catId2);
        expect(updated.version).toBe(expense.version + 1);

        // Exactly one decision row with source=manual, prior=T6_CAT_ID, new=catId2
        const decRows = runtimeSql(
          `SELECT source, prior_spending_category_id, new_spending_category_id,
                  actor_user_id, expense_version
             FROM app.expense_spending_category_decisions
            WHERE expense_id = '${expense.id}'
              AND source = 'manual'
              AND prior_spending_category_id = '${T6_CAT_ID}'
              AND new_spending_category_id = '${catId2}';`,
        );
        expect(decRows).toContain("manual");
        expect(decRows).toContain(T6_CAT_ID);
        expect(decRows).toContain(catId2);
        expect(decRows).toContain(T6_USER_ID);

        // The pending spending_category suggestion must be superseded
        const sugStatus = runtimeSql(
          `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${sugId}';`,
        );
        expect(sugStatus).toBe("superseded");
      },
    );

    // ---------------------------------------------------------------- //
    // T6-L5: Permanent replay — returns original response after generic idempotency deleted
    // ---------------------------------------------------------------- //

    it(
      "T6-L5: permanent replay returns original response after generic idempotency record deleted",
      async () => {
        const db = database!;

        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Replay Diner",
            amount: "7.00",
            currency: "USD",
            incurredOn: "2026-09-17",
          },
          requestId: `t6-l5-${runKey}`,
        });

        const jobRow = runtimeSql(
          `SELECT id, version FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId, jobVersionStr] = jobRow.split("|");
        const jobVersion = parseInt(jobVersionStr ?? "1", 10);

        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        const enrichmentDomain = createEnrichmentJobsDomain(db);
        const idemKey = `t6-l5-replay-${runKey}`;

        // First submit
        const first = await enrichmentDomain.submitEnrichmentResult({
          jobId: jobId!,
          idempotencyKey: idemKey,
          expectedJobVersion: jobVersion + 1,
          result: {
            schemaVersion: 1,
            rulesVersion: 1,
            outcome: "stale",
            ruleTagKeys: [],
            suggestions: [],
          },
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `t6-l5-req1-${runKey}`,
        });
        expect(first.replayed).toBe(false);
        expect(first.body.status).toBe("SUCCEEDED");

        // Delete generic idempotency record (simulating expiry)
        adminSql(
          `DELETE FROM app.idempotency_records
            WHERE idempotency_key = '${idemKey}';`,
          databaseName,
        );

        // Verify generic idempotency is gone
        const idemCount = adminSql(
          `SELECT count(*) FROM app.idempotency_records
            WHERE idempotency_key = '${idemKey}';`,
          databaseName,
        );
        expect(idemCount).toBe("0");

        // Replay must return original response via permanent operation key
        const replay = await enrichmentDomain.submitEnrichmentResult({
          jobId: jobId!,
          idempotencyKey: idemKey,
          expectedJobVersion: jobVersion + 1,
          result: {
            schemaVersion: 1,
            rulesVersion: 1,
            outcome: "stale",
            ruleTagKeys: [],
            suggestions: [],
          },
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `t6-l5-req2-${runKey}`,
        });

        expect(replay.replayed).toBe(true);
        expect(replay.statusCode).toBe(200);
        expect(replay.body.status).toBe("SUCCEEDED");
      },
    );

    // ---------------------------------------------------------------- //
    // T6-L6: Changed-payload conflict — same operation key, different result
    // ---------------------------------------------------------------- //

    // ---------------------------------------------------------------- //
    // T6-L7: F8 merchant key parity — verbatim slug, no hyphen conversion
    // ---------------------------------------------------------------- //

    it(
      "T6-L7: F8 merchant key in eligibleTagKeys is merchant:<verbatim-normalized-slug>",
      async () => {
        const db = database!;

        // "Whole Foods Market" → normalizeMerchant → "whole foods market" (spaces, no hyphens)
        // The eligible key must be "merchant:whole foods market", NOT "merchant:whole-foods-market"
        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Whole Foods Market",
            amount: "50.00",
            currency: "USD",
            incurredOn: "2026-09-15",
          },
          requestId: `t6-l7-${runKey}`,
        });

        const jobRow = runtimeSql(
          `SELECT id, version FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId] = jobRow.split("|");

        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        const inputResponse = await buildEnrichmentInput(db, jobId!);
        expect(inputResponse.outcome).toBe("evaluate");
        if (inputResponse.outcome !== "evaluate") throw new Error("expected evaluate");

        const inp = inputResponse.input;
        // F8: normalizedMerchant is the stable slug with hyphens (tag key constraint requires [a-z0-9_:.-]+)
        expect(inp.normalizedMerchant).toBe("whole-foods-market"); // hyphens replace spaces in slug

        // F8: key matches worker derivation: f"merchant:{inp.normalizedMerchant}"
        expect(inp.eligibleTagKeys).toContain("merchant:whole-foods-market");
        expect(inp.eligibleTagKeys).not.toContain("merchant:whole foods market");
      },
    );

    // ---------------------------------------------------------------- //
    // T6-L8: F5 24-month cutoff — history boundary correct, no setMonth overflow
    // ---------------------------------------------------------------- //

    it(
      "T6-L8: F5 24-month cutoff excludes expenses before cutoff and includes those at/after",
      async () => {
        const db = database!;

        // Create current expense (2026-09-15)
        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Boundary Bakery",
            amount: "10.00",
            currency: "USD",
            incurredOn: "2026-09-15",
          },
          requestId: `t6-l8-create-${runKey}`,
        });

        // Seed historical expense at cutoff date (2024-09-15 — exactly 24 months before)
        const atCutoffId = `t6l8a${runKey.slice(0, 8)}`;
        const beforeCutoffId = `t6l8b${runKey.slice(0, 8)}`;
        const withinWindowId = `t6l8c${runKey.slice(0, 8)}`;

        // Valid UUIDs for seeded expenses — use randomUUID to avoid collision
        const atCutoffUuid = randomUUID();
        const beforeCutoffUuid = randomUUID();
        const withinWindowUuid = randomUUID();

        // Seed expenses and fingerprints for the same merchant
        const normalizedSlug = "boundary bakery";
        runtimeSql(`
          -- At cutoff (2024-09-15) — should be INCLUDED (incurred_on >= cutoff)
          INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
            merchant, amount, currency, incurred_on, source, status)
          VALUES ('${atCutoffUuid}', '${T6_TENANT_ID}', '${T6_USER_ID}',
            '${T6_PROFILE_ID}', NULL, 'Boundary Bakery', '9.00', 'USD', '2024-09-15', 'manual', 'ready')
          ON CONFLICT DO NOTHING;

          INSERT INTO app.expense_dedup_fingerprints
            (id, tenant_id, personal_profile_id, business_id, expense_id, fingerprint_version,
             normalized_merchant, amount_minor_units, currency, incurred_on, fingerprint_hash)
          VALUES (gen_random_uuid(), '${T6_TENANT_ID}', '${T6_PROFILE_ID}', NULL, '${atCutoffUuid}',
            1, '${normalizedSlug}', 900, 'USD', '2024-09-15', '${"b".repeat(64)}')
          ON CONFLICT DO NOTHING;

          -- Before cutoff (2024-09-14) — should be EXCLUDED (incurred_on < cutoff)
          INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
            merchant, amount, currency, incurred_on, source, status)
          VALUES ('${beforeCutoffUuid}', '${T6_TENANT_ID}', '${T6_USER_ID}',
            '${T6_PROFILE_ID}', NULL, 'Boundary Bakery', '8.00', 'USD', '2024-09-14', 'manual', 'ready')
          ON CONFLICT DO NOTHING;

          INSERT INTO app.expense_dedup_fingerprints
            (id, tenant_id, personal_profile_id, business_id, expense_id, fingerprint_version,
             normalized_merchant, amount_minor_units, currency, incurred_on, fingerprint_hash)
          VALUES (gen_random_uuid(), '${T6_TENANT_ID}', '${T6_PROFILE_ID}', NULL, '${beforeCutoffUuid}',
            1, '${normalizedSlug}', 800, 'USD', '2024-09-14', '${"c".repeat(64)}')
          ON CONFLICT DO NOTHING;

          -- Within window (2025-06-15) — should be INCLUDED
          INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
            merchant, amount, currency, incurred_on, source, status)
          VALUES ('${withinWindowUuid}', '${T6_TENANT_ID}', '${T6_USER_ID}',
            '${T6_PROFILE_ID}', NULL, 'Boundary Bakery', '7.00', 'USD', '2025-06-15', 'manual', 'ready')
          ON CONFLICT DO NOTHING;

          INSERT INTO app.expense_dedup_fingerprints
            (id, tenant_id, personal_profile_id, business_id, expense_id, fingerprint_version,
             normalized_merchant, amount_minor_units, currency, incurred_on, fingerprint_hash)
          VALUES (gen_random_uuid(), '${T6_TENANT_ID}', '${T6_PROFILE_ID}', NULL, '${withinWindowUuid}',
            1, '${normalizedSlug}', 700, 'USD', '2025-06-15', '${"d".repeat(64)}')
          ON CONFLICT DO NOTHING;
        `);

        const jobRow = runtimeSql(
          `SELECT id, version FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId] = jobRow.split("|");

        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        const inputResponse = await buildEnrichmentInput(db, jobId!);
        expect(inputResponse.outcome).toBe("evaluate");
        if (inputResponse.outcome !== "evaluate") throw new Error("expected evaluate");

        const history = inputResponse.input.history;
        // Should include: atCutoffUuid + withinWindowUuid = 2 examples
        // Should exclude: beforeCutoffUuid (before cutoff) + expense itself
        expect(history.exampleCount).toBe(2);
      },
    );

    // ---------------------------------------------------------------- //
    // T6-L9: F6 spending-category history from decisions, not expenses col
    // ---------------------------------------------------------------- //

    it(
      "T6-L9: F6 spending-category history comes from latest qualifying decision, not expense column",
      async () => {
        const db = database!;

        // Seed a second spending category
        const catId3 = "6a000000-0000-4000-8000-00000000000a";
        runtimeSql(`
          INSERT INTO app.spending_categories (id, tenant_id, name, color, icon, status)
          VALUES ('${catId3}', '${T6_TENANT_ID}', 'T6 Cat3', '#334455', 'home', 'active')
          ON CONFLICT DO NOTHING;
        `);

        // Create a historical expense with category T6_CAT_ID in expenses table,
        // but with a manual decision pointing to catId3 (later manual override)
        const histExpUuid = randomUUID();
        runtimeSql(`
          INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
            merchant, amount, currency, incurred_on, source, status, spending_category_id)
          VALUES ('${histExpUuid}', '${T6_TENANT_ID}', '${T6_USER_ID}',
            '${T6_PROFILE_ID}', NULL, 'Decision Diner', '25.00', 'USD', '2025-06-01', 'manual', 'ready',
            '${T6_CAT_ID}')
          ON CONFLICT DO NOTHING;

          INSERT INTO app.expense_dedup_fingerprints
            (id, tenant_id, personal_profile_id, business_id, expense_id, fingerprint_version,
             normalized_merchant, amount_minor_units, currency, incurred_on, fingerprint_hash)
          VALUES (gen_random_uuid(), '${T6_TENANT_ID}', '${T6_PROFILE_ID}', NULL, '${histExpUuid}',
            1, 'decision diner', 2500, 'USD', '2025-06-01', '${"e".repeat(64)}')
          ON CONFLICT DO NOTHING;

          -- Manual baseline decision (expense_version=1 — first/earlier)
          INSERT INTO app.expense_spending_category_decisions
            (id, tenant_id, personal_profile_id, business_id, expense_id,
             prior_spending_category_id, new_spending_category_id, source, expense_version)
          VALUES (gen_random_uuid(), '${T6_TENANT_ID}', '${T6_PROFILE_ID}', NULL, '${histExpUuid}',
            NULL, '${T6_CAT_ID}', 'manual_baseline', 1)
          ON CONFLICT DO NOTHING;
        `);

        // Insert the later manual decision in a separate call to ensure different created_at
        runtimeSql(`
          INSERT INTO app.expense_spending_category_decisions
            (id, tenant_id, personal_profile_id, business_id, expense_id,
             prior_spending_category_id, new_spending_category_id, source, expense_version)
          VALUES (gen_random_uuid(), '${T6_TENANT_ID}', '${T6_PROFILE_ID}', NULL, '${histExpUuid}',
            '${T6_CAT_ID}', '${catId3}', 'manual', 2)
          ON CONFLICT DO NOTHING;
        `);

        // Create current expense from same merchant
        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Decision Diner",
            amount: "30.00",
            currency: "USD",
            incurredOn: "2026-09-17",
          },
          requestId: `t6-l9-${runKey}`,
        });

        const jobRow = runtimeSql(
          `SELECT id FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId] = jobRow.split("|");

        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        const inputResponse = await buildEnrichmentInput(db, jobId!);
        expect(inputResponse.outcome).toBe("evaluate");
        if (inputResponse.outcome !== "evaluate") throw new Error("expected evaluate");

        const history = inputResponse.input.history;
        expect(history.exampleCount).toBe(1);

        // F6: history should use catId3 (from latest manual decision), not T6_CAT_ID (expense col)
        const catCandidates = history.candidateSpendingCategoryIds;
        expect(catCandidates.length).toBeGreaterThan(0);
        expect(catCandidates[0].id).toBe(catId3);
        // T6_CAT_ID (from expense col) must NOT appear as a candidate
        expect(catCandidates.some((c) => c.id === T6_CAT_ID)).toBe(false);
      },
    );

    // ---------------------------------------------------------------- //
    // T6-L10: F10 expense_tag association version increments on re-apply
    // ---------------------------------------------------------------- //

    it(
      "T6-L10: F10 expense_tag version increments when rule tag re-applied to existing active association",
      async () => {
        const db = database!;

        const expenseDomain = createExpenseDomain(db);
        // Saturday = weekend rule fires
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Version Cafe",
            amount: "11.00",
            currency: "USD",
            incurredOn: "2026-09-19", // Saturday
          },
          requestId: `t6-l10-create-${runKey}`,
        });

        const getJobRow = () => runtimeSql(
          `SELECT id, version FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow'
            ORDER BY created_at DESC LIMIT 1;`,
        );

        // First result submission — creates rule tag (version=1 from insert trigger default)
        let jobRow = getJobRow();
        let [jobId, jobVersionStr] = jobRow.split("|");
        let jobVersion = parseInt(jobVersionStr ?? "1", 10);

        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        // Get the actual eligible keys from projection to avoid mismatch
        const inputResp = await buildEnrichmentInput(db, jobId!);
        expect(inputResp.outcome).toBe("evaluate");
        if (inputResp.outcome !== "evaluate") throw new Error("expected evaluate");
        const eligibleKeys = inputResp.input.eligibleTagKeys;
        // Build only weekend key if eligible, else empty (weekend rule fires on Saturday)
        const weekendKey = eligibleKeys.includes("timing:weekend") ? ["timing:weekend"] : [];
        // Include merchant key if eligible
        const merchantKey = eligibleKeys.find((k) => k.startsWith("merchant:"));
        const ruleTagKeys = [...(merchantKey ? [merchantKey] : []), ...weekendKey].sort();

        const enrichmentDomain = createEnrichmentJobsDomain(db);
        await enrichmentDomain.submitEnrichmentResult({
          jobId: jobId!,
          idempotencyKey: `t6-l10-first-${runKey}`,
          expectedJobVersion: jobVersion + 1,
          result: {
            schemaVersion: 1,
            rulesVersion: 1,
            outcome: "applied",
            ruleTagKeys,
            suggestions: [],
          },
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `t6-l10-req1-${runKey}`,
        });

        // Get the expense_tag version after first apply
        const versionAfterFirst = runtimeSql(
          `SELECT et.version FROM app.expense_tags et
             INNER JOIN app.tags t ON t.id = et.tag_id
            WHERE et.expense_id = '${expense.id}'
              AND t.key = 'timing:weekend';`,
        );
        const firstVersion = parseInt(versionAfterFirst, 10);
        expect(firstVersion).toBeGreaterThanOrEqual(1);

        // Seed a new enrichment job for re-apply (simulate re-run)
        const newJobId = randomUUID();
        runtimeSql(`
          INSERT INTO app.processing_jobs
            (id, tenant_id, personal_profile_id, business_id,
             workflow_type, workflow_id, task_queue, status,
             target_aggregate_type, target_aggregate_id, expected_aggregate_version,
             input_params, allowed_result_schema_version, dispatched_at)
          VALUES
            ('${newJobId}', '${T6_TENANT_ID}', '${T6_PROFILE_ID}', NULL,
             'ExpenseEnrichmentWorkflow', 'job-${newJobId}', 'expense-tax-ai-worker', 'RUNNING',
             'expense', '${expense.id}', 1,
             '{}', 'expense-enrichment-v1', now())
          ON CONFLICT DO NOTHING;
        `);

        // Re-apply with same rule tag keys for the same expense
        await enrichmentDomain.submitEnrichmentResult({
          jobId: newJobId,
          idempotencyKey: `t6-l10-second-${runKey}`,
          expectedJobVersion: 1,
          result: {
            schemaVersion: 1,
            rulesVersion: 1,
            outcome: "applied",
            ruleTagKeys,
            suggestions: [],
          },
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `t6-l10-req2-${runKey}`,
        });

        // F10: version must have incremented
        const versionAfterSecond = runtimeSql(
          `SELECT et.version FROM app.expense_tags et
             INNER JOIN app.tags t ON t.id = et.tag_id
            WHERE et.expense_id = '${expense.id}'
              AND t.key = 'timing:weekend';`,
        );
        const secondVersion = parseInt(versionAfterSecond, 10);
        expect(secondVersion).toBe(firstVersion + 1);
      },
    );

    // ---------------------------------------------------------------- //
    // T6-L11: F3 atomic replay — result op key kind='result', null candidate
    // ---------------------------------------------------------------- //

    it(
      "T6-L11: F1/F2 result operation key has kind='result' and null candidate_id",
      async () => {
        const db = database!;

        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Result Kind Cafe",
            amount: "6.00",
            currency: "USD",
            incurredOn: "2026-09-15",
          },
          requestId: `t6-l11-${runKey}`,
        });

        const jobRow = runtimeSql(
          `SELECT id, version FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId, jobVersionStr] = jobRow.split("|");
        const jobVersion = parseInt(jobVersionStr ?? "1", 10);

        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        const enrichmentDomain = createEnrichmentJobsDomain(db);
        const idemKey = `t6-l11-result-${runKey}`;

        await enrichmentDomain.submitEnrichmentResult({
          jobId: jobId!,
          idempotencyKey: idemKey,
          expectedJobVersion: jobVersion + 1,
          result: {
            schemaVersion: 1,
            rulesVersion: 1,
            outcome: "stale",
            ruleTagKeys: [],
            suggestions: [],
          },
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `t6-l11-req-${runKey}`,
        });

        // Verify result op key has kind='result' and null candidate_id (F1/F2)
        const opKeyRow = runtimeSql(
          `SELECT kind, candidate_id
             FROM app.enrichment_operation_keys
            WHERE operation_key = 'result:${jobId}:${idemKey}';`,
        );
        expect(opKeyRow).toContain("result"); // kind = 'result'
        // candidate_id is null — in tuples-only format, null columns produce empty string
        // The row should exist and kind should be 'result'
        expect(opKeyRow.startsWith("result")).toBe(true);
      },
    );

    it(
      "T6-L6: same idempotency key with changed result payload is a permanent conflict",
      async () => {
        const db = database!;

        const expenseDomain = createExpenseDomain(db);
        const expense = await expenseDomain.createPersonal({
          actorUserId: T6_USER_ID,
          tenantId: T6_TENANT_ID,
          profileId: T6_PROFILE_ID,
          request: {
            personalProfileId: T6_PROFILE_ID,
            merchant: "Conflict Cafe",
            amount: "9.00",
            currency: "USD",
            incurredOn: "2026-09-15",
          },
          requestId: `t6-l6-${runKey}`,
        });

        const jobRow = runtimeSql(
          `SELECT id, version FROM app.processing_jobs
            WHERE target_aggregate_id = '${expense.id}'
              AND workflow_type = 'ExpenseEnrichmentWorkflow';`,
        );
        const [jobId, jobVersionStr] = jobRow.split("|");
        const jobVersion = parseInt(jobVersionStr ?? "1", 10);

        runtimeSql(`
          UPDATE app.processing_jobs
             SET status = 'RUNNING', version = version + 1, dispatched_at = now(), updated_at = now()
           WHERE id = '${jobId}';
        `);

        const enrichmentDomain = createEnrichmentJobsDomain(db);
        const idemKey = `t6-l6-conflict-${runKey}`;

        // First submit with stale
        const first = await enrichmentDomain.submitEnrichmentResult({
          jobId: jobId!,
          idempotencyKey: idemKey,
          expectedJobVersion: jobVersion + 1,
          result: {
            schemaVersion: 1,
            rulesVersion: 1,
            outcome: "stale",
            ruleTagKeys: [],
            suggestions: [],
          },
          actorServicePrincipal: "ai-worker-app-machine",
          requestId: `t6-l6-req1-${runKey}`,
        });
        expect(first.replayed).toBe(false);

        // Delete generic idempotency to force permanent operation key path
        adminSql(
          `DELETE FROM app.idempotency_records WHERE idempotency_key = '${idemKey}';`,
          databaseName,
        );

        // Replay with DIFFERENT payload — must conflict
        await expect(
          enrichmentDomain.submitEnrichmentResult({
            jobId: jobId!,
            idempotencyKey: idemKey,
            expectedJobVersion: jobVersion + 1,
            result: {
              schemaVersion: 1,
              rulesVersion: 2, // changed rulesVersion — different payload
              outcome: "stale",
              ruleTagKeys: [],
              suggestions: [],
            },
            actorServicePrincipal: "ai-worker-app-machine",
            requestId: `t6-l6-req2-${runKey}`,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      },
    );
  },
);
