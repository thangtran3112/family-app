import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createExpenseDomain } from "../../services/app-api/src/domain/expenses.js";
import { createTaxDomain } from "../../services/app-api/src/domain/tax.js";
import { DomainError } from "../../services/app-api/src/errors.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0J_WAVE3_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);

let postgresContainerId = "";
let runtimePassword = "";
let database: Kysely<AppDatabase>;

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

function runSql(sql: string): CommandResult {
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

function expectConstraint(sql: string, constraintName: string): void {
  const result = runSql(sql);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(constraintName);
}

function seedScope(userId: string, tenantId: string, businessId: string): void {
  executeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${userId}', 'wave3-${runKey}-${userId.slice(0, 6)}@example.test', 'Wave 3 User');
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${tenantId}', 'Wave 3 Tenant', 'wave3-${runKey}-${tenantId.slice(0, 6)}');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
    VALUES ('${tenantId}', '${userId}', 'owner');
    INSERT INTO app.businesses
      (id, tenant_id, name, industry_code, timezone, base_currency)
    VALUES ('${businessId}', '${tenantId}', 'Wave 3 Business', 'restaurant', 'UTC', 'USD');
    INSERT INTO app.business_memberships
      (business_id, tenant_id, user_id, role)
    VALUES ('${businessId}', '${tenantId}', '${userId}', 'owner');
  `);
}

describe.skipIf(!integrationEnabled)("Phase 0J Wave 3 database schema", () => {
  beforeAll(() => {
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
    runtimePassword =
      config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword) {
      throw new Error("Phase 0J Wave 3 PostgreSQL prerequisites are missing");
    }
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
  });

  afterAll(async () => {
    if (!postgresContainerId || !runtimePassword) return;
    runSql(`DELETE FROM app.tenants WHERE slug LIKE 'wave3-${runKey}-%';`);
    runSql(`DELETE FROM app.users WHERE primary_email LIKE 'wave3-${runKey}-%';`);
    await database.destroy();
  });

  it("creates expense and taxonomy tables", () => {
    expect(
      executeSql(`
        SELECT string_agg(name, ',' ORDER BY name)
        FROM unnest(ARRAY[
          'app.expenses',
          'app.tax_category_definitions',
          'app.taxonomy_versions'
        ]) AS name
        WHERE to_regclass(name) IS NOT NULL;
      `),
    ).toBe("app.expenses,app.tax_category_definitions,app.taxonomy_versions");
  });

  it("seeds the finalized 2025 Schedule C taxonomy", () => {
    expect(
      executeSql(`
        SELECT concat(jurisdiction_code, ':', tax_year, ':', code, ':', source_revision)
        FROM app.taxonomy_versions
        WHERE jurisdiction_code = 'US-FEDERAL' AND tax_year = 2025;
      `),
    ).toBe("US-FEDERAL:2025:schedule-c-2025:2025-final");
    expect(
      executeSql(`
        SELECT count(*)
        FROM app.tax_category_definitions definition
        INNER JOIN app.taxonomy_versions version
          ON version.id = definition.taxonomy_version_id
        WHERE version.tax_year = 2025;
      `),
    ).toBe("24");
    expect(
      executeSql(`
        SELECT source_url FROM app.taxonomy_versions
        WHERE tax_year = 2025;
      `),
    ).toBe("https://www.irs.gov/forms-pubs/about-schedule-c-form-1040");
  });

  it("enforces exclusive expense scope and generated tax year", () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    const categoryId = randomUUID();
    seedScope(userId, tenantId, businessId);
    executeSql(`
      INSERT INTO app.spending_categories
        (id, tenant_id, name, color, icon)
      VALUES ('${categoryId}', '${tenantId}', 'Food', '#2563EB', 'basket');
    `);

    expectConstraint(
      `INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, merchant, amount, currency, incurred_on)
       VALUES ('${randomUUID()}', '${tenantId}', '${userId}', 'Unscoped', 10.00, 'USD', '2025-03-01');`,
      "expenses_scope_check",
    );
    expectConstraint(
      `INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
         merchant, amount, currency, incurred_on)
       VALUES ('${randomUUID()}', '${tenantId}', '${userId}', '${randomUUID()}',
         '${businessId}', 'Ambiguous', 10.00, 'USD', '2025-03-01');`,
      "expenses_scope_check",
    );
    executeSql(`
      INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, business_id, spending_category_id,
         merchant, amount, currency, incurred_on, status)
      VALUES ('${randomUUID()}', '${tenantId}', '${userId}', '${businessId}', '${categoryId}',
        'Valid', 10.00, 'USD', '2025-03-01', 'ready');
    `);
    expect(
      executeSql(`
        SELECT tax_year FROM app.expenses
        WHERE tenant_id = '${tenantId}' AND merchant = 'Valid';
      `),
    ).toBe("2025");
  });

  it("rejects personal projects and cross-scope references", () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    const projectId = randomUUID();
    seedScope(userId, tenantId, businessId);
    executeSql(`
      INSERT INTO app.projects
        (id, tenant_id, business_id, name)
      VALUES ('${projectId}', '${tenantId}', '${businessId}', 'Job');
    `);
    expectConstraint(
      `INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, personal_profile_id, project_id,
         merchant, amount, currency, incurred_on)
       VALUES ('${randomUUID()}', '${tenantId}', '${userId}', '${randomUUID()}',
         '${projectId}', 'Personal Job', 10.00, 'USD', '2025-03-01');`,
      "expenses_personal_project_check",
    );
    expectConstraint(
      `INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, business_id, project_id,
         merchant, amount, currency, incurred_on)
       VALUES ('${randomUUID()}', '${tenantId}', '${userId}', '${businessId}',
         '${randomUUID()}', 'Foreign Job', 10.00, 'USD', '2025-03-01');`,
      "expenses_project_business_fk",
    );
  });

  it("creates tax profiles and singleton business treatments", () => {
    expect(
      executeSql(`
        SELECT string_agg(name, ',' ORDER BY name)
        FROM unnest(ARRAY[
          'app.business_tax_profiles',
          'app.expense_tax_treatments'
        ]) AS name
        WHERE to_regclass(name) IS NOT NULL;
      `),
    ).toBe("app.business_tax_profiles,app.expense_tax_treatments");
    const userId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    const expenseId = randomUUID();
    const profileId = randomUUID();
    seedScope(userId, tenantId, businessId);
    executeSql(`
      INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, business_id, merchant, amount,
         currency, incurred_on, status)
      VALUES ('${expenseId}', '${tenantId}', '${userId}', '${businessId}',
        'Business Expense', 20.00, 'USD', '2025-04-01', 'ready');
      INSERT INTO app.business_tax_profiles
        (id, tenant_id, business_id, tax_year, taxonomy_version_id,
         tax_form, accounting_method, status)
      VALUES ('${profileId}', '${tenantId}', '${businessId}', 2025,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'schedule_c', 'cash', 'active');
      INSERT INTO app.expense_tax_treatments
        (expense_id, tenant_id, business_id, tax_year, business_tax_profile_id,
         taxonomy_version_id, tax_category_definition_id, deductible_percent,
         review_status, created_by_user_id, updated_by_user_id)
      VALUES ('${expenseId}', '${tenantId}', '${businessId}', 2025, '${profileId}',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 75.00, 'reviewed',
        '${userId}', '${userId}');
    `);
    expectConstraint(
      `INSERT INTO app.business_tax_profiles
        (id, tenant_id, business_id, tax_year, taxonomy_version_id,
         tax_form, accounting_method, status)
       VALUES ('${randomUUID()}', '${tenantId}', '${businessId}', 2025,
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'schedule_c', 'cash', 'draft');`,
      "business_tax_profiles_business_year_unique",
    );
    expectConstraint(
      `INSERT INTO app.expense_tax_treatments
        (expense_id, tenant_id, business_id, tax_year, business_tax_profile_id,
         taxonomy_version_id, tax_category_definition_id, deductible_percent,
         review_status, created_by_user_id, updated_by_user_id)
       VALUES ('${expenseId}', '${tenantId}', '${businessId}', 2025, '${profileId}',
         'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 50.00, 'reviewed',
         '${userId}', '${userId}');`,
      "expense_tax_treatments_pkey",
    );
  });

  it("enforces expense membership lifecycle for Personal and business scopes", async () => {
    const ownerId = randomUUID();
    const viewerId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    const profileId = randomUUID();
    seedScope(ownerId, tenantId, businessId);
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${viewerId}', 'wave3-${runKey}-viewer@example.test', 'Viewer');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${tenantId}', '${viewerId}', 'member');
      INSERT INTO app.personal_profiles (id, tenant_id, name)
      VALUES ('${profileId}', '${tenantId}', 'Personal');
      INSERT INTO app.personal_memberships
        (personal_profile_id, tenant_id, user_id, role)
      VALUES ('${profileId}', '${tenantId}', '${ownerId}', 'owner');
      INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role)
      VALUES ('${businessId}', '${tenantId}', '${viewerId}', 'viewer');
    `);
    const domain = createExpenseDomain(database);
    const personal = await domain.createPersonal({
      actorUserId: ownerId,
      tenantId,
      profileId,
      request: {
        personalProfileId: profileId,
        merchant: "Personal Market",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      },
      requestId: `wave3-${runKey}-personal-create`,
    });
    const business = await domain.createBusiness({
      actorUserId: ownerId,
      tenantId,
      businessId,
      request: {
        businessId,
        merchant: "Business Supplier",
        amount: "25.00",
        currency: "USD",
        incurredOn: "2025-04-01",
      },
      requestId: `wave3-${runKey}-business-create`,
    });
    expect(personal.taxYear).toBe(2025);
    expect(business.businessId).toBe(businessId);
    expect(
      await domain.listBusiness({
        actorUserId: viewerId,
        tenantId,
        businessId,
        query: {
          sort: "incurredOn",
          direction: "desc",
          limit: 50,
        },
      }),
    ).toMatchObject({ items: [business], nextCursor: null });
    const updated = await domain.updateBusiness({
      actorUserId: ownerId,
      tenantId,
      businessId,
      expenseId: business.id,
      request: { expectedVersion: 1, merchant: "Updated Supplier" },
      requestId: `wave3-${runKey}-business-update`,
    });
    expect(updated).toMatchObject({ merchant: "Updated Supplier", version: 2 });
    await expect(
      domain.updateBusiness({
        actorUserId: viewerId,
        tenantId,
        businessId,
        expenseId: business.id,
        request: { expectedVersion: 2, merchant: "Viewer Update" },
        requestId: `wave3-${runKey}-viewer-update`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "FORBIDDEN" });
    await domain.archiveBusiness({
      actorUserId: ownerId,
      tenantId,
      businessId,
      expenseId: business.id,
      request: { expectedVersion: 2 },
      requestId: `wave3-${runKey}-business-archive`,
    });
    expect(
      await domain.listBusiness({
        actorUserId: viewerId,
        tenantId,
        businessId,
        query: { sort: "incurredOn", direction: "desc", limit: 50 },
      }),
    ).toEqual({ items: [], nextCursor: null });
  });

  it("activates exact-year tax profile and aligns treatment to business expense", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    const expenseId = randomUUID();
    seedScope(userId, tenantId, businessId);
    executeSql(`
      INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, business_id, merchant, amount,
         currency, incurred_on, status)
      VALUES ('${expenseId}', '${tenantId}', '${userId}', '${businessId}',
        'Tax Expense', 30.00, 'USD', '2025-06-01', 'ready');
    `);
    const domain = createTaxDomain(database);
    const created = await domain.createProfile({
      actorUserId: userId,
      tenantId,
      businessId,
      request: { taxYear: 2025, accountingMethod: "cash" },
      requestId: `wave3-${runKey}-profile-create`,
    });
    expect(created).toMatchObject({ taxYear: 2025, status: "draft" });
    const active = await domain.updateProfile({
      actorUserId: userId,
      tenantId,
      businessId,
      taxYear: 2025,
      request: { expectedVersion: 1, status: "active" },
      requestId: `wave3-${runKey}-profile-activate`,
    });
    expect(active.status).toBe("active");
    const treatment = await domain.upsertTreatment({
      actorUserId: userId,
      tenantId,
      businessId,
      expenseId,
      request: {
        businessTaxProfileId: created.id,
        taxonomyVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        taxCategoryDefinitionId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
        deductiblePercent: "75.00",
        reviewStatus: "reviewed",
        note: null,
      },
      requestId: `wave3-${runKey}-treatment-upsert`,
    });
    expect(treatment).toMatchObject({ expenseId, taxYear: 2025, deductiblePercent: "75.00" });
  });
});
