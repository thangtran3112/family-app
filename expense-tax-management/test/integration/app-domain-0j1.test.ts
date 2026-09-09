import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createPlansDomain } from "../../services/app-api/src/domain/plans.js";
import { DomainError } from "../../services/app-api/src/errors.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0J1_INTEGRATION === "1";
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

function seedTenantOnly(userId: string, tenantId: string, role = "owner"): void {
  executeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${userId}', '0j1-${runKey}-${userId.slice(0, 6)}@example.test', '0J1 User');
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${tenantId}', '0J1 Tenant', '0j1-${runKey}-${tenantId.slice(0, 6)}');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
    VALUES ('${tenantId}', '${userId}', '${role}');
  `);
}

describe.skipIf(!integrationEnabled)("Phase 0J1 plans and entitlements", () => {
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
      throw new Error("Phase 0J1 PostgreSQL prerequisites are missing");
    }
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
  });

  afterAll(async () => {
    if (!postgresContainerId || !runtimePassword) return;
    runSql(`DELETE FROM app.tenants WHERE slug LIKE '0j1-${runKey}-%';`);
    runSql(`DELETE FROM app.users WHERE primary_email LIKE '0j1-${runKey}-%';`);
    await database.destroy();
  });

  it("creates plans/entitlements tables", () => {
    expect(
      executeSql(`
        SELECT string_agg(name, ',' ORDER BY name)
        FROM unnest(ARRAY[
          'app.plans',
          'app.plan_versions',
          'app.feature_definitions',
          'app.plan_entitlements',
          'app.tenant_subscriptions',
          'app.tenant_addons',
          'app.tenant_feature_overrides',
          'app.feature_usage_events',
          'app.entitlement_snapshot_outbox'
        ]) AS name
        WHERE to_regclass(name) IS NOT NULL;
      `),
    ).toBe(
      "app.entitlement_snapshot_outbox,app.feature_definitions,app.feature_usage_events,app.plan_entitlements,app.plans,app.plan_versions,app.tenant_addons,app.tenant_feature_overrides,app.tenant_subscriptions",
    );
  });

  it("seeds the trial plan with six feature definitions", () => {
    expect(
      executeSql(`
        SELECT concat(p.key, ':', pv.version_number, ':', pv.is_current)
        FROM app.plans p JOIN app.plan_versions pv ON pv.plan_id = p.id
        WHERE p.key = 'trial';
      `),
    ).toBe("trial:1:t");
    expect(
      executeSql(`SELECT count(*) FROM app.feature_definitions;`),
    ).toBe("6");
    expect(
      executeSql(`
        SELECT count(*) FROM app.plan_entitlements pe
        JOIN app.plan_versions pv ON pv.id = pe.plan_version_id
        JOIN app.plans p ON p.id = pv.plan_id
        WHERE p.key = 'trial';
      `),
    ).toBe("6");
  });

  it("enforces one current version per plan and unique addon/override rows", () => {
    const planId = randomUUID();
    const versionId = randomUUID();
    executeSql(`
      INSERT INTO app.plans (id, key, name) VALUES ('${planId}', 'test-${runKey}', 'Test Plan');
      INSERT INTO app.plan_versions (id, plan_id, version_number, is_current)
      VALUES ('${versionId}', '${planId}', 1, true);
    `);
    expectConstraint(
      `INSERT INTO app.plan_versions (id, plan_id, version_number, is_current)
       VALUES ('${randomUUID()}', '${planId}', 2, true);`,
      "plan_versions_one_current_per_plan",
    );

    const userId = randomUUID();
    const tenantId = randomUUID();
    seedTenantOnly(userId, tenantId);
    expectConstraint(
      `INSERT INTO app.tenant_feature_overrides (id, tenant_id, feature_definition_id, override_enabled, reason, granted_by)
       VALUES ('${randomUUID()}', '${tenantId}', 'bbbbbbbb-0001-4000-8000-000000000001', false, '', 'platform-admin');`,
      "tenant_feature_overrides_reason_check",
    );
    executeSql(`
      INSERT INTO app.tenant_feature_overrides (id, tenant_id, feature_definition_id, override_enabled, reason, granted_by)
      VALUES ('${randomUUID()}', '${tenantId}', 'bbbbbbbb-0001-4000-8000-000000000001', false, 'abuse review', 'platform-admin');
    `);
    expectConstraint(
      `INSERT INTO app.tenant_feature_overrides (id, tenant_id, feature_definition_id, override_enabled, reason, granted_by)
       VALUES ('${randomUUID()}', '${tenantId}', 'bbbbbbbb-0001-4000-8000-000000000001', true, 'second one', 'platform-admin');`,
      "tenant_feature_overrides_tenant_feature_unique",
    );
  });

  it("resolves override over addon over plan", async () => {
    const ownerId = randomUUID();
    const tenantId = randomUUID();
    seedTenantOnly(ownerId, tenantId);
    const domain = createPlansDomain(database);

    const baseline = await domain.resolveEffectiveEntitlements({
      tenantId,
      actorUserId: ownerId,
    });
    expect(baseline.find((entitlement) => entitlement.featureKey === "ai_search")).toMatchObject({
      isEnabled: true,
      limitValue: 20,
      limitPeriod: "monthly",
      source: "plan",
    });
    expect(
      baseline.find((entitlement) => entitlement.featureKey === "connected_mailbox_scan"),
    ).toMatchObject({ isEnabled: false, source: "plan" });

    await domain.addAddon({
      tenantId,
      actorUserId: ownerId,
      request: { featureKey: "connected_mailbox_scan", reason: "beta tester" },
      requestId: `0j1-${runKey}-addon-add`,
    });
    const withAddon = await domain.resolveEffectiveEntitlements({
      tenantId,
      actorUserId: ownerId,
    });
    expect(
      withAddon.find((entitlement) => entitlement.featureKey === "connected_mailbox_scan"),
    ).toMatchObject({ isEnabled: true, source: "addon" });

    const featureId = executeSql(
      `SELECT id FROM app.feature_definitions WHERE key = 'connected_mailbox_scan';`,
    );
    executeSql(`
      INSERT INTO app.tenant_feature_overrides
        (id, tenant_id, feature_definition_id, override_enabled, reason, granted_by)
      VALUES ('${randomUUID()}', '${tenantId}', '${featureId}', false, 'abuse review', 'platform-admin');
    `);
    const withOverride = await domain.resolveEffectiveEntitlements({
      tenantId,
      actorUserId: ownerId,
    });
    expect(
      withOverride.find((entitlement) => entitlement.featureKey === "connected_mailbox_scan"),
    ).toMatchObject({ isEnabled: false, source: "override" });
  });

  it("publishes an outbox row on every entitlement-affecting mutation and rejects non-owners", async () => {
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const tenantId = randomUUID();
    seedTenantOnly(ownerId, tenantId, "owner");
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${memberId}', '0j1-${runKey}-member@example.test', 'Member');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${tenantId}', '${memberId}', 'member');
    `);
    const domain = createPlansDomain(database);

    await expect(
      domain.addAddon({
        tenantId,
        actorUserId: memberId,
        request: { featureKey: "receipt_forwarding", reason: "not allowed" },
        requestId: `0j1-${runKey}-forbidden`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "FORBIDDEN" });

    const subscription = await domain.getSubscription({ tenantId });
    expect(subscription.currentEntitlementVersion).toBe(1);

    await domain.addAddon({
      tenantId,
      actorUserId: ownerId,
      request: { featureKey: "connected_mailbox_scan", reason: "grant" },
      requestId: `0j1-${runKey}-addon-outbox`,
    });
    const bumped = await domain.getSubscription({ tenantId });
    expect(bumped.currentEntitlementVersion).toBe(2);

    const outboxCount = executeSql(`
      SELECT count(*) FROM app.entitlement_snapshot_outbox WHERE tenant_id = '${tenantId}';
    `);
    expect(outboxCount).toBe("1");

    const before = await domain.listEntitlementSnapshotsAfter({
      afterSequence: 0,
      limit: 500,
    });
    const ours = before.items.find((snapshot) => snapshot.tenantId === tenantId);
    expect(ours).toMatchObject({ entitlementVersion: 2 });
    expect(before.nextAfterSequence).not.toBeNull();

    const after = await domain.listEntitlementSnapshotsAfter({
      afterSequence: before.nextAfterSequence!,
      limit: 500,
    });
    expect(after.items.find((snapshot) => snapshot.tenantId === tenantId)).toBeUndefined();

    await domain.removeAddon({
      tenantId,
      actorUserId: ownerId,
      featureKey: "connected_mailbox_scan",
      requestId: `0j1-${runKey}-addon-remove`,
    });
    expect((await domain.getSubscription({ tenantId })).currentEntitlementVersion).toBe(3);
  });
});
