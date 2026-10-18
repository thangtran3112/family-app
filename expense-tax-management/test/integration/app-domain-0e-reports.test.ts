import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createExpenseDomain } from "../../services/app-api/src/domain/expenses.js";
import { createExportsDomain } from "../../services/app-api/src/domain/exports.js";
import { createTaxDomain } from "../../services/app-api/src/domain/tax.js";
import { DomainError } from "../../services/app-api/src/errors.js";
import { createLocalStorageAdapter } from "../../services/app-api/src/storage/local.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0E_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);

const TAXONOMY_2025_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEALS_CATEGORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000020";
const ADVERTISING_CATEGORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

// Fixed UUIDs for the golden bundle: the CSV embeds expense IDs, so
// byte-identical output requires a byte-identical seed. Timestamps stay
// out of the CSV by design (no created_at column); the manifest clock is
// injected. Reruns after a failed cleanup collide loudly on these PKs --
// clean the 0e-golden tenant manually if that ever happens.
const G = {
  user: "0e000000-0000-4000-8000-000000000001",
  tenant: "0e000000-0000-4000-8000-000000000002",
  profile: "0e000000-0000-4000-8000-000000000003",
  business: "0e000000-0000-4000-8000-000000000004",
  project: "0e000000-0000-4000-8000-000000000005",
  category: "0e000000-0000-4000-8000-000000000006",
  taxProfile: "0e000000-0000-4000-8000-000000000007",
  e1: "0e000000-0000-4000-8000-000000000010",
  e2: "0e000000-0000-4000-8000-000000000011",
  e3: "0e000000-0000-4000-8000-000000000012",
  e4: "0e000000-0000-4000-8000-000000000013",
  e5: "0e000000-0000-4000-8000-000000000014",
};

let postgresContainerId = "";
let runtimePassword = "";
let database: Kysely<AppDatabase>;
let storageRoot = "";
const knownTenantIds: string[] = [];

