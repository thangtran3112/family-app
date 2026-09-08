import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createBusinessDomain } from "../../services/app-api/src/domain/businesses.js";
import { createMembershipDomain } from "../../services/app-api/src/domain/memberships.js";
import { createSpendingCategoryDomain } from "../../services/app-api/src/domain/spending-categories.js";
import { createProjectDomain } from "../../services/app-api/src/domain/projects.js";
import { DomainError } from "../../services/app-api/src/errors.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0J_WAVE2_INTEGRATION === "1";
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

describe.skipIf(!integrationEnabled)("Phase 0J Wave 2 database schema", () => {
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
      throw new Error("Phase 0J Wave 2 PostgreSQL prerequisites are missing");
    }
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5432/expense_tax_db`,
    );
  });

  afterAll(async () => {
    if (!postgresContainerId || !runtimePassword) return;
    runSql(`DELETE FROM app.tenants WHERE slug LIKE 'wave2-${runKey}-%';`);
    runSql(`DELETE FROM app.users WHERE primary_email LIKE 'wave2-${runKey}-%';`);
    runSql(`DELETE FROM app.app_audit_events WHERE request_id LIKE 'wave2-${runKey}-%';`);
    runSql(
      `DELETE FROM app.idempotency_records WHERE idempotency_key LIKE 'wave2-${runKey}-%';`,
    );
    await database.destroy();
  });

  it("creates all Wave 2 tables and invitation grant columns", () => {
    expect(
      executeSql(`
        SELECT string_agg(name, ',' ORDER BY name)
        FROM unnest(ARRAY[
          'app.business_industries',
          'app.business_memberships',
          'app.businesses',
          'app.industry_spending_category_templates',
          'app.projects',
          'app.spending_categories',
          'app.spending_category_templates'
        ]) AS name
        WHERE to_regclass(name) IS NOT NULL;
      `),
    ).toBe(
      "app.businesses,app.business_industries,app.business_memberships,app.industry_spending_category_templates,app.projects,app.spending_categories,app.spending_category_templates",
    );
    expect(
      executeSql(`
        SELECT string_agg(column_name, ',' ORDER BY column_name)
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = 'tenant_invitations'
          AND column_name IN ('business_id', 'business_role');
      `),
    ).toBe("business_id,business_role");
    expect(
      executeSql(`
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'projects'
          AND column_name LIKE '%tax%';
      `),
    ).toBe("0");
  });

  it("seeds exact stable industries and category templates once", () => {
    expect(
      executeSql("SELECT string_agg(code, ',' ORDER BY code) FROM app.business_industries;"),
    ).toBe("construction,daycare,grocery,restaurant,salon");
    expect(
      executeSql(
        "SELECT string_agg(template_key, ',' ORDER BY template_key) FROM app.spending_category_templates;",
      ),
    ).toBe(
      "beauty-supplies,beverages,booking-fees,booth-equipment,building-materials,cleaning-safety,delivery-fees,equipment-maintenance,equipment-rental,food-inventory,jobsite-supplies,kitchen-supplies,learning-supplies,licensing,licensing-training,linens-laundry,meals-snacks,packaging,permits-inspections,refrigeration-maintenance,resale-inventory,store-supplies,subcontractors,toys-equipment",
    );
    expect(
      executeSql(
        "SELECT count(*) FROM app.industry_spending_category_templates;",
      ),
    ).toBe("25");
    expect(
      executeSql(`
        SELECT string_agg(industry_code || ':' || mapping_count, ',' ORDER BY industry_code)
        FROM (
          SELECT industry_code, count(*)::text AS mapping_count
          FROM app.industry_spending_category_templates
          GROUP BY industry_code
        ) counts;
      `),
    ).toBe("construction:5,daycare:5,grocery:5,restaurant:5,salon:5");
    expect(
      executeSql(`
        SELECT string_agg(template_key, ',' ORDER BY sort_order)
        FROM app.industry_spending_category_templates
        WHERE industry_code = 'restaurant';
      `),
    ).toBe(
      "food-inventory,beverages,kitchen-supplies,delivery-fees,equipment-maintenance",
    );
    expect(
      executeSql(`
        SELECT count(*)
        FROM (
          SELECT code FROM app.business_industries GROUP BY code HAVING count(*) > 1
          UNION ALL
          SELECT template_key FROM app.spending_category_templates GROUP BY template_key HAVING count(*) > 1
          UNION ALL
          SELECT industry_code || ':' || template_key
          FROM app.industry_spending_category_templates
          GROUP BY industry_code, template_key
          HAVING count(*) > 1
        ) duplicates;
      `),
    ).toBe("0");
  });

  it("enforces industry and tenant-safe business references", () => {
    const userId = randomUUID();
    const firstTenantId = randomUUID();
    const secondTenantId = randomUUID();
    const businessId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${userId}', 'wave2-${runKey}-refs@example.test', 'Wave 2 User');
      INSERT INTO app.tenants (id, name, slug) VALUES
        ('${firstTenantId}', 'First Tenant', 'wave2-${runKey}-refs-a'),
        ('${secondTenantId}', 'Second Tenant', 'wave2-${runKey}-refs-b');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES
        ('${businessId}', '${firstTenantId}', 'Cafe', 'restaurant', 'America/New_York', 'USD');
    `);

    expectConstraint(
      `INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
       VALUES
        ('${randomUUID()}', '${firstTenantId}', 'Unknown', 'unknown', 'UTC', 'USD');`,
      "businesses_industry_fk",
    );
    expectConstraint(
      `INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role)
       VALUES ('${businessId}', '${secondTenantId}', '${userId}', 'viewer');`,
      "business_memberships_business_tenant_fk",
    );
    expectConstraint(
      `INSERT INTO app.projects
        (id, tenant_id, business_id, name)
       VALUES ('${randomUUID()}', '${secondTenantId}', '${businessId}', 'Wrong Tenant');`,
      "projects_business_tenant_fk",
    );
    expectConstraint(
      `INSERT INTO app.industry_spending_category_templates
        (industry_code, template_key, sort_order)
       VALUES ('restaurant', 'food-inventory', 1);`,
      "industry_spending_category_templates_pkey",
    );
  });

  it("enforces one template category per tenant and one invitation grant scope", () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const profileId = randomUUID();
    const businessId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${userId}', 'wave2-${runKey}-unique@example.test', 'Wave 2 User');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Unique Tenant', 'wave2-${runKey}-unique');
      INSERT INTO app.personal_profiles (id, tenant_id, name)
      VALUES ('${profileId}', '${tenantId}', 'Personal');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES ('${businessId}', '${tenantId}', 'Cafe', 'restaurant', 'UTC', 'USD');
      INSERT INTO app.spending_categories
        (id, tenant_id, template_key, name, color, icon)
      VALUES ('${randomUUID()}', '${tenantId}', 'food-inventory', 'Supplies', '#2563EB', 'package');
    `);

    expectConstraint(
      `INSERT INTO app.spending_categories
        (id, tenant_id, template_key, name, color, icon)
       VALUES ('${randomUUID()}', '${tenantId}', 'beverages', ' supplies ', '#2563EB', 'package');`,
      "spending_categories_active_normalized_name_unique",
    );
    executeSql(`
      UPDATE app.spending_categories
      SET status = 'archived', archived_at = now()
      WHERE tenant_id = '${tenantId}' AND name = 'Supplies';
    `);
    executeSql(`
      INSERT INTO app.spending_categories
        (id, tenant_id, template_key, name, color, icon)
      VALUES ('${randomUUID()}', '${tenantId}', 'beverages', ' supplies ', '#2563EB', 'package');
    `);
    expectConstraint(
      `INSERT INTO app.spending_categories
        (id, tenant_id, template_key, name, color, icon)
       VALUES ('${randomUUID()}', '${tenantId}', 'beverages', 'Other Supplies', '#2563EB', 'package');`,
      "spending_categories_tenant_template_unique",
    );
    expectConstraint(
      `INSERT INTO app.tenant_invitations
        (id, tenant_id, normalized_email, tenant_role, personal_profile_id,
         personal_role, business_id, business_role, token_hash, expires_at,
         created_by_user_id)
       VALUES
        ('${randomUUID()}', '${tenantId}', 'wave2-${runKey}-invite@example.test',
         'member', '${profileId}', 'viewer', '${businessId}', 'viewer',
         '${"c".repeat(64)}', now() + interval '7 days', '${userId}');`,
      "tenant_invitations_single_grant_check",
    );
  });

  it("creates business owner state and tenant categories idempotently", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${userId}', 'wave2-${runKey}-bootstrap@example.test', 'Business Owner');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Bootstrap Tenant', 'wave2-${runKey}-bootstrap');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${tenantId}', '${userId}', 'owner');
    `);
    const domain = createBusinessDomain(database);
    const input = {
      actorUserId: userId,
      tenantId,
      request: {
        name: "Corner Cafe",
        industryCode: "restaurant",
        timezone: "America/New_York",
        baseCurrency: "USD",
      },
      idempotencyKey: `wave2-${runKey}-business-create`,
      requestId: `wave2-${runKey}-business-create`,
    };

    const created = await domain.create(input);
    const replayed = await domain.create({
      ...input,
      requestId: `wave2-${runKey}-business-replay`,
    });
    const secondBusiness = await domain.create({
      ...input,
      request: { ...input.request, name: "Second Cafe" },
      idempotencyKey: `wave2-${runKey}-business-second`,
      requestId: `wave2-${runKey}-business-second`,
    });
    const groceryBusiness = await domain.create({
      ...input,
      request: {
        ...input.request,
        name: "Neighborhood Grocery",
        industryCode: "grocery",
      },
      idempotencyKey: `wave2-${runKey}-business-grocery`,
      requestId: `wave2-${runKey}-business-grocery`,
    });

    expect(created.body.businessMembership).toMatchObject({
      userId,
      role: "owner",
      status: "active",
    });
    expect(created.body.createdSpendingCategories).toHaveLength(5);
    expect(replayed.body).toEqual(created.body);
    expect(replayed.replayed).toBe(true);
    expect(secondBusiness.body.createdSpendingCategories).toHaveLength(0);
    expect(groceryBusiness.body.createdSpendingCategories).toHaveLength(4);
    expect(
      executeSql(
        `SELECT count(*) FROM app.spending_categories WHERE tenant_id = '${tenantId}';`,
      ),
    ).toBe("9");
  });

  it("requires active tenant and business memberships for visibility", async () => {
    const ownerId = randomUUID();
    const viewerId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${ownerId}', 'wave2-${runKey}-visibility-owner@example.test', 'Owner'),
        ('${viewerId}', 'wave2-${runKey}-visibility-viewer@example.test', 'Viewer');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Visibility Tenant', 'wave2-${runKey}-visibility');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role) VALUES
        ('${tenantId}', '${ownerId}', 'owner'),
        ('${tenantId}', '${viewerId}', 'member');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES ('${businessId}', '${tenantId}', 'Cafe', 'restaurant', 'UTC', 'USD');
      INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role)
      VALUES ('${businessId}', '${tenantId}', '${viewerId}', 'viewer');
    `);
    const domain = createBusinessDomain(database);

    expect(await domain.list(ownerId, tenantId)).toEqual([]);
    expect(await domain.list(viewerId, tenantId)).toHaveLength(1);
    executeSql(`
      UPDATE app.tenant_memberships
      SET status = 'inactive'
      WHERE tenant_id = '${tenantId}' AND user_id = '${viewerId}';
    `);
    expect(await domain.list(viewerId, tenantId)).toEqual([]);
  });

  it("enforces optimistic business updates and blocks archived writes", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${userId}', 'wave2-${runKey}-versions@example.test', 'Owner');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Version Tenant', 'wave2-${runKey}-versions');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${tenantId}', '${userId}', 'owner');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES ('${businessId}', '${tenantId}', 'Cafe', 'restaurant', 'UTC', 'USD');
      INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role)
      VALUES ('${businessId}', '${tenantId}', '${userId}', 'owner');
    `);
    const domain = createBusinessDomain(database);

    const updated = await domain.update({
      actorUserId: userId,
      tenantId,
      businessId,
      request: { expectedVersion: 1, name: "Updated Cafe" },
      requestId: `wave2-${runKey}-business-update`,
    });
    expect(updated).toMatchObject({ name: "Updated Cafe", version: 2 });
    await expect(
      domain.update({
        actorUserId: userId,
        tenantId,
        businessId,
        request: { expectedVersion: 1, name: "Stale Cafe" },
        requestId: `wave2-${runKey}-business-stale`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
    await domain.archive({
      actorUserId: userId,
      tenantId,
      businessId,
      request: { expectedVersion: 2 },
      requestId: `wave2-${runKey}-business-archive`,
    });
    await expect(
      domain.update({
        actorUserId: userId,
        tenantId,
        businessId,
        request: { expectedVersion: 3, name: "Archived Cafe" },
        requestId: `wave2-${runKey}-business-archived-update`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
  });

  it("allows only business owners to administer tenant-member grants", async () => {
    const ownerId = randomUUID();
    const tenantAdminId = randomUUID();
    const targetId = randomUUID();
    const outsiderId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${ownerId}', 'wave2-${runKey}-membership-owner@example.test', 'Owner'),
        ('${tenantAdminId}', 'wave2-${runKey}-membership-admin@example.test', 'Admin'),
        ('${targetId}', 'wave2-${runKey}-membership-target@example.test', 'Target'),
        ('${outsiderId}', 'wave2-${runKey}-membership-outsider@example.test', 'Outsider');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Membership Tenant', 'wave2-${runKey}-membership');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role) VALUES
        ('${tenantId}', '${ownerId}', 'owner'),
        ('${tenantId}', '${tenantAdminId}', 'admin'),
        ('${tenantId}', '${targetId}', 'member');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES ('${businessId}', '${tenantId}', 'Cafe', 'restaurant', 'UTC', 'USD');
      INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role)
      VALUES ('${businessId}', '${tenantId}', '${ownerId}', 'owner');
    `);
    const domain = createMembershipDomain(database, { error() {} });

    const created = await domain.createBusinessMembership({
      actorUserId: ownerId,
      tenantId,
      businessId,
      request: { userId: targetId, role: "viewer" },
      requestId: `wave2-${runKey}-business-membership-create`,
    });
    expect(created).toMatchObject({ userId: targetId, role: "viewer" });
    expect(await domain.listBusinessMemberships({ actorUserId: ownerId, tenantId, businessId })).toHaveLength(2);
    await expect(
      domain.createBusinessMembership({
        actorUserId: ownerId,
        tenantId,
        businessId,
        request: { userId: targetId, role: "editor" },
        requestId: `wave2-${runKey}-business-membership-duplicate`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
    await expect(
      domain.createBusinessMembership({
        actorUserId: ownerId,
        tenantId,
        businessId,
        request: { userId: outsiderId, role: "viewer" },
        requestId: `wave2-${runKey}-business-membership-outsider`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "NOT_FOUND" });
    await expect(
      domain.listBusinessMemberships({
        actorUserId: tenantAdminId,
        tenantId,
        businessId,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "FORBIDDEN" });
  });

  it("serializes concurrent business owner deactivation", async () => {
    const firstOwnerId = randomUUID();
    const secondOwnerId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${firstOwnerId}', 'wave2-${runKey}-concurrent-a@example.test', 'Owner A'),
        ('${secondOwnerId}', 'wave2-${runKey}-concurrent-b@example.test', 'Owner B');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Concurrent Tenant', 'wave2-${runKey}-concurrent');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role) VALUES
        ('${tenantId}', '${firstOwnerId}', 'owner'),
        ('${tenantId}', '${secondOwnerId}', 'owner');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES ('${businessId}', '${tenantId}', 'Cafe', 'restaurant', 'UTC', 'USD');
      INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role) VALUES
        ('${businessId}', '${tenantId}', '${firstOwnerId}', 'owner'),
        ('${businessId}', '${tenantId}', '${secondOwnerId}', 'owner');
    `);
    const domain = createMembershipDomain(database, { error() {} });

    const results = await Promise.allSettled([
      domain.updateBusinessMembership({
        actorUserId: firstOwnerId,
        tenantId,
        businessId,
        targetUserId: firstOwnerId,
        request: { expectedVersion: 1, status: "inactive" },
        requestId: `wave2-${runKey}-concurrent-a`,
      }),
      domain.updateBusinessMembership({
        actorUserId: secondOwnerId,
        tenantId,
        businessId,
        targetUserId: secondOwnerId,
        request: { expectedVersion: 1, status: "inactive" },
        requestId: `wave2-${runKey}-concurrent-b`,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      executeSql(`
        SELECT count(*) FROM app.business_memberships
        WHERE business_id = '${businessId}' AND role = 'owner' AND status = 'active';
      `),
    ).toBe("1");
  });

  it("accepts business-only invitations without granting Personal access", async () => {
    const ownerId = randomUUID();
    const adminId = randomUUID();
    const inviteeId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    const profileId = randomUUID();
    const inviteeEmail = `wave2-${runKey}-business-invitee@example.test`;
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${ownerId}', 'wave2-${runKey}-invite-owner@example.test', 'Owner'),
        ('${adminId}', 'wave2-${runKey}-invite-admin@example.test', 'Admin'),
        ('${inviteeId}', '${inviteeEmail}', 'Invitee');
      INSERT INTO app.auth_identities
        (id, user_id, issuer, subject, verified_email, email_verified)
      VALUES
        ('${randomUUID()}', '${inviteeId}', 'https://identity.test',
         'wave2-${runKey}-invitee', '${inviteeEmail}', true);
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Invitation Tenant', 'wave2-${runKey}-invitation');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role) VALUES
        ('${tenantId}', '${ownerId}', 'owner'),
        ('${tenantId}', '${adminId}', 'admin');
      INSERT INTO app.personal_profiles (id, tenant_id, name)
      VALUES ('${profileId}', '${tenantId}', 'Personal');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES ('${businessId}', '${tenantId}', 'Cafe', 'restaurant', 'UTC', 'USD');
      INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role)
      VALUES ('${businessId}', '${tenantId}', '${ownerId}', 'owner');
    `);
    const domain = createMembershipDomain(database, { error() {} });
    const request = {
      email: inviteeEmail,
      tenantRole: "member" as const,
      grant: { type: "business" as const, businessId, role: "viewer" as const },
    };

    await expect(
      domain.createInvitation({
        actorUserId: adminId,
        tenantId,
        request,
        requestId: `wave2-${runKey}-business-invite-admin`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "FORBIDDEN" });
    const created = await domain.createInvitation({
      actorUserId: ownerId,
      tenantId,
      request,
      requestId: `wave2-${runKey}-business-invite-create`,
    });
    expect(created.invitation.grant).toEqual({
      type: "business",
      businessId,
      role: "viewer",
    });
    expect(
      executeSql(`
        SELECT count(*) FROM app.tenant_invitations
        WHERE id = '${created.invitation.id}'
          AND token_hash <> '${created.invitationToken}'
          AND business_id = '${businessId}'
          AND personal_profile_id IS NULL;
      `),
    ).toBe("1");

    const accepted = await domain.acceptInvitation({
      actorUserId: inviteeId,
      request: { token: created.invitationToken },
      requestId: `wave2-${runKey}-business-invite-accept`,
    });
    const replayed = await domain.acceptInvitation({
      actorUserId: inviteeId,
      request: { token: created.invitationToken },
      requestId: `wave2-${runKey}-business-invite-replay`,
    });
    expect(accepted.body.grant).toEqual(created.invitation.grant);
    expect(replayed.replayed).toBe(true);
    expect(
      executeSql(`
        SELECT concat(
          (SELECT count(*) FROM app.tenant_memberships
           WHERE tenant_id = '${tenantId}' AND user_id = '${inviteeId}' AND status = 'active'),
          ',',
          (SELECT count(*) FROM app.business_memberships
           WHERE business_id = '${businessId}' AND user_id = '${inviteeId}'
             AND role = 'viewer' AND status = 'active'),
          ',',
          (SELECT count(*) FROM app.personal_memberships
           WHERE personal_profile_id = '${profileId}' AND user_id = '${inviteeId}')
        );
      `),
    ).toBe("1,1,0");
  });

  it("rejects acceptance after invited business is archived", async () => {
    const ownerId = randomUUID();
    const inviteeId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    const inviteeEmail = `wave2-${runKey}-archived-invitee@example.test`;
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${ownerId}', 'wave2-${runKey}-archived-owner@example.test', 'Owner'),
        ('${inviteeId}', '${inviteeEmail}', 'Invitee');
      INSERT INTO app.auth_identities
        (id, user_id, issuer, subject, verified_email, email_verified)
      VALUES ('${randomUUID()}', '${inviteeId}', 'https://identity.test',
        'wave2-${runKey}-archived-invitee', '${inviteeEmail}', true);
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Archived Invitation Tenant', 'wave2-${runKey}-archived-invitation');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${tenantId}', '${ownerId}', 'owner');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES ('${businessId}', '${tenantId}', 'Cafe', 'restaurant', 'UTC', 'USD');
      INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role)
      VALUES ('${businessId}', '${tenantId}', '${ownerId}', 'owner');
    `);
    const domain = createMembershipDomain(database, { error() {} });
    const created = await domain.createInvitation({
      actorUserId: ownerId,
      tenantId,
      request: {
        email: inviteeEmail,
        tenantRole: "member",
        grant: { type: "business", businessId, role: "viewer" },
      },
      requestId: `wave2-${runKey}-archived-invite-create`,
    });
    executeSql(`
      UPDATE app.businesses
      SET status = 'archived', archived_at = now()
      WHERE id = '${businessId}';
    `);

    await expect(
      domain.acceptInvitation({
        actorUserId: inviteeId,
        request: { token: created.invitationToken },
        requestId: `wave2-${runKey}-archived-invite-accept`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
  });

  it("enforces tenant-scoped spending category lifecycle", async () => {
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const tenantId = randomUUID();
    const foreignTenantId = randomUUID();
    const foreignCategoryId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${ownerId}', 'wave2-${runKey}-category-owner@example.test', 'Owner'),
        ('${memberId}', 'wave2-${runKey}-category-member@example.test', 'Member');
      INSERT INTO app.tenants (id, name, slug) VALUES
        ('${tenantId}', 'Category Tenant', 'wave2-${runKey}-category'),
        ('${foreignTenantId}', 'Foreign Category Tenant', 'wave2-${runKey}-category-foreign');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role) VALUES
        ('${tenantId}', '${ownerId}', 'owner'),
        ('${tenantId}', '${memberId}', 'member');
      INSERT INTO app.spending_categories
        (id, tenant_id, name, color, icon)
      VALUES ('${foreignCategoryId}', '${foreignTenantId}', 'Foreign', '#2563EB', 'package');
    `);
    const domain = createSpendingCategoryDomain(database);
    const created = await domain.create({
      actorUserId: ownerId,
      tenantId,
      request: {
        name: "Materials",
        description: "Operating materials",
        color: "#2563EB",
        icon: "package",
      },
      requestId: `wave2-${runKey}-category-create`,
    });

    expect(created).toMatchObject({ tenantId, templateKey: null, version: 1 });
    expect(await domain.list(memberId, tenantId)).toHaveLength(1);
    await expect(
      domain.create({
        actorUserId: memberId,
        tenantId,
        request: { name: "Fuel", color: "#15803D", icon: "car" },
        requestId: `wave2-${runKey}-category-member-create`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "FORBIDDEN" });
    await expect(
      domain.create({
        actorUserId: ownerId,
        tenantId,
        request: { name: "materials", color: "#15803D", icon: "package" },
        requestId: `wave2-${runKey}-category-duplicate`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
    await expect(
      domain.update({
        actorUserId: ownerId,
        tenantId,
        categoryId: foreignCategoryId,
        request: { expectedVersion: 1, name: "Hidden" },
        requestId: `wave2-${runKey}-category-foreign`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "NOT_FOUND" });
    const updated = await domain.update({
      actorUserId: ownerId,
      tenantId,
      categoryId: created.id,
      request: { expectedVersion: 1, name: "Project Materials" },
      requestId: `wave2-${runKey}-category-update`,
    });
    expect(updated).toMatchObject({ name: "Project Materials", version: 2 });
    await expect(
      domain.update({
        actorUserId: ownerId,
        tenantId,
        categoryId: created.id,
        request: { expectedVersion: 1, name: "Stale" },
        requestId: `wave2-${runKey}-category-stale`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
    await domain.archive({
      actorUserId: ownerId,
      tenantId,
      categoryId: created.id,
      request: { expectedVersion: 2 },
      requestId: `wave2-${runKey}-category-archive`,
    });
    expect(await domain.list(memberId, tenantId)).toEqual([]);
    await expect(
      domain.update({
        actorUserId: ownerId,
        tenantId,
        categoryId: created.id,
        request: { expectedVersion: 3, name: "Archived" },
        requestId: `wave2-${runKey}-category-archived-update`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
  });

  it("enforces business-scoped project roles, dates, and lifecycle", async () => {
    const ownerId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${ownerId}', 'wave2-${runKey}-project-owner@example.test', 'Owner'),
        ('${editorId}', 'wave2-${runKey}-project-editor@example.test', 'Editor'),
        ('${viewerId}', 'wave2-${runKey}-project-viewer@example.test', 'Viewer');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Project Tenant', 'wave2-${runKey}-project');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role) VALUES
        ('${tenantId}', '${ownerId}', 'owner'),
        ('${tenantId}', '${editorId}', 'member'),
        ('${tenantId}', '${viewerId}', 'member');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES ('${businessId}', '${tenantId}', 'Builder', 'construction', 'UTC', 'USD');
      INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role) VALUES
        ('${businessId}', '${tenantId}', '${ownerId}', 'owner'),
        ('${businessId}', '${tenantId}', '${editorId}', 'editor'),
        ('${businessId}', '${tenantId}', '${viewerId}', 'viewer');
    `);
    const domain = createProjectDomain(database);
    const created = await domain.create({
      actorUserId: editorId,
      tenantId,
      businessId,
      request: { name: "Renovation", startsOn: "2026-09-10" },
      requestId: `wave2-${runKey}-project-create`,
    });

    expect(created.startsOn).toBe("2026-09-10");
    expect(await domain.list(viewerId, tenantId, businessId)).toHaveLength(1);
    expect(await domain.get(viewerId, tenantId, businessId, created.id)).toEqual(created);
    await expect(
      domain.create({
        actorUserId: viewerId,
        tenantId,
        businessId,
        request: { name: "Forbidden" },
        requestId: `wave2-${runKey}-project-viewer-create`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "FORBIDDEN" });
    await expect(
      domain.update({
        actorUserId: editorId,
        tenantId,
        businessId,
        projectId: created.id,
        request: { expectedVersion: 1, endsOn: "2026-09-09" },
        requestId: `wave2-${runKey}-project-invalid-dates`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "VALIDATION_ERROR" });
    const updated = await domain.update({
      actorUserId: editorId,
      tenantId,
      businessId,
      projectId: created.id,
      request: { expectedVersion: 1, endsOn: "2026-09-11" },
      requestId: `wave2-${runKey}-project-update`,
    });
    expect(updated).toMatchObject({ endsOn: "2026-09-11", version: 2 });
    await expect(
      domain.update({
        actorUserId: editorId,
        tenantId,
        businessId,
        projectId: created.id,
        request: { expectedVersion: 1, name: "Stale" },
        requestId: `wave2-${runKey}-project-stale`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
    await domain.archive({
      actorUserId: editorId,
      tenantId,
      businessId,
      projectId: created.id,
      request: { expectedVersion: 2 },
      requestId: `wave2-${runKey}-project-archive`,
    });
    expect(await domain.list(viewerId, tenantId, businessId)).toEqual([]);
    await expect(
      domain.update({
        actorUserId: editorId,
        tenantId,
        businessId,
        projectId: created.id,
        request: { expectedVersion: 3, name: "Archived" },
        requestId: `wave2-${runKey}-project-archived-update`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });

    executeSql(`
      UPDATE app.businesses
      SET status = 'archived', archived_at = now()
      WHERE id = '${businessId}';
    `);
    await expect(
      domain.create({
        actorUserId: ownerId,
        tenantId,
        businessId,
        request: { name: "Archived Business Project" },
        requestId: `wave2-${runKey}-project-archived-business`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
  });
});