function runSql(sql: string) {
  return spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${runtimePassword}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      "expense_app_runtime",
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

function executeSql(sql: string): string {
  const result = runSql(sql);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function seedBusinessTenant(prefix: string, ids: {
  user: string; tenant: string; profile: string; business: string;
  project: string; category: string;
}): { userId: string; tenantId: string; profileId: string; businessId: string; projectId: string; categoryId: string } {
  executeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${ids.user}', '${prefix}-${ids.user.slice(0, 6)}@example.test', '0E User');
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${ids.tenant}', '0E Tenant', '${prefix}-${ids.tenant.slice(0, 6)}');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
    VALUES ('${ids.tenant}', '${ids.user}', 'owner');
    INSERT INTO app.personal_profiles (id, tenant_id, name)
    VALUES ('${ids.profile}', '${ids.tenant}', 'Personal');
    INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role)
    VALUES ('${ids.profile}', '${ids.tenant}', '${ids.user}', 'owner');
    INSERT INTO app.businesses (id, tenant_id, name, industry_code, timezone, base_currency)
    VALUES ('${ids.business}', '${ids.tenant}', 'Golden Bakery', 'restaurant', 'America/New_York', 'USD');
    INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role)
    VALUES ('${ids.business}', '${ids.tenant}', '${ids.user}', 'owner');
    INSERT INTO app.projects (id, tenant_id, business_id, name, client_name)
    VALUES ('${ids.project}', '${ids.tenant}', '${ids.business}', 'Golden Client', 'Acme');
    INSERT INTO app.spending_categories (id, tenant_id, name, color, icon)
    VALUES ('${ids.category}', '${ids.tenant}', 'Golden Supplies', '#ffffff', 'box');
  `);
  knownTenantIds.push(ids.tenant);
  return {
    userId: ids.user, tenantId: ids.tenant, profileId: ids.profile,
    businessId: ids.business, projectId: ids.project, categoryId: ids.category,
  };
}

describe.skipIf(!integrationEnabled)("Phase 0E reports and exports", () => {
  beforeAll(async () => {
    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as {
      readonly services: Record<
        string,
        { readonly environment?: Record<string, string | null> }
      >;
    };
    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    }).trim();
    runtimePassword =
      config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword) {
      throw new Error("Phase 0E PostgreSQL prerequisites are missing");
    }
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
    storageRoot = await mkdtemp(path.join(tmpdir(), `expense-tax-0e-${runKey}-`));
  });

  afterAll(async () => {
    if (postgresContainerId && runtimePassword) {
      executeSql(`DELETE FROM app.app_audit_events WHERE tenant_id = '${G.tenant}';`);
      // Idempotency records outlive tenants (keyed by actor+op+key, no FK):
      // without this, a rerun replays a bundle id whose row is gone.
      executeSql(`DELETE FROM app.idempotency_records WHERE actor_key = 'user:${G.user}';`);
      executeSql(`DELETE FROM app.tenants WHERE id = '${G.tenant}';`);
      executeSql(`DELETE FROM app.users WHERE id = '${G.user}';`);
      for (const tenantId of knownTenantIds) {
        executeSql(`DELETE FROM app.app_audit_events WHERE tenant_id = '${tenantId}';`);
      }
      executeSql(`DELETE FROM app.tenants WHERE slug LIKE '0e-${runKey}-%';`);
      executeSql(`DELETE FROM app.users WHERE primary_email LIKE '0e-${runKey}-%';`);
    }
    await database?.destroy();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  function domains() {
    const storage = createLocalStorageAdapter({
      rootDir: storageRoot,
      baseUrl: "http://127.0.0.1:8100",
      signingKey: `0e-test-signing-${runKey}`,
    });
    return {
      storage,
      expenseDomain: createExpenseDomain(database),
      taxDomain: createTaxDomain(database),
      exportsDomain: createExportsDomain(database, storage, { appVersion: "0.1.0" }),
    };
  }

  it("builds a tax report with buckets, review flags, and foreign accounting", async () => {
    const ids = {
      user: randomUUID(), tenant: randomUUID(), profile: randomUUID(),
      business: randomUUID(), project: randomUUID(), category: randomUUID(),
    };
    const t = seedBusinessTenant(`0e-${runKey}`, ids);
    const { expenseDomain, taxDomain, exportsDomain } = domains();

    const draftProfile = await taxDomain.createProfile({
      actorUserId: t.userId,
      tenantId: t.tenantId,
      businessId: t.businessId,
      request: { taxYear: 2025, accountingMethod: "cash" },
      requestId: `0e-${runKey}-profile`,
    });
    // Treatments require an active profile (domain rule, not test setup).
    const profile = await taxDomain.updateProfile({
      actorUserId: t.userId,
      tenantId: t.tenantId,
      businessId: t.businessId,
      taxYear: 2025,
      request: { expectedVersion: draftProfile.version, status: "active" },
      requestId: `0e-${runKey}-profile-activate`,
    });

    const e1 = await expenseDomain.createBusiness({
      actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId,
      request: {
        businessId: t.businessId, merchant: "Corner Deli", amount: "12.34",
        currency: "USD", incurredOn: "2025-03-01", projectId: t.projectId,
        spendingCategoryId: t.categoryId,
      },
      requestId: `0e-${runKey}-e1`,
    });
    await taxDomain.upsertTreatment({
      actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId,
      expenseId: e1.id,
      request: {
        businessTaxProfileId: profile.id, taxonomyVersionId: TAXONOMY_2025_ID,
        taxCategoryDefinitionId: MEALS_CATEGORY_ID, deductiblePercent: "50.00",
        reviewStatus: "reviewed",
      },
      requestId: `0e-${runKey}-t1`,
    });
    const e2 = await expenseDomain.createBusiness({
      actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId,
      request: {
        businessId: t.businessId, merchant: "Staples", amount: "100.00",
        currency: "USD", incurredOn: "2025-03-15",
      },
      requestId: `0e-${runKey}-e2`,
    });
    await taxDomain.upsertTreatment({
      actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId,
      expenseId: e2.id,
      request: {
        businessTaxProfileId: profile.id, taxonomyVersionId: TAXONOMY_2025_ID,
        taxCategoryDefinitionId: ADVERTISING_CATEGORY_ID, deductiblePercent: "100.00",
        reviewStatus: "unreviewed",
      },
      requestId: `0e-${runKey}-t2`,
    });
    await expenseDomain.createBusiness({
      actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId,
      request: {
        businessId: t.businessId, merchant: "NoTreat Co", amount: "50.00",
        currency: "USD", incurredOn: "2025-04-02",
      },
      requestId: `0e-${runKey}-e3`,
    });
    await expenseDomain.createBusiness({
      actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId,
      request: {
        businessId: t.businessId, merchant: "Euro Supplier", amount: "200.00",
        currency: "EUR", incurredOn: "2025-04-10",
      },
      requestId: `0e-${runKey}-e4`,
    });

    const report = await exportsDomain.getTaxReport({
      actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId, taxYear: 2025,
    });
    expect(report.baseCurrency).toBe("USD");
    expect(report.profile?.taxonomyVersionId).toBe(TAXONOMY_2025_ID);
    expect(report.totals).toMatchObject({
      // Sums ignore review state (review filtering is orthogonal):
      // 6.17 (meals 50%) + 100.00 (advertising 100%, unreviewed) + 0.00 untreated.
      currency: "USD", grossTotal: "162.34", deductibleTotal: "106.17", expenseCount: 3,
    });
    expect(report.totalsByCurrency).toHaveLength(2);
    expect(report.foreignCurrencySummary).toEqual({ excludedCount: 1, currencies: ["EUR"] });
    expect(report.review).toEqual({
      total: 4, treated: 2, reviewed: 1, unreviewed: 1, excluded: 0, missingTreatment: 2,
    });
    const meals = report.byCategory.find((row) => row.categoryCode === "meals");
    expect(meals).toMatchObject({ expenseCount: 1, grossTotal: "12.34", deductibleTotal: "6.17" });
    const uncategorized = report.byCategory.find((row) => row.categoryCode === null);
    expect(uncategorized?.expenseCount).toBe(1);
    expect(report.byMonth.map((row) => row.month)).toEqual(["2025-03", "2025-04"]);
  });

  it("builds a project cost report scoped to one business", async () => {
    const ids = {
      user: randomUUID(), tenant: randomUUID(), profile: randomUUID(),
      business: randomUUID(), project: randomUUID(), category: randomUUID(),
    };
    const t = seedBusinessTenant(`0e-${runKey}`, ids);
    const { expenseDomain, exportsDomain } = domains();
    await expenseDomain.createBusiness({
      actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId,
      request: {
        businessId: t.businessId, merchant: "Client lunch", amount: "45.00",
        currency: "USD", incurredOn: "2025-06-01", projectId: t.projectId,
        spendingCategoryId: t.categoryId,
      },
      requestId: `0e-${runKey}-p1`,
    });

    const report = await exportsDomain.getProjectCostReport({
      actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId,
      projectId: t.projectId,
    });
    expect(report.projectName).toBe("Golden Client");
    expect(report.totals).toMatchObject({ grossTotal: "45.00", expenseCount: 1 });
    expect(report.bySpendingCategory).toHaveLength(1);
    expect(report.bySpendingCategory[0]).toMatchObject({
      categoryName: "Golden Supplies", grossTotal: "45.00",
    });

    await expect(
      exportsDomain.getProjectCostReport({
        actorUserId: t.userId, tenantId: t.tenantId,
        businessId: randomUUID(), projectId: t.projectId,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "NOT_FOUND" });
  });

  it("refuses export creation without a tax profile and for viewers", async () => {
    const ids = {
      user: randomUUID(), tenant: randomUUID(), profile: randomUUID(),
      business: randomUUID(), project: randomUUID(), category: randomUUID(),
    };
    const t = seedBusinessTenant(`0e-${runKey}`, ids);
    const { exportsDomain } = domains();

    await expect(
      exportsDomain.createExportBundle({
        actorUserId: t.userId, tenantId: t.tenantId, businessId: t.businessId,
        taxYear: 2025, idempotencyKey: `0e-${runKey}-noprofile`, requestId: `0e-${runKey}-noprofile`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "NOT_FOUND" });

    // Viewers may read reports but never mint bundles.
    const viewerId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${viewerId}', '0e-${runKey}-viewer@example.test', 'Viewer');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${t.tenantId}', '${viewerId}', 'member');
      INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role)
      VALUES ('${t.businessId}', '${t.tenantId}', '${viewerId}', 'viewer');
    `);
    await expect(
      exportsDomain.createExportBundle({
        actorUserId: viewerId, tenantId: t.tenantId, businessId: t.businessId,
        taxYear: 2025, idempotencyKey: `0e-${runKey}-viewer`, requestId: `0e-${runKey}-viewer`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "FORBIDDEN" });
    const viewerReport = await exportsDomain.getTaxReport({
      actorUserId: viewerId, tenantId: t.tenantId, businessId: t.businessId, taxYear: 2025,
    });
    expect(viewerReport.review.total).toBe(0);
  });

  it("produces a byte-identical CSV + semantic manifest from a fixed seed", async () => {
    seedBusinessTenant("0e-golden", G);
    const { exportsDomain, storage } = domains();

    // Fixed profile ID via SQL: the domain mints random UUIDs, which would
    // leak nondeterminism into the manifest. Status active directly (the
    // draft->active promotion is covered by the domain-level tests above
    // using random ids).
    executeSql(`
      INSERT INTO app.business_tax_profiles
        (id, tenant_id, business_id, tax_year, taxonomy_version_id, accounting_method, status)
      VALUES
        ('${G.taxProfile}', '${G.tenant}', '${G.business}', 2025, '${TAXONOMY_2025_ID}', 'cash', 'active');
    `);
    const profile = { id: G.taxProfile, taxonomyVersionId: TAXONOMY_2025_ID };
    expect(profile.taxonomyVersionId).toBe(TAXONOMY_2025_ID);

    // Fixed expense IDs via direct SQL (the domain mints random UUIDs,
    // which would defeat byte-identical output).
    executeSql(`
      INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, business_id, merchant, description, amount, currency, incurred_on, source, status, archived_at)
      VALUES
        ('${G.e1}', '${G.tenant}', '${G.user}', '${G.business}', 'Corner Deli', 'Lunch', '12.34', 'USD', '2025-03-01', 'manual', 'ready', NULL),
        ('${G.e2}', '${G.tenant}', '${G.user}', '${G.business}', 'Staples', NULL, '100.00', 'USD', '2025-03-15', 'manual', 'draft', NULL),
        ('${G.e3}', '${G.tenant}', '${G.user}', '${G.business}', 'NoTreat Co', NULL, '50.00', 'USD', '2025-04-02', 'ocr', 'ready', NULL),
        ('${G.e4}', '${G.tenant}', '${G.user}', '${G.business}', 'Euro Supplier', NULL, '200.00', 'EUR', '2025-04-10', 'manual', 'ready', NULL),
        ('${G.e5}', '${G.tenant}', '${G.user}', '${G.business}', 'Old News', NULL, '999.99', 'USD', '2025-05-01', 'manual', 'archived', '2025-06-01T00:00:00Z');
      UPDATE app.expenses SET project_id = '${G.project}', spending_category_id = '${G.category}' WHERE id = '${G.e1}';
      INSERT INTO app.expense_tax_treatments
        (expense_id, tenant_id, business_id, tax_year, business_tax_profile_id, taxonomy_version_id, tax_category_definition_id, deductible_percent, review_status, created_by_user_id, updated_by_user_id)
      VALUES
        ('${G.e1}', '${G.tenant}', '${G.business}', 2025, '${profile.id}', '${TAXONOMY_2025_ID}', '${MEALS_CATEGORY_ID}', '50.00', 'reviewed', '${G.user}', '${G.user}'),
        ('${G.e2}', '${G.tenant}', '${G.business}', 2025, '${profile.id}', '${TAXONOMY_2025_ID}', '${ADVERTISING_CATEGORY_ID}', '100.00', 'unreviewed', '${G.user}', '${G.user}'),
        ('${G.e4}', '${G.tenant}', '${G.business}', 2025, '${profile.id}', '${TAXONOMY_2025_ID}', '${MEALS_CATEGORY_ID}', '100.00', 'reviewed', '${G.user}', '${G.user}');
    `);
    const fixedNow = new Date("2026-09-09T00:00:00.000Z");
    const created = await exportsDomain.createExportBundle({
      actorUserId: G.user, tenantId: G.tenant, businessId: G.business,
      taxYear: 2025, idempotencyKey: "0e-golden-bundle", requestId: "0e-golden-bundle",
      now: fixedNow,
    });
    expect(created.body.expenseCount).toBe(2);

    const bundleRow = await database
      .selectFrom("app.export_bundles")
      .selectAll()
      .where("id", "=", created.body.id)
      .executeTakeFirstOrThrow();
    const csvBytes = await storage.readObject(bundleRow.csv_storage_key);
    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const fixtureDir = new URL("../fixtures/", import.meta.url);
    if (process.env.WRITE_FIXTURES === "1") {
      // One-shot fixture authoring: run with WRITE_FIXTURES=1, inspect the
      // output by hand, commit it, then re-run normally. Never left on.
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(new URL("../fixtures/tax-export-canonical.csv", import.meta.url), csvBytes.toString("utf8"));
      await writeFile(
        new URL("../fixtures/tax-export-manifest.json", import.meta.url),
        `${JSON.stringify(
          { ...(bundleRow.manifest as Record<string, unknown>), bundleId: "BUNDLE" },
          null,
          2,
        )}\n`,
      );
    }
    const expectedCsv = await readFile(
      new URL("../fixtures/tax-export-canonical.csv", import.meta.url),
      "utf8",
    );
    expect(csvBytes.toString("utf8")).toBe(expectedCsv);

    const expectedManifest = JSON.parse(
      await readFile(new URL("../fixtures/tax-export-manifest.json", import.meta.url), "utf8"),
    );
    const normalize = (manifest: unknown) => ({
      ...(manifest as Record<string, unknown>),
      bundleId: "BUNDLE",
    });
    expect(normalize(bundleRow.manifest)).toEqual({
      ...expectedManifest,
      bundleId: "BUNDLE",
    });

    // The stored manifest.json file must parse to the same semantic
    // content (its byte order differs: Postgres jsonb normalizes object
    // key order on read-back, so byte-identity is only claimed for the
    // CSV — the money artifact).
    const storedManifestBytes = await storage.readObject(
      bundleRow.manifest_storage_key,
    );
    expect(normalize(JSON.parse(storedManifestBytes.toString("utf8")))).toEqual({
      ...expectedManifest,
      bundleId: "BUNDLE",
    });

    // Idempotent replay: same key returns the same bundle, no second row.
    const replay = await exportsDomain.createExportBundle({
      actorUserId: G.user, tenantId: G.tenant, businessId: G.business,
      taxYear: 2025, idempotencyKey: "0e-golden-bundle", requestId: "0e-golden-replay",
      now: fixedNow,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.body.id).toBe(created.body.id);
    expect(
      executeSql(`SELECT count(*) FROM app.export_bundles WHERE business_id = '${G.business}';`),
    ).toBe("1");
  });
});
